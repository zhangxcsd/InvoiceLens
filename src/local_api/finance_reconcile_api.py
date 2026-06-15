"""财务账表导入与 DWD/DWS 发票净额核对（只读比对 + 最小导入持久化）。"""

from __future__ import annotations

import io
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd

from db.schema_sqlfiles import DDL_FINANCE

_INIT_LOCK = threading.Lock()
_AMOUNT_TOLERANCE = Decimal("0.01")

_COL_ALIASES: dict[str, tuple[str, ...]] = {
    "tax_id": ("税号", "纳税人识别号", "统一社会信用代码", "tax_id", "entity_id", "主体税号"),
    "entity_name": ("主体名称", "企业名称", "纳税人名称", "entity_name", "名称"),
    "stat_year": ("年度", "统计年度", "会计年度", "stat_year", "year"),
    "stat_month": ("期间", "月份", "会计期间", "stat_month", "month", "period"),
    "role_type": ("购销标志", "进项销项", "role_type", "方向"),
    "subject_code": ("科目编码", "科目代码", "subject_code", "科目"),
    "subject_name": ("科目名称", "subject_name"),
    "ledger_amount": ("账表金额", "账面金额", "金额", "ledger_amount", "amount", "本期发生额"),
}

_ROLE_OUTPUT = frozenset({"销项", "output", "seller", "销售", "开出"})
_ROLE_INPUT = frozenset({"进项", "input", "buyer", "采购", "取得"})


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _norm_header(s: Any) -> str:
    if s is None or (isinstance(s, float) and pd.isna(s)):
        return ""
    return re.sub(r"\s+", "", str(s).strip().lower())


def _norm_tax_id(v: Any) -> str:
    s = str(v or "").strip()
    if not s or s.lower() in {"nan", "none", "nat", "<na>"}:
        return ""
    return re.sub(r"[\s-]+", "", s).upper()


def _norm_role(v: Any) -> str:
    s = str(v or "").strip()
    if not s:
        return "销项"
    low = s.lower()
    if s in _ROLE_INPUT or low in _ROLE_INPUT:
        return "进项"
    return "销项"


def _parse_int(v: Any, *, lo: int, hi: int) -> int | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip()
    if not s or s.lower() in {"nan", "none", "nat", "<na>"}:
        return None
    s = re.sub(r"[^\d]", "", s)
    if not s:
        return None
    try:
        n = int(s)
    except ValueError:
        return None
    if n < lo or n > hi:
        return None
    return n


def _parse_amount(v: Any) -> Decimal | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip().replace(",", "").replace("，", "")
    if not s or s.lower() in {"nan", "none", "nat", "<na>", "-", "—"}:
        return None
    try:
        return Decimal(s)
    except (InvalidOperation, ValueError):
        return None


def _decimal_float(v: Decimal | float | int | None) -> float:
    if v is None:
        return 0.0
    if isinstance(v, Decimal):
        return float(v)
    return float(v)


def _ensure_runtime(conn: Any) -> None:
    """仅确保财务账表 DDL 就绪，避免每次请求触发全库 init_all_tables。"""
    with _INIT_LOCK:
        for stmt in [s.strip() for s in DDL_FINANCE.split(";") if s.strip()]:
            has_sql = False
            for line in stmt.splitlines():
                s = line.strip()
                if s and not s.startswith("--"):
                    has_sql = True
                    break
            if not has_sql:
                continue
            try:
                conn.execute(stmt)
            except Exception:
                continue


def _table_exists(conn: Any, name: str) -> bool:
    try:
        row = conn.execute(
            "SELECT COUNT(*)::BIGINT FROM information_schema.tables "
            "WHERE table_schema='main' AND table_name = ?",
            [name],
        ).fetchone()
        return bool(row and int(row[0] or 0) > 0)
    except Exception:
        return False


def _detect_columns(headers: list[str]) -> dict[str, int | None]:
    norm_headers = [_norm_header(h) for h in headers]
    out: dict[str, int | None] = {k: None for k in _COL_ALIASES}
    for field, aliases in _COL_ALIASES.items():
        alias_norm = {_norm_header(a) for a in aliases}
        for idx, nh in enumerate(norm_headers):
            if nh in alias_norm:
                out[field] = idx
                break
    return out


def _read_upload_frame(
    file_bytes: bytes,
    upload_filename: str,
) -> tuple[pd.DataFrame, str, dict[str, Any] | None]:
    """读取上传文件；文件级失败返回 (empty_df, '', error_dict)。"""
    fn = (upload_filename or "upload.bin").lower()
    try:
        bio = io.BytesIO(file_bytes)
        if fn.endswith(".csv"):
            df = pd.read_csv(bio, dtype=str)
            return df, "csv", None
        engine = "xlrd" if fn.endswith(".xls") else "openpyxl"
        xls = pd.ExcelFile(bio, engine=engine)
        sheet = xls.sheet_names[0]
        df = pd.read_excel(xls, sheet_name=sheet, dtype=str)
        return df, sheet, None
    except Exception as exc:
        return (
            pd.DataFrame(),
            "",
            {
                "file_blocking": True,
                "reason": f"无法读取文件：{exc}",
                "exception_type": type(exc).__name__,
                "reject_row_samples": [],
                "reject_row_ranges": [],
            },
        )


