from __future__ import annotations

import json
import time
from typing import Any

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.etl.dwd_to_dim_enterprise_master import build_enterprise_mapping_status, build_enterprise_master
from src.etl.dwd_to_dim_enterprise_profile import build_enterprise_invoice_profile


def build_dim_enterprise_profile(
    *,
    stat_month: str | None = None,
    import_batch_id: str | None = None,
    calc_batch_id: str | None = None,
    source_scope: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
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
    )


def build_dim_enterprise_master_task(
    *,
    import_batch_id: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    conn = get_conn()
    init_all_tables(conn)
    return build_enterprise_master(
        conn,
        import_batch_id=import_batch_id,
        subject_category_scope=subject_category_scope,
        run_id=run_id,
    )


def build_dim_enterprise_mapping_task(
    *,
    import_batch_id: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    conn = get_conn()
    init_all_tables(conn)
    return build_enterprise_mapping_status(
        conn,
        import_batch_id=import_batch_id,
        subject_category_scope=subject_category_scope,
        run_id=run_id,
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

