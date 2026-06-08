"""DM 疑点层构建入口（供 API / 任务编排调用）。"""

from __future__ import annotations

import logging
from typing import Any, Callable

from src.audit.engine import AUTOMATION_TASK_CODE, TASK_DISPLAY_NAME, run_audit_scan

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, str], None] | None


def _safe_record_running(**kwargs: Any) -> None:
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(**kwargs)
    except Exception:
        logger.exception("写入 ads_etl_task_run_log（running）失败")


def _safe_record_done(**kwargs: Any) -> None:
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run

        record_dim_task_run(**kwargs)
    except Exception:
        logger.exception("写入 ads_etl_task_run_log 失败")


def refresh_audit_flags(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    entity_id: str | None = None,
    rule_ids: list[str] | None = None,
    dry_run: bool = False,
    run_id: str | None = None,
    trigger_source: str = "manual_api",
    on_progress: ProgressFn = None,
) -> dict[str, Any]:
    """按年度批量运行审计规则扫描。"""
    years: list[int] = []
    if stat_years:
        years = sorted({int(y) for y in stat_years if 1990 <= int(y) <= 2100})
    if not years:
        try:
            rows = conn.execute(
                "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL ORDER BY 1 DESC"
            ).fetchall()
            years = [int(r[0]) for r in rows or [] if r and r[0] is not None][:5]
        except Exception:
            years = []

    if not years:
        return {"ok": False, "error": {"code": "no_stat_years", "message": "DWD 中无可用 stat_year"}}

    rid = run_id or f"{AUTOMATION_TASK_CODE}_{years[0]}"
    if not dry_run:
        _safe_record_running(
            run_id=rid,
            task_code=AUTOMATION_TASK_CODE,
            task_name=TASK_DISPLAY_NAME,
            trigger_source=trigger_source,
        )

    year_results: list[dict[str, Any]] = []
    total_flags = 0
    try:
        for y in years:
            if on_progress:
                on_progress("year_start", str(y))
            res = run_audit_scan(
                conn,
                stat_year=y,
                entity_id=entity_id,
                rule_ids=rule_ids,
                dry_run=dry_run,
                on_progress=on_progress,
            )
            if not dry_run and res.get("ok"):
                try:
                    from src.audit.config_loader import group_id_for_year
                    from src.etl.dm_related_build import refresh_shell_co

                    gid = group_id_for_year(y)
                    batch = str(res.get("analysis_batch") or rid)
                    shell_cnt = refresh_shell_co(
                        conn, stat_year=y, group_id=gid, analysis_batch=batch
                    )
                    res["shell_count"] = shell_cnt
                    from src.etl.ads_scorecard_build import refresh_ads_scorecard

                    sc_res = refresh_ads_scorecard(
                        conn,
                        stat_year=y,
                        group_id=gid,
                        analysis_batch=batch,
                    )
                    res["scorecard_inserted"] = int(sc_res.get("inserted") or 0)
                except Exception:
                    logger.exception("通道公司/评分卡刷新失败 stat_year=%s", y)
            year_results.append(res)
            total_flags += int(res.get("flag_count") or 0)
        payload = {
            "ok": True,
            "dry_run": dry_run,
            "stat_years": [str(y) for y in years],
            "total_flag_count": total_flags,
            "year_results": year_results,
            "run_id": rid,
        }
        if not dry_run:
            _safe_record_done(
                run_id=rid,
                task_code=AUTOMATION_TASK_CODE,
                task_name=TASK_DISPLAY_NAME,
                trigger_source=trigger_source,
                status="success",
                result=payload,
                rows_affected=total_flags,
            )
        return payload
    except Exception as exc:
        logger.exception("审计疑点扫描失败")
        if not dry_run:
            _safe_record_done(
                run_id=rid,
                task_code=AUTOMATION_TASK_CODE,
                task_name=TASK_DISPLAY_NAME,
                trigger_source=trigger_source,
                status="failed",
                error_message=str(exc),
            )
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
            "run_id": rid,
        }