def _period_key(stat_year: int, stat_month: int | None) -> tuple[int, int]:
    return (stat_year, 0 if stat_month is None else stat_month)


def _load_invoice_net_rows(
    conn: Any,
    *,
    stat_year: int | None = None,
    entity_id: str | None = None,
) -> list[dict[str, Any]]:
    """按主体/年度/期间/购销方向汇总发票净额。优先 dws_inv_trend，回退 dwd_inv_header。"""
    rows: list[dict[str, Any]] = []
    eid = _norm_tax_id(entity_id) if entity_id else ""
    if _table_exists(conn, "dws_inv_trend"):
        clauses = ["1=1"]
        params: list[Any] = []
        if stat_year is not None:
            clauses.append("stat_year = ?")
            params.append(stat_year)
        if eid:
            clauses.append("entity_id = ?")
            params.append(eid)
        where = " AND ".join(clauses)
        try:
            for r in conn.execute(
                f"""
                SELECT entity_id, any_value(entity_name) AS entity_name,
                       stat_year, stat_month, role_type,
                       coalesce(sum(net_jshj), 0) AS invoice_net
                FROM dws_inv_trend
                WHERE {where}
                GROUP BY entity_id, stat_year, stat_month, role_type
                """,
                params,
            ).fetchall() or []:
                rows.append(
                    {
                        "tax_id": _norm_tax_id(r[0]),
                        "entity_name": str(r[1] or ""),
                        "stat_year": int(r[2]),
                        "stat_month": int(r[3]),
                        "role_type": _norm_role(r[4]),
                        "invoice_net": Decimal(str(r[5] or 0)),
                    }
                )
            if rows:
                return rows
        except Exception:
            pass

    if not _table_exists(conn, "dwd_inv_header"):
        return rows

    norm_xfs = "upper(regexp_replace(trim(COALESCE(xfsbh, '')), '[\\\\s-]+', '', 'g'))"
    norm_gfs = "upper(regexp_replace(trim(COALESCE(gfsbh, '')), '[\\\\s-]+', '', 'g'))"
    net_expr = "COALESCE(net_jshj, jshj, 0)"
    clauses_h: list[str] = [f"length(trim(COALESCE(xfsbh, ''))) > 0"]
    clauses_g: list[str] = [f"length(trim(COALESCE(gfsbh, ''))) > 0"]
    params_h: list[Any] = []
    params_g: list[Any] = []
    if stat_year is not None:
        clauses_h.append("stat_year = ?")
        clauses_g.append("stat_year = ?")
        params_h.append(stat_year)
        params_g.append(stat_year)
    if eid:
        clauses_h.append(f"{norm_xfs} = ?")
        clauses_g.append(f"{norm_gfs} = ?")
        params_h.append(eid)
        params_g.append(eid)
    wh = " AND ".join(clauses_h)
    wg = " AND ".join(clauses_g)
    try:
        sql = f"""
            SELECT tax_id, any_value(entity_name), stat_year, stat_month, role_type,
                   coalesce(sum(invoice_net), 0) AS invoice_net
            FROM (
                SELECT {norm_xfs} AS tax_id, xfmc AS entity_name,
                       stat_year, stat_month, '销项' AS role_type,
                       {net_expr} AS invoice_net
                FROM dwd_inv_header
                WHERE {wh}
                UNION ALL
                SELECT {norm_gfs}, gfmc, stat_year, stat_month, '进项',
                       {net_expr}
                FROM dwd_inv_header
                WHERE {wg}
            ) t
            WHERE length(trim(tax_id)) > 0
            GROUP BY tax_id, stat_year, stat_month, role_type
        """
        for r in conn.execute(sql, params_h + params_g).fetchall() or []:
            rows.append(
                {
                    "tax_id": _norm_tax_id(r[0]),
                    "entity_name": str(r[1] or ""),
                    "stat_year": int(r[2]),
                    "stat_month": int(r[3]),
                    "role_type": _norm_role(r[4]),
                    "invoice_net": Decimal(str(r[5] or 0)),
                }
            )
    except Exception:
        return []
    return rows


