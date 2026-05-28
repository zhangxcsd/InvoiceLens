from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

TASK_CODE_SUBJECT_INGEST = "subject_master_ingest_from_dwd"
TASK_NAME_SUBJECT_INGEST = "主体库 · 从 DWD 归集"

TASK_CODE_SUBJECT_RECOMPUTE = "subject_category_recompute"
TASK_NAME_SUBJECT_RECOMPUTE = "主体库 · 重算（分类+关联）"

TASK_CODE_SUBJECT_RENAME = "subject_rename_signal"
TASK_NAME_SUBJECT_RENAME = "主体库 · 重建更名信号"


def record_subject_library_task_run(
    *,
    run_id: str,
    task_code: str,
    task_name: str,
    result: dict[str, Any],
    rows_affected: int = 0,
    params: dict[str, Any] | None = None,
    run_mode: str | None = None,
    trigger_source: str = "dwd_to_dim_ui",
    started_at_ts: float | None = None,
) -> None:
    """将主体库批任务写入 ads_etl_task_run_log（与 DWD→DIM / 派生任务页共用台账）。"""
    from src.local_api.dwd_to_dim_build import record_dim_task_run

    err_obj = result.get("error") if isinstance(result.get("error"), dict) else None
    err_msg = None
    if err_obj:
        err_msg = str(err_obj.get("message") or err_obj.get("detail") or "")
    elif not result.get("ok"):
        err_msg = str(result.get("error") or result.get("message") or "任务失败")
    try:
        record_dim_task_run(
            run_id=run_id,
            task_code=task_code,
            task_name=task_name,
            status="success" if result.get("ok") else "failed",
            trigger_source=trigger_source,
            run_mode=run_mode,
            params=params,
            result=result,
            rows_affected=int(rows_affected or 0),
            error_message=err_msg,
            started_at_ts=started_at_ts if started_at_ts is not None else time.time(),
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 ads_etl_task_run_log（主体库任务 %s）失败，已忽略", task_code)
