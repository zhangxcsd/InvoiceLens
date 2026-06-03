"""DWD→DIM 任务注册表（后端单一来源，供 /api/dim/tasks 与任务中心 UI 对齐）。"""

from __future__ import annotations

from typing import Any

TASK_CODE_SUBJECT_PIPELINE = "subject_library_pipeline"
TASK_NAME_SUBJECT_PIPELINE = "主体库 · 一键全流程（归集→重算→更名）"

DIM_TASK_REGISTRY: list[dict[str, Any]] = [
    {
        "task_code": "subject_master_ingest_from_dwd",
        "task_name": "主体库 · 从 DWD 归集",
        "domain": "主体库",
        "subject_category": "SC-ENT",
        "output_table": "dim_subject_master",
        "trigger_modes": ["manual", "chained"],
        "depends_on": ["dwd_inv_header"],
        "owner": "维度组",
    },
    {
        "task_code": "subject_category_recompute",
        "task_name": "主体库 · 重算（分类+关联）",
        "domain": "主体库",
        "subject_category": "SC-ENT",
        "output_table": "dim_subject_master / dim_subject_category_snapshot",
        "trigger_modes": ["manual", "chained"],
        "depends_on": ["subject_master_ingest_from_dwd"],
        "owner": "维度组",
    },
    {
        "task_code": "subject_rename_signal",
        "task_name": "主体库 · 重建更名信号",
        "domain": "主体库",
        "subject_category": "SC-ENT",
        "output_table": "dim_subject_rename_signal",
        "trigger_modes": ["manual"],
        "depends_on": ["dim_subject_master"],
        "owner": "维度组",
    },
    {
        "task_code": TASK_CODE_SUBJECT_PIPELINE,
        "task_name": TASK_NAME_SUBJECT_PIPELINE,
        "domain": "主体库",
        "subject_category": "SC-ENT",
        "output_table": "dim_subject_master / dim_subject_rename_signal",
        "trigger_modes": ["manual", "chained"],
        "depends_on": ["dwd_inv_header"],
        "owner": "维度组",
    },
    {
        "task_code": "enterprise_master_build",
        "task_name": "全量企业主数据构建",
        "domain": "企业组织维度",
        "subject_category": "SC-ENT",
        "output_table": "dim_enterprise_master",
        "trigger_modes": ["manual", "chained", "scheduled"],
        "depends_on": ["dwd_inv_header"],
        "owner": "维度组",
    },
    {
        "task_code": "group_enterprise_year_build",
        "task_name": "集团成员表 · 从管理与产权台账计算",
        "domain": "企业组织维度",
        "subject_category": "SC-ENT",
        "output_table": "dim_group_enterprise_year",
        "trigger_modes": ["manual", "chained"],
        "depends_on": ["dim_audited_enterprise_registry"],
        "owner": "维度组",
    },
    {
        "task_code": "enterprise_mapping_check",
        "task_name": "企业↔票主体映射检查",
        "domain": "企业组织维度",
        "subject_category": "SC-BRANCH",
        "output_table": "dwd_enterprise_mapping_status",
        "trigger_modes": ["manual", "chained"],
        "depends_on": ["enterprise_master_build"],
        "owner": "风控组",
    },
    {
        "task_code": "enterprise_profile_agg",
        "task_name": "企业发票画像聚合",
        "domain": "企业组织维度",
        "subject_category": "SC-TEMP",
        "output_table": "dws_enterprise_invoice_profile",
        "trigger_modes": ["manual", "scheduled"],
        "depends_on": ["enterprise_master_build"],
        "owner": "数据平台组",
    },
]


def registry_task_codes() -> list[str]:
    return [str(x.get("task_code") or "").strip() for x in DIM_TASK_REGISTRY if str(x.get("task_code") or "").strip()]


def registry_by_code() -> dict[str, dict[str, Any]]:
    return {str(x["task_code"]): x for x in DIM_TASK_REGISTRY if x.get("task_code")}