def _invoice_lookup(
    invoice_rows: list[dict[str, Any]],
) -> dict[tuple[str, int, int, str], dict[str, Any]]:
    """键：(tax_id, year, month, role)；month=0 表示年度汇总。"""
    by_period: dict[tuple[str, int, int, str], Decimal] = {}
    meta: dict[tuple[str, int, int, str], dict[str, Any]] = {}
    for row in invoice_rows:
        tax_id = row["tax_id"]
        year = int(row["stat_year"])
        month = int(row["stat_month"])
        role = _norm_role(row["role_type"])
        amt = Decimal(str(row["invoice_net"]))
        key = (tax_id, year, month, role)
        by_period[key] = by_period.get(key, Decimal("0")) + amt
        if key not in meta:
            meta[key] = {"entity_name": row.get("entity_name") or ""}
    out: dict[tuple[str, int, int, str], dict[str, Any]] = {}
    year_acc: dict[tuple[str, int, str], Decimal] = {}
    for key, amt in by_period.items():
        tax_id, year, month, role = key
        out[key] = {"invoice_net": amt, "entity_name": meta[key]["entity_name"]}
        yk = (tax_id, year, role)
        year_acc[yk] = year_acc.get(yk, Decimal("0")) + amt
    for (tax_id, year, role), amt in year_acc.items():
        ykey = (tax_id, year, 0, role)
        if ykey not in out:
            out[ykey] = {"invoice_net": amt, "entity_name": ""}
        else:
            out[ykey]["invoice_net"] = amt
    return out


def _load_ledger_rows(
    conn: Any,
    *,
    batch_id: str | None,
    stat_year: int | None = None,
    entity_id: str | None = None,
) -> list[dict[str, Any]]:
    if not _table_exists(conn, "dm_finance_ledger"):
        return []
    clauses = ["1=1"]
    params: list[Any] = []
    if batch_id:
        clauses.append("batch_id = ?")
        params.append(batch_id)
    if stat_year is not None:
        clauses.append("stat_year = ?")
        params.append(stat_year)
    eid = _norm_tax_id(entity_id) if entity_id else ""
    if eid:
        clauses.append("tax_id = ?")
        params.append(eid)
    where = " AND ".join(clauses)
    try:
        rows = conn.execute(
            f"""
            SELECT row_id, batch_id, seq_no, tax_id, entity_name, stat_year, stat_month,
                   role_type, subject_code, subject_name, ledger_amount
            FROM dm_finance_ledger
            WHERE {where}
            ORDER BY stat_year DESC, coalesce(stat_month, 0) DESC, tax_id, seq_no
            """,
            params,
        ).fetchall()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in rows or []:
        out.append(
            {
                "row_id": str(r[0]),
                "batch_id": str(r[1]),
                "seq_no": int(r[2] or 0),
                "tax_id": _norm_tax_id(r[3]),
                "entity_name": str(r[4] or ""),
                "stat_year": int(r[5]),
                "stat_month": int(r[6]) if r[6] is not None else None,
                "role_type": _norm_role(r[7]),
                "subject_code": str(r[8] or ""),
                "subject_name": str(r[9] or ""),
                "ledger_amount": Decimal(str(r[10] or 0)),
            }
        )
    return out


def _classify_diff(
    *,
    ledger_amt: Decimal | None,
    invoice_amt: Decimal | None,
    tax_id: str,
) -> tuple[str, Decimal]:
    """返回 (diff_type, diff_amount)。"""
    if not tax_id or len(tax_id) < 6:
        diff = (ledger_amt or Decimal("0")) - (invoice_amt or Decimal("0"))
        return "D", diff
    has_ledger = ledger_amt is not None
    has_invoice = invoice_amt is not None
    if has_invoice and not has_ledger:
        return "A", invoice_amt or Decimal("0")
    if has_ledger and not has_invoice:
        return "B", ledger_amt or Decimal("0")
    la = ledger_amt or Decimal("0")
    ia = invoice_amt or Decimal("0")
    diff = la - ia
    if abs(diff) <= _AMOUNT_TOLERANCE:
        return "MATCH", diff
    return "C", diff


