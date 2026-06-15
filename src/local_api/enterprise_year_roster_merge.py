"""
dim_enterprise_year_roster 来源标识与台账/人工字段合并逻辑。

产品规则见 docs/dim_enterprise_year_roster_policy.md
"""

from __future__ import annotations

import re
from typing import Any

_NORM_ID_RE = re.compile(r"[\s-]+")


def norm_enterprise_id(raw: str) -> str:
    return _NORM_ID_RE.sub("", str(raw or "").strip()).upper()


def norm_name_key(raw: str) -> str:
    return str(raw or "").strip().lower()


def derive_data_source(*, in_registry: bool, in_manual: bool) -> str | None:
    if in_registry and in_manual:
        return "registry+manual"
    if in_registry:
        return "registry"
    if in_manual:
        return "manual"
    return None


def registry_quality(
    *,
    state_investor: str,
    state_investor_unified_credit_code: str | None,
) -> tuple[str, str | None]:
    issues: list[str] = []
    si_name = str(state_investor or "").strip()
    if not si_name or si_name == "（未维护国家出资企业）":
        issues.append("国家出资企业未维护")
    si_id = str(state_investor_unified_credit_code or "").strip()
    if si_name and si_name != "（未维护国家出资企业）" and not si_id:
        issues.append(f"未在同年度台账中匹配到国家出资企业「{si_name}」的税号")
    status = "ok" if not issues else "conflict"
    return status, ("；".join(issues) if issues else None)


def _field_conflict(manual_val: str, registry_val: str) -> bool:
    return norm_name_key(manual_val) != norm_name_key(registry_val)


def merge_registry_row(
    existing: dict[str, Any] | None,
    *,
    stat_year: int,
    enterprise_id: str,
    registry_enterprise_name: str,
    registry_state_investor: str,
    registry_state_investor_code: str | None,
    registry_is_member: bool,
    registry_row_id: str,
    build_run_id: str,
    calc_version: str = "v2",
) -> dict[str, Any]:
    """将台账快照合并进花名册行（不删除仅人工行）。"""
    reg_si = registry_state_investor.strip() or "（未维护国家出资企业）"
    reg_q_status, reg_q_issue = registry_quality(
        state_investor=reg_si,
        state_investor_unified_credit_code=registry_state_investor_code,
    )

    if existing is None:
        return {
            "stat_year": stat_year,
            "enterprise_id": enterprise_id,
            "enterprise_name": registry_enterprise_name,
            "state_investor": reg_si,
            "state_investor_unified_credit_code": registry_state_investor_code,
            "is_member": registry_is_member,
            "registry_row_id": registry_row_id,
            "in_registry": True,
            "in_manual": False,
            "data_source": "registry",
            "source_record_id": build_run_id,
            "calc_version": calc_version,
            "quality_status": reg_q_status,
            "quality_issue": reg_q_issue,
        }

    in_manual = bool(existing.get("in_manual"))
    if not in_manual:
        return {
            "stat_year": stat_year,
            "enterprise_id": enterprise_id,
            "enterprise_name": registry_enterprise_name,
            "state_investor": reg_si,
            "state_investor_unified_credit_code": registry_state_investor_code,
            "is_member": registry_is_member,
            "registry_row_id": registry_row_id,
            "in_registry": True,
            "in_manual": False,
            "data_source": "registry",
            "source_record_id": build_run_id,
            "calc_version": calc_version,
            "quality_status": reg_q_status,
            "quality_issue": reg_q_issue,
            "manual_note": existing.get("manual_note"),
        }

    manual_si = str(existing.get("state_investor") or "").strip()
    manual_si_code = existing.get("state_investor_unified_credit_code")
    manual_name = str(existing.get("enterprise_name") or "").strip() or enterprise_id
    manual_is_member = bool(existing.get("is_member", True))

    merged_name = manual_name
    name_conflict = _field_conflict(manual_name, registry_enterprise_name)
    if not name_conflict:
        merged_name = registry_enterprise_name or manual_name

    conflicts: list[str] = []
    if _field_conflict(manual_si, reg_si):
        conflicts.append(f"国家出资企业不一致（人工：{manual_si}；台账：{reg_si}）")
    manual_code_s = str(manual_si_code or "").strip()
    reg_code_s = str(registry_state_investor_code or "").strip()
    if manual_code_s and reg_code_s and norm_enterprise_id(manual_code_s) != norm_enterprise_id(reg_code_s):
        conflicts.append(
            f"国家出资企业税号不一致（人工：{manual_code_s}；台账：{reg_code_s}）"
        )
    if manual_is_member != registry_is_member:
        conflicts.append(
            f"有效成员不一致（人工：{'是' if manual_is_member else '否'}；台账：{'是' if registry_is_member else '否'}）"
        )
    if name_conflict:
        conflicts.append(f"企业名称不一致（人工：{manual_name}；台账：{registry_enterprise_name}）")

    if conflicts:
        q_status = "conflict"
        q_issue = "；".join(conflicts)
    else:
        q_status = reg_q_status
        q_issue = reg_q_issue

    return {
        "stat_year": stat_year,
        "enterprise_id": enterprise_id,
        "enterprise_name": merged_name,
        "state_investor": manual_si or reg_si,
        "state_investor_unified_credit_code": manual_si_code or registry_state_investor_code,
        "is_member": manual_is_member,
        "registry_row_id": registry_row_id,
        "in_registry": True,
        "in_manual": True,
        "data_source": "registry+manual",
        "source_record_id": build_run_id,
        "calc_version": calc_version,
        "quality_status": q_status,
        "quality_issue": q_issue,
        "manual_note": existing.get("manual_note"),
    }


