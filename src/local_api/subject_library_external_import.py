from __future__ import annotations

import io
import logging
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

from src.local_api.subject_library_dwd_ingest import (
    _source_record_id,
    _stable_subject_id,
    _subject_no_type,
)
from src.local_api.subject_library_manual_guard import (
    load_repaired_field_map,
    resolve_org_category_for_upsert,
    resolve_subject_category_for_upsert,
)
from src.subject_category.infer import normalize_party_name, subject_category_for_ingest
from src.subject_category.recompute import _make_run_id

logger = logging.getLogger(__name__)


def _norm_header(s: str) -> str:
    return re.sub(r"\s+", "", str(s or "").strip().lower())


def _pick_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    norm_map: dict[str, str] = {}
    for c in df.columns:
        k = _norm_header(str(c))
        if k and k not in norm_map:
            norm_map[k] = str(c)
    for cand in candidates:
        key = _norm_header(cand)
        if key in norm_map:
            return norm_map[key]
    return None


def _parse_subject_type_cell(raw: str) -> str:
    v = str(raw or "").strip().lower()
    if v in {"person", "个人", "自然人", "natural"}:
        return "person"
    if v in {"org", "enterprise", "企业", "组织机构", "组织", "单位"}:
        return "org"
    return ""


def _parse_org_category(raw: str, subject_category: str) -> str:
    s = str(raw or "").strip().upper()
    if s and re.match(r"^SC-[A-Z0-9_-]+$", s):
        return s
    if subject_category == "person":
        return "SC-TEMP" if not s else s
    return "SC-ENT"