def _build_reconcile_rows(
    conn: Any,
    *,
    batch_id: str | None,
    stat_year: int | None = None,
    entity_id: str | None = None,
) -> list[dict[str, Any]]:
    ledger_rows = _load_ledger_rows(conn, batch_id=batch_id, stat_year=stat_year, entity_id=entity_id)
    invoice_rows = _load_invoice_net_rows(conn, stat_year=stat_year, entity_id=entity_id)
    invoice_map = _invoice_lookup(invoice_rows)

    ledger_keys: set[tuple[str, int, int, str]] = set()
    result: list[dict[str, Any]] = []
    seq = 0

    for lr in ledger_rows:
        tax_id = lr["tax_id"]
        year = lr["stat_year"]
        month = lr["stat_month"]
        role = lr["role_type"]
        pk = _period_key(year, month)
        key = (tax_id, pk[0], pk[1], role)
        ledger_keys.add(key)
        inv = invoice_map.get(key)
        invoice_amt = inv["invoice_net"] if inv else None
        diff_type, diff_amt = _classify_diff(
            ledger_amt=lr["ledger_amount"],
            invoice_amt=invoice_amt,
            tax_id=tax_id,
        )
        entity_name = lr["entity_name"] or (inv or {}).get("entity_name") or tax_id
        seq += 1
        result.append(
            {
                "diff_id": f"FR-{lr['batch_id']}-{seq:04d}",
                "batch_id": lr["batch_id"],
                "tax_id": tax_id,
                "entity_name": entity_name,
                "stat_year": year,
                "stat_month": month,
                "role_type": role,
                "subject_code": lr["subject_code"],
                "subject_name": lr["subject_name"],
                "ledger_amount": _decimal_float(lr["ledger_amount"]),
                "invoice_net": _decimal_float(invoice_amt) if invoice_amt is not None else None,
                "diff_amount": _decimal_float(diff_amt),
                "diff_type": diff_type,
                "status": "已匹配" if diff_type == "MATCH" else ("待跟踪" if diff_type in {"A", "B", "C"} else "待分类"),
            }
        )

    for key, inv in invoice_map.items():
        if key in ledger_keys:
            continue
        tax_id, year, month, role = key
        if month == 0:
            continue
        diff_type, diff_amt = _classify_diff(ledger_amt=None, invoice_amt=inv["invoice_net"], tax_id=tax_id)
        if diff_type != "A":
            continue
        seq += 1
        result.append(
            {
                "diff_id": f"FR-INV-{seq:04d}",
                "batch_id": batch_id or "",
                "tax_id": tax_id,
                "entity_name": inv.get("entity_name") or tax_id,
                "stat_year": year,
                "stat_month": month if month else None,
                "role_type": role,
                "subject_code": "",
                "subject_name": "",
                "ledger_amount": None,
                "invoice_net": _decimal_float(inv["invoice_net"]),
                "diff_amount": _decimal_float(diff_amt),
                "diff_type": "A",
                "status": "待跟踪",
            }
        )

    return result


