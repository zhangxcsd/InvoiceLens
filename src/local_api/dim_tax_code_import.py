"""
税收分类编码 dim_tax_code 全量导入（商品和服务税收分类编码表）。

- 与前端「编码库管理」页一致：支持仓库相对路径或 multipart 上传 xls/xlsx/csv。
- 正文读取：跳过前 2 行，从第 3 行起为数据（与页面说明一致）。
- 列位次与 config/ddl/dim.sql 注释对齐：0–10 为篇…细目共 11 列，11 为合并编码，12–14 为名称/简称/说明。
"""

from __future__ import annotations

import io
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.local_api.dim_tax_code_risk_rules import (
    audit_risk_label_for_row,
    invalidate_risk_config_cache,
    load_dim_tax_code_risk_config,
)

_INIT_LOCK = threading.Lock()


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _norm_cell(v: Any) -> str | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip()
    if not s or s.lower() in {"nan", "none", "nat", "<na>"}:
        return None
    return s


def _digits_tax_code(raw: Any) -> str | None:
    s = _norm_cell(raw)
    if not s:
        return None
    digits = "".join(ch for ch in s if ch.isdigit())
    if not digits:
        return None
    if len(digits) > 19:
        digits = digits[-19:]
    digits = digits.zfill(19)
    if len(digits) != 19:
        return None
    return digits


def tax_segments(code: str) -> list[str]:
    d = _digits_tax_code(code)
    if not d:
        return []
    return [d[0:1]] + [d[i : i + 2] for i in range(1, 19, 2)]


def parent_merged_code(code: str) -> str | None:
    segs = tax_segments(code)
    if len(segs) != 10:
        return None
    k = -1
    for i in range(9, -1, -1):
        if i == 0:
            if segs[0] and segs[0] != "0":
                k = i
                break
        elif segs[i] and segs[i] != "00":
            k = i
            break
    if k <= 0:
        return None
    new_segs = list(segs)
    if k == 0:
        new_segs[0] = "0"
    else:
        new_segs[k] = "00"
    for j in range(k + 1, 10):
        new_segs[j] = "00"
    return new_segs[0] + "".join(new_segs[1:])


def level_depth_from_merged(code: str) -> int:
    segs = tax_segments(code)
    if len(segs) != 10:
        return 0
    for i in range(9, -1, -1):
        if i == 0:
            if segs[0] and segs[0] != "0":
                return i + 1
        elif segs[i] and segs[i] != "00":
            return i + 1
    return 0


def _resolve_source_path(rel_or_abs: str) -> Path:
    raw = (rel_or_abs or "").strip().strip('"').replace("\\", "/")
    if not raw:
        raise ValueError("source_path 为空")
    p = Path(raw)
    if not p.is_absolute():
        p = (_project_root() / raw).resolve()
    root = _project_root().resolve()
    try:
        p.relative_to(root)
    except ValueError as exc:
        raise ValueError("source_path 必须位于项目根目录之下") from exc
    if not p.is_file():
        raise FileNotFoundError(f"找不到文件：{p}")
    return p


def _read_frame(path: Path | None, file_bytes: bytes | None, upload_filename: str | None) -> tuple[pd.DataFrame, str]:
    """返回 (DataFrame, sheet 名或 'csv')。"""
    if file_bytes is not None:
        fn = (upload_filename or "upload.bin").lower()
        bio = io.BytesIO(file_bytes)
        if fn.endswith(".csv"):
            df = pd.read_csv(bio, header=None, dtype=str, skiprows=2)
            return df, "csv"
        engine = "xlrd" if fn.endswith(".xls") else "openpyxl"
        xls = pd.ExcelFile(bio, engine=engine)
        sheet = xls.sheet_names[0]
        df = pd.read_excel(xls, sheet_name=sheet, header=None, dtype=str, skiprows=2)
        return df, sheet
    assert path is not None
    suf = path.suffix.lower()
    if suf == ".csv":
        df = pd.read_csv(path, header=None, dtype=str, skiprows=2)
        return df, "csv"
    engine = "xlrd" if suf == ".xls" else "openpyxl"
    xls = pd.ExcelFile(path, engine=engine)
    sheet = xls.sheet_names[0]
    df = pd.read_excel(path, sheet_name=sheet, header=None, dtype=str, skiprows=2)
    return df, sheet


