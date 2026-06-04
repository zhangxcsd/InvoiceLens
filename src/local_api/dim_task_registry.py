"""DWD→DIM 任务注册表（后端单一来源，供 /api/dim/tasks 与任务中心 UI 对齐）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_CATALOG_PATH = _PROJECT_ROOT / "config" / "dim_task_catalog.json"

TASK_CODE_SUBJECT_PIPELINE = "subject_library_pipeline"
TASK_NAME_SUBJECT_PIPELINE = "主体库 · 一键全流程（归集→重算→更名）"


def _load_dim_task_catalog() -> list[dict[str, Any]]:
    try:
        raw = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, list) and raw:
            return [dict(x) for x in raw if isinstance(x, dict)]
    except Exception:
        pass
    return []


DIM_TASK_REGISTRY: list[dict[str, Any]] = _load_dim_task_catalog()

# 兼容：目录缺失时仍保留最小常量（避免 import 失败）
if not DIM_TASK_REGISTRY:
    DIM_TASK_REGISTRY = [
        {
            "task_no": 4,
            "task_code": TASK_CODE_SUBJECT_PIPELINE,
            "task_name": TASK_NAME_SUBJECT_PIPELINE,
            "domain": "主体库",
            "output_table": "dim_subject_master",
            "trigger_modes": ["manual", "chained"],
            "depends_on": ["dwd_inv_header"],
            "owner": "维度组",
        }
    ]


def registry_task_codes() -> list[str]:
    return [str(x.get("task_code") or "").strip() for x in DIM_TASK_REGISTRY if str(x.get("task_code") or "").strip()]


def registry_by_code() -> dict[str, dict[str, Any]]:
    return {str(x["task_code"]): x for x in DIM_TASK_REGISTRY if x.get("task_code")}