def api_ledger_import(
    conn: Any,
    *,
    file_bytes: bytes,
    upload_filename: str,
    batch_name: str | None = None,
    default_stat_year: int | None = None,
) -> dict[str, Any]:
    _ensure_runtime(conn)
    batch_id = f"fin_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"
    source_file = upload_filename or "upload.bin"
    detail: dict[str, Any] = {
        "reject_row_samples": [],
        "reject_row_ranges": [],
        "file_logs": [],
    }

    df, sheet, file_err = _read_upload_frame(file_bytes, upload_filename)
    if file_err:
        detail["file_logs"].append({**file_err, "source_excel_file": source_file})
        conn.execute(
            """
            INSERT INTO dm_finance_ledger_batch (
                batch_id, batch_name, source_file, stat_year, row_count, reject_count,
                import_status, detail_json
            ) VALUES (?, ?, ?, ?, 0, 0, '失败', ?)
            """,
            [batch_id, batch_name or source_file, source_file, default_stat_year, json.dumps(detail, ensure_ascii=False)],
        )
        return {
            "ok": False,
            "batch_id": batch_id,
            "import_status": "失败",
            "message": file_err["reason"],
            "detail": detail,
        }

    if df.empty:
        detail["file_logs"].append(
            {
                "file_blocking": True,
                "reason": "文件无数据行",
                "source_excel_file": source_file,
                "reject_row_samples": [],
                "reject_row_ranges": [],
            }
        )
        conn.execute(
            """
            INSERT INTO dm_finance_ledger_batch (
                batch_id, batch_name, source_file, stat_year, row_count, reject_count,
                import_status, detail_json
            ) VALUES (?, ?, ?, ?, 0, 0, '失败', ?)
            """,
            [batch_id, batch_name or source_file, source_file, default_stat_year, json.dumps(detail, ensure_ascii=False)],
        )
        return {"ok": False, "batch_id": batch_id, "import_status": "失败", "message": "文件无数据行", "detail": detail}

    headers = [str(c) for c in df.columns.tolist()]
    colmap = _detect_columns(headers)
    if colmap["tax_id"] is None or colmap["ledger_amount"] is None:
        msg = "缺少必要列：须包含税号与账表金额（或同义列名）"
        detail["file_logs"].append(
            {
                "file_blocking": True,
                "reason": msg,
                "source_excel_file": source_file,
                "detected_headers": headers,
                "reject_row_samples": [],
                "reject_row_ranges": [],
            }
        )
        conn.execute(
            """
            INSERT INTO dm_finance_ledger_batch (
                batch_id, batch_name, source_file, stat_year, row_count, reject_count,
                import_status, detail_json
            ) VALUES (?, ?, ?, ?, 0, 0, '失败', ?)
            """,
            [batch_id, batch_name or source_file, source_file, default_stat_year, json.dumps(detail, ensure_ascii=False)],
        )
        return {"ok": False, "batch_id": batch_id, "import_status": "失败", "message": msg, "detail": detail}

    accepted: list[dict[str, Any]] = []
    rejects: list[dict[str, Any]] = []
    batch_year: int | None = default_stat_year

    for idx, row in df.iterrows():
        seq_no = int(idx) + 2
        try:
            def _cell(field: str) -> Any:
                ci = colmap.get(field)
                if ci is None:
                    return None
                return row.iloc[ci]

            tax_id = _norm_tax_id(_cell("tax_id"))
            amount = _parse_amount(_cell("ledger_amount"))
            year = _parse_int(_cell("stat_year"), lo=1990, hi=2100) or default_stat_year
            month = _parse_int(_cell("stat_month"), lo=1, hi=12)
            if not tax_id:
                rejects.append(
                    {
                        "seq_no": seq_no,
                        "sheet": sheet,
                        "field": "tax_id",
                        "reason": "税号为空或无效",
                        "exception_type": "RowValidationError",
                    }
                )
                continue
            if amount is None:
                rejects.append(
                    {
                        "seq_no": seq_no,
                        "sheet": sheet,
                        "field": "ledger_amount",
                        "reason": "账表金额无法解析",
                        "exception_type": "RowValidationError",
                    }
                )
                continue
            if year is None:
                rejects.append(
                    {
                        "seq_no": seq_no,
                        "sheet": sheet,
                        "field": "stat_year",
                        "reason": "统计年度缺失或无效",
                        "exception_type": "RowValidationError",
                    }
                )
                continue
            if batch_year is None:
                batch_year = year
            accepted.append(
                {
                    "row_id": str(uuid.uuid4()),
                    "batch_id": batch_id,
                    "seq_no": seq_no,
                    "tax_id": tax_id,
                    "entity_name": str(_cell("entity_name") or "").strip() or None,
                    "stat_year": year,
                    "stat_month": month,
                    "role_type": _norm_role(_cell("role_type")),
                    "subject_code": str(_cell("subject_code") or "").strip() or None,
                    "subject_name": str(_cell("subject_name") or "").strip() or None,
                    "ledger_amount": amount,
                    "source_excel_file": source_file,
                    "source_sheet": sheet,
                }
            )
        except Exception as exc:
            rejects.append(
                {
                    "seq_no": seq_no,
                    "sheet": sheet,
                    "field": None,
                    "reason": f"行解析异常：{exc}",
                    "exception_type": type(exc).__name__,
                }
            )

    detail["reject_row_samples"] = rejects[:50]
    if rejects:
        detail["reject_row_ranges"] = [
            {
                "seq_no_start": rejects[0]["seq_no"],
                "seq_no_end": rejects[-1]["seq_no"],
                "reason": "存在行级拒收（详见 reject_row_samples）",
            }
        ]

    import_status = "成功"
    if rejects and accepted:
        import_status = "警告"
    elif rejects and not accepted:
        import_status = "失败"

    for rec in accepted:
        conn.execute(
            """
            INSERT INTO dm_finance_ledger (
                row_id, batch_id, seq_no, tax_id, entity_name, stat_year, stat_month,
                role_type, subject_code, subject_name, ledger_amount,
                source_excel_file, source_sheet, ingest_ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            [
                rec["row_id"],
                rec["batch_id"],
                rec["seq_no"],
                rec["tax_id"],
                rec["entity_name"],
                rec["stat_year"],
                rec["stat_month"],
                rec["role_type"],
                rec["subject_code"],
                rec["subject_name"],
                float(rec["ledger_amount"]),
                rec["source_excel_file"],
                rec["source_sheet"],
            ],
        )

    conn.execute(
        """
        INSERT INTO dm_finance_ledger_batch (
            batch_id, batch_name, source_file, stat_year, row_count, reject_count,
            import_status, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            batch_id,
            batch_name or source_file,
            source_file,
            batch_year,
            len(accepted),
            len(rejects),
            import_status,
            json.dumps(detail, ensure_ascii=False),
        ],
    )

    ok = import_status != "失败"
    return {
        "ok": ok,
        "batch_id": batch_id,
        "import_status": import_status,
        "row_count": len(accepted),
        "reject_count": len(rejects),
        "message": "导入完成" if ok else "导入失败：无有效行",
        "detail": detail,
    }


def api_ledger_batches(conn: Any, *, limit: int = 50) -> dict[str, Any]:
    _ensure_runtime(conn)
    if not _table_exists(conn, "dm_finance_ledger_batch"):
        return {"ok": True, "batches": []}
    lim = max(1, min(200, int(limit)))
    try:
        rows = conn.execute(
            """
            SELECT batch_id, batch_name, source_file, stat_year, row_count, reject_count,
                   import_status, imported_at
            FROM dm_finance_ledger_batch
            ORDER BY imported_at DESC NULLS LAST
            LIMIT ?
            """,
            [lim],
        ).fetchall()
    except Exception as exc:
        return {"ok": False, "batches": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}
    batches = [
        {
            "batch_id": str(r[0]),
            "batch_name": str(r[1] or r[0]),
            "source_file": str(r[2] or ""),
            "stat_year": int(r[3]) if r[3] is not None else None,
            "row_count": int(r[4] or 0),
            "reject_count": int(r[5] or 0),
            "import_status": str(r[6] or ""),
            "imported_at": str(r[7] or ""),
        }
        for r in rows or []
    ]
    return {"ok": True, "batches": batches}


