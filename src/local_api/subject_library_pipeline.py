"""主体库一键全流程：独立父级 run 台账 + 步骤级 progress heartbeat。"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from src.local_api.dim_task_registry import TASK_CODE_SUBJECT_PIPELINE, TASK_NAME_SUBJECT_PIPELINE
from src.local_api.subject_library_task_run import (
    TASK_CODE_SUBJECT_INGEST,
    TASK_CODE_SUBJECT_RECOMPUTE,
    TASK_CODE_SUBJECT_RENAME,
    TASK_NAME_SUBJECT_INGEST,
    TASK_NAME_SUBJECT_RECOMPUTE,
    TASK_NAME_SUBJECT_RENAME,
    record_subject_library_task_run,
    record_subject_library_task_run_running,
)

logger = logging.getLogger(__name__)

_pipeline_jobs_lock = threading.Lock()
_pipeline_jobs: dict[str, dict[str, Any]] = {}


def snapshot_active_pipeline_jobs() -> list[dict[str, Any]]:
    with _pipeline_jobs_lock:
        return [
            {
                "task_code": TASK_CODE_SUBJECT_PIPELINE,
                "task_name": TASK_NAME_SUBJECT_PIPELINE,
                "run_id": str(j.get("run_id") or ""),
                "status": str(j.get("status") or ""),
                "message": str(j.get("message") or ""),
                "step": str(j.get("step") or ""),
                "started_at_ms": j.get("started_at_ms"),
            }
            for j in _pipeline_jobs.values()
            if str(j.get("status") or "") in ("queued", "running")
        ]


def start_subject_library_pipeline(
    *,
    overwrite_manual_repairs: bool = False,
    with_relations: bool = True,
) -> dict[str, Any]:
    """后台执行全流程，立即返回 pipeline run_id。"""
    run_id = f"pipeline_{int(time.time())}"
    started_ts = time.time()
    params = {
        "overwrite_manual_repairs": overwrite_manual_repairs,
        "with_relations": with_relations,
    }
    with _pipeline_jobs_lock:
        _pipeline_jobs[run_id] = {
            "run_id": run_id,
            "status": "queued",
            "step": "queued",
            "message": "排队中，即将开始全流程…",
            "started_at_ms": started_ts * 1000.0,
            "ledger_started_ts": started_ts,
        }
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(
            run_id=run_id,
            task_code=TASK_CODE_SUBJECT_PIPELINE,
            task_name=TASK_NAME_SUBJECT_PIPELINE,
            run_mode="chained",
            params=params,
            started_at_ts=started_ts,
            progress_message="排队中，即将开始全流程…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 pipeline running 台账失败（后台仍会继续）")

    t = threading.Thread(
        target=_run_subject_library_pipeline_job,
        args=(run_id, overwrite_manual_repairs, with_relations),
        daemon=True,
    )
    t.start()
    return {
        "ok": True,
        "async": True,
        "run_id": run_id,
        "task_code": TASK_CODE_SUBJECT_PIPELINE,
        "message": "已启动全流程后台任务，请在任务中心查看进度。",
    }


def get_subject_library_pipeline_status(run_id: str) -> dict[str, Any]:
    rid = (run_id or "").strip()
    if not rid:
        return {"ok": False, "error": {"message": "run_id 不能为空"}}
    with _pipeline_jobs_lock:
        job = _pipeline_jobs.get(rid)
    if job is not None:
        return {
            "ok": True,
            "run_id": rid,
            "task_code": TASK_CODE_SUBJECT_PIPELINE,
            "status": job.get("status"),
            "step": job.get("step"),
            "message": job.get("message"),
            "result": job.get("result"),
        }
    return _pipeline_status_from_task_log(rid)


def _pipeline_status_from_task_log(run_id: str) -> dict[str, Any]:
    from db.duckdb_conn import get_conn
    from db.schema_sqlfiles import init_all_tables

    try:
        conn = get_conn()
        init_all_tables(conn)
        row = conn.execute(
            """
            SELECT status, result_json, error_message
            FROM ads_etl_task_run_log
            WHERE run_id = ? AND task_code = ?
            LIMIT 1
            """,
            [run_id, TASK_CODE_SUBJECT_PIPELINE],
        ).fetchone()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": f"读取台账失败：{exc}"}}

    if row is None:
        return {"ok": False, "error": {"message": "run_id 不存在"}}

    st = str(row[0] or "").strip().lower()
    return {
        "ok": True,
        "run_id": run_id,
        "task_code": TASK_CODE_SUBJECT_PIPELINE,
        "status": st,
        "restored_from_task_log": True,
        "message": str(row[2] or "") if st == "failed" else "已从台账恢复",
        "result": row[1],
    }


def _pipeline_progress(run_id: str, *, step: str, message: str) -> None:
    with _pipeline_jobs_lock:
        job = _pipeline_jobs.get(run_id)
        if job is not None:
            job["status"] = "running"
            job["step"] = step
            job["message"] = message
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_progress

        record_dim_task_run_progress(run_id, step=step, message=message)
    except Exception:  # noqa: BLE001
        logger.exception("更新 pipeline progress 失败")


def _run_subject_library_pipeline_job(
    run_id: str,
    overwrite_manual_repairs: bool,
    with_relations: bool,
) -> None:
    from db.duckdb_conn import get_conn
    from db.schema_sqlfiles import init_all_tables
    from src.local_api.dwd_to_dim_build import record_dim_task_run
    from src.local_api.subject_library_dwd_ingest import ingest_dim_subject_master_from_dwd
    from src.local_api.subject_library_rename_build import start_subject_rename_signal_rebuild
    from src.subject_category.recompute import (
        recompute_org_subject_categories,
        recompute_org_subject_categories_and_relations,
    )

    started_ts = time.time()
    with _pipeline_jobs_lock:
        j = _pipeline_jobs.get(run_id)
        if j is not None:
            started_ts = float(j.get("ledger_started_ts") or started_ts)

    child_runs: dict[str, Any] = {}
    result: dict[str, Any] = {"ok": False}

    try:
        _pipeline_progress(run_id, step="ingest", message="步骤 1/3：从 DWD 归集主体…")
        ingest_run_id = f"{run_id}_ingest"
        record_subject_library_task_run_running(
            run_id=ingest_run_id,
            task_code=TASK_CODE_SUBJECT_INGEST,
            task_name=TASK_NAME_SUBJECT_INGEST,
            params={"overwrite_manual_repairs": overwrite_manual_repairs, "parent_run_id": run_id},
            started_at_ts=time.time(),
        )
        conn = get_conn()
        init_all_tables(conn)
        ingest_result = ingest_dim_subject_master_from_dwd(
            conn,
            run_id=ingest_run_id,
            overwrite_manual_repairs=overwrite_manual_repairs,
        )
        record_subject_library_task_run(
            run_id=str(ingest_result.get("run_id") or ingest_run_id),
            task_code=TASK_CODE_SUBJECT_INGEST,
            task_name=TASK_NAME_SUBJECT_INGEST,
            result=ingest_result,
            rows_affected=int(ingest_result.get("subjects_upserted") or 0),
            params={"overwrite_manual_repairs": overwrite_manual_repairs, "parent_run_id": run_id},
            started_at_ts=time.time(),
        )
        child_runs["ingest"] = ingest_result
        if not ingest_result.get("ok"):
            raise RuntimeError(str(ingest_result.get("error") or "DWD 归集失败"))

        _pipeline_progress(run_id, step="recompute", message="步骤 2/3：重算分类与关联…")
        recompute_run_id = f"{run_id}_recompute"
        record_subject_library_task_run_running(
            run_id=recompute_run_id,
            task_code=TASK_CODE_SUBJECT_RECOMPUTE,
            task_name=TASK_NAME_SUBJECT_RECOMPUTE,
            params={
                "with_relations": with_relations,
                "overwrite_manual_repairs": overwrite_manual_repairs,
                "parent_run_id": run_id,
            },
            started_at_ts=time.time(),
        )
        if with_relations:
            recompute_result = recompute_org_subject_categories_and_relations(
                conn,
                run_id=recompute_run_id,
                overwrite_manual_repairs=overwrite_manual_repairs,
            )
        else:
            recompute_result = recompute_org_subject_categories(
                conn,
                run_id=recompute_run_id,
                overwrite_manual_repairs=overwrite_manual_repairs,
            )
        cat_block = (
            recompute_result.get("category") if isinstance(recompute_result.get("category"), dict) else recompute_result
        )
        ledger_recompute_id = str(
            (cat_block or {}).get("run_id") or recompute_result.get("run_id") or recompute_run_id
        )
        record_subject_library_task_run(
            run_id=ledger_recompute_id,
            task_code=TASK_CODE_SUBJECT_RECOMPUTE,
            task_name=TASK_NAME_SUBJECT_RECOMPUTE,
            result=recompute_result,
            rows_affected=int((cat_block or {}).get("matched") or 0),
            params={
                "with_relations": with_relations,
                "overwrite_manual_repairs": overwrite_manual_repairs,
                "parent_run_id": run_id,
            },
            started_at_ts=time.time(),
        )
        child_runs["recompute"] = recompute_result
        if not recompute_result.get("ok"):
            raise RuntimeError(str(recompute_result.get("error") or "分类重算失败"))

        _pipeline_progress(run_id, step="rename", message="步骤 3/3：重建更名信号…")
        rename_start = start_subject_rename_signal_rebuild(async_mode=True)
        child_runs["rename_start"] = rename_start
        if not rename_start.get("ok"):
            raise RuntimeError(str((rename_start.get("error") or {}).get("message") or "更名信号启动失败"))
        rename_run_id = str(rename_start.get("run_id") or "")
        if rename_start.get("async") and rename_run_id:
            _wait_rename_done(run_id, rename_run_id)
        elif not rename_start.get("async"):
            child_runs["rename"] = rename_start
        else:
            raise RuntimeError("更名信号未返回 run_id")

        result = {
            "ok": True,
            "run_id": run_id,
            "child_runs": child_runs,
            "subjects_upserted": int(ingest_result.get("subjects_upserted") or 0),
            "message": "全流程完成",
        }
        record_dim_task_run(
            run_id=run_id,
            task_code=TASK_CODE_SUBJECT_PIPELINE,
            task_name=TASK_NAME_SUBJECT_PIPELINE,
            status="success",
            run_mode="chained",
            params={
                "overwrite_manual_repairs": overwrite_manual_repairs,
                "with_relations": with_relations,
            },
            result=result,
            rows_affected=int(ingest_result.get("subjects_upserted") or 0),
            started_at_ts=started_ts,
        )
        with _pipeline_jobs_lock:
            job = _pipeline_jobs.get(run_id)
            if job is not None:
                job["status"] = "success"
                job["step"] = "done"
                job["message"] = result.get("message") or "完成"
                job["result"] = result
    except Exception as exc:  # noqa: BLE001
        logger.exception("主体库全流程失败")
        err_msg = str(exc)
        result = {"ok": False, "error": {"message": err_msg}, "child_runs": child_runs}
        try:
            record_dim_task_run(
                run_id=run_id,
                task_code=TASK_CODE_SUBJECT_PIPELINE,
                task_name=TASK_NAME_SUBJECT_PIPELINE,
                status="failed",
                run_mode="chained",
                params={
                    "overwrite_manual_repairs": overwrite_manual_repairs,
                    "with_relations": with_relations,
                },
                result=result,
                rows_affected=0,
                error_message=err_msg,
                started_at_ts=started_ts,
            )
        except Exception:  # noqa: BLE001
            logger.exception("写入 pipeline 失败台账异常")
        with _pipeline_jobs_lock:
            job = _pipeline_jobs.get(run_id)
            if job is not None:
                job["status"] = "failed"
                job["step"] = "failed"
                job["message"] = err_msg
                job["result"] = result


def _wait_rename_done(pipeline_run_id: str, rename_run_id: str) -> None:
    from src.local_api.subject_library_rename_build import get_subject_rename_rebuild_status

    deadline = time.time() + 2 * 60 * 60
    poll_s = 1.5
    while time.time() < deadline:
        st = get_subject_rename_rebuild_status(rename_run_id)
        msg = str(st.get("message") or "正在重建更名信号…")
        _pipeline_progress(pipeline_run_id, step="rename", message=f"步骤 3/3：{msg}")
        status = str(st.get("status") or "").lower()
        if status in ("success", "failed"):
            if status == "failed":
                err = st.get("error") if isinstance(st.get("error"), dict) else {"message": msg}
                raise RuntimeError(str(err.get("message") or "更名信号重建失败"))
            return
        time.sleep(poll_s)
    raise RuntimeError("等待更名信号重建超时")
