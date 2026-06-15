"""分析关键路径 · 一键任务链（串行编排 dim_task_catalog 关键步骤）。"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables

logger = logging.getLogger(__name__)

TASK_CODE_DIM_CHAIN = "dim.analysis_critical_chain"
TASK_NAME_DIM_CHAIN = "分析关键路径 · 一键任务链"

# 与 config/dim_task_catalog.json 依赖对齐；dws.rebuild 为 DWS 层补充步骤（scorecard 依赖 dws_inv_trend）
CHAIN_STEP_DEFS: list[dict[str, str]] = [
    {"step_id": "subject_library_pipeline", "task_code": "subject_library_pipeline", "label": "主体库全流程"},
    {"step_id": "enterprise_year_roster_build", "task_code": "enterprise_year_roster_build", "label": "花名册台账同步"},
    {"step_id": "group_enterprise_year_build", "task_code": "group_enterprise_year_build", "label": "集团成员表"},
    {"step_id": "dim.org_hier.build", "task_code": "dim.org_hier.build", "label": "组织层级双树重算"},
    {"step_id": "dim.enterprise_year_rel.rebuild", "task_code": "dim.enterprise_year_rel.rebuild", "label": "年度购销标志"},
    {"step_id": "dws.rebuild", "task_code": "dws.rebuild", "label": "DWS 汇总重建（含进销偏离）"},
    {"step_id": "dm.audit_flag.scan", "task_code": "dm.audit_flag.scan", "label": "审计疑点扫描"},
    {"step_id": "ads.scorecard.refresh", "task_code": "ads.scorecard.refresh", "label": "子公司评分卡"},
]

_CHAIN_TASK_CODES = {s["task_code"] for s in CHAIN_STEP_DEFS} | {
    "subject_master_ingest_from_dwd",
    "subject_category_recompute",
    "subject_rename_signal",
}

_RUNS_STORE_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "task_chain_runs.json"
_MAX_PERSISTED_RUNS = 20

_chain_jobs_lock = threading.Lock()
_chain_jobs: dict[str, dict[str, Any]] = {}
_active_chain_run_id: str | None = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _load_runs_store() -> dict[str, Any]:
    if not _RUNS_STORE_PATH.is_file():
        return {"runs": []}
    try:
        raw = json.loads(_RUNS_STORE_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("runs"), list):
            return raw
    except Exception as exc:  # noqa: BLE001
        logger.warning("read task chain runs store: %s", exc)
    return {"runs": []}


def _save_runs_store(store: dict[str, Any]) -> None:
    try:
        _RUNS_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _RUNS_STORE_PATH.write_text(
            json.dumps(store, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        logger.exception("persist task chain runs store failed")


def _persist_run_record(record: dict[str, Any]) -> None:
    rid = str(record.get("run_id") or "").strip()
    if not rid:
        return
    store = _load_runs_store()
    runs: list[dict[str, Any]] = list(store.get("runs") or [])
    replaced = False
    for i, row in enumerate(runs):
        if str(row.get("run_id") or "") == rid:
            runs[i] = record
            replaced = True
            break
    if not replaced:
        runs.insert(0, record)
    runs.sort(key=lambda r: str(r.get("started_at") or ""), reverse=True)
    store["runs"] = runs[:_MAX_PERSISTED_RUNS]
    _save_runs_store(store)


def _get_persisted_run(run_id: str) -> dict[str, Any] | None:
    store = _load_runs_store()
    for row in store.get("runs") or []:
        if str(row.get("run_id") or "") == run_id:
            return dict(row)
    return None


def _instance_config_snapshot() -> dict[str, Any]:
    snap: dict[str, Any] = {}
    try:
        from src.local_api.settings_api import get_effective_instance_config, get_setting

        inst = get_effective_instance_config()
        snap["default_stat_year"] = inst.get("default_stat_year")
        snap["instance_id"] = inst.get("instance_id")
        snap["min_analysis_subject_invoice_count"] = get_setting("min_analysis_subject_invoice_count", 10)
    except Exception:  # noqa: BLE001
        logger.exception("build instance config snapshot failed")
    return snap


def _effective_chain_step_defs(*, skip_subject_pipeline: bool) -> list[dict[str, str]]:
    if skip_subject_pipeline:
        return [s for s in CHAIN_STEP_DEFS if s["step_id"] != "subject_library_pipeline"]
    return list(CHAIN_STEP_DEFS)


def _init_step_rows(*, skip_subject_pipeline: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sdef in _effective_chain_step_defs(skip_subject_pipeline=skip_subject_pipeline):
        rows.append(
            {
                "step_id": sdef["step_id"],
                "task_code": sdef["task_code"],
                "label": sdef["label"],
                "status": "pending",
                "started_at": None,
                "finished_at": None,
                "duration_ms": None,
                "error_message": None,
                "retry_count": 0,
                "result": None,
            }
        )
    return rows


def _derive_overall_status(steps: list[dict[str, Any]], *, terminal: bool) -> str:
    if not steps:
        return "failed" if terminal else "running"
    statuses = {str(s.get("status") or "") for s in steps}
    if not terminal:
        if "running" in statuses:
            return "running"
        if "failed" in statuses:
            return "partial" if any(str(s.get("status") or "") == "success" for s in steps) else "failed"
        return "running"
    if all(str(s.get("status") or "") == "success" for s in steps):
        return "success"
    if any(str(s.get("status") or "") == "success" for s in steps):
        return "partial"
    return "failed"


def _sync_job_record(run_id: str) -> None:
    with _chain_jobs_lock:
        job = _chain_jobs.get(run_id)
    if job is None:
        return
    record = {
        "run_id": run_id,
        "parent_run_id": job.get("parent_run_id"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "overall_status": job.get("overall_status") or job.get("status"),
        "status": job.get("status"),
        "step": job.get("step"),
        "message": job.get("message"),
        "params": job.get("params") or {},
        "stat_years": job.get("stat_years"),
        "instance_snapshot": job.get("instance_snapshot") or {},
        "steps": job.get("steps") or [],
        "result": job.get("result"),
    }
    _persist_run_record(record)


def snapshot_active_chain_jobs() -> list[dict[str, Any]]:
    with _chain_jobs_lock:
        return [
            {
                "task_code": TASK_CODE_DIM_CHAIN,
                "task_name": TASK_NAME_DIM_CHAIN,
                "run_id": str(j.get("run_id") or ""),
                "status": str(j.get("status") or j.get("overall_status") or ""),
                "message": str(j.get("message") or ""),
                "step": str(j.get("step") or ""),
                "started_at_ms": j.get("started_at_ms"),
            }
            for j in _chain_jobs.values()
            if str(j.get("status") or j.get("overall_status") or "") in ("queued", "running")
        ]


def _chain_busy_message(*, exclude_run_id: str | None = None) -> str | None:
    with _chain_jobs_lock:
        active = _active_chain_run_id
        if active and active != exclude_run_id:
            job = _chain_jobs.get(active) or {}
            return f"任务链已在执行（run_id={active}，步骤={job.get('step') or '…'}）"
    try:
        from src.local_api.dwd_to_dim_build import summarize_dim_task_status

        summary = summarize_dim_task_status(task_codes=sorted(_CHAIN_TASK_CODES))
        running = [t for t in summary.get("tasks") or [] if t.get("status") == "running"]
        if running:
            codes = ", ".join(str(t.get("task_code") or "") for t in running[:3])
            return f"相关任务仍在运行，请稍后再试：{codes}"
    except Exception:
        pass
    try:
        from src.local_api.subject_library_pipeline import snapshot_active_pipeline_jobs

        jobs = snapshot_active_pipeline_jobs()
        if jobs:
            return "主体库全流程仍在运行，请稍后再试"
    except Exception:
        pass
    try:
        from src.local_api.enterprise_year_rel_build import rel_rebuild_busy_message

        rel_busy = rel_rebuild_busy_message(exclude_run_id=exclude_run_id)
        if rel_busy:
            return rel_busy
    except Exception:
        pass
    return None


def list_dim_task_chain_runs(*, limit: int = 20) -> dict[str, Any]:
    lim = max(1, min(int(limit or 20), 50))
    store = _load_runs_store()
    runs = list(store.get("runs") or [])[:lim]
    with _chain_jobs_lock:
        active_ids = {str(j.get("run_id") or "") for j in _chain_jobs.values()}
    for rid, job in list(_chain_jobs.items()):
        if rid in {str(r.get("run_id") or "") for r in runs}:
            continue
        if str(job.get("status") or job.get("overall_status") or "") in ("queued", "running", "success", "failed", "partial"):
            runs.insert(
                0,
                {
                    "run_id": rid,
                    "parent_run_id": job.get("parent_run_id"),
                    "started_at": job.get("started_at"),
                    "finished_at": job.get("finished_at"),
                    "overall_status": job.get("overall_status") or job.get("status"),
                    "message": job.get("message"),
                    "stat_years": job.get("stat_years"),
                    "instance_snapshot": job.get("instance_snapshot") or {},
                    "steps": job.get("steps") or [],
                    "active": True,
                },
            )
    runs = runs[:lim]
    return {"ok": True, "runs": runs, "active_run_ids": sorted(active_ids)}


def start_dim_task_chain(
    *,
    stat_years: list[int] | None = None,
    overwrite_manual_repairs: bool = False,
    with_relations: bool = True,
    skip_subject_pipeline: bool = False,
) -> dict[str, Any]:
    busy = _chain_busy_message()
    if busy:
        return {"ok": False, "error": {"message": busy, "exception_type": "ConflictError"}}

    run_id = f"chain_{uuid.uuid4().hex[:12]}"
    started_ts = time.time()
    started_at = _utc_now_iso()
    params = {
        "stat_years": stat_years,
        "overwrite_manual_repairs": overwrite_manual_repairs,
        "with_relations": with_relations,
        "skip_subject_pipeline": skip_subject_pipeline,
    }
    steps = _init_step_rows(skip_subject_pipeline=skip_subject_pipeline)
    instance_snapshot = _instance_config_snapshot()
    global _active_chain_run_id
    with _chain_jobs_lock:
        _active_chain_run_id = run_id
        _chain_jobs[run_id] = {
            "run_id": run_id,
            "parent_run_id": None,
            "status": "queued",
            "overall_status": "running",
            "step": "queued",
            "message": "排队中，即将开始关键路径任务链…",
            "started_at": started_at,
            "finished_at": None,
            "started_at_ms": started_ts * 1000.0,
            "ledger_started_ts": started_ts,
            "params": params,
            "stat_years": None,
            "instance_snapshot": instance_snapshot,
            "steps": steps,
        }
    _sync_job_record(run_id)
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(
            run_id=run_id,
            task_code=TASK_CODE_DIM_CHAIN,
            task_name=TASK_NAME_DIM_CHAIN,
            trigger_source="task_chain",
            run_mode="chained",
            params={**params, "instance_snapshot": instance_snapshot},
            started_at_ts=started_ts,
            progress_message="排队中…",
            progress_step="queued",
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入任务链 running 台账失败")

    t = threading.Thread(
        target=_run_dim_task_chain_job,
        args=(run_id, stat_years, overwrite_manual_repairs, with_relations, skip_subject_pipeline, None),
        daemon=True,
    )
    t.start()
    return {
        "ok": True,
        "async": True,
        "run_id": run_id,
        "task_code": TASK_CODE_DIM_CHAIN,
        "steps": [s["step_id"] for s in steps],
        "instance_snapshot": instance_snapshot,
        "message": "已启动分析关键路径任务链，请查看进度。",
    }


def retry_dim_task_chain_step(*, run_id: str, step_id: str, continue_chain: bool = True) -> dict[str, Any]:
    rid = (run_id or "").strip()
    sid = (step_id or "").strip()
    if not rid or not sid:
        return {"ok": False, "error": {"message": "run_id 与 step_id 不能为空"}}

    busy = _chain_busy_message(exclude_run_id=rid)
    if busy:
        return {"ok": False, "error": {"message": busy, "exception_type": "ConflictError"}}

    with _chain_jobs_lock:
        job = _chain_jobs.get(rid)
    if job is None:
        job = _get_persisted_run(rid)
    if job is None:
        return {"ok": False, "error": {"message": "run_id 不存在"}}

    overall = str(job.get("overall_status") or job.get("status") or "").lower()
    if overall in ("running", "queued"):
        return {"ok": False, "error": {"message": "任务链仍在执行中，请稍后再试"}}

    steps: list[dict[str, Any]] = list(job.get("steps") or [])
    target = next((s for s in steps if str(s.get("step_id") or "") == sid), None)
    if target is None:
        return {"ok": False, "error": {"message": f"步骤 {sid} 不存在于该次运行"}}

    target_status = str(target.get("status") or "").lower()
    if target_status not in ("failed", "pending"):
        return {"ok": False, "error": {"message": f"步骤 {sid} 当前状态为 {target_status}，仅失败或待执行步骤可重试"}}

    params = dict(job.get("params") or {})
    stat_years = params.get("stat_years")
    if isinstance(stat_years, list):
        stat_years = [int(y) for y in stat_years if 1990 <= int(y) <= 2100] or None
    else:
        stat_years = job.get("stat_years")
        if isinstance(stat_years, list):
            stat_years = [int(y) for y in stat_years if 1990 <= int(y) <= 2100] or None
        else:
            stat_years = None

    target["retry_count"] = int(target.get("retry_count") or 0) + 1
    target["status"] = "pending"
    target["error_message"] = None
    target["started_at"] = None
    target["finished_at"] = None
    target["duration_ms"] = None

    started_ts = time.time()
    started_at = job.get("started_at") or _utc_now_iso()
    global _active_chain_run_id
    with _chain_jobs_lock:
        _active_chain_run_id = rid
        _chain_jobs[rid] = {
            "run_id": rid,
            "parent_run_id": job.get("parent_run_id"),
            "status": "running",
            "overall_status": "running",
            "step": sid,
            "message": f"重试步骤：{target.get('label') or sid}…",
            "started_at": started_at,
            "finished_at": None,
            "started_at_ms": started_ts * 1000.0,
            "ledger_started_ts": float(job.get("ledger_started_ts") or started_ts),
            "params": params,
            "stat_years": job.get("stat_years"),
            "instance_snapshot": job.get("instance_snapshot") or _instance_config_snapshot(),
            "steps": steps,
            "retry_from_step_id": sid,
            "single_step_only": not continue_chain,
        }
    _sync_job_record(rid)

    t = threading.Thread(
        target=_run_dim_task_chain_job,
        args=(
            rid,
            stat_years,
            bool(params.get("overwrite_manual_repairs")),
            bool(params.get("with_relations", True)),
            bool(params.get("skip_subject_pipeline")),
            sid,
            not continue_chain,
        ),
        daemon=True,
    )
    t.start()
    return {
        "ok": True,
        "async": True,
        "run_id": rid,
        "step_id": sid,
        "retry_count": target["retry_count"],
        "continue_chain": continue_chain,
        "message": f"已开始{'重试' if not continue_chain else '从步骤继续'} {target.get('label') or sid}",
    }


def get_dim_task_chain_status(run_id: str) -> dict[str, Any]:
    rid = (run_id or "").strip()
    if not rid:
        return {"ok": False, "error": {"message": "run_id 不能为空"}}
    with _chain_jobs_lock:
        job = _chain_jobs.get(rid)
    if job is not None:
        return _status_payload_from_job(rid, job)
    persisted = _get_persisted_run(rid)
    if persisted is not None:
        return _status_payload_from_job(rid, persisted, restored=True)
    return _chain_status_from_task_log(rid)


def _status_payload_from_job(run_id: str, job: dict[str, Any], *, restored: bool = False) -> dict[str, Any]:
    steps = job.get("steps") or []
    overall = job.get("overall_status") or job.get("status")
    return {
        "ok": True,
        "run_id": run_id,
        "task_code": TASK_CODE_DIM_CHAIN,
        "status": overall,
        "overall_status": overall,
        "step": job.get("step"),
        "message": job.get("message"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "steps": steps,
        "stat_years": job.get("stat_years"),
        "instance_snapshot": job.get("instance_snapshot") or {},
        "params": job.get("params") or {},
        "result": job.get("result"),
        "restored_from_store": restored,
    }


def _chain_status_from_task_log(run_id: str) -> dict[str, Any]:
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
            [run_id, TASK_CODE_DIM_CHAIN],
        ).fetchone()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": f"读取台账失败：{exc}"}}
    if row is None:
        return {"ok": False, "error": {"message": "run_id 不存在"}}
    st = str(row[0] or "").strip().lower()
    result_raw = row[1]
    result: dict[str, Any] = {}
    if isinstance(result_raw, dict):
        result = result_raw
    elif isinstance(result_raw, str) and result_raw.strip():
        try:
            result = json.loads(result_raw)
        except Exception:
            result = {}
    legacy_steps = result.get("steps") if isinstance(result.get("steps"), list) else []
    return {
        "ok": True,
        "run_id": run_id,
        "task_code": TASK_CODE_DIM_CHAIN,
        "status": st,
        "overall_status": st,
        "restored_from_task_log": True,
        "message": str(row[2] or "") if st == "failed" else "已从台账恢复",
        "steps": legacy_steps,
        "result": result,
    }


def _find_step_row(steps: list[dict[str, Any]], step_id: str) -> dict[str, Any] | None:
    return next((s for s in steps if str(s.get("step_id") or "") == step_id), None)


def _mark_step_running(steps: list[dict[str, Any]], step_id: str) -> None:
    row = _find_step_row(steps, step_id)
    if row is None:
        return
    row["status"] = "running"
    row["started_at"] = _utc_now_iso()
    row["finished_at"] = None
    row["duration_ms"] = None
    row["error_message"] = None


def _mark_step_success(steps: list[dict[str, Any]], step_id: str, *, result: dict[str, Any]) -> None:
    row = _find_step_row(steps, step_id)
    if row is None:
        return
    finished = _utc_now_iso()
    started = row.get("started_at")
    duration_ms = None
    if started:
        try:
            t0 = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(finished.replace("Z", "+00:00"))
            duration_ms = int((t1 - t0).total_seconds() * 1000)
        except Exception:
            duration_ms = None
    row["status"] = "success"
    row["finished_at"] = finished
    row["duration_ms"] = duration_ms
    row["error_message"] = None
    row["result"] = result


def _mark_step_skipped(steps: list[dict[str, Any]], step_id: str, *, message: str, result: dict[str, Any] | None = None) -> None:
    row = _find_step_row(steps, step_id)
    if row is None:
        return
    finished = _utc_now_iso()
    row["status"] = "skipped"
    row["finished_at"] = finished
    row["duration_ms"] = 0
    row["error_message"] = None
    row["result"] = result or {"ok": True, "skipped": True, "message": message}


def _mark_step_failed(steps: list[dict[str, Any]], step_id: str, *, error_message: str, result: dict[str, Any] | None = None) -> None:
    row = _find_step_row(steps, step_id)
    if row is None:
        return
    finished = _utc_now_iso()
    started = row.get("started_at")
    duration_ms = None
    if started:
        try:
            t0 = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(finished.replace("Z", "+00:00"))
            duration_ms = int((t1 - t0).total_seconds() * 1000)
        except Exception:
            duration_ms = None
    row["status"] = "failed"
    row["finished_at"] = finished
    row["duration_ms"] = duration_ms
    row["error_message"] = error_message
    if result is not None:
        row["result"] = result


def _chain_progress(
    run_id: str,
    *,
    step: str,
    message: str,
    steps: list[dict[str, Any]] | None = None,
    stat_years: list[int] | None = None,
) -> None:
    with _chain_jobs_lock:
        job = _chain_jobs.get(run_id)
        if job is not None:
            job["status"] = "running"
            job["overall_status"] = "running"
            job["step"] = step
            job["message"] = message
            if steps is not None:
                job["steps"] = steps
                job["overall_status"] = _derive_overall_status(steps, terminal=False)
            if stat_years is not None:
                job["stat_years"] = stat_years
    _sync_job_record(run_id)
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_progress

        record_dim_task_run_progress(run_id, step=step, message=message, extra={"steps": steps} if steps else None)
    except Exception:  # noqa: BLE001
        logger.exception("更新任务链 progress 失败")


def _resolve_years(conn: Any, stat_years: list[int] | None) -> list[int]:
    if stat_years:
        return sorted({int(y) for y in stat_years if 1990 <= int(y) <= 2100})
    from src.local_api.enterprise_year_rel_build import _merge_auto_target_years

    return _merge_auto_target_years(conn)


def _wait_subject_pipeline(parent_run_id: str, pipeline_run_id: str, steps: list[dict[str, Any]]) -> dict[str, Any]:
    from src.local_api.subject_library_pipeline import get_subject_library_pipeline_status

    deadline = time.time() + 2 * 60 * 60
    poll_s = 1.5
    while time.time() < deadline:
        st = get_subject_library_pipeline_status(pipeline_run_id)
        msg = str(st.get("message") or "主体库全流程执行中…")
        _chain_progress(
            parent_run_id,
            step="subject_library_pipeline",
            message=f"主体库全流程：{msg}",
            steps=steps,
        )
        status = str(st.get("status") or "").lower()
        if status in ("success", "failed"):
            if status == "failed":
                err = st.get("error") if isinstance(st.get("error"), dict) else {"message": msg}
                raise RuntimeError(str(err.get("message") or "主体库全流程失败"))
            return st
        time.sleep(poll_s)
    raise RuntimeError("等待主体库全流程超时")


def _execute_chain_step(
    *,
    run_id: str,
    step_id: str,
    conn: Any,
    years: list[int],
    steps: list[dict[str, Any]],
    overwrite_manual_repairs: bool,
    with_relations: bool,
    step_idx: int,
    total_steps: int,
) -> None:
    label = str((_find_step_row(steps, step_id) or {}).get("label") or step_id)
    _mark_step_running(steps, step_id)
    _chain_progress(
        run_id,
        step=step_id,
        message=f"步骤 {step_idx}/{total_steps}：{label}…",
        steps=steps,
        stat_years=years,
    )

    if step_id == "subject_library_pipeline":
        from src.local_api.subject_library_pipeline import start_subject_library_pipeline

        pipe_start = start_subject_library_pipeline(
            overwrite_manual_repairs=overwrite_manual_repairs,
            with_relations=with_relations,
        )
        if not pipe_start.get("ok"):
            raise RuntimeError(str((pipe_start.get("error") or {}).get("message") or "主体库全流程启动失败"))
        pipe_run_id = str(pipe_start.get("run_id") or "")
        if not pipe_run_id:
            raise RuntimeError("主体库全流程未返回 run_id")
        pipe_result = _wait_subject_pipeline(run_id, pipe_run_id, steps)
        _mark_step_success(steps, step_id, result={"ok": True, "run_id": pipe_run_id, **pipe_result})
        return

    if step_id == "enterprise_year_roster_build":
        from src.local_api.enterprise_year_roster_build import rebuild_enterprise_year_roster_from_registry

        roster_result = rebuild_enterprise_year_roster_from_registry(
            conn,
            stat_years=years,
            chain_rel_rebuild=False,
            run_id=f"{run_id}_roster",
        )
        if not roster_result.get("ok"):
            raise RuntimeError(str((roster_result.get("error") or {}).get("message") or "花名册同步失败"))
        _mark_step_success(steps, step_id, result=roster_result)
        return

    if step_id == "group_enterprise_year_build":
        from src.local_api.group_enterprise_year_build import rebuild_group_enterprise_year_from_registry

        group_result = rebuild_group_enterprise_year_from_registry(
            conn,
            stat_years=years,
            replace_years=True,
            run_id=f"{run_id}_group_year",
        )
        if not group_result.get("ok"):
            raise RuntimeError(str((group_result.get("error") or {}).get("message") or "集团成员表计算失败"))
        _mark_step_success(steps, step_id, result=group_result)
        return

    if step_id == "dim.org_hier.build":
        from src.local_api.dim_org_hier_build import rebuild_org_hierarchy_paths

        hier_years: list[int] = []
        try:
            if years:
                ph = ",".join("?" * len(years))
                rows = conn.execute(
                    f"SELECT DISTINCT stat_year FROM dim_org_hier WHERE stat_year IN ({ph}) ORDER BY stat_year",
                    years,
                ).fetchall()
                hier_years = [int(r[0]) for r in rows or []]
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"读取 dim_org_hier 年度失败：{exc}") from exc
        if not hier_years:
            _mark_step_skipped(
                steps,
                step_id,
                message="dim_org_hier 无数据，请先在「管理关系树」页导入组织维度 Excel",
                result={"ok": True, "skipped": True, "reason": "no_org_hier_data"},
            )
            return
        org_result = rebuild_org_hierarchy_paths(
            conn,
            stat_years=hier_years,
            run_id=f"{run_id}_org_hier",
        )
        if not org_result.get("ok"):
            raise RuntimeError(str((org_result.get("error") or {}).get("message") or "组织层级重算失败"))
        _mark_step_success(steps, step_id, result=org_result)
        return

    if step_id == "dim.enterprise_year_rel.rebuild":
        from src.local_api.enterprise_year_rel_build import rebuild_dim_enterprise_year_rel

        rel_result = rebuild_dim_enterprise_year_rel(
            conn,
            stat_years=years,
            trigger_source="task_chain",
            run_id=f"{run_id}_rel",
        )
        if not rel_result.get("ok") and not rel_result.get("skipped"):
            raise RuntimeError(str((rel_result.get("error") or {}).get("message") or "年度关系重算失败"))
        _mark_step_success(steps, step_id, result=rel_result)
        return

    if step_id == "dws.rebuild":
        from src.etl.dws_build import refresh_dws_years

        dws_result = refresh_dws_years(conn, stat_years=years, run_id=f"{run_id}_dws")
        if not dws_result.get("ok"):
            raise RuntimeError(str((dws_result.get("error") or {}).get("message") or "DWS 重建失败"))
        _mark_step_success(steps, step_id, result=dws_result)
        try:
            from src.local_api.dws_dashboard_api import sync_tax_deviation_flags_for_years

            tax_sync = sync_tax_deviation_flags_for_years(conn, stat_years=years)
            if not tax_sync.get("ok"):
                logger.warning("tax deviation sync after dws.rebuild: %s", tax_sync)
        except Exception as exc:  # noqa: BLE001
            logger.warning("tax deviation sync failed: %s", exc)
        return

    if step_id == "dm.audit_flag.scan":
        from src.etl.dm_audit_build import refresh_audit_flags

        audit_result = refresh_audit_flags(
            conn,
            stat_years=years,
            trigger_source="task_chain",
        )
        if not audit_result.get("ok"):
            raise RuntimeError(str((audit_result.get("error") or {}).get("message") or "审计扫描失败"))
        _mark_step_success(steps, step_id, result=audit_result)
        return

    if step_id == "ads.scorecard.refresh":
        from src.etl.ads_scorecard_build import refresh_ads_scorecard_years

        score_result = refresh_ads_scorecard_years(conn, stat_years=years)
        if not score_result.get("ok"):
            raise RuntimeError(str((score_result.get("error") or {}).get("message") or "评分卡刷新失败"))
        _mark_step_success(steps, step_id, result=score_result)
        return

    raise RuntimeError(f"未知步骤：{step_id}")


def _run_dim_task_chain_job(
    run_id: str,
    stat_years: list[int] | None,
    overwrite_manual_repairs: bool,
    with_relations: bool,
    skip_subject_pipeline: bool,
    start_from_step_id: str | None,
    single_step_only: bool = False,
) -> None:
    from src.local_api.dwd_to_dim_build import record_dim_task_run

    global _active_chain_run_id
    started_ts = time.time()
    with _chain_jobs_lock:
        j = _chain_jobs.get(run_id)
        if j is not None:
            started_ts = float(j.get("ledger_started_ts") or started_ts)
            steps: list[dict[str, Any]] = list(j.get("steps") or [])
            params = dict(j.get("params") or {})
        else:
            steps = _init_step_rows(skip_subject_pipeline=skip_subject_pipeline)
            params = {
                "stat_years": stat_years,
                "overwrite_manual_repairs": overwrite_manual_repairs,
                "with_relations": with_relations,
                "skip_subject_pipeline": skip_subject_pipeline,
            }

    result: dict[str, Any] = {"ok": False}
    years: list[int] = []

    try:
        conn = get_conn()
        init_all_tables(conn)
        years = _resolve_years(conn, stat_years)
        if not years:
            raise RuntimeError("无法推断 stat_year：请先导入发票 DWD 或维护花名册/台账")

        ordered_ids = [str(s.get("step_id") or "") for s in steps]
        if start_from_step_id:
            if start_from_step_id not in ordered_ids:
                raise RuntimeError(f"重试步骤 {start_from_step_id} 不在当前任务链中")
            start_idx = ordered_ids.index(start_from_step_id)
            runnable = [start_from_step_id] if single_step_only else ordered_ids[start_idx:]
        else:
            runnable = ordered_ids

        total_steps = len(ordered_ids)
        for offset, step_id in enumerate(runnable):
            row = _find_step_row(steps, step_id)
            if row and str(row.get("status") or "") == "success" and start_from_step_id and step_id != start_from_step_id:
                continue
            if row and str(row.get("status") or "") == "success" and not start_from_step_id:
                continue
            step_idx = ordered_ids.index(step_id) + 1
            try:
                _execute_chain_step(
                    run_id=run_id,
                    step_id=step_id,
                    conn=conn,
                    years=years,
                    steps=steps,
                    overwrite_manual_repairs=overwrite_manual_repairs,
                    with_relations=with_relations,
                    step_idx=step_idx,
                    total_steps=total_steps,
                )
            except Exception as step_exc:  # noqa: BLE001
                err_msg = str(step_exc)
                _mark_step_failed(steps, step_id, error_message=err_msg, result={"ok": False, "error": {"message": err_msg}})
                _chain_progress(run_id, step=step_id, message=err_msg, steps=steps, stat_years=years)
                raise

        overall = _derive_overall_status(steps, terminal=True)
        if single_step_only and overall == "success" and any(
            str(s.get("status") or "") not in ("success", "skipped") for s in steps
        ):
            overall = "partial"

        result = {
            "ok": overall in ("success", "partial"),
            "run_id": run_id,
            "stat_years": years,
            "steps": steps,
            "message": (
                f"步骤 {start_from_step_id} 重试完成"
                if single_step_only and start_from_step_id
                else f"关键路径任务链完成（{len(years)} 个年度）"
            ),
            "single_step_only": single_step_only,
        }
        finished_at = _utc_now_iso()
        record_dim_task_run(
            run_id=run_id,
            task_code=TASK_CODE_DIM_CHAIN,
            task_name=TASK_NAME_DIM_CHAIN,
            status=overall,
            trigger_source="task_chain",
            run_mode="chained",
            params=params,
            result=result,
            rows_affected=sum(
                int(((s.get("result") or {}) if isinstance(s.get("result"), dict) else {}).get("rows_written") or 0)
                for s in steps
            ),
            started_at_ts=started_ts,
        )
        with _chain_jobs_lock:
            job = _chain_jobs.get(run_id)
            if job is not None:
                job["status"] = overall
                job["overall_status"] = overall
                job["step"] = "done" if overall == "success" else (start_from_step_id or "done")
                job["message"] = result["message"]
                job["result"] = result
                job["steps"] = steps
                job["stat_years"] = years
                job["finished_at"] = finished_at
        _sync_job_record(run_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("任务链失败")
        err_msg = str(exc)
        overall = _derive_overall_status(steps, terminal=True)
        result = {"ok": False, "error": {"message": err_msg}, "steps": steps, "stat_years": years}
        try:
            record_dim_task_run(
                run_id=run_id,
                task_code=TASK_CODE_DIM_CHAIN,
                task_name=TASK_NAME_DIM_CHAIN,
                status="failed" if overall == "failed" else "partial",
                trigger_source="task_chain",
                run_mode="chained",
                params=params,
                result=result,
                rows_affected=0,
                error_message=err_msg,
                started_at_ts=started_ts,
            )
        except Exception:  # noqa: BLE001
            logger.exception("写入任务链失败台账异常")
        finished_at = _utc_now_iso()
        with _chain_jobs_lock:
            job = _chain_jobs.get(run_id)
            if job is not None:
                job["status"] = overall
                job["overall_status"] = overall
                job["step"] = job.get("step") or "failed"
                job["message"] = err_msg
                job["result"] = result
                job["steps"] = steps
                job["stat_years"] = years or job.get("stat_years")
                job["finished_at"] = finished_at
        _sync_job_record(run_id)
    finally:
        with _chain_jobs_lock:
            if _active_chain_run_id == run_id:
                _active_chain_run_id = None