def _ensure_dim_tax_code_schema(conn) -> None:
    """
    兼容旧库：若 dim_tax_code 缺少新版治理字段，按需补列。
    DuckDB 的 CREATE TABLE IF NOT EXISTS 不会自动补齐新增列。
    """
    required_cols: list[tuple[str, str]] = [
        ("level_depth", "TINYINT"),
        ("is_leaf", "BOOLEAN"),
        ("parent_code", "VARCHAR"),
        ("full_path", "TEXT"),
        ("data_version", "VARCHAR"),
        ("clean_status", "VARCHAR"),
        ("audit_risk_label", "VARCHAR DEFAULT 'NORMAL'"),
        ("import_batch_id", "VARCHAR"),
        ("import_session_id", "VARCHAR"),
        ("ods_file_seq", "INTEGER"),
        ("source_excel_file", "VARCHAR"),
        ("source_parquet_file", "VARCHAR"),
        ("source_sheet", "VARCHAR"),
        ("ingest_ts", "TIMESTAMP"),
        ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
    ]
    existing = {
        str(r[0]).lower()
        for r in conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='main' AND table_name='dim_tax_code'"
        ).fetchall()
    }
    for col, ddl in required_cols:
        if col.lower() in existing:
            continue
        conn.execute(f"ALTER TABLE dim_tax_code ADD COLUMN {col} {ddl}")
        existing.add(col.lower())


def _prepare_dim_tax_runtime(conn) -> None:
    """
    读写接口共用的初始化入口：
    - 进程内串行，避免 ThreadingHTTPServer 并发触发 DDL/VIEW 变更冲突；
    - 对 DuckDB 的 write-write conflict 做短暂重试。
    """
    with _INIT_LOCK:
        last_exc: Exception | None = None
        for i in range(5):
            try:
                init_all_tables(conn)
                _ensure_dim_tax_code_schema(conn)
                return
            except Exception as exc:  # noqa: BLE001
                msg = str(exc).lower()
                if "write-write conflict" not in msg and "transactioncontext error" not in msg:
                    raise
                last_exc = exc
                time.sleep(0.05 * (i + 1))
        assert last_exc is not None
        raise last_exc