def api_reconcile_overview(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    _ensure_runtime(conn)
    rows = _build_reconcile_rows(conn, batch_id=batch_id, stat_year=stat_year, entity_id=entity_id)
    matched = [r for r in rows if r["diff_type"] == "MATCH"]
    unmatched = [r for r in rows if r["diff_type"] != "MATCH"]
    total_diff = sum(abs(r["diff_amount"]) for r in unmatched)
    type_counts = {k: 0 for k in ("A", "B", "C", "D", "MATCH")}
    for r in rows:
        dt = r["diff_type"]
        if dt in type_counts:
            type_counts[dt] += 1
    dwd_ready = _table_exists(conn, "dwd_inv_header")
    ledger_ready = False
    if _table_exists(conn, "dm_finance_ledger"):
        try:
            ledger_ready = int(
                conn.execute("SELECT COUNT(*)::BIGINT FROM dm_finance_ledger").fetchone()[0] or 0
            ) > 0
        except Exception:
            ledger_ready = False
    return {
        "ok": True,
        "batch_id": batch_id,
        "stat_year": stat_year,
        "entity_id": _norm_tax_id(entity_id) if entity_id else None,
        "dwd_ready": dwd_ready,
        "ledger_ready": bool(ledger_ready),
        "kpi": {
            "total_rows": len(rows),
            "matched_count": len(matched),
            "unmatched_count": len(unmatched),
            "total_diff_amount": round(total_diff, 2),
            "type_a_count": type_counts["A"],
            "type_b_count": type_counts["B"],
            "type_c_count": type_counts["C"],
            "type_d_count": type_counts["D"],
        },
        "hint": None
        if ledger_ready and dwd_ready
        else "请先导入财务账表并完成 ODS→DWD 构建后再核对。",
    }


def api_reconcile_diff_summary(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    _ensure_runtime(conn)
    rows = _build_reconcile_rows(conn, batch_id=batch_id, stat_year=stat_year, entity_id=entity_id)
    summary: dict[str, dict[str, Any]] = {}
    for code in ("A", "B", "C", "D"):
        summary[code] = {"count": 0, "diff_amount": 0.0}
    for r in rows:
        dt = r["diff_type"]
        if dt not in summary:
            continue
        summary[dt]["count"] += 1
        summary[dt]["diff_amount"] = round(summary[dt]["diff_amount"] + abs(r["diff_amount"]), 2)
    explained = sum(1 for r in rows if r["diff_type"] == "MATCH")
    pending = sum(1 for r in rows if r["status"] == "待跟踪")
    return {
        "ok": True,
        "batch_id": batch_id,
        "kpi": {
            "diff_count": sum(summary[c]["count"] for c in ("A", "B", "C", "D")),
            "diff_amount_total": round(sum(summary[c]["diff_amount"] for c in ("A", "B", "C", "D")), 2),
            "explained_count": explained,
            "pending_count": pending,
        },
        "by_type": summary,
    }


_FIN_DIFF_CSV_HEADERS = [
    "差异编号",
    "批次",
    "主体税号",
    "主体名称",
    "统计年度",
    "统计月份",
    "方向",
    "科目编码",
    "科目名称",
    "账表金额",
    "发票净额",
    "差异金额",
    "差异类型",
    "状态",
]


def export_finance_reconcile_csv_bytes(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None = None,
    max_rows: int = 5000,
) -> tuple[bytes | None, int]:
    """导出财务账票核对差异 CSV（仅非 MATCH 行），无数据时返回 (None, 0)。"""
    import csv
    import io

    try:
        _ensure_runtime(conn)
        if not _table_exists(conn, "dm_finance_ledger"):
            return None, 0
        rows = _build_reconcile_rows(
            conn, batch_id=None, stat_year=stat_year, entity_id=entity_id
        )
        diff_rows = [r for r in rows if str(r.get("diff_type") or "") != "MATCH"]
        if not diff_rows:
            return None, 0
        lim = max(1, min(int(max_rows or 5000), 20000))
        diff_rows = diff_rows[:lim]
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(_FIN_DIFF_CSV_HEADERS)
        for r in diff_rows:
            month = r.get("stat_month")
            writer.writerow(
                [
                    str(r.get("diff_id") or ""),
                    str(r.get("batch_id") or ""),
                    str(r.get("tax_id") or ""),
                    str(r.get("entity_name") or ""),
                    str(r.get("stat_year") or ""),
                    str(month) if month is not None else "",
                    str(r.get("role_type") or ""),
                    str(r.get("subject_code") or ""),
                    str(r.get("subject_name") or ""),
                    f"{float(r['ledger_amount']):.2f}" if r.get("ledger_amount") is not None else "",
                    f"{float(r['invoice_net']):.2f}" if r.get("invoice_net") is not None else "",
                    f"{float(r['diff_amount']):.2f}" if r.get("diff_amount") is not None else "",
                    str(r.get("diff_type") or ""),
                    str(r.get("status") or ""),
                ]
            )
        return buf.getvalue().encode("utf-8-sig"), len(diff_rows)
    except Exception:
        return None, 0


def api_reconcile_details(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
    entity_id: str | None = None,
    diff_type: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    _ensure_runtime(conn)
    rows = _build_reconcile_rows(conn, batch_id=batch_id, stat_year=stat_year, entity_id=entity_id)
    dt_filter = (diff_type or "").strip().upper()
    if dt_filter and dt_filter != "ALL":
        rows = [r for r in rows if r["diff_type"] == dt_filter]
    total = len(rows)
    off = max(0, int(offset))
    lim = max(1, min(500, int(limit)))
    page = rows[off : off + lim]
    return {
        "ok": True,
        "batch_id": batch_id,
        "total": total,
        "offset": off,
        "limit": lim,
        "rows": page,
    }


# 差异类型 → 审计规则（与 config/audit_rules.yaml 中 RULE-FIN-* 对应）
_FIN_DIFF_RULE_MAP: dict[str, str] = {
    "A": "RULE-FIN-INVOICE-ONLY",
    "B": "RULE-FIN-LEDGER-ONLY",
    "C": "RULE-FIN-DIFF",
    "D": "RULE-FIN-OTHER",
}
_FIN_RULE_IDS: tuple[str, ...] = tuple(_FIN_DIFF_RULE_MAP.values())
_FIN_FLAG_TYPES: dict[str, str] = {
    "A": "账票核对",
    "B": "账票核对",
    "C": "账票核对",
    "D": "账票核对",
}


def _period_label(year: int, month: int | None) -> str:
    if month is None or month <= 0:
        return f"{year} 年度"
    return f"{year}-{month:02d}"


def _fin_flag_description(row: dict[str, Any]) -> str:
    dt = str(row.get("diff_type") or "")
    period = _period_label(int(row["stat_year"]), row.get("stat_month"))
    role = str(row.get("role_type") or "")
    subject = str(row.get("subject_name") or row.get("subject_code") or "").strip()
    ledger = row.get("ledger_amount")
    invoice = row.get("invoice_net")
    diff = row.get("diff_amount")
    parts = [f"财务账票核对差异（{dt}）", f"期间 {period}"]
    if role:
        parts.append(f"方向 {role}")
    if subject:
        parts.append(f"科目 {subject}")
    if ledger is not None:
        parts.append(f"账表 {_decimal_float(ledger):,.2f}")
    if invoice is not None:
        parts.append(f"发票净额 {_decimal_float(invoice):,.2f}")
    parts.append(f"差异 {_decimal_float(diff):,.2f}")
    return "；".join(parts)


def _fin_flag_suggestion(diff_type: str) -> str:
    if diff_type == "C":
        return "核对账表入账与发票明细，确认是否存在时间性差异、科目映射错误或漏开票"
    if diff_type == "B":
        return "核实账面记录是否有对应发票或属于无票支出/预提，必要时补录或调整"
    if diff_type == "A":
        return "核实发票是否已入账、是否归属其他科目或期间，必要时补账或说明"
    return "复核主体识别与期间口径，人工归类后跟踪"


def _fin_flag_detail_json(row: dict[str, Any], *, batch_id: str | None) -> str:
    import json

    year = int(row["stat_year"])
    diff_type = str(row.get("diff_type") or "")
    return json.dumps(
        {
            "stat_year": year,
            "entity_id": str(row.get("tax_id") or ""),
            "batch_id": str(row.get("batch_id") or batch_id or ""),
            "diff_type": diff_type,
            "stat_month": row.get("stat_month"),
            "role_type": str(row.get("role_type") or ""),
            "subject_code": str(row.get("subject_code") or ""),
            "ledger_amount": _decimal_float(row.get("ledger_amount")),
            "invoice_net": _decimal_float(row.get("invoice_net")),
            "diff_amount": _decimal_float(row.get("diff_amount")),
            "rule_subtype": "finance_reconcile",
        },
        ensure_ascii=False,
    )


def sync_finance_reconcile_flags(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
    entity_id: str | None = None,
    include_types: tuple[str, ...] = ("A", "B", "C", "D"),
) -> dict[str, Any]:
    """
    将财务核对差异行同步至 dm_audit_flag（RULE-FIN-*）。

    重同步时仅删除未确认疑点，已确认记录保留（与 audit engine 一致）。
    """
    import logging

    from src.audit.config_loader import group_id_for_year, load_audit_rules_config

    logger = logging.getLogger(__name__)
    _ensure_runtime(conn)

    rows = _build_reconcile_rows(
        conn, batch_id=batch_id, stat_year=stat_year, entity_id=entity_id
    )
    diff_rows = [r for r in rows if r.get("diff_type") in include_types]
    analysis_batch = f"finance_reconcile_{batch_id or 'all'}"
    current_ids = {str(r["diff_id"]) for r in diff_rows}

    try:
        if not _table_exists(conn, "dm_audit_flag"):
            return {
                "ok": False,
                "inserted": 0,
                "skipped_confirmed": 0,
                "deleted": 0,
                "by_rule": {},
                "error": {"message": "dm_audit_flag 表不存在", "exception_type": "SchemaError"},
            }

        placeholders = ", ".join("?" for _ in _FIN_RULE_IDS)
        if current_ids:
            id_ph = ", ".join("?" for _ in current_ids)
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE analysis_batch = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                  AND flag_id NOT IN ({id_ph})
                """,
                [analysis_batch, *_FIN_RULE_IDS, *current_ids],
            )
        else:
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE analysis_batch = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                """,
                [analysis_batch, *_FIN_RULE_IDS],
            )
    except Exception as exc:
        logger.exception("cleanup finance reconcile flags")
        return {
            "ok": False,
            "inserted": 0,
            "skipped_confirmed": 0,
            "deleted": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }

    cfg = load_audit_rules_config()
    rules_cfg = cfg.get("rules") if isinstance(cfg, dict) else {}
    inserted = 0
    skipped_confirmed = 0
    by_rule: dict[str, int] = {rid: 0 for rid in _FIN_RULE_IDS}

    for row in diff_rows:
        diff_type = str(row.get("diff_type") or "")
        rule_id = _FIN_DIFF_RULE_MAP.get(diff_type)
        if not rule_id:
            continue
        flag_id = str(row["diff_id"])
        try:
            existing = conn.execute(
                "SELECT COALESCE(is_confirmed, FALSE) FROM dm_audit_flag WHERE flag_id = ?",
                [flag_id],
            ).fetchone()
            if existing and bool(existing[0]):
                skipped_confirmed += 1
                continue
        except Exception:
            logger.exception("check confirmed flag %s", flag_id)

        year = int(row["stat_year"])
        gid = group_id_for_year(year)
        rc = rules_cfg.get(rule_id, {}) if isinstance(rules_cfg, dict) else {}
        risk_level = str(rc.get("risk_level") or "中风险")
        tax_id = str(row.get("tax_id") or "")
        entity_name = str(row.get("entity_name") or tax_id)
        amount = abs(float(row.get("diff_amount") or 0))

        detail_json = _fin_flag_detail_json(row, batch_id=batch_id)
        try:
            conn.execute(
                """
                INSERT INTO dm_audit_flag (
                    flag_id, rule_id, risk_level, flag_type, group_id,
                    entity_id, entity_name, amount, description, suggestion,
                    is_confirmed, analysis_batch, detail_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)
                ON CONFLICT (flag_id) DO UPDATE SET
                    rule_id = excluded.rule_id,
                    risk_level = excluded.risk_level,
                    flag_type = excluded.flag_type,
                    entity_name = excluded.entity_name,
                    amount = excluded.amount,
                    description = excluded.description,
                    suggestion = excluded.suggestion,
                    analysis_batch = excluded.analysis_batch,
                    detail_json = excluded.detail_json
                """,
                [
                    flag_id,
                    rule_id,
                    risk_level,
                    _FIN_FLAG_TYPES.get(diff_type, "账票核对"),
                    gid,
                    tax_id,
                    entity_name,
                    amount,
                    _fin_flag_description(row),
                    _fin_flag_suggestion(diff_type),
                    analysis_batch,
                    detail_json,
                ],
            )
            inserted += 1
            by_rule[rule_id] = by_rule.get(rule_id, 0) + 1
        except Exception:
            logger.exception("insert finance reconcile flag %s", flag_id)

    return {
        "ok": True,
        "batch_id": batch_id,
        "stat_year": stat_year,
        "analysis_batch": analysis_batch,
        "diff_count": len(diff_rows),
        "inserted": inserted,
        "skipped_confirmed": skipped_confirmed,
        "by_rule": by_rule,
    }


def api_reconcile_sync_flags(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    try:
        return sync_finance_reconcile_flags(
            conn,
            batch_id=batch_id,
            stat_year=stat_year,
            entity_id=entity_id,
        )
    except Exception as exc:
        return {
            "ok": False,
            "inserted": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
