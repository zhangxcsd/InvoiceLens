from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any

from db.schema_sqlfiles import init_all_tables
from src.subject_category.infer import normalize_party_name
from src.subject_category.recompute import _make_run_id


def _id_card_like(party_id: str) -> bool:
    return bool(re.fullmatch(r"\d{17}[\dX]", party_id))


def _stable_subject_id(norm_no: str, norm_name: str) -> str:
    if norm_no:
        key = f"NO:{norm_no}"
    elif norm_name:
        key = f"NM:{norm_name}"
    else:
        return ""
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    return f"SUB_{h}"


def _subject_no_type(norm_no: str) -> str | None:
    if not norm_no:
        return None
    if _id_card_like(norm_no):
        return "id_card"
    if len(norm_no) == 18:
        return "uscc"
    if norm_no.isdigit() or re.match(r"^[0-9A-Z]+$", norm_no):
        return "taxpayer_id"
    return "other"


def _source_record_id(subject_id: str, match_rule: str) -> str:
    h = hashlib.sha256(f"{subject_id}|{match_rule}".encode("utf-8")).hexdigest()[:28]
    return f"SRC_{h}"


def ingest_dim_subject_master_from_dwd(conn, *, run_id: str | None = None) -> dict[str, Any]:
    """
    从 dwd_inv_header 的销方/购方归集写入 dim_subject_master，并写入最多两条 dim_subject_source_record
   （match_rule=dwd_invoice_seller / dwd_invoice_buyer），供主体库「交易角色」统计。
    """
    init_all_tables(conn)
    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
    except Exception:
        return {
            "ok": False,
            "error": "dwd_inv_header 不可读或不存在，请先完成 ODS→DWD 构建。",
            "subjects_upserted": 0,
            "header_rows_scanned": 0,
        }

    run_id = run_id or _make_run_id("subject_dwd_ingest")
    now = datetime.now()

    header_rows = int(
        conn.execute("SELECT COUNT(*)::BIGINT FROM dwd_inv_header").fetchone()[0] or 0
    )

    # DuckDB 内聚合，避免对全量发票头在 Python 中逐行归集（与 normalize_party_id/name 语义对齐）
    rows = conn.execute(
        """
        WITH base AS (
            SELECT
                'seller'::VARCHAR AS side,
                COALESCE(xfsbh, '') AS raw_no,
                COALESCE(xfmc, '') AS raw_name,
                COALESCE(import_batch_id, first_import_batch_id, '') AS bid,
                COALESCE(import_session_id, '') AS sid,
                CAST(invoice_date AS DATE) AS inv
            FROM dwd_inv_header
            UNION ALL
            SELECT
                'buyer'::VARCHAR,
                COALESCE(gfsbh, ''),
                COALESCE(gfmc, ''),
                COALESCE(import_batch_id, first_import_batch_id, ''),
                COALESCE(import_session_id, ''),
                CAST(invoice_date AS DATE)
            FROM dwd_inv_header
        ),
        n AS (
            SELECT
                side,
                upper(regexp_replace(trim(raw_no), '[\\s-]+', '', 'g')) AS pid,
                regexp_replace(trim(raw_name), '\\s+', '', 'g') AS pname_std,
                trim(raw_name) AS raw_name_t,
                bid,
                sid,
                inv
            FROM base
        ),
        k AS (
            SELECT
                *,
                CASE
                    WHEN length(pid) > 0 THEN 'NO:' || pid
                    WHEN length(pname_std) > 0 THEN 'NM:' || pname_std
                    ELSE ''
                END AS mk
            FROM n
            WHERE length(pid) > 0 OR length(pname_std) > 0
        ),
        g AS (
            SELECT
                mk,
                max(pid) AS pid,
                max(pname_std) AS pname_std,
                arg_max(nullif(raw_name_t, ''), length(nullif(raw_name_t, ''))) AS best_name,
                min(inv) AS first_inv,
                max(inv) AS last_inv,
                min_by(bid, coalesce(inv, DATE '9999-12-31')) AS first_bid,
                max_by(bid, coalesce(inv, DATE '1900-01-01')) AS last_bid,
                min_by(sid, coalesce(inv, DATE '9999-12-31')) AS first_sid,
                max_by(sid, coalesce(inv, DATE '1900-01-01')) AS last_sid,
                max(CASE WHEN side = 'seller' THEN 1 ELSE 0 END) AS has_seller,
                max(CASE WHEN side = 'buyer' THEN 1 ELSE 0 END) AS has_buyer
            FROM k
            GROUP BY mk
        )
        SELECT
            mk,
            pid,
            pname_std,
            best_name,
            first_bid,
            last_bid,
            first_sid,
            last_sid,
            has_seller,
            has_buyer
        FROM g
        """
    ).fetchall()

    agg: dict[str, dict[str, Any]] = {}
    roles: dict[str, set[str]] = {}
    for (
        _mk,
        pid,
        pname_std,
        best_name,
        first_bid,
        last_bid,
        first_sid,
        last_sid,
        has_seller,
        has_buyer,
    ) in rows:
        pid_py = str(pid or "")
        pname_py = str(pname_std or "")
        sid = _stable_subject_id(pid_py, pname_py)
        if not sid:
            continue
        raw_bn = best_name if best_name is not None else ""
        display = str(raw_bn).strip() or pid_py or "（未知主体）"
        cat: str = "person" if pid_py and _id_card_like(pid_py) else "org"
        agg[sid] = {
            "subject_id": sid,
            "subject_no": pid_py,
            "subject_name": display,
            "subject_name_std": normalize_party_name(display),
            "subject_category": cat,
            "subject_no_type": _subject_no_type(pid_py),
            "first_batch": str(first_bid or ""),
            "first_session": str(first_sid or ""),
            "last_batch": str(last_bid or ""),
            "last_session": str(last_sid or ""),
        }
        rs: set[str] = set()
        if int(has_seller or 0):
            rs.add("seller")
        if int(has_buyer or 0):
            rs.add("buyer")
        roles[sid] = rs

    master_rows: list[tuple[Any, ...]] = []
    existing_created: dict[str, datetime] = {}
    preserve: dict[str, dict[str, Any]] = {}
    if agg:
        ids = list(agg.keys())
        chunk = 400
        for i in range(0, len(ids), chunk):
            part = ids[i : i + chunk]
            ph = ",".join(["?"] * len(part))
            for row in conn.execute(
                f"""
                SELECT
                    subject_id,
                    created_at,
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
                sid = str(row[0] or "")
                ca = row[1]
                existing_created[sid] = ca if isinstance(ca, datetime) else now
                preserve[sid] = {
                    "org_category": row[2],
                    "subject_snapshot_id": row[3],
                    "category_rule_version": row[4],
                    "category_rule_enabled_at_run": row[5]
                    if row[5] is not None
                    else True,
                    "category_status_note": row[6],
                    "quality_status": row[7] or "ok",
                    "quality_issue": row[8],
                }

    for sid, a in agg.items():
        created = existing_created.get(sid, now)
        pr = preserve.get(sid, {})
        master_rows.append(
            (
                sid,
                str(a["subject_name"]),
                str(a["subject_name_std"] or ""),
                str(a["subject_category"]),
                pr.get("org_category"),
                str(a["subject_no"] or "") or None,
                str(a["subject_no_type"] or "") or None,
                "single",
                "invoice",
                str(a["first_batch"] or ""),
                str(a["first_session"] or ""),
                str(a["last_batch"] or ""),
                str(a["last_session"] or ""),
                str(pr.get("quality_status") or "ok"),
                pr.get("quality_issue"),
                run_id,
                pr.get("subject_snapshot_id"),
                pr.get("category_rule_version"),
                bool(pr.get("category_rule_enabled_at_run", True)),
                pr.get("category_status_note"),
                created,
                now,
            )
        )

    src_rows: list[tuple[Any, ...]] = []
    for sid, role_set in roles.items():
        a = agg[sid]
        raw_cat = str(a["subject_category"])
        for role in ("seller", "buyer"):
            if role not in role_set:
                continue
            rule = "dwd_invoice_seller" if role == "seller" else "dwd_invoice_buyer"
            src_rows.append(
                (
                    _source_record_id(sid, rule),
                    sid,
                    "invoice",
                    str(a["last_batch"] or ""),
                    str(a["last_session"] or ""),
                    None,
                    None,
                    None,
                    None,
                    None,
                    str(a["subject_name"]),
                    str(a["subject_no"] or ""),
                    str(a["subject_no_type"] or "") or None,
                    raw_cat,
                    None,
                    run_id,
                    None,
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

    conn.execute("BEGIN TRANSACTION")
    try:
        if master_rows:
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
                master_rows,
            )
        if src_rows:
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
                src_rows,
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return {
        "ok": True,
        "run_id": run_id,
        "header_rows_scanned": header_rows,
        "subjects_upserted": len(agg),
        "source_rows_upserted": len(src_rows),
    }