def parse_dim_tax_rows(df: pd.DataFrame, *, data_version: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """解析为可写入 dim_tax_code 的行字典列表与统计。"""
    if df.shape[1] < 15:
        raise ValueError(f"列数不足（至少需要 15 列，当前 {df.shape[1]}）")

    stats: dict[str, Any] = {
        "source_rows": int(len(df)),
        "parsed_codes": 0,
        "invalid_code_rows": 0,
        "duplicate_rows": 0,
    }

    by_code: dict[str, int] = {}
    acc: list[dict[str, Any]] = []

    for _, row in df.iterrows():
        raw_code = row.iloc[11] if len(row) > 11 else None
        code = _digits_tax_code(raw_code)
        if not code:
            continue
        stats["parsed_codes"] += 1

        gname = _norm_cell(row.iloc[12]) if len(row) > 12 else None
        gshort = _norm_cell(row.iloc[13]) if len(row) > 13 else None
        desc = _norm_cell(row.iloc[14]) if len(row) > 14 else None
        levels = [_norm_cell(row.iloc[i]) if len(row) > i else None for i in range(11)]

        invalid = len(code) != 19 or not code.isdigit()
        parent = parent_merged_code(code)
        depth = level_depth_from_merged(code)

        clean: str | None
        if code in by_code:
            stats["duplicate_rows"] += 1
            acc[by_code[code]]["clean_status"] = "分类编码重复"
            clean = "分类编码重复"
        elif invalid:
            clean = "分类编码有误"
            stats["invalid_code_rows"] += 1
            by_code[code] = len(acc)
        else:
            clean = None
            by_code[code] = len(acc)

        acc.append(
            {
                "tax_code": code,
                "goods_name": gname,
                "goods_short_name": gshort,
                "description": desc,
                "level_pian": levels[0],
                "level_lei": levels[1],
                "level_zhang": levels[2],
                "level_jie": levels[3],
                "level_tiao": levels[4],
                "level_kuan": levels[5],
                "level_xiang": levels[6],
                "level_mu": levels[7],
                "level_zimu": levels[8],
                "level_ximu": levels[9],
                "clean_status": clean,
                "parent_code": parent,
                "level_depth": depth,
            }
        )

    code_to_row = {r["tax_code"]: r for r in acc}

    def label_for(c: str) -> str:
        r = code_to_row.get(c)
        return (r.get("goods_name") if r else None) or c

    def full_path(code: str) -> str:
        parts: list[str] = []
        cur: str | None = code
        seen: set[str] = set()
        while cur and cur not in seen:
            seen.add(cur)
            parts.append(label_for(cur))
            row = code_to_row.get(cur)
            parent = row.get("parent_code") if row else None
            cur = parent
        return " > ".join(reversed(parts))

    parents_referenced = {r.get("parent_code") for r in acc if r.get("parent_code")}

    cfg = load_dim_tax_code_risk_config()
    for r in acc:
        r["full_path"] = full_path(r["tax_code"])
        r["is_leaf"] = r["tax_code"] not in parents_referenced
        r["data_version"] = data_version
        r["audit_risk_label"] = audit_risk_label_for_row(
            tax_code=r["tax_code"],
            goods_name=r.get("goods_name"),
            goods_short_name=r.get("goods_short_name"),
            full_path=r.get("full_path"),
            cfg=cfg,
        )

    stats["insert_rows"] = len(acc)
    return acc, stats


def run_dim_tax_code_import(
    *,
    data_version: str,
    source_path: str,
    strategy: str,
    file_bytes: bytes | None = None,
    upload_filename: str | None = None,
) -> dict[str, Any]:
    """
    执行导入。strategy: full_rebuild | dry_run
    返回 dict 含 ok、message、stats、received 等，供 HTTP 层原样 JSON 输出。
    """
    path: Path | None = None
    if file_bytes is None and source_path.strip():
        path = _resolve_source_path(source_path)

    try:
        df, sheet = _read_frame(path, file_bytes, upload_filename)
    except Exception as exc:
        return {
            "ok": False,
            "implemented": True,
            "message": f"读取源文件失败：{type(exc).__name__}: {exc}",
            "error": {"message": str(exc)},
        }

    src_label = str(path) if path else (upload_filename or "upload")
    batch_id = f"BATCH_DIM_TAX_{datetime.now(timezone.utc).strftime('%Y%m%d')}_{uuid.uuid4().hex[:8]}"
    session_id = f"SID_DIM_{uuid.uuid4().hex[:10]}"
    ingest_ts = datetime.now(timezone.utc).replace(tzinfo=None)

    try:
        rows, stats = parse_dim_tax_rows(df, data_version=data_version)
    except Exception as exc:
        return {
            "ok": False,
            "implemented": True,
            "message": f"解析失败：{type(exc).__name__}: {exc}",
            "error": {"message": str(exc)},
        }

    if strategy.strip().lower() == "dry_run":
        return {
            "ok": True,
            "implemented": True,
            "dry_run": True,
            "message": (
                f"校验完成（未写入数据库）。源={src_label!r}，sheet={sheet!r}；"
                f"解析 {stats.get('parsed_codes', 0)} 条编码，"
                f"待写入 {stats.get('insert_rows', 0)} 行，"
                f"编码有误 {stats.get('invalid_code_rows', 0)}，重复 {stats.get('duplicate_rows', 0)}。"
            ),
            "stats": stats,
            "received": {
                "data_version": data_version,
                "source_path": source_path,
                "strategy": strategy,
                "upload_filename": upload_filename,
                "import_batch_id": batch_id,
                "import_session_id": session_id,
            },
        }

    conn = get_conn()
    _prepare_dim_tax_runtime(conn)

    insert_cols = """
        INSERT INTO dim_tax_code (
            tax_code, goods_name, goods_short_name, description,
            level_pian, level_lei, level_zhang, level_jie, level_tiao,
            level_kuan, level_xiang, level_mu, level_zimu, level_ximu,
            level_depth, is_leaf, parent_code, full_path,
            data_version, clean_status, audit_risk_label,
            import_batch_id, import_session_id, ods_file_seq,
            source_excel_file, source_parquet_file, source_sheet, ingest_ts
        )
    """

    try:
        conn.execute("BEGIN TRANSACTION")
        conn.execute("DELETE FROM dim_tax_code")
        bdf = pd.DataFrame(rows)
        bdf["import_batch_id"] = batch_id
        bdf["import_session_id"] = session_id
        bdf["source_excel_file"] = src_label if not upload_filename else f"upload:{upload_filename}"
        bdf["source_sheet"] = str(sheet)
        bdf["ingest_ts"] = ingest_ts
        conn.register("_dim_tax_stg", bdf)
        try:
            conn.execute(
                insert_cols
                + """
                SELECT
                  tax_code, goods_name, goods_short_name, description,
                  level_pian, level_lei, level_zhang, level_jie, level_tiao,
                  level_kuan, level_xiang, level_mu, level_zimu, level_ximu,
                  level_depth, is_leaf, parent_code, full_path,
                  data_version, clean_status, audit_risk_label,
                  import_batch_id, import_session_id,
                  CAST(NULL AS INTEGER),
                  source_excel_file, CAST(NULL AS VARCHAR), source_sheet,
                  CAST(ingest_ts AS TIMESTAMP)
                FROM _dim_tax_stg
                """
            )
        finally:
            try:
                conn.unregister("_dim_tax_stg")
            except Exception:
                pass
        conn.execute("COMMIT")
    except Exception as exc:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        return {
            "ok": False,
            "implemented": True,
            "message": f"写入 dim_tax_code 失败：{type(exc).__name__}: {exc}",
            "error": {"message": str(exc)},
            "stats": stats,
        }

    cnt = conn.execute("SELECT COUNT(*) FROM dim_tax_code").fetchone()[0]
    return {
        "ok": True,
        "implemented": True,
        "dry_run": False,
        "message": (
            f"已全量写入 dim_tax_code：共 {cnt} 行（DELETE 后 INSERT）。"
            f"批次 {batch_id}，会话 {session_id}。"
            f"解析统计：编码有误 {stats.get('invalid_code_rows', 0)}，重复 {stats.get('duplicate_rows', 0)}。"
        ),
        "stats": {**stats, "dim_tax_code_count": int(cnt)},
        "received": {
            "data_version": data_version,
            "source_path": source_path,
            "strategy": strategy,
            "upload_filename": upload_filename,
            "import_batch_id": batch_id,
            "import_session_id": session_id,
            "source_sheet": str(sheet),
        },
    }


def _map_clean_status_db_to_ui(raw: Any) -> str:
    if raw is None:
        return "ok"
    s = str(raw).strip()
    if not s:
        return "ok"
    if s == "分类编码有误":
        return "invalid"
    if s == "分类编码重复":
        return "duplicate"
    return "ok"


def _map_row_tuple(t: Any) -> dict[str, Any]:
    (
        tax_code,
        goods_name,
        goods_short_name,
        description,
        parent_code,
        level_depth,
        is_leaf,
        full_path,
        clean_status,
        audit_risk_label,
        data_version,
        import_batch_id,
        import_session_id,
        source_sheet,
        source_excel_file,
    ) = t
    risk = str(audit_risk_label or "NORMAL").strip().upper() or "NORMAL"
    if risk not in {"NORMAL", "HIGH"}:
        risk = "NORMAL"
    return {
        "taxCode": str(tax_code),
        "goodsName": goods_name if goods_name is not None else "",
        "goodsShortName": goods_short_name if goods_short_name is not None else "",
        "description": str(description or ""),
        "parentCode": str(parent_code) if parent_code not in (None, "") else None,
        "levelDepth": int(level_depth or 0),
        "isLeaf": bool(is_leaf) if is_leaf is not None else False,
        "fullPath": str(full_path or ""),
        "cleanStatus": _map_clean_status_db_to_ui(clean_status),
        "auditRiskLabel": risk,
        "dataVersion": str(data_version or ""),
        "importBatchId": str(import_batch_id or ""),
        "importSessionId": str(import_session_id or ""),
        "sourceSheet": str(source_sheet or ""),
        "sourceExcelFile": str(source_excel_file or ""),
    }


def api_list_dim_tax_code_rows(
    *,
    keyword: str = "",
    clean_status: str = "all",
    risk: str = "all",
    import_batch_id: str = "",
    import_session_id: str = "",
    abnormal_only: bool = False,
) -> dict[str, Any]:
    """供 GET /api/dim-tax-code/rows：按筛选条件返回 dim_tax_code 行（camelCase）。"""
    conn = get_conn()
    _prepare_dim_tax_runtime(conn)
    clauses: list[str] = ["1=1"]
    params: list[Any] = []

    kw = keyword.strip()
    if kw:
        like = f"%{kw}%"
        clauses.append(
            "(tax_code ILIKE ? OR coalesce(goods_name,'') ILIKE ? "
            "OR coalesce(goods_short_name,'') ILIKE ? OR coalesce(full_path,'') ILIKE ?)"
        )
        params.extend([like, like, like, like])

    cs = (clean_status or "all").strip().lower()
    if cs == "ok":
        clauses.append("(clean_status IS NULL OR trim(cast(clean_status AS VARCHAR)) = '')")
    elif cs == "invalid":
        clauses.append("clean_status = ?")
        params.append("分类编码有误")
    elif cs == "duplicate":
        clauses.append("clean_status = ?")
        params.append("分类编码重复")

    if abnormal_only:
        clauses.append("(clean_status IS NOT NULL AND trim(cast(clean_status AS VARCHAR)) <> '')")

    rk = (risk or "all").strip().upper()
    if rk == "HIGH":
        clauses.append("trim(coalesce(cast(audit_risk_label AS VARCHAR), '')) = 'HIGH'")
    elif rk == "NORMAL":
        clauses.append(
            "(audit_risk_label IS NULL OR trim(coalesce(cast(audit_risk_label AS VARCHAR), '')) IN ('', 'NORMAL'))"
        )

    batch_kw = (import_batch_id or "").strip()
    if batch_kw:
        clauses.append("coalesce(import_batch_id,'') ILIKE ?")
        params.append(f"%{batch_kw}%")

    session_kw = (import_session_id or "").strip()
    if session_kw:
        clauses.append("coalesce(import_session_id,'') ILIKE ?")
        params.append(f"%{session_kw}%")

    where_sql = " AND ".join(clauses)
    count_sql = f"SELECT COUNT(*) FROM dim_tax_code WHERE {where_sql}"
    total = int(conn.execute(count_sql, params).fetchone()[0])

    list_sql = (
        f"SELECT tax_code, goods_name, goods_short_name, description, parent_code, level_depth, is_leaf, "
        f"full_path, clean_status, audit_risk_label, data_version, import_batch_id, import_session_id, "
        f"source_sheet, source_excel_file FROM dim_tax_code WHERE {where_sql} ORDER BY tax_code LIMIT 50000"
    )
    raw_rows = conn.execute(list_sql, params).fetchall()
    rows = [_map_row_tuple(t) for t in raw_rows]
    return {"ok": True, "total": total, "rows": rows}


def api_list_dim_tax_code_filter_options(*, import_batch_id: str = "") -> dict[str, Any]:
    """供 GET /api/dim-tax-code/filter-options：返回批次与会话下拉选项。"""
    conn = get_conn()
    _prepare_dim_tax_runtime(conn)

    batch_rows = conn.execute(
        """
        SELECT DISTINCT trim(coalesce(import_batch_id, '')) AS v
        FROM dim_tax_code
        WHERE trim(coalesce(import_batch_id, '')) <> ''
        ORDER BY v DESC
        LIMIT 1000
        """
    ).fetchall()
    batch_options = [str(r[0]) for r in batch_rows if r and r[0] is not None]

    session_params: list[Any] = []
    session_where = "trim(coalesce(import_session_id, '')) <> ''"
    batch_kw = (import_batch_id or "").strip()
    if batch_kw:
        session_where += " AND trim(coalesce(import_batch_id, '')) = ?"
        session_params.append(batch_kw)
    session_rows = conn.execute(
        f"""
        SELECT DISTINCT trim(coalesce(import_session_id, '')) AS v
        FROM dim_tax_code
        WHERE {session_where}
        ORDER BY v DESC
        LIMIT 1000
        """,
        session_params,
    ).fetchall()
    session_options = [str(r[0]) for r in session_rows if r and r[0] is not None]
    return {"ok": True, "importBatchOptions": batch_options, "importSessionOptions": session_options}


def reapply_dim_tax_code_audit_risk_from_yaml() -> dict[str, Any]:
    """按当前 YAML 重算库中 audit_risk_label（不重新读 Excel）。"""
    invalidate_risk_config_cache()
    cfg = load_dim_tax_code_risk_config(force_reload=True)
    conn = get_conn()
    _prepare_dim_tax_runtime(conn)
    try:
        conn.execute("BEGIN TRANSACTION")
        cur = conn.execute(
            "SELECT tax_code, goods_name, goods_short_name, full_path FROM dim_tax_code"
        )
        n = 0
        for tax_code, gn, gs, fp in cur.fetchall():
            lab = audit_risk_label_for_row(
                tax_code=str(tax_code),
                goods_name=gn,
                goods_short_name=gs,
                full_path=fp,
                cfg=cfg,
            )
            conn.execute(
                "UPDATE dim_tax_code SET audit_risk_label = ?, updated_at = CURRENT_TIMESTAMP WHERE tax_code = ?",
                [lab, str(tax_code)],
            )
            n += 1
        conn.execute("COMMIT")
        return {
            "ok": True,
            "message": f"已按 config/dim_tax_code_risk_rules.yaml 更新 {n} 行的 audit_risk_label。",
            "stats": {"rows_updated": n},
        }
    except Exception as exc:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        return {
            "ok": False,
            "message": f"重算风险标签失败：{type(exc).__name__}: {exc}",
            "error": {"message": str(exc)},
        }
