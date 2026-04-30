from __future__ import annotations

import hashlib
import json
import uuid
from decimal import Decimal
from datetime import datetime
from pathlib import Path
from typing import Any

from db.schema_sqlfiles import init_all_tables
from src.subject_category.infer import (
    enabled_category_codes,
    infer_org_subject_category,
    load_category_doc,
    load_matching_doc,
    normalize_party_id,
    normalize_party_name,
)


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_warehouse_path() -> Path:
    return _project_root() / "data" / "warehouse.duckdb"


def _stable_rule_version(matching_doc: dict[str, Any], category_doc: dict[str, Any]) -> str:
    payload = {"matching": matching_doc, "category": category_doc}
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"scm-{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:12]}"


def _make_run_id(prefix: str) -> str:
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"{prefix}_{ts}_{uuid.uuid4().hex[:8]}"


def recompute_org_subject_categories(conn, *, run_id: str | None = None, snapshot_id: str | None = None) -> dict[str, Any]:
    """
    仅重算组织主体（subject_category='org'）的机构类别。
    - 写入 dim_subject_category_snapshot
    - 回写 dim_subject_master 的 org_category 与治理字段
    """
    init_all_tables(conn)
    matching_doc = load_matching_doc()
    category_doc = load_category_doc()
    enabled_codes = enabled_category_codes(category_doc)
    rule_version = _stable_rule_version(matching_doc, category_doc)
    run_id = run_id or _make_run_id("subject_run")
    snapshot_id = snapshot_id or _make_run_id("subject_snapshot")

    rows = conn.execute(
        """
        SELECT
            subject_id,
            COALESCE(subject_name_std, subject_name, '') AS party_name,
            COALESCE(subject_no, '') AS party_id,
            COALESCE(subject_category, 'org') AS subject_category
        FROM dim_subject_master
        WHERE subject_category = 'org'
        """
    ).fetchall()

    total = len(rows)
    matched = 0
    needs_review = 0
    disabled_blocked = 0

    snapshot_rows: list[tuple[Any, ...]] = []
    update_rows: list[tuple[Any, ...]] = []
    now = datetime.now()

    for subject_id, party_name, party_id, subject_category in rows:
        result = infer_org_subject_category(
            party_id=str(party_id or ""),
            party_name=str(party_name or ""),
            matching_doc=matching_doc,
            category_doc=category_doc,
            enabled_codes=enabled_codes,
        )
        if result.matched:
            matched += 1
        if result.needs_review:
            needs_review += 1
        if result.skipped_disabled_codes and not result.matched:
            disabled_blocked += 1

        is_enabled = bool(result.category_code and result.category_code in enabled_codes)
        status_note = ""
        if result.skipped_disabled_codes and not result.matched:
            status_note = "category_disabled_at_run"
        elif result.needs_review and not result.matched:
            status_note = "needs_review"
        elif result.matched:
            status_note = "active_category"

        snapshot_row_id = f"{snapshot_id}:{subject_id}"
        snapshot_rows.append(
            (
                snapshot_row_id,
                snapshot_id,
                run_id,
                subject_id,
                subject_category,
                result.category_code,
                rule_version,
                is_enabled,
                status_note,
                json.dumps(result.reasons, ensure_ascii=False),
                bool(result.needs_review),
                json.dumps(result.skipped_disabled_codes, ensure_ascii=False),
                now,
            )
        )
        update_rows.append(
            (
                result.category_code,
                rule_version,
                is_enabled,
                status_note,
                run_id,
                snapshot_id,
                now,
                subject_id,
            )
        )

    conn.execute("BEGIN TRANSACTION")
    try:
        if snapshot_rows:
            conn.executemany(
                """
                INSERT OR REPLACE INTO dim_subject_category_snapshot (
                    snapshot_row_id,
                    snapshot_id,
                    subject_build_run_id,
                    subject_id,
                    subject_category,
                    org_category,
                    category_rule_version,
                    category_rule_enabled_at_run,
                    category_status_note,
                    infer_reasons_json,
                    infer_needs_review,
                    infer_skipped_disabled_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                snapshot_rows,
            )
            conn.executemany(
                """
                UPDATE dim_subject_master
                SET
                    org_category = ?,
                    category_rule_version = ?,
                    category_rule_enabled_at_run = ?,
                    category_status_note = ?,
                    subject_build_run_id = ?,
                    subject_snapshot_id = ?,
                    updated_at = ?
                WHERE subject_id = ?
                """,
                update_rows,
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return {
        "run_id": run_id,
        "snapshot_id": snapshot_id,
        "rule_version": rule_version,
        "total": total,
        "matched": matched,
        "needs_review": needs_review,
        "disabled_blocked": disabled_blocked,
    }


def recompute_subject_relations_from_dwd(conn, *, run_id: str, snapshot_id: str) -> dict[str, Any]:
    """
    从 dwd_inv_header 重建主体关系快照（当前实现：销方 -> 购方 TRADE_COUNTERPARTY）。
    仅处理能映射到 dim_subject_master 的组织主体（subject_category='org'）。
    """
    init_all_tables(conn)
    subjects = conn.execute(
        """
        SELECT
            subject_id,
            COALESCE(subject_no, '') AS subject_no,
            COALESCE(subject_name_std, subject_name, '') AS subject_name
        FROM dim_subject_master
        WHERE subject_category = 'org'
        """
    ).fetchall()
    no_to_subject: dict[str, str] = {}
    name_to_subject: dict[str, str] = {}
    for sid, sno, sname in subjects:
        key_no = normalize_party_id(str(sno or ""))
        key_name = normalize_party_name(str(sname or ""))
        if key_no and key_no not in no_to_subject:
            no_to_subject[key_no] = str(sid)
        if key_name and key_name not in name_to_subject:
            name_to_subject[key_name] = str(sid)

    headers = conn.execute(
        """
        SELECT
            header_uuid,
            COALESCE(xfsbh, '') AS xfsbh,
            COALESCE(xfmc, '') AS xfmc,
            COALESCE(gfsbh, '') AS gfsbh,
            COALESCE(gfmc, '') AS gfmc,
            jshj,
            invoice_date
        FROM dwd_inv_header
        WHERE COALESCE(xfmc, '') <> '' AND COALESCE(gfmc, '') <> ''
        """
    ).fetchall()

    def _resolve_subject(pid: str, name: str) -> str | None:
        kpid = normalize_party_id(pid)
        if kpid and kpid in no_to_subject:
            return no_to_subject[kpid]
        kname = normalize_party_name(name)
        if kname and kname in name_to_subject:
            return name_to_subject[kname]
        return None

    # key: (left_subject_id, right_subject_id, relation_type)
    agg: dict[tuple[str, str, str], dict[str, Any]] = {}
    unresolved = 0
    for header_uuid, xfsbh, xfmc, gfsbh, gfmc, jshj, invoice_date in headers:
        left_id = _resolve_subject(str(xfsbh or ""), str(xfmc or ""))
        right_id = _resolve_subject(str(gfsbh or ""), str(gfmc or ""))
        if not left_id or not right_id or left_id == right_id:
            unresolved += 1
            continue
        key = (left_id, right_id, "TRADE_COUNTERPARTY")
        if key not in agg:
            agg[key] = {
                "evidence_count": 0,
                "trade_invoice_count": 0,
                "trade_amount_jshj": Decimal("0"),
                "first_invoice_date": invoice_date,
                "last_invoice_date": invoice_date,
                "sample_headers": [],
            }
        rec = agg[key]
        rec["evidence_count"] += 1
        rec["trade_invoice_count"] += 1
        rec["trade_amount_jshj"] += Decimal(str(jshj or 0))
        if rec["first_invoice_date"] is None or (invoice_date is not None and invoice_date < rec["first_invoice_date"]):
            rec["first_invoice_date"] = invoice_date
        if rec["last_invoice_date"] is None or (invoice_date is not None and invoice_date > rec["last_invoice_date"]):
            rec["last_invoice_date"] = invoice_date
        if len(rec["sample_headers"]) < 5 and header_uuid:
            rec["sample_headers"].append(str(header_uuid))

    now = datetime.now()
    snapshot_rows: list[tuple[Any, ...]] = []
    current_rows: list[tuple[Any, ...]] = []
    for (left_id, right_id, rel_type), rec in agg.items():
        relation_row_id = f"{snapshot_id}:{left_id}:{right_id}:{rel_type}"
        relation_key = f"{left_id}:{right_id}:{rel_type}"
        evidence_json = json.dumps(
            {
                "sample_header_uuid": rec["sample_headers"],
                "evidence_count": rec["evidence_count"],
            },
            ensure_ascii=False,
        )
        strength = Decimal(str(rec["trade_invoice_count"]))
        confidence = Decimal("1.0000")
        snapshot_rows.append(
            (
                relation_row_id,
                snapshot_id,
                run_id,
                rel_type,
                left_id,
                right_id,
                strength,
                confidence,
                rec["evidence_count"],
                rec["trade_invoice_count"],
                rec["trade_amount_jshj"],
                rec["first_invoice_date"],
                rec["last_invoice_date"],
                evidence_json,
                now,
            )
        )
        current_rows.append(
            (
                relation_key,
                snapshot_id,
                run_id,
                rel_type,
                left_id,
                right_id,
                strength,
                confidence,
                rec["evidence_count"],
                rec["trade_invoice_count"],
                rec["trade_amount_jshj"],
                rec["first_invoice_date"],
                rec["last_invoice_date"],
                evidence_json,
                now,
            )
        )

    conn.execute("BEGIN TRANSACTION")
    try:
        conn.execute("DELETE FROM dim_subject_relation_snapshot WHERE snapshot_id = ?", [snapshot_id])
        if snapshot_rows:
            conn.executemany(
                """
                INSERT OR REPLACE INTO dim_subject_relation_snapshot (
                    relation_row_id,
                    snapshot_id,
                    subject_build_run_id,
                    relation_type,
                    left_subject_id,
                    right_subject_id,
                    relation_strength,
                    relation_confidence,
                    evidence_count,
                    trade_invoice_count,
                    trade_amount_jshj,
                    first_invoice_date,
                    last_invoice_date,
                    evidence_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                snapshot_rows,
            )
            conn.executemany(
                """
                INSERT OR REPLACE INTO dim_subject_relation_current (
                    relation_key,
                    snapshot_id,
                    subject_build_run_id,
                    relation_type,
                    left_subject_id,
                    right_subject_id,
                    relation_strength,
                    relation_confidence,
                    evidence_count,
                    trade_invoice_count,
                    trade_amount_jshj,
                    first_invoice_date,
                    last_invoice_date,
                    evidence_json,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                current_rows,
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    return {
        "snapshot_id": snapshot_id,
        "run_id": run_id,
        "relation_total": len(snapshot_rows),
        "header_total": len(headers),
        "header_unresolved": unresolved,
    }


def recompute_org_subject_categories_and_relations(
    conn,
    *,
    run_id: str | None = None,
    snapshot_id: str | None = None,
) -> dict[str, Any]:
    """
    联动重算：
    1) 重算组织主体分类快照并回写主表
    2) 基于同一 run_id/snapshot_id 重建关系快照
    """
    run_id = run_id or _make_run_id("subject_run")
    snapshot_id = snapshot_id or _make_run_id("subject_snapshot")
    cat = recompute_org_subject_categories(conn, run_id=run_id, snapshot_id=snapshot_id)
    rel = recompute_subject_relations_from_dwd(conn, run_id=run_id, snapshot_id=snapshot_id)
    return {
        "run_id": run_id,
        "snapshot_id": snapshot_id,
        "category": cat,
        "relation": rel,
    }