def build_manual_row(
    *,
    stat_year: int,
    enterprise_id: str,
    enterprise_name: str,
    state_investor: str,
    state_investor_unified_credit_code: str | None,
    is_member: bool,
    manual_note: str | None,
    existing: dict[str, Any] | None,
    source_record_id: str,
) -> dict[str, Any]:
    """单条人工新增/编辑写入。"""
    si = str(state_investor or "").strip() or "（未维护国家出资企业）"
    q_status, q_issue = registry_quality(
        state_investor=si,
        state_investor_unified_credit_code=state_investor_unified_credit_code,
    )

    in_registry = bool(existing.get("in_registry")) if existing else False
    reg_si = ""
    reg_si_code = None
    if existing:
        reg_si = str(
            existing.get("registry_state_investor")
            or existing.get("_registry_state_investor")
            or existing.get("_registry_snapshot_state_investor")
            or ""
        ).strip()
        reg_si_code = existing.get("registry_state_investor_unified_credit_code")
    if in_registry and existing:
        reg_si = str(existing.get("_registry_snapshot_state_investor") or reg_si).strip()
        conflicts: list[str] = []
        if reg_si and _field_conflict(si, reg_si):
            conflicts.append(f"国家出资企业不一致（人工：{si}；台账：{reg_si}）")
        reg_code = str(existing.get("_registry_snapshot_state_investor_code") or reg_si_code or "").strip()
        manual_code = str(state_investor_unified_credit_code or "").strip()
        if manual_code and reg_code and norm_enterprise_id(manual_code) != norm_enterprise_id(reg_code):
            conflicts.append(f"国家出资企业税号不一致（人工：{manual_code}；台账：{reg_code}）")
        if conflicts:
            q_status = "conflict"
            q_issue = "；".join(conflicts)

    in_manual = True
    data_source = derive_data_source(in_registry=in_registry, in_manual=in_manual)

    row: dict[str, Any] = {
        "stat_year": stat_year,
        "enterprise_id": enterprise_id,
        "enterprise_name": enterprise_name.strip() or enterprise_id,
        "state_investor": si,
        "state_investor_unified_credit_code": state_investor_unified_credit_code,
        "is_member": is_member,
        "registry_row_id": existing.get("registry_row_id") if existing else None,
        "in_registry": in_registry,
        "in_manual": in_manual,
        "data_source": data_source,
        "source_record_id": source_record_id,
        "calc_version": "v2",
        "quality_status": q_status,
        "quality_issue": q_issue,
        "manual_note": manual_note,
    }
    return row


def roster_row_to_dict(row: tuple[Any, ...] | None, columns: list[str]) -> dict[str, Any] | None:
    if not row:
        return None
    return {col: row[i] for i, col in enumerate(columns)}


ROSTER_FETCH_COLUMNS = [
    "enterprise_name",
    "state_investor",
    "state_investor_unified_credit_code",
    "is_member",
    "registry_row_id",
    "in_registry",
    "in_manual",
    "data_source",
    "quality_status",
    "quality_issue",
    "manual_note",
]
