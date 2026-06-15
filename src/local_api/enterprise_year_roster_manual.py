"""
dim_enterprise_year_roster 人工维护：单条增删改、从上年度复制。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from src.local_api.enterprise_year_roster_build import (
    chain_rebuild_enterprise_year_rel_after_roster,
    ensure_enterprise_year_roster_schema,
)
from src.local_api.enterprise_year_roster_merge import (
    build_manual_row,
    derive_data_source,
    norm_enterprise_id,
    norm_name_key,
    registry_quality,
)
from src.local_api.enterprise_year_roster_store import (
    count_manual_only_rows,
    fetch_roster_row,
    upsert_roster_row,
)

logger = logging.getLogger(__name__)


def _safe_year(raw: Any) -> int | None:
    try:
        y = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if 1990 <= y <= 2100:
        return y
    return None


def _registry_snapshot_for_enterprise(conn: Any, *, stat_year: int, enterprise_id: str) -> dict[str, Any] | None:
    try:
        rows = conn.execute(
            """
            SELECT enterprise_name, state_investor
            FROM dim_audited_enterprise_registry
            WHERE snapshot_year = ?
              AND upper(regexp_replace(trim(COALESCE(unified_social_credit_code, '')), '[\\s-]+', '', 'g')) = ?
            LIMIT 1
            """,
            [stat_year, enterprise_id],
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取台账快照失败: %s", exc)
        return None
    if not rows:
        return None
    ename = str(rows[0][0] or "").strip()
    si = str(rows[0][1] or "").strip()
    name_to_id: dict[str, str] = {}
    try:
        id_rows = conn.execute(
            """
            SELECT unified_social_credit_code, enterprise_name
            FROM dim_audited_enterprise_registry
            WHERE snapshot_year = ?
              AND trim(COALESCE(unified_social_credit_code, '')) <> ''
            """,
            [stat_year],
        ).fetchall()
        for code, nm in id_rows or []:
            nk = norm_name_key(str(nm or ""))
            eid = norm_enterprise_id(str(code or ""))
            if nk and eid and nk not in name_to_id:
                name_to_id[nk] = eid
    except Exception:
        pass
    si_code = name_to_id.get(norm_name_key(si), "") if si else ""
    return {
        "enterprise_name": ename or enterprise_id,
        "state_investor": si or "（未维护国家出资企业）",
        "state_investor_unified_credit_code": si_code or None,
    }


def _chain_rel(conn: Any, stat_years: list[int], run_id: str) -> dict[str, Any]:
    return chain_rebuild_enterprise_year_rel_after_roster(
        conn,
        stat_years=stat_years,
        trigger_source="roster_manual_chain",
        run_id=run_id,
    )


def api_enterprise_year_roster_manual_upsert(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    ensure_enterprise_year_roster_schema(conn)
    year_i = _safe_year(body.get("stat_year") or body.get("statYear"))
    eid = norm_enterprise_id(str(body.get("enterprise_id") or body.get("enterpriseId") or ""))
    if year_i is None or not eid:
        return {
            "ok": False,
            "error": {"message": "缺少有效统计年度或统一社会信用代码", "exception_type": "ValidationError"},
        }

    ename = str(body.get("enterprise_name") or body.get("enterpriseName") or "").strip() or eid
    si = str(body.get("state_investor") or body.get("stateInvestor") or "").strip()
    si_code_raw = body.get("state_investor_unified_credit_code") or body.get("stateInvestorUnifiedCreditCode")
    si_code = norm_enterprise_id(str(si_code_raw or "")) or None
    is_member = body.get("is_member", body.get("isMember", True))
    is_member_b = bool(is_member) if not isinstance(is_member, str) else is_member.lower() in ("1", "true", "yes", "是")
    manual_note = str(body.get("manual_note") or body.get("manualNote") or "").strip() or None
    run_id = str(body.get("run_id") or "").strip() or f"roster_manual_{uuid.uuid4().hex[:12]}"

    existing = fetch_roster_row(conn, stat_year=year_i, enterprise_id=eid)
    registry_snap = _registry_snapshot_for_enterprise(conn, stat_year=year_i, enterprise_id=eid)
    in_registry = bool(existing.get("in_registry")) if existing else bool(registry_snap)

    q_status, q_issue = registry_quality(state_investor=si or "（未维护国家出资企业）", state_investor_unified_credit_code=si_code)
    conflicts: list[str] = []
    if in_registry and registry_snap:
        reg_si = registry_snap["state_investor"]
        if norm_name_key(si or reg_si) != norm_name_key(reg_si):
            conflicts.append(f"国家出资企业不一致（人工：{si or '（空）'}；台账：{reg_si}）")
        reg_code = str(registry_snap.get("state_investor_unified_credit_code") or "").strip()
        if si_code and reg_code and norm_enterprise_id(si_code) != norm_enterprise_id(reg_code):
            conflicts.append(f"国家出资企业税号不一致（人工：{si_code}；台账：{reg_code}）")
    if conflicts:
        q_status = "conflict"
        q_issue = "；".join(conflicts)

    item = build_manual_row(
        stat_year=year_i,
        enterprise_id=eid,
        enterprise_name=ename,
        state_investor=si,
        state_investor_unified_credit_code=si_code,
        is_member=is_member_b,
        manual_note=manual_note,
        existing=existing,
        source_record_id=run_id,
    )
    item["in_registry"] = in_registry
    item["data_source"] = derive_data_source(in_registry=in_registry, in_manual=True)
    item["quality_status"] = q_status
    item["quality_issue"] = q_issue
    if existing and existing.get("registry_row_id"):
        item["registry_row_id"] = existing["registry_row_id"]

    try:
        upsert_roster_row(conn, item, touch_manual=True)
        rel = _chain_rel(conn, [year_i], run_id)
        return {
            "ok": True,
            "stat_year": str(year_i),
            "enterprise_id": eid,
            "data_source": item["data_source"],
            "enterprise_year_rel_rebuild": rel,
        }
    except Exception as exc:
        logger.exception("manual upsert roster failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_enterprise_year_roster_manual_delete(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    ensure_enterprise_year_roster_schema(conn)
    year_i = _safe_year(body.get("stat_year") or body.get("statYear"))
    eid = norm_enterprise_id(str(body.get("enterprise_id") or body.get("enterpriseId") or ""))
    if year_i is None or not eid:
        return {
            "ok": False,
            "error": {"message": "缺少有效统计年度或统一社会信用代码", "exception_type": "ValidationError"},
        }

    existing = fetch_roster_row(conn, stat_year=year_i, enterprise_id=eid)
    if not existing:
        return {"ok": False, "error": {"message": "花名册中不存在该成员", "exception_type": "NotFoundError"}}

    in_registry = bool(existing.get("in_registry"))
    in_manual = bool(existing.get("in_manual"))
    if in_registry and in_manual:
        return {
            "ok": False,
            "error": {
                "message": "该行同时含台账与人工来源，不可直接删除；请编辑「有效成员」或调整归属",
                "exception_type": "ValidationError",
            },
        }
    if in_registry and not in_manual:
        return {
            "ok": False,
            "error": {
                "message": "仅台账同步的成员不可在此删除；请在「管理与产权层级信息」维护或标记非成员",
                "exception_type": "ValidationError",
            },
        }

    run_id = f"roster_manual_del_{uuid.uuid4().hex[:12]}"
    try:
        conn.execute(
            "DELETE FROM dim_enterprise_year_roster WHERE stat_year = ? AND enterprise_id = ?",
            [year_i, eid],
        )
        rel = _chain_rel(conn, [year_i], run_id)
        return {"ok": True, "stat_year": str(year_i), "enterprise_id": eid, "enterprise_year_rel_rebuild": rel}
    except Exception as exc:
        logger.exception("manual delete roster failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _copy_source_rows(
    conn: Any,
    *,
    source_year: int,
    include_pending: bool,
) -> list[dict[str, Any]]:
    where = "stat_year = ? AND COALESCE(is_member, TRUE) = TRUE"
    if not include_pending:
        where += " AND lower(COALESCE(quality_status, '')) = 'ok'"
    rows = conn.execute(
        f"""
        SELECT enterprise_id, enterprise_name, state_investor,
               state_investor_unified_credit_code, is_member
        FROM dim_enterprise_year_roster
        WHERE {where}
        ORDER BY enterprise_id
        """,
        [source_year],
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows or []:
        out.append(
            {
                "enterprise_id": str(r[0] or ""),
                "enterprise_name": str(r[1] or ""),
                "state_investor": str(r[2] or ""),
                "state_investor_unified_credit_code": str(r[3] or "") if r[3] else None,
                "is_member": bool(r[4]),
            }
        )
    return out


def _classify_copy_row(
    source: dict[str, Any],
    target_existing: dict[str, Any] | None,
    *,
    registry_snap: dict[str, Any] | None,
) -> dict[str, Any]:
    eid = source["enterprise_id"]
    if target_existing is None:
        return {"enterprise_id": eid, "action": "insert", "reason": "目标年度不存在"}

    in_r = bool(target_existing.get("in_registry"))
    in_m = bool(target_existing.get("in_manual"))
    if in_r and in_m:
        return {"enterprise_id": eid, "action": "skip", "reason": "dual_source", "skip_kind": "dual_source"}
    if in_m and not in_r:
        return {"enterprise_id": eid, "action": "skip", "reason": "manual_exists", "skip_kind": "manual_only"}
    if in_r and not in_m:
        hint = None
        if registry_snap and norm_name_key(source.get("state_investor", "")) != norm_name_key(
            target_existing.get("state_investor", "")
        ):
            hint = "复制来源与台账现值国家出资企业不一致"
        return {
            "enterprise_id": eid,
            "action": "skip",
            "reason": "registry_exists",
            "skip_kind": "registry_only",
            "conflict_hint": hint,
        }
    return {"enterprise_id": eid, "action": "skip", "reason": "unknown_existing"}


def api_enterprise_year_roster_copy_preview(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    ensure_enterprise_year_roster_schema(conn)
    source_year = _safe_year(body.get("source_year") or body.get("sourceYear"))
    target_year = _safe_year(body.get("target_year") or body.get("targetYear"))
    if source_year is None or target_year is None:
        return {
            "ok": False,
            "error": {"message": "缺少有效来源年度或目标年度", "exception_type": "ValidationError"},
        }
    if source_year == target_year:
        return {"ok": False, "error": {"message": "来源年度与目标年度不能相同", "exception_type": "ValidationError"}}

    include_pending = bool(body.get("include_pending") or body.get("includePending"))
    sources = _copy_source_rows(conn, source_year=source_year, include_pending=include_pending)

    to_insert: list[dict[str, Any]] = []
    to_skip: list[dict[str, Any]] = []
    conflict_hints: list[dict[str, Any]] = []

    for src in sources:
        eid = src["enterprise_id"]
        existing = fetch_roster_row(conn, stat_year=target_year, enterprise_id=eid)
        reg_snap = _registry_snapshot_for_enterprise(conn, stat_year=target_year, enterprise_id=eid)
        cls = _classify_copy_row(src, existing, registry_snap=reg_snap)
        if cls["action"] == "insert":
            to_insert.append({**src, "stat_year": target_year})
        else:
            to_skip.append({**src, **cls})
            if cls.get("conflict_hint"):
                conflict_hints.append({"enterprise_id": eid, "hint": cls["conflict_hint"]})

    return {
        "ok": True,
        "source_year": str(source_year),
        "target_year": str(target_year),
        "source_row_count": len(sources),
        "to_insert_count": len(to_insert),
        "to_skip_count": len(to_skip),
        "conflict_hint_count": len(conflict_hints),
        "to_insert": to_insert[:200],
        "to_skip": to_skip[:200],
        "conflict_hints": conflict_hints[:100],
    }


def api_enterprise_year_roster_copy_execute(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    preview = api_enterprise_year_roster_copy_preview(conn, body)
    if not preview.get("ok"):
        return preview

    target_year = int(preview["target_year"])
    overwrite_manual = bool(body.get("overwrite_manual") or body.get("overwriteManual"))
    fill_empty_registry = bool(body.get("fill_empty_registry") or body.get("fillEmptyRegistry"))
    include_pending = bool(body.get("include_pending") or body.get("includePending"))
    run_id = str(body.get("run_id") or "").strip() or f"roster_copy_{uuid.uuid4().hex[:12]}"

    sources = _copy_source_rows(
        conn,
        source_year=int(preview["source_year"]),
        include_pending=include_pending,
    )

    inserted = 0
    skipped = 0
    updated = 0

    try:
        for src in sources:
            eid = src["enterprise_id"]
            existing = fetch_roster_row(conn, stat_year=target_year, enterprise_id=eid)
            if existing is None:
                item = {
                    "stat_year": target_year,
                    "enterprise_id": eid,
                    "enterprise_name": src["enterprise_name"],
                    "state_investor": src["state_investor"],
                    "state_investor_unified_credit_code": src.get("state_investor_unified_credit_code"),
                    "is_member": src.get("is_member", True),
                    "registry_row_id": None,
                    "in_registry": False,
                    "in_manual": True,
                    "data_source": "manual",
                    "source_record_id": run_id,
                    "calc_version": "v2",
                    "quality_status": "ok",
                    "quality_issue": None,
                    "manual_note": f"由上年度 {preview['source_year']} 复制",
                }
                q_status, q_issue = registry_quality(
                    state_investor=item["state_investor"],
                    state_investor_unified_credit_code=item.get("state_investor_unified_credit_code"),
                )
                item["quality_status"] = q_status
                item["quality_issue"] = q_issue
                upsert_roster_row(conn, item, touch_manual=True)
                inserted += 1
                continue

            in_r = bool(existing.get("in_registry"))
            in_m = bool(existing.get("in_manual"))
            if in_r and in_m:
                skipped += 1
                continue
            if in_m and not in_r:
                if overwrite_manual:
                    item = {
                        "stat_year": target_year,
                        "enterprise_id": eid,
                        "enterprise_name": src["enterprise_name"],
                        "state_investor": src["state_investor"],
                        "state_investor_unified_credit_code": src.get("state_investor_unified_credit_code"),
                        "is_member": src.get("is_member", True),
                        "registry_row_id": None,
                        "in_registry": False,
                        "in_manual": True,
                        "data_source": "manual",
                        "source_record_id": run_id,
                        "calc_version": "v2",
                        "manual_note": f"由上年度 {preview['source_year']} 复制（覆盖原人工行）",
                    }
                    q_status, q_issue = registry_quality(
                        state_investor=item["state_investor"],
                        state_investor_unified_credit_code=item.get("state_investor_unified_credit_code"),
                    )
                    item["quality_status"] = q_status
                    item["quality_issue"] = q_issue
                    upsert_roster_row(conn, item, touch_manual=True)
                    updated += 1
                else:
                    skipped += 1
                continue
            if in_r and not in_m and fill_empty_registry:
                merged_name = existing.get("enterprise_name") or src["enterprise_name"]
                if not str(existing.get("enterprise_name") or "").strip():
                    merged_name = src["enterprise_name"]
                merged_si = existing.get("state_investor") or src["state_investor"]
                merged_code = existing.get("state_investor_unified_credit_code") or src.get(
                    "state_investor_unified_credit_code"
                )
                item = {
                    **existing,
                    "stat_year": target_year,
                    "enterprise_id": eid,
                    "enterprise_name": merged_name,
                    "state_investor": merged_si,
                    "state_investor_unified_credit_code": merged_code,
                    "in_registry": True,
                    "in_manual": False,
                    "data_source": "registry",
                    "source_record_id": run_id,
                }
                q_status, q_issue = registry_quality(
                    state_investor=str(item["state_investor"]),
                    state_investor_unified_credit_code=item.get("state_investor_unified_credit_code"),
                )
                item["quality_status"] = q_status
                item["quality_issue"] = q_issue
                upsert_roster_row(conn, item, touch_manual=False)
                updated += 1
                continue
            skipped += 1

        rel = _chain_rel(conn, [target_year], run_id)
        return {
            "ok": True,
            "source_year": preview["source_year"],
            "target_year": preview["target_year"],
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "enterprise_year_rel_rebuild": rel,
        }
    except Exception as exc:
        logger.exception("copy execute roster failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