def api_import_external_subjects_from_file(
    conn,
    *,
    file_bytes: bytes,
    filename: str,
    snapshot_year: str = "",
) -> dict[str, Any]:
    """
    将上传的 CSV / Excel 解析后写入 dim_subject_master（及 dim_subject_source_record）。
    - 文件级失败：ok=False 且 file_blocking=True。
    - 行级失败：跳过该行，记录 reject_row_samples。
    """
    from db.schema_sqlfiles import init_all_tables

    init_all_tables(conn)
    fname = Path(filename or "upload").name
    reject_samples: list[dict[str, Any]] = []

    def add_reject(seq: int | str, sheet: str, field: str, reason: str, exc_type: str) -> None:
        reject_samples.append(
            {
                "seq_no": seq,
                "sheet": sheet,
                "field": field,
                "reason": reason,
                "exception_type": exc_type,
            }
        )

    if not file_bytes:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {"message": "上传文件为空"},
            "reject_row_samples": [],
        }

    ext = Path(fname).suffix.lower()
    sheet_label = Path(fname).stem or "upload"
    df: pd.DataFrame | None = None
    try:
        if ext == ".csv":
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding="utf-8-sig")
        elif ext in {".xlsx", ".xlsm"}:
            df = pd.read_excel(io.BytesIO(file_bytes), dtype=str, engine="openpyxl")
        elif ext == ".xls":
            df = pd.read_excel(io.BytesIO(file_bytes), dtype=str, engine="xlrd")
        else:
            return {
                "ok": False,
                "file_blocking": True,
                "error": {"message": "仅支持 .csv / .xlsx / .xlsm / .xls"},
                "reject_row_samples": [],
            }
    except Exception as exc:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {
                "message": f"无法打开或解析文件：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
            "reject_row_samples": [],
        }

    if df is None or df.empty or len(df.columns) == 0:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {"message": "文件无表头或无数据行"},
            "reject_row_samples": [],
        }

    col_name = _pick_column(
        df,
        [
            "主体名称",
            "企业名称",
            "名称",
            "纳税人名称",
            "subject_name",
            "enterprise_name",
        ],
    )
    col_no = _pick_column(
        df,
        [
            "纳税人识别号",
            "统一社会信用代码",
            "税号",
            "主体识别号",
            "subject_no",
            "taxpayer_id",
            "uscc",
        ],
    )
    col_type = _pick_column(df, ["主体类型", "subject_type"])
    col_org_cat = _pick_column(df, ["主体类别编码", "org_category", "subject_category_code", "类别编码"])
    col_seq = _pick_column(df, ["序号", "seq", "seq_no", "行号"])

    if not col_name:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {
                "message": "未识别到主体名称列，请包含表头：主体名称 / 企业名称 / subject_name 之一",
            },
            "reject_row_samples": [],
        }

    year = (snapshot_year or "").strip()
    if year and (not year.isdigit() or len(year) != 4):
        year = ""
    run_id = _make_run_id("subject_ext_import")
    batch_tag = f"EXT_{datetime.now().strftime('%Y%m%d')}_{int(time.time()) % 1_000_000:06d}"
    session_tag = f"ext_{int(time.time())}_{Path(fname).stem[:40]}"
    snapshot_id = f"EXT_SNAP_{year or datetime.now().strftime('%Y')}_{batch_tag[-6:]}"

    rows_out: list[dict[str, Any]] = []
    for i, row in df.iterrows():
        excel_row = int(i) + 2 if isinstance(i, (int, float)) else 2
        seq_cell = ""
        try:
            if col_seq is not None:
                v = row.get(col_seq)
                seq_cell = str(v).strip() if v is not None and str(v).strip() not in {"", "nan"} else ""
        except Exception:
            seq_cell = ""
        seq_display = seq_cell or str(excel_row)

        try:
            raw_name = row.get(col_name)
            name = str(raw_name or "").strip()
            if name in {"", "nan", "None"}:
                add_reject(seq_display, sheet_label, col_name or "", "主体名称为空", "ValueError")
                continue

            raw_no = ""
            if col_no is not None:
                nv = row.get(col_no)
                raw_no = str(nv or "").strip()
                if raw_no in {"nan", "None"}:
                    raw_no = ""
                raw_no = re.sub(r"[\s-]+", "", raw_no)

            st_raw = ""
            if col_type is not None:
                st_raw = str(row.get(col_type) or "").strip()
            st = _parse_subject_type_cell(st_raw)
            if not st:
                st = subject_category_for_ingest(raw_no)

            org_cat_raw = ""
            if col_org_cat is not None:
                org_cat_raw = str(row.get(col_org_cat) or "").strip()
            org_cat = _parse_org_category(org_cat_raw, st)

            sid = _stable_subject_id(raw_no, normalize_party_name(name) or name)
            if not sid:
                add_reject(
                    seq_display,
                    sheet_label,
                    "subject_id",
                    "无法生成稳定主体 ID（名称与识别号均为空）",
                    "ValueError",
                )
                continue

            rows_out.append(
                {
                    "subject_id": sid,
                    "subject_name": name,
                    "subject_no": raw_no,
                    "subject_category": st,
                    "org_category": org_cat,
                    "seq_display": seq_display,
                    "excel_row": excel_row,
                }
            )
        except Exception as exc:
            add_reject(seq_display, sheet_label, "", f"行解析失败：{exc}", type(exc).__name__)
            continue

    if not rows_out:
        return {
            "ok": False,
            "file_blocking": False,
            "error": {"message": "无有效数据行可导入（请检查表头与内容）"},
            "reject_row_samples": reject_samples[:50],
            "subjects_upserted": 0,
        }

    ids = list({r["subject_id"] for r in rows_out})
    repair_map = load_repaired_field_map(conn)
    preserve: dict[str, dict[str, Any]] = {}
    existing_created: dict[str, datetime] = {}
    chunk = 400
    for j in range(0, len(ids), chunk):
        part = ids[j : j + chunk]
        ph = ",".join(["?"] * len(part))
        try:
            for erow in conn.execute(
                f"""
                SELECT
                    subject_id,
                    created_at,
                    first_source_system,
                    first_import_batch_id,
                    first_import_session_id,
                    subject_category,
                    org_category,
                    subject_snapshot_id,
                    category_rule_version,
                    category_rule_enabled_at_run,
                    category_status_note,
                    quality_status,
                    quality_issue
                FROM dim_subject_master
                WHERE subject_id IN ({ph})
                """,
                part,
            ).fetchall():
                sid = str(erow[0] or "")
                ca = erow[1]
                now0 = datetime.now()
                existing_created[sid] = ca if isinstance(ca, datetime) else now0
                preserve[sid] = {
                    "first_source_system": str(erow[2] or ""),
                    "first_import_batch_id": str(erow[3] or ""),
                    "first_import_session_id": str(erow[4] or ""),
                    "subject_category_existing": erow[5],
                    "org_category_existing": erow[6],
                    "subject_snapshot_id": erow[7],
                    "category_rule_version": erow[8],
                    "category_rule_enabled_at_run": erow[9] if erow[9] is not None else True,
                    "category_status_note": erow[10],
                    "quality_status": erow[11] or "ok",
                    "quality_issue": erow[12],
                }
        except Exception as exc:
            return {
                "ok": False,
                "file_blocking": True,
                "error": {
                    "message": f"查询已有主体失败：{type(exc).__name__}: {exc}",
                    "exception_type": type(exc).__name__,
                },
                "reject_row_samples": reject_samples[:50],
            }

    last_by_id: dict[str, dict[str, Any]] = {}
    for r in rows_out:
        last_by_id[r["subject_id"]] = r

    master_tuples: list[tuple[Any, ...]] = []
    now = datetime.now()
    for sid, r in last_by_id.items():
        pr = preserve.get(sid, {})
        created = existing_created.get(sid, now)
        prev_raw = str(pr.get("first_source_system") or "").strip()
        prev_lower = prev_raw.lower()
        existed_in_master = sid in preserve

        # 仅「纯外部新建」写 external；已存在主体时须保留 invoice/manual，避免把平台侧误打成 external。
        if prev_lower == "invoice":
            first_sys = "invoice"
            first_bid = str(pr.get("first_import_batch_id") or "")
            first_sid = str(pr.get("first_import_session_id") or "")
        elif prev_lower == "manual":
            first_sys = "manual"
            first_bid = str(pr.get("first_import_batch_id") or "")
            first_sid = str(pr.get("first_import_session_id") or "")
        elif prev_lower == "external":
            first_sys = "external"
            first_bid = str(pr.get("first_import_batch_id") or "") or batch_tag
            first_sid = str(pr.get("first_import_session_id") or "") or session_tag
        elif prev_lower == "platform":
            # 历史或脚本曾写入 platform，与 invoice 同档
            first_sys = "invoice"
            first_bid = str(pr.get("first_import_batch_id") or "")
            first_sid = str(pr.get("first_import_session_id") or "")
        elif existed_in_master and prev_raw == "":
            # 库内已有行但 first_source_system 为空：多为发票归集前迁移数据，勿用外部导入覆盖为 external
            first_sys = "invoice"
            first_bid = str(pr.get("first_import_batch_id") or "")
            first_sid = str(pr.get("first_import_session_id") or "")
        else:
            first_sys = "external"
            first_bid = str(pr.get("first_import_batch_id") or "") or batch_tag
            first_sid = str(pr.get("first_import_session_id") or "") or session_tag

        org_incoming = str(r["org_category"])
        if (
            prev_lower in ("invoice", "manual", "platform") or (existed_in_master and prev_raw == "")
        ) and pr.get("org_category_existing"):
            org_incoming = str(pr.get("org_category_existing") or org_incoming)

        subj_cat = resolve_subject_category_for_upsert(
            subject_id=sid,
            incoming_category=str(r["subject_category"]),
            existing_category=str(pr.get("subject_category_existing") or "") or None,
            repair_map=repair_map,
            respect_manual_repairs=True,
        )
        org_resolved = resolve_org_category_for_upsert(
            subject_id=sid,
            incoming_org_category=org_incoming,
            existing_org_category=pr.get("org_category_existing"),
            repair_map=repair_map,
            respect_manual_repairs=True,
        )
        org_use = org_incoming if org_resolved is None else org_resolved

        snap_use = str(pr.get("subject_snapshot_id") or "") or snapshot_id
        if year and year not in snap_use:
            snap_use = f"{snap_use}_{year}"

        sub_no = str(r["subject_no"] or "") or None
        no_type = _subject_no_type(sub_no) if sub_no else None
        name_std = normalize_party_name(str(r["subject_name"])) or ""

        master_tuples.append(
            (
                sid,
                str(r["subject_name"]),
                name_std,
                subj_cat,
                org_use,
                sub_no,
                no_type,
                "single",
                first_sys,
                first_bid,
                first_sid,
                batch_tag,
                session_tag,
                str(pr.get("quality_status") or "ok"),
                pr.get("quality_issue"),
                run_id,
                snap_use,
                pr.get("category_rule_version"),
                bool(pr.get("category_rule_enabled_at_run", True)),
                pr.get("category_status_note"),
                created,
                now,
            )
        )

    src_tuples: list[tuple[Any, ...]] = []
    for r in rows_out:
        sid = str(r["subject_id"])
        rule = "external_file_row"
        src_id = _source_record_id(sid, f"{rule}_{batch_tag}_{r['seq_display']}_{r['excel_row']}")
        src_tuples.append(
            (
                src_id,
                sid,
                "external",
                batch_tag,
                session_tag,
                None,
                fname,
                None,
                sheet_label,
                int(r["excel_row"]) if isinstance(r.get("excel_row"), int) else None,
                str(r["subject_name"]),
                str(r["subject_no"] or ""),
                _subject_no_type(str(r["subject_no"] or "")) if str(r["subject_no"] or "") else None,
                str(r["subject_category"]),
                str(r["org_category"]),
                run_id,
                snapshot_id,
                None,
                True,
                None,
                "matched",
                rule,
                1.0,
                None,
                now,
            )
        )

    try:
        conn.execute("BEGIN TRANSACTION")
        conn.executemany(
            """
            INSERT OR REPLACE INTO dim_subject_master (
                subject_id,
                subject_name,
                subject_name_std,
                subject_category,
                org_category,
                subject_no,
                subject_no_type,
                source_status,
                first_source_system,
                first_import_batch_id,
                first_import_session_id,
                last_import_batch_id,
                last_import_session_id,
                quality_status,
                quality_issue,
                subject_build_run_id,
                subject_snapshot_id,
                category_rule_version,
                category_rule_enabled_at_run,
                category_status_note,
                created_at,
                updated_at
            ) VALUES (
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            )
            """,
            master_tuples,
        )
        if src_tuples:
            conn.executemany(
                """
                INSERT OR REPLACE INTO dim_subject_source_record (
                    source_record_id,
                    subject_id,
                    source_system,
                    import_batch_id,
                    import_session_id,
                    ods_file_seq,
                    source_excel_file,
                    source_parquet_file,
                    source_sheet,
                    source_row_no,
                    raw_subject_name,
                    raw_subject_no,
                    raw_subject_no_type,
                    raw_subject_category,
                    raw_org_category,
                    subject_build_run_id,
                    subject_snapshot_id,
                    category_rule_version,
                    category_rule_enabled_at_run,
                    category_status_note,
                    match_status,
                    match_rule,
                    match_confidence,
                    payload_json,
                    ingest_ts
                ) VALUES (
                    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
                )
                """,
                src_tuples,
            )
        conn.execute("COMMIT")
    except Exception as exc:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        return {
            "ok": False,
            "file_blocking": True,
            "error": {
                "message": f"写入 DuckDB 失败：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
            "reject_row_samples": reject_samples[:50],
        }

    try:
        from src.local_api.subject_library_display_cache import refresh_subject_library_display_cache

        refresh_subject_library_display_cache(conn)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "外部导入后刷新主体库展示缓存失败，已忽略：%s: %s",
            type(exc).__name__,
            exc,
        )

    return {
        "ok": True,
        "message": f"已导入 {len(last_by_id)} 个主体（来源文件：{fname}；写入 dim_subject_master）",
        "subjects_upserted": len(last_by_id),
        "source_rows_written": len(src_tuples),
        "import_batch_id": batch_tag,
        "import_session_id": session_tag,
        "run_id": run_id,
        "reject_row_samples": reject_samples[:50],
        "reject_row_ranges": [],
    }
