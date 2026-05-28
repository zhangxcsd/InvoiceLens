from __future__ import annotations

from typing import Any

# 人工修正日志中受保护的字段（与 subject_library_repair 写入一致）
REPAIR_GUARD_FIELD_NAMES = frozenset({"subject_category", "org_category"})


def load_repaired_field_map(conn) -> dict[str, set[str]]:
    """
    subject_id → 曾被人工修正过的 field_name 集合。
    仅统计 subject_category / org_category。
    """
    out: dict[str, set[str]] = {}
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT subject_id, field_name
            FROM dim_subject_master_repair_log
            WHERE field_name IN ('subject_category', 'org_category')
            """,
        ).fetchall()
    except Exception:
        return out
    for sid_raw, field_raw in rows:
        sid = str(sid_raw or "").strip()
        field = str(field_raw or "").strip()
        if not sid or field not in REPAIR_GUARD_FIELD_NAMES:
            continue
        out.setdefault(sid, set()).add(field)
    return out


def subject_category_fields_locked(repair_map: dict[str, set[str]], subject_id: str) -> bool:
    """该主体是否对类别相关字段启用了人工保护（任一 guard 字段被修过）。"""
    rep = repair_map.get(str(subject_id or "").strip(), set())
    return bool(rep & REPAIR_GUARD_FIELD_NAMES)


def resolve_subject_category_for_upsert(
    *,
    subject_id: str,
    incoming_category: str,
    existing_category: str | None,
    repair_map: dict[str, set[str]],
    respect_manual_repairs: bool,
) -> str:
    if not respect_manual_repairs:
        return incoming_category
    if "subject_category" not in repair_map.get(subject_id, set()):
        return incoming_category
    if existing_category is not None and str(existing_category).strip():
        return str(existing_category).strip()
    return incoming_category


def resolve_org_category_for_upsert(
    *,
    subject_id: str,
    incoming_org_category: str | None,
    existing_org_category: Any,
    repair_map: dict[str, set[str]],
    respect_manual_repairs: bool,
) -> Any:
    if not respect_manual_repairs:
        return incoming_org_category
    if "org_category" not in repair_map.get(subject_id, set()):
        return incoming_org_category
    return existing_org_category
