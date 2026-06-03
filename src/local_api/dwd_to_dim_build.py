from __future__ import annotations

import json
import time
from typing import Any, Callable

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.etl.dwd_to_dim_enterprise_master import build_enterprise_mapping_status, build_enterprise_master
from src.etl.dwd_to_dim_enterprise_profile import build_enterprise_invoice_profile

ProgressFn = Callable[[str, str], None]


def build_dim_enterprise_profile(
    *,
    stat_month: str | None = None,
    import_batch_id: str | None = None,
    calc_batch_id: str | None = None,
    source_scope: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """本地 API 包装：触发 dwd_inv_header -> dws_enterprise_invoice_profile 聚合。"""
    conn = get_conn()
    init_all_tables(conn)
    return build_enterprise_invoice_profile(
        conn=conn,
        stat_month=stat_month,
        import_batch_id=import_batch_id,
        calc_batch_id=calc_batch_id,
        source_scope=source_scope,
        subject_category_scope=subject_category_scope,
        run_id=run_id,
        on_progress=on_progress,
    )


def build_dim_enterprise_master_task(
    *,
    import_batch_id: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    conn = get_conn()
    init_all_tables(conn)
    return build_enterprise_master(
        conn,
        import_batch_id=import_batch_id,
        subject_category_scope=subject_category_scope,
        run_id=run_id,
        on_progress=on_progress,
    )


def build_dim_enterprise_mapping_task(
    *,
    import_batch_id: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    conn = get_conn()
    init_all_tables(conn)
    return build_enterprise_mapping_status(
        conn,
        import_batch_id=import_batch_id,
        subject_category_scope=subject_category_scope,
        run_id=run_id,
        on_progress=on_progress,
    )


def record_dim_task_run(
    *,
    run_id: str,
    task_code: str,
    task_name: str,
    status: str,
    trigger_source: str = "manual_ui",
    run_mode: str | None = None,
    params: dict[str, Any] | None = None,
    result: dict[str, Any] | None = None,
    rows_affected: int | None = None,
    error_message: str | None = None,
    calc_batch_id: str | None = None,
    import_batch_id: str | None = None,
    started_at_ts: float | None = None,
) -> None:
    conn = get_conn()
    init_all_tables(conn)
    finished_at = time.time()
    started = float(started_at_ts) if started_at_ts is not None else finished_at
    duration_ms = int(max(0.0, (finished_at - started) * 1000))
    conn.execute(
        """
        INSERT OR REPLACE INTO ads_etl_task_run_log (
            run_id, task_code, task_name, status, trigger_source, run_mode,
            params_json, result_json, rows_affected, error_message,
            calc_batch_id, import_batch_id, started_at, finished_at, duration_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_timestamp(?), to_timestamp(?), ?)
        """,
        [
            run_id,
            task_code,
            task_name,
            status,
            trigger_source,
            run_mode,
            json.dumps(params or {}, ensure_ascii=False),
            json.dumps(result or {}, ensure_ascii=False),
            int(rows_affected or 0),
            error_message,
            calc_batch_id,
            import_batch_id,
            started,
            finished_at,
            duration_ms,
        ],
    )


def record_dim_task_run_running(
    *,
    run_id: str,
    task_code: str,
    task_name: str,
    trigger_source: str = "manual_ui",
    run_mode: str | None = None,
    params: dict[str, Any] | None = None,
    started_at_ts: float | None = None,
    progress_message: str | None = None,
    progress_step: str | None = None,
) -> None:
    conn = get_conn()
    init_all_tables(conn)
    started = float(started_at_ts) if started_at_ts is not None else time.time()
    progress = _make_progress_payload(
        message=progress_message or "任务已启动…",
        step=progress_step or "start",
        heartbeat_at=started,
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO ads_etl_task_run_log (
            run_id, task_code, task_name, status, trigger_source, run_mode,
            params_json, result_json, rows_affected, error_message,
            calc_batch_id, import_batch_id, started_at, finished_at, duration_ms
        )
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?, 0, NULL, NULL, NULL, to_timestamp(?), NULL, NULL)
        """,
        [
            run_id,
            task_code,
            task_name,
            trigger_source,
            run_mode,
            json.dumps(params or {}, ensure_ascii=False),
            json.dumps({"progress": progress}, ensure_ascii=False),
            started,
        ],
    )


def _make_progress_payload(
    *,
    message: str,
    step: str,
    heartbeat_at: float | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ts = float(heartbeat_at if heartbeat_at is not None else time.time())
    out: dict[str, Any] = {
        "step": step,
        "message": message,
        "heartbeat_at": ts,
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)),
    }
    if extra:
        out.update(extra)
    return out


def record_dim_task_run_progress(
    run_id: str,
    *,
    message: str,
    step: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    rid = str(run_id or "").strip()
    if not rid:
        return
    conn = get_conn()
    init_all_tables(conn)
    try:
        row = conn.execute(
            """
            SELECT result_json
            FROM ads_etl_task_run_log
            WHERE run_id = ? AND lower(status) = 'running' AND finished_at IS NULL
            LIMIT 1
            """,
            [rid],
        ).fetchone()
    except Exception:
        return
    if row is None:
        return
    prev_result: dict[str, Any] = {}
    try:
        if row[0]:
            parsed = json.loads(str(row[0]))
            if isinstance(parsed, dict):
                prev_result = parsed
    except Exception:
        prev_result = {}
    prev_progress = prev_result.get("progress") if isinstance(prev_result.get("progress"), dict) else {}
    step_val = step or str(prev_progress.get("step") or "running")
    merged = {**prev_result, "progress": _make_progress_payload(message=message, step=step_val, extra=extra)}
    try:
        conn.execute(
            """
            UPDATE ads_etl_task_run_log
            SET result_json = ?
            WHERE run_id = ? AND lower(status) = 'running' AND finished_at IS NULL
            """,
            [json.dumps(merged, ensure_ascii=False), rid],
        )
    except Exception:
        pass


def _parse_progress_from_result_json(raw: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(raw)) if raw else {}
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    prog = parsed.get("progress")
    return prog if isinstance(prog, dict) else {}


def _started_at_epoch(started_at_raw: Any) -> float | None:
    if started_at_raw is None:
        return None
    try:
        if isinstance(started_at_raw, (int, float)):
            return float(started_at_raw)
        s = str(started_at_raw).strip()
        if not s:
            return None
        from datetime import datetime

        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(s[:26], fmt).timestamp()
            except ValueError:
                continue
        return None
    except Exception:
        return None


def _normalize_task_run_status(raw: str | None) -> str:
    return str(raw or "").strip().lower()


def _snapshot_active_rename_jobs() -> list[dict[str, Any]]:
    try:
        from src.local_api.subject_library_rename_build import snapshot_active_rename_jobs

        return snapshot_active_rename_jobs()
    except Exception:
        return []


def _snapshot_active_pipeline_jobs() -> list[dict[str, Any]]:
    try:
        from src.local_api.subject_library_pipeline import snapshot_active_pipeline_jobs

        return snapshot_active_pipeline_jobs()
    except Exception:
        return []


def _append_memory_active_run(
    active_runs: list[dict[str, Any]],
    running_by_code: dict[str, dict[str, Any]],
    *,
    job: dict[str, Any],
    now_ts: float,
) -> None:
    code = str(job.get("task_code") or "").strip()
    if not code:
        return
    mem_status = _normalize_task_run_status(str(job.get("status") or ""))
    if mem_status not in ("queued", "running"):
        return
    started_ms = job.get("started_at_ms")
    started_epoch = float(started_ms) / 1000.0 if isinstance(started_ms, (int, float)) else now_ts
    elapsed_ms = int(max(0.0, (now_ts - started_epoch) * 1000))
    mem_run = {
        "task_code": code,
        "run_id": str(job.get("run_id") or ""),
        "started_at": "",
        "task_name": str(job.get("task_name") or ""),
        "progress_step": str(job.get("step") or mem_status),
        "progress_message": str(job.get("message") or ""),
        "heartbeat_at": now_ts,
        "elapsed_ms": elapsed_ms,
        "status": mem_status,
        "source": "memory",
    }
    prev = running_by_code.get(code)
    if prev is None or mem_status == "queued" or str(prev.get("source") or "") != "task_log":
        running_by_code[code] = mem_run
    run_id = mem_run["run_id"]
    if run_id:
        for i, x in enumerate(active_runs):
            if str(x.get("run_id") or "") == run_id:
                active_runs[i] = {**x, **mem_run}
                return
    active_runs.append(mem_run)


def list_dim_task_runs(
    *,
    task_code: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    conn = get_conn()
    init_all_tables(conn)
    lim = max(1, min(int(limit or 20), 100))
    if task_code:
        rows = conn.execute(
            """
            SELECT
              run_id, task_code, task_name, status, trigger_source, run_mode,
              rows_affected, error_message, calc_batch_id, import_batch_id,
              CAST(started_at AS VARCHAR), CAST(finished_at AS VARCHAR), duration_ms
            FROM ads_etl_task_run_log
            WHERE task_code = ?
            ORDER BY started_at DESC
            LIMIT ?
            """,
            [task_code, lim],
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT
              run_id, task_code, task_name, status, trigger_source, run_mode,
              rows_affected, error_message, calc_batch_id, import_batch_id,
              CAST(started_at AS VARCHAR), CAST(finished_at AS VARCHAR), duration_ms
            FROM ads_etl_task_run_log
            ORDER BY started_at DESC
            LIMIT ?
            """,
            [lim],
        ).fetchall()

    data = [
        {
            "run_id": str(r[0] or ""),
            "task_code": str(r[1] or ""),
            "task_name": str(r[2] or ""),
            "status": str(r[3] or ""),
            "trigger_source": str(r[4] or ""),
            "run_mode": str(r[5] or ""),
            "rows_affected": int(r[6] or 0),
            "error_message": str(r[7] or "") if r[7] is not None else "",
            "calc_batch_id": str(r[8] or "") if r[8] is not None else "",
            "import_batch_id": str(r[9] or "") if r[9] is not None else "",
            "started_at": str(r[10] or ""),
            "finished_at": str(r[11] or "") if r[11] is not None else "",
            "duration_ms": int(r[12] or 0),
        }
        for r in rows
    ]
    return {"ok": True, "runs": data}


def summarize_dim_task_status(*, task_codes: list[str] | None = None) -> dict[str, Any]:
    conn = get_conn()
    init_all_tables(conn)
    registered = [str(c or "").strip() for c in (task_codes or []) if str(c or "").strip()]

    latest_by_code: dict[str, dict[str, Any]] = {}
    try:
        rows = conn.execute(
            """
            WITH latest AS (
                SELECT
                    task_code, task_name, status, started_at, finished_at, duration_ms,
                    error_message, run_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY task_code ORDER BY started_at DESC NULLS LAST
                    ) AS rn
                FROM ads_etl_task_run_log
            )
            SELECT task_code, task_name, status,
                   CAST(started_at AS VARCHAR), CAST(finished_at AS VARCHAR),
                   duration_ms, error_message, run_id
            FROM latest WHERE rn = 1
            """
        ).fetchall()
        for r in rows:
            code = str(r[0] or "").strip()
            if code:
                latest_by_code[code] = {
                    "task_code": code,
                    "task_name": str(r[1] or ""),
                    "status": _normalize_task_run_status(str(r[2] or "")),
                    "started_at": str(r[3] or ""),
                    "finished_at": str(r[4] or "") if r[4] is not None else "",
                    "duration_ms": int(r[5] or 0),
                    "error_message": str(r[6] or "") if r[6] is not None else "",
                    "run_id": str(r[7] or ""),
                }
    except Exception:
        latest_by_code = {}

    running_list: list[dict[str, Any]] = []
    running_by_code: dict[str, dict[str, Any]] = {}
    active_runs: list[dict[str, Any]] = []
    now_ts = time.time()
    try:
        running_rows = conn.execute(
            """
            SELECT task_code, run_id, CAST(started_at AS VARCHAR), task_name, result_json, started_at
            FROM ads_etl_task_run_log
            WHERE lower(status) = 'running' AND finished_at IS NULL
            ORDER BY started_at ASC
            """
        ).fetchall()
        for r in running_rows:
            code = str(r[0] or "").strip()
            if not code:
                continue
            started_at = str(r[2] or "")
            progress = _parse_progress_from_result_json(r[4])
            started_epoch = _started_at_epoch(r[5]) or _started_at_epoch(started_at)
            elapsed_ms = int(max(0.0, (now_ts - started_epoch) * 1000)) if started_epoch else 0
            item = {
                "task_code": code,
                "run_id": str(r[1] or ""),
                "started_at": started_at,
                "task_name": str(r[3] or ""),
                "progress_step": str(progress.get("step") or ""),
                "progress_message": str(progress.get("message") or ""),
                "heartbeat_at": progress.get("heartbeat_at"),
                "elapsed_ms": elapsed_ms,
                "status": "running",
                "source": "task_log",
            }
            running_list.append(item)
            running_by_code[code] = item
            active_runs.append(item)
    except Exception:
        pass

    rename_by_code: dict[str, dict[str, Any]] = {}
    for job in _snapshot_active_rename_jobs() + _snapshot_active_pipeline_jobs():
        code = str(job.get("task_code") or "").strip()
        if code:
            rename_by_code[code] = job
        _append_memory_active_run(active_runs, running_by_code, job=job, now_ts=now_ts)

    all_codes = set(registered) | set(latest_by_code.keys()) | set(running_by_code.keys()) | set(rename_by_code.keys())
    iterate_codes = registered if registered else sorted(all_codes)

    tasks: list[dict[str, Any]] = []
    failed_recent: list[dict[str, Any]] = []
    for code in iterate_codes:
        latest = latest_by_code.get(code)
        mem = rename_by_code.get(code)
        mem_status = _normalize_task_run_status(str(mem.get("status") if mem else ""))
        if mem_status == "queued":
            ui_status = "queued"
        elif code in running_by_code or mem_status == "running":
            ui_status = "running"
        elif latest and latest.get("status") == "failed":
            ui_status = "failed"
        else:
            ui_status = "idle"

        task_name = ""
        if latest and latest.get("task_name"):
            task_name = str(latest["task_name"])
        elif mem and mem.get("task_name"):
            task_name = str(mem["task_name"])
        elif code in running_by_code:
            task_name = str(running_by_code[code].get("task_name") or "")

        task_item = {
            "task_code": code,
            "task_name": task_name,
            "status": ui_status,
            "queue_depth": 1 if ui_status == "queued" else 0,
            "last_started_at": str(latest.get("started_at") or "") if latest else "",
            "last_finished_at": str(latest.get("finished_at") or "") if latest else "",
            "last_duration_ms": int(latest.get("duration_ms") or 0) if latest else 0,
            "last_run_status": str(latest.get("status") or "") if latest else "",
            "last_error_message": str(latest.get("error_message") or "") if latest else "",
            "running_run_id": str(running_by_code.get(code, {}).get("run_id") or ""),
            "progress_step": str(running_by_code.get(code, {}).get("progress_step") or ""),
            "progress_message": str(running_by_code.get(code, {}).get("progress_message") or ""),
            "elapsed_ms": int(running_by_code.get(code, {}).get("elapsed_ms") or 0),
        }
        tasks.append(task_item)
        if ui_status == "failed" and latest:
            failed_recent.append(
                {
                    "task_code": code,
                    "task_name": task_name or str(latest.get("task_name") or code),
                    "error_message": str(latest.get("error_message") or "任务失败"),
                    "last_fail_at": str(latest.get("started_at") or ""),
                    "run_id": str(latest.get("run_id") or ""),
                }
            )

    failed_recent.sort(key=lambda x: str(x.get("last_fail_at") or ""), reverse=True)
    stats = {
        "running_count": len(running_list),
        "queued_count": sum(1 for t in tasks if t.get("status") == "queued"),
        "queue_depth_total": sum(int(t.get("queue_depth") or 0) for t in tasks),
    }
    return {
        "ok": True,
        "tasks": tasks,
        "running": running_list,
        "active_runs": active_runs,
        "failed_recent": failed_recent,
        "stats": stats,
    }


def list_unified_dim_tasks() -> dict[str, Any]:
    from src.local_api.dim_task_registry import DIM_TASK_REGISTRY, registry_task_codes

    summary = summarize_dim_task_status(task_codes=registry_task_codes())
    live_by_code = {str(t.get("task_code") or ""): t for t in summary.get("tasks") or []}
    merged_tasks: list[dict[str, Any]] = []
    for reg in DIM_TASK_REGISTRY:
        code = str(reg.get("task_code") or "").strip()
        live = live_by_code.get(code) or {}
        merged_tasks.append(
            {
                **reg,
                "status": live.get("status") or "idle",
                "queue_depth": int(live.get("queue_depth") or 0),
                "last_started_at": live.get("last_started_at") or "",
                "last_finished_at": live.get("last_finished_at") or "",
                "last_duration_ms": int(live.get("last_duration_ms") or 0),
                "last_run_status": live.get("last_run_status") or "",
                "last_error_message": live.get("last_error_message") or "",
                "running_run_id": live.get("running_run_id") or "",
                "progress_step": live.get("progress_step") or "",
                "progress_message": live.get("progress_message") or "",
                "elapsed_ms": int(live.get("elapsed_ms") or 0),
            }
        )
    return {
        "ok": True,
        "registry": DIM_TASK_REGISTRY,
        "tasks": merged_tasks,
        "active_runs": summary.get("active_runs") or [],
        "failed_recent": summary.get("failed_recent") or [],
        "stats": summary.get("stats") or {},
    }


def get_dim_task_run_status(run_id: str) -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        return {"ok": False, "error": {"message": "run_id 不能为空"}}
    conn = get_conn()
    init_all_tables(conn)
    try:
        row = conn.execute(
            """
            SELECT run_id, task_code, task_name, status, rows_affected, error_message,
                   CAST(started_at AS VARCHAR), CAST(finished_at AS VARCHAR), duration_ms, result_json
            FROM ads_etl_task_run_log WHERE run_id = ? LIMIT 1
            """,
            [rid],
        ).fetchone()
    except Exception as exc:
        return {"ok": False, "error": {"message": f"读取运行状态失败：{exc}"}}
    if row is None:
        return {"ok": False, "error": {"message": "run_id 不存在"}}
    progress = _parse_progress_from_result_json(row[9])
    started_epoch = _started_at_epoch(row[6])
    elapsed_ms = 0
    if started_epoch and _normalize_task_run_status(str(row[3] or "")) == "running" and row[7] is None:
        elapsed_ms = int(max(0.0, (time.time() - started_epoch) * 1000))
    return {
        "ok": True,
        "run_id": str(row[0] or ""),
        "task_code": str(row[1] or ""),
        "task_name": str(row[2] or ""),
        "status": str(row[3] or ""),
        "rows_affected": int(row[4] or 0),
        "error_message": str(row[5] or "") if row[5] is not None else "",
        "started_at": str(row[6] or ""),
        "finished_at": str(row[7] or "") if row[7] is not None else "",
        "duration_ms": int(row[8] or 0),
        "progress_step": str(progress.get("step") or ""),
        "progress_message": str(progress.get("message") or ""),
        "heartbeat_at": progress.get("heartbeat_at"),
        "elapsed_ms": elapsed_ms,
    }
