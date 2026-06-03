"""DWD→DIM 长任务：后台线程执行 + progress heartbeat（企业维度等）。"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, str], None]


def want_async_mode(body: object, *, default: bool = True) -> bool:
    if not isinstance(body, dict) or "async" not in body:
        return default
    v = body.get("async")
    if v is False or v == 0:
        return False
    if isinstance(v, str) and v.strip().lower() in {"0", "false", "no", "off"}:
        return False
    return True


def _progress_fn(run_id: str) -> ProgressFn:
    def _fn(step: str, message: str) -> None:
        try:
            from src.local_api.dwd_to_dim_build import record_dim_task_run_progress

            record_dim_task_run_progress(run_id, step=step, message=message)
        except Exception:  # noqa: BLE001
            logger.exception("更新任务 progress 失败 run_id=%s", run_id)

    return _fn


def _spawn(job: Callable[[], None]) -> None:
    threading.Thread(target=job, daemon=True).start()


def start_async_enterprise_master_build(
    *,
    import_batch_id: str | None,
    subject_category_scope: str | None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"enterprise_master_{int(time.time())}"
    started = time.time()
    params = {"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope}
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code="enterprise_master_build",
            task_name="全量企业主数据构建",
            run_mode="incremental",
            params=params,
            started_at_ts=started,
            progress_message="排队中，即将开始企业主数据构建…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 enterprise_master running 台账失败")

    def _job() -> None:
        _run_enterprise_master_job(rid, started, import_batch_id, subject_category_scope)

    _spawn(_job)
    return {
        "ok": True,
        "async": True,
        "run_id": rid,
        "task_code": "enterprise_master_build",
        "message": "已启动后台构建，请在任务中心查看进度。",
    }


def _run_enterprise_master_job(
    run_id: str,
    started_ts: float,
    import_batch_id: str | None,
    subject_category_scope: str | None,
) -> None:
    progress = _progress_fn(run_id)
    try:
        from src.local_api.dwd_to_dim_build import build_dim_enterprise_master_task, record_dim_task_run

        progress("start", "正在构建 dim_enterprise…")
        payload = build_dim_enterprise_master_task(
            import_batch_id=import_batch_id,
            subject_category_scope=subject_category_scope,
            run_id=run_id,
            on_progress=progress,
        )
        rows = int(payload.get("rows_affected") or 0)
        record_dim_task_run(
            run_id=str(payload.get("run_id") or run_id),
            task_code="enterprise_master_build",
            task_name="全量企业主数据构建",
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            result=payload,
            rows_affected=rows,
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            import_batch_id=import_batch_id,
            started_at_ts=started_ts,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("后台 enterprise_master 构建失败")
        _record_failed(
            run_id=run_id,
            task_code="enterprise_master_build",
            task_name="全量企业主数据构建",
            started_ts=started_ts,
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            exc=exc,
        )


def start_async_enterprise_profile_build(
    *,
    stat_month: str | None,
    import_batch_id: str | None,
    calc_batch_id: str | None,
    source_scope: str | None,
    subject_category_scope: str | None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"enterprise_profile_{int(time.time())}"
    started = time.time()
    params = {
        "stat_month": stat_month,
        "import_batch_id": import_batch_id,
        "calc_batch_id": calc_batch_id,
        "source_scope": source_scope,
        "subject_category_scope": subject_category_scope,
    }
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code="enterprise_profile_agg",
            task_name="企业发票画像聚合",
            run_mode="incremental",
            params=params,
            started_at_ts=started,
            progress_message="排队中，即将开始企业画像聚合…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 enterprise_profile running 台账失败")

    def _job() -> None:
        _run_enterprise_profile_job(
            rid,
            started,
            stat_month,
            import_batch_id,
            calc_batch_id,
            source_scope,
            subject_category_scope,
        )

    _spawn(_job)
    return {
        "ok": True,
        "async": True,
        "run_id": rid,
        "task_code": "enterprise_profile_agg",
        "message": "已启动后台聚合，请在任务中心查看进度。",
    }


def _run_enterprise_profile_job(
    run_id: str,
    started_ts: float,
    stat_month: str | None,
    import_batch_id: str | None,
    calc_batch_id: str | None,
    source_scope: str | None,
    subject_category_scope: str | None,
) -> None:
    progress = _progress_fn(run_id)
    params = {
        "stat_month": stat_month,
        "import_batch_id": import_batch_id,
        "calc_batch_id": calc_batch_id,
        "source_scope": source_scope,
        "subject_category_scope": subject_category_scope,
    }
    try:
        from src.local_api.dwd_to_dim_build import build_dim_enterprise_profile, record_dim_task_run

        progress("start", "正在聚合企业发票画像…")
        payload = build_dim_enterprise_profile(
            stat_month=stat_month,
            import_batch_id=import_batch_id,
            calc_batch_id=calc_batch_id,
            source_scope=source_scope,
            subject_category_scope=subject_category_scope,
            run_id=run_id,
            on_progress=progress,
        )
        rows = int(payload.get("profile_rows_written") or 0)
        record_dim_task_run(
            run_id=str(payload.get("run_id") or run_id),
            task_code="enterprise_profile_agg",
            task_name="企业发票画像聚合",
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params=params,
            result=payload,
            rows_affected=rows,
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            calc_batch_id=str(payload.get("calc_batch_id") or calc_batch_id or ""),
            import_batch_id=import_batch_id,
            started_at_ts=started_ts,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("后台 enterprise_profile 构建失败")
        _record_failed(
            run_id=run_id,
            task_code="enterprise_profile_agg",
            task_name="企业发票画像聚合",
            started_ts=started_ts,
            params=params,
            exc=exc,
        )


def start_async_enterprise_mapping_build(
    *,
    import_batch_id: str | None,
    subject_category_scope: str | None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"enterprise_mapping_{int(time.time())}"
    started = time.time()
    params = {"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope}
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code="enterprise_mapping_check",
            task_name="企业↔票主体映射检查",
            run_mode="incremental",
            params=params,
            started_at_ts=started,
            progress_message="排队中，即将开始映射检查…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 enterprise_mapping running 台账失败")

    def _job() -> None:
        _run_enterprise_mapping_job(rid, started, import_batch_id, subject_category_scope)

    _spawn(_job)
    return {
        "ok": True,
        "async": True,
        "run_id": rid,
        "task_code": "enterprise_mapping_check",
        "message": "已启动后台映射检查，请在任务中心查看进度。",
    }


def _run_enterprise_mapping_job(
    run_id: str,
    started_ts: float,
    import_batch_id: str | None,
    subject_category_scope: str | None,
) -> None:
    progress = _progress_fn(run_id)
    try:
        from src.local_api.dwd_to_dim_build import build_dim_enterprise_mapping_task, record_dim_task_run

        progress("start", "正在检查企业↔票主体映射…")
        payload = build_dim_enterprise_mapping_task(
            import_batch_id=import_batch_id,
            subject_category_scope=subject_category_scope,
            run_id=run_id,
            on_progress=progress,
        )
        rows = int(payload.get("rows_affected") or 0)
        record_dim_task_run(
            run_id=str(payload.get("run_id") or run_id),
            task_code="enterprise_mapping_check",
            task_name="企业↔票主体映射检查",
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            result=payload,
            rows_affected=rows,
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            import_batch_id=import_batch_id,
            started_at_ts=started_ts,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("后台 enterprise_mapping 构建失败")
        _record_failed(
            run_id=run_id,
            task_code="enterprise_mapping_check",
            task_name="企业↔票主体映射检查",
            started_ts=started_ts,
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            exc=exc,
        )


def run_enterprise_master_sync(
    *,
    import_batch_id: str | None,
    subject_category_scope: str | None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"enterprise_master_{int(time.time())}"
    started = time.time()
    progress = _progress_fn(rid)
    try:
        from src.local_api.dwd_to_dim_build import build_dim_enterprise_master_task, record_dim_task_run, record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code="enterprise_master_build",
            task_name="全量企业主数据构建",
            run_mode="incremental",
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            started_at_ts=started,
            progress_message="正在构建 dim_enterprise…",
            progress_step="start",
        )
        payload = build_dim_enterprise_master_task(
            import_batch_id=import_batch_id,
            subject_category_scope=subject_category_scope,
            run_id=rid,
            on_progress=progress,
        )
        record_dim_task_run(
            run_id=str(payload.get("run_id") or rid),
            task_code="enterprise_master_build",
            task_name="全量企业主数据构建",
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            result=payload,
            rows_affected=int(payload.get("rows_affected") or 0),
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            import_batch_id=import_batch_id,
            started_at_ts=started,
        )
        return payload
    except Exception as exc:
        _record_failed(
            run_id=rid,
            task_code="enterprise_master_build",
            task_name="全量企业主数据构建",
            started_ts=started,
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            exc=exc,
        )
        return {"ok": False, "error": {"message": str(exc)}}


def run_enterprise_profile_sync(
    *,
    stat_month: str | None,
    import_batch_id: str | None,
    calc_batch_id: str | None,
    source_scope: str | None,
    subject_category_scope: str | None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"enterprise_profile_{int(time.time())}"
    started = time.time()
    progress = _progress_fn(rid)
    params = {
        "stat_month": stat_month,
        "import_batch_id": import_batch_id,
        "calc_batch_id": calc_batch_id,
        "source_scope": source_scope,
        "subject_category_scope": subject_category_scope,
    }
    try:
        from src.local_api.dwd_to_dim_build import build_dim_enterprise_profile, record_dim_task_run, record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code="enterprise_profile_agg",
            task_name="企业发票画像聚合",
            run_mode="incremental",
            params=params,
            started_at_ts=started,
            progress_message="正在聚合企业发票画像…",
            progress_step="start",
        )
        payload = build_dim_enterprise_profile(
            stat_month=stat_month,
            import_batch_id=import_batch_id,
            calc_batch_id=calc_batch_id,
            source_scope=source_scope,
            subject_category_scope=subject_category_scope,
            run_id=rid,
            on_progress=progress,
        )
        record_dim_task_run(
            run_id=str(payload.get("run_id") or rid),
            task_code="enterprise_profile_agg",
            task_name="企业发票画像聚合",
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params=params,
            result=payload,
            rows_affected=int(payload.get("profile_rows_written") or 0),
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            calc_batch_id=str(payload.get("calc_batch_id") or calc_batch_id or ""),
            import_batch_id=import_batch_id,
            started_at_ts=started,
        )
        return payload
    except Exception as exc:
        _record_failed(run_id=rid, task_code="enterprise_profile_agg", task_name="企业发票画像聚合", started_ts=started, params=params, exc=exc)
        return {"ok": False, "error": {"message": str(exc)}}


def run_enterprise_mapping_sync(
    *,
    import_batch_id: str | None,
    subject_category_scope: str | None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"enterprise_mapping_{int(time.time())}"
    started = time.time()
    progress = _progress_fn(rid)
    try:
        from src.local_api.dwd_to_dim_build import build_dim_enterprise_mapping_task, record_dim_task_run, record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code="enterprise_mapping_check",
            task_name="企业↔票主体映射检查",
            run_mode="incremental",
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            started_at_ts=started,
            progress_message="正在检查企业↔票主体映射…",
            progress_step="start",
        )
        payload = build_dim_enterprise_mapping_task(
            import_batch_id=import_batch_id,
            subject_category_scope=subject_category_scope,
            run_id=rid,
            on_progress=progress,
        )
        record_dim_task_run(
            run_id=str(payload.get("run_id") or rid),
            task_code="enterprise_mapping_check",
            task_name="企业↔票主体映射检查",
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            result=payload,
            rows_affected=int(payload.get("rows_affected") or 0),
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            import_batch_id=import_batch_id,
            started_at_ts=started,
        )
        return payload
    except Exception as exc:
        _record_failed(
            run_id=rid,
            task_code="enterprise_mapping_check",
            task_name="企业↔票主体映射检查",
            started_ts=started,
            params={"import_batch_id": import_batch_id, "subject_category_scope": subject_category_scope},
            exc=exc,
        )
        return {"ok": False, "error": {"message": str(exc)}}


TASK_CODE_GROUP_ENTERPRISE_YEAR = "group_enterprise_year_build"
TASK_NAME_GROUP_ENTERPRISE_YEAR = "集团成员表 · 从管理与产权台账计算"


def start_async_subject_category_recompute(
    *,
    with_relations: bool = False,
    overwrite_manual_repairs: bool = False,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"subject_recompute_{int(time.time())}"
    started = time.time()
    params = {
        "with_relations": with_relations,
        "overwrite_manual_repairs": overwrite_manual_repairs,
    }
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running
        from src.local_api.subject_library_task_run import TASK_CODE_SUBJECT_RECOMPUTE, TASK_NAME_SUBJECT_RECOMPUTE

        record_dim_task_run_running(
            run_id=rid,
            task_code=TASK_CODE_SUBJECT_RECOMPUTE,
            task_name=TASK_NAME_SUBJECT_RECOMPUTE,
            run_mode="incremental",
            params=params,
            started_at_ts=started,
            progress_message="排队中，即将开始主体分类重算…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 subject_recompute running 台账失败")

    def _job() -> None:
        _run_subject_category_recompute_job(
            rid,
            started,
            with_relations=with_relations,
            overwrite_manual_repairs=overwrite_manual_repairs,
        )

    _spawn(_job)
    return {
        "ok": True,
        "async": True,
        "run_id": rid,
        "task_code": TASK_CODE_SUBJECT_RECOMPUTE,
        "message": "已启动后台重算，请查看下方进度。",
    }


def _run_subject_category_recompute_job(
    run_id: str,
    started_ts: float,
    *,
    with_relations: bool,
    overwrite_manual_repairs: bool,
) -> None:
    progress = _progress_fn(run_id)
    params = {"with_relations": with_relations, "overwrite_manual_repairs": overwrite_manual_repairs}
    try:
        from db.duckdb_conn import get_conn
        from db.schema_sqlfiles import init_all_tables
        from src.local_api.subject_library_task_run import (
            TASK_CODE_SUBJECT_RECOMPUTE,
            TASK_NAME_SUBJECT_RECOMPUTE,
            record_subject_library_task_run,
        )
        from src.subject_category.recompute import (
            recompute_org_subject_categories,
            recompute_org_subject_categories_and_relations,
        )

        conn = get_conn()
        init_all_tables(conn)
        if with_relations:
            progress("start", "开始重算：分类快照 + 主体关联…")
            result = recompute_org_subject_categories_and_relations(
                conn,
                run_id=run_id,
                overwrite_manual_repairs=overwrite_manual_repairs,
                on_progress=progress,
            )
        else:
            progress("category", "正在重算机构主体分类（不含关联）…")
            result = recompute_org_subject_categories(
                conn,
                run_id=run_id,
                overwrite_manual_repairs=overwrite_manual_repairs,
            )
        cat_block = result.get("category") if isinstance(result.get("category"), dict) else result
        rows = int((cat_block or {}).get("matched") or 0)
        progress("finalize", "重算完成，正在写入运行台账…")
        ok_result = isinstance(result, dict) and result.get("ok") is not False
        if not ok_result:
            err_msg = str((result.get("error") or {}).get("message") or "分类重算失败")
            raise RuntimeError(err_msg)
        record_subject_library_task_run(
            run_id=str((cat_block or {}).get("run_id") or result.get("run_id") or run_id),
            task_code=TASK_CODE_SUBJECT_RECOMPUTE,
            task_name=TASK_NAME_SUBJECT_RECOMPUTE,
            result={**result, "ok": True},
            rows_affected=rows,
            params=params,
            started_at_ts=started_ts,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("后台 subject_category_recompute 失败")
        from src.local_api.subject_library_task_run import TASK_CODE_SUBJECT_RECOMPUTE, TASK_NAME_SUBJECT_RECOMPUTE

        _record_failed(
            run_id=run_id,
            task_code=TASK_CODE_SUBJECT_RECOMPUTE,
            task_name=TASK_NAME_SUBJECT_RECOMPUTE,
            started_ts=started_ts,
            params=params,
            exc=exc,
        )


def start_async_group_enterprise_year_build(
    *,
    stat_years: list[int] | None = None,
    replace_years: bool = True,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = (run_id or "").strip() or f"group_year_{int(time.time())}"
    started = time.time()
    params = {"stat_years": stat_years or [], "replace_years": replace_years}
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(
            run_id=rid,
            task_code=TASK_CODE_GROUP_ENTERPRISE_YEAR,
            task_name=TASK_NAME_GROUP_ENTERPRISE_YEAR,
            run_mode="incremental",
            params=params,
            started_at_ts=started,
            progress_message="排队中，即将从「管理与产权层级信息」计算集团成员表…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 group_enterprise_year running 台账失败")

    def _job() -> None:
        _run_group_enterprise_year_job(rid, started, stat_years=stat_years, replace_years=replace_years)

    _spawn(_job)
    return {
        "ok": True,
        "async": True,
        "run_id": rid,
        "task_code": TASK_CODE_GROUP_ENTERPRISE_YEAR,
        "message": "已启动后台计算，请查看下方进度。",
    }


def _run_group_enterprise_year_job(
    run_id: str,
    started_ts: float,
    *,
    stat_years: list[int] | None,
    replace_years: bool,
) -> None:
    progress = _progress_fn(run_id)
    params = {"stat_years": stat_years or [], "replace_years": replace_years}
    try:
        from db.duckdb_conn import get_conn
        from db.schema_sqlfiles import init_all_tables
        from src.local_api.dwd_to_dim_build import record_dim_task_run
        from src.local_api.group_enterprise_year_build import rebuild_group_enterprise_year_from_registry

        conn = get_conn()
        init_all_tables(conn)
        progress("start", "正在读取 dim_audited_enterprise_registry（管理与产权层级信息）…")
        payload = rebuild_group_enterprise_year_from_registry(
            conn,
            stat_years=stat_years,
            replace_years=replace_years,
            run_id=run_id,
            on_progress=progress,
        )
        rows = int(payload.get("rows_written") or payload.get("total_written") or 0)
        record_dim_task_run(
            run_id=run_id,
            task_code=TASK_CODE_GROUP_ENTERPRISE_YEAR,
            task_name=TASK_NAME_GROUP_ENTERPRISE_YEAR,
            status="success" if payload.get("ok") else "failed",
            run_mode="incremental",
            params=params,
            result=payload,
            rows_affected=rows,
            error_message=None if payload.get("ok") else str((payload.get("error") or {}).get("message") or ""),
            started_at_ts=started_ts,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("后台 group_enterprise_year 构建失败")
        _record_failed(
            run_id=run_id,
            task_code=TASK_CODE_GROUP_ENTERPRISE_YEAR,
            task_name=TASK_NAME_GROUP_ENTERPRISE_YEAR,
            started_ts=started_ts,
            params=params,
            exc=exc,
        )


def _record_failed(
    *,
    run_id: str,
    task_code: str,
    task_name: str,
    started_ts: float,
    params: dict[str, Any],
    exc: Exception,
) -> None:
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run

        record_dim_task_run(
            run_id=run_id,
            task_code=task_code,
            task_name=task_name,
            status="failed",
            run_mode="incremental",
            params=params,
            result={"ok": False, "error": {"message": str(exc)}},
            rows_affected=0,
            error_message=str(exc),
            started_at_ts=started_ts,
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入失败台账异常 task_code=%s", task_code)
