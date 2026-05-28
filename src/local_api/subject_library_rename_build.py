"""
主体库 · 更名信号构建（dim_subject_rename_signal）

基于 dwd_inv_header 销/购两侧：同一规范化识别号下出现多个弱规范化展示名时，
按名称首次出现时间排序，相邻不同名生成一条有向边（全历史，不做 stat_year 切片）。

名称比对键 `name_norm`：在空白折叠、小写之外，将全角括号「（」「）」等与半角「()」等
常见全半角标点统一，避免「凯发新泉自来水（德州）」与「凯发新泉自来水(德州)」被误判为更名。

与 dim_subject_master.category_status_note（机构类别治理）解耦。
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Any

from db.schema_sqlfiles import init_all_tables
from src.subject_category.recompute import _make_run_id

logger = logging.getLogger(__name__)

_rename_jobs_lock = threading.Lock()
_rename_jobs: dict[str, dict[str, Any]] = {}

def _sql_rename_name_norm(trimmed_expr_sql: str) -> str:
    """
    展示名 → 比对用 name_norm（与 dim_subject_rename_signal 聚合键一致）。
    trimmed_expr_sql：已 trim 的列表达式，如 trim(COALESCE(name_display,''))。
    """
    e = trimmed_expr_sql.strip()
    # 全角圆括号、直角/全角方括号、全角空格与逗号冒号 → 半角，便于与票面异体统一比对
    _pairs: tuple[tuple[str, str], ...] = (
        ("\uff08", "("),
        ("\uff09", ")"),
        ("\u3010", "["),
        ("\u3011", "]"),
        ("\uff3b", "["),
        ("\uff3d", "]"),
        ("\u3000", " "),
        ("\uff0c", ","),
        ("\uff1a", ":"),
    )

    def _sql_str_lit(s: str) -> str:
        return "'" + s.replace("'", "''") + "'"

    body = e
    for fr, to in _pairs:
        body = f"replace({body}, {_sql_str_lit(fr)}, {_sql_str_lit(to)})"
    return r"lower(trim(regexp_replace(" + body + r", '\s+', ' ', 'g')))"


_NAME_TRIM = "trim(COALESCE(name_display,''))"
_SQL_NAME_NORM = _sql_rename_name_norm(_NAME_TRIM)

# DuckDB：占位符顺序 [run_id, run_id, built_at]
_REBUILD_RENAME_INSERT_SQL = """
INSERT INTO dim_subject_rename_signal (
    signal_id,
    subject_id,
    normalized_subject_no,
    from_name_norm,
    to_name_norm,
    from_name_raw,
    to_name_raw,
    transition_date,
    evidence_invoice_count,
    confidence,
    build_run_id,
    built_at
)
WITH ev AS (
    SELECT
        upper(regexp_replace(trim(COALESCE(xfsbh, '')), '[\\s-]+', '', 'g')) AS pid,
        trim(COALESCE(xfmc, '')) AS name_display,
        CAST(invoice_date AS DATE) AS inv,
        header_uuid
    FROM dwd_inv_header
    WHERE length(trim(COALESCE(xfsbh, ''))) > 0
    UNION ALL
    SELECT
        upper(regexp_replace(trim(COALESCE(gfsbh, '')), '[\\s-]+', '', 'g')),
        trim(COALESCE(gfmc, '')),
        CAST(invoice_date AS DATE),
        header_uuid
    FROM dwd_inv_header
    WHERE length(trim(COALESCE(gfsbh, ''))) > 0
),
n AS (
    SELECT
        pid,
        """ + _SQL_NAME_NORM + r""" AS name_norm,
        NULLIF(""" + _NAME_TRIM + r""", '') AS name_raw,
        inv,
        header_uuid
    FROM ev
    WHERE length(pid) > 0
      AND length(""" + _NAME_TRIM + r""") > 0
      AND length(""" + _SQL_NAME_NORM + r""") > 0
),
agg AS (
    SELECT
        pid,
        name_norm,
        min(inv) AS first_inv,
        min_by(name_raw, concat(cast(inv AS VARCHAR), '|', header_uuid)) AS name_raw_pick,
        count(*)::BIGINT AS cnt
    FROM n
    GROUP BY pid, name_norm
),
ord AS (
    SELECT
        *,
        row_number() OVER (PARTITION BY pid ORDER BY first_inv ASC, name_norm ASC) AS ordn
    FROM agg
),
pairs AS (
    SELECT
        o1.pid,
        o1.name_norm AS from_norm,
        o2.name_norm AS to_norm,
        o1.name_raw_pick AS from_raw,
        o2.name_raw_pick AS to_raw,
        o2.first_inv AS transition_date,
        (o1.cnt + o2.cnt)::BIGINT AS evidence_invoice_count
    FROM ord o1
    INNER JOIN ord o2
        ON o1.pid = o2.pid
        AND o2.ordn = o1.ordn + 1
        AND o1.name_norm <> o2.name_norm
)
SELECT
    'RSG_' || substr(
        md5(concat(p.pid, '|', p.from_norm, '|', p.to_norm, '|', cast(p.transition_date AS VARCHAR), '|', ?)),
        1,
        32
    ) AS signal_id,
    (
        SELECT sm.subject_id
        FROM dim_subject_master sm
        WHERE sm.subject_no IS NOT NULL
          AND upper(regexp_replace(trim(sm.subject_no), '[\\s-]+', '', 'g')) = p.pid
        ORDER BY sm.subject_id
        LIMIT 1
    ) AS subject_id,
    p.pid,
    p.from_norm,
    p.to_norm,
    cast(p.from_raw AS VARCHAR),
    cast(p.to_raw AS VARCHAR),
    p.transition_date,
    p.evidence_invoice_count,
    CASE
        WHEN p.evidence_invoice_count < 5 THEN 'low'
        WHEN p.evidence_invoice_count < 30 THEN 'medium'
        ELSE 'high'
    END,
    ?,
    CAST(? AS TIMESTAMP)
FROM pairs p
"""


def rebuild_subject_rename_signals(conn, *, run_id: str | None = None) -> dict[str, Any]:
    """
    清空并重建 dim_subject_rename_signal。依赖 dwd_inv_header 与 dim_subject_master 已存在。
    """
    init_all_tables(conn)
    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "dwd_inv_header 不可读或不存在，请先完成 ODS→DWD 构建。",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    run_id = run_id or _make_run_id("rename_signal")
    now = datetime.now()

    try:
        conn.execute("BEGIN TRANSACTION")
        conn.execute("DELETE FROM dim_subject_rename_signal")
        conn.execute(_REBUILD_RENAME_INSERT_SQL, [run_id, run_id, now])
        row = conn.execute("SELECT COUNT(*)::BIGINT FROM dim_subject_rename_signal").fetchone()
        n_sig = int(row[0] or 0) if row else 0
        conn.execute("COMMIT")
    except Exception as exc:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        logger.exception("重建 dim_subject_rename_signal 失败")
        return {
            "ok": False,
            "error": {
                "message": f"重建更名信号失败：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    return {
        "ok": True,
        "run_id": run_id,
        "signals_written": n_sig,
        "message": f"已重建更名信号 {n_sig} 条（run_id={run_id}）。",
    }


def _record_rename_task_run_log(run_id: str, started: float, result: dict[str, Any]) -> None:
    """将一次更名信号重建写入 ads_etl_task_run_log（同步与异步共用）。"""
    from src.local_api.dwd_to_dim_build import record_dim_task_run

    err_obj = result.get("error") if isinstance(result.get("error"), dict) else None
    err_msg = None
    if err_obj:
        err_msg = str(err_obj.get("message") or err_obj.get("detail") or "")
    try:
        record_dim_task_run(
            run_id=run_id,
            task_code="subject_rename_signal",
            task_name="主体更名信号重建",
            status="success" if result.get("ok") else "failed",
            result=result,
            rows_affected=int(result.get("signals_written") or 0),
            error_message=err_msg,
            started_at_ts=started,
        )
    except Exception:  # noqa: BLE001
        logger.exception("写入 ads_etl_task_run_log（更名信号任务）失败，已忽略")


def start_subject_rename_signal_rebuild(*, async_mode: bool = True) -> dict[str, Any]:
    """
    启动全量更名信号重建。

    - async_mode=True（默认）：后台线程执行，立即返回 run_id，用 get_subject_rename_rebuild_status 轮询。
    - async_mode=False：在当前请求内同步执行（兼容旧脚本/网关超时自担）。
    """
    if async_mode:
        run_id = _make_run_id("rename_signal")
        now_ms = time.time() * 1000.0
        ledger_started_ts = time.time()
        with _rename_jobs_lock:
            _rename_jobs[run_id] = {
                "run_id": run_id,
                "status": "queued",
                "message": "排队中，即将聚合全量 dwd_inv_header…",
                "signals_written": None,
                "error": None,
                "started_at_ms": now_ms,
                "finished_at_ms": None,
                "ledger_started_ts": ledger_started_ts,
            }
        try:
            from src.local_api.dwd_to_dim_build import record_dim_task_run_running

            record_dim_task_run_running(
                run_id=run_id,
                task_code="subject_rename_signal",
                task_name="主体更名信号重建",
                started_at_ts=ledger_started_ts,
            )
        except Exception:  # noqa: BLE001
            logger.exception("写入 running 任务台账失败（后台任务仍会继续）")
        t = threading.Thread(target=_run_subject_rename_rebuild_job, args=(run_id,), daemon=True)
        t.start()
        return {
            "ok": True,
            "async": True,
            "run_id": run_id,
            "message": "已启动后台任务，请轮询 rename-rebuild-status。",
        }

    from db.duckdb_conn import get_conn

    started = time.time()
    try:
        conn = get_conn()
        result = rebuild_subject_rename_signals(conn)
    except Exception as exc:  # noqa: BLE001
        logger.exception("同步重建更名信号失败")
        result = {
            "ok": False,
            "error": {
                "message": f"同步重建异常：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    audit_run_id = str(result.get("run_id") or "").strip() or _make_run_id("rename_signal")
    _record_rename_task_run_log(audit_run_id, started, result)

    if result.get("ok"):
        return {
            "ok": True,
            "async": False,
            "run_id": result.get("run_id"),
            "signals_written": result.get("signals_written"),
            "message": result.get("message"),
        }
    err = result.get("error") if isinstance(result.get("error"), dict) else {"message": str(result.get("error"))}
    return {
        "ok": False,
        "async": False,
        "run_id": result.get("run_id") or audit_run_id,
        "error": err,
    }


def _rename_status_from_ads_task_log(run_id: str) -> dict[str, Any] | None:
    """
    内存中无任务时，从 ads_etl_task_run_log 按 run_id 恢复状态（服务重启后轮询仍可用）。
    识别 task_code=subject_rename_signal 且 status 为 running / success / failed。
    """
    import json

    from db.duckdb_conn import get_conn
    from db.schema_sqlfiles import init_all_tables

    try:
        conn = get_conn()
        init_all_tables(conn)
        row = conn.execute(
            """
            SELECT status, rows_affected, error_message, result_json
            FROM ads_etl_task_run_log
            WHERE run_id = ? AND task_code = ?
            LIMIT 1
            """,
            [run_id, "subject_rename_signal"],
        ).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.warning("从 ads_etl_task_run_log 查询更名重建状态失败：%s: %s", type(exc).__name__, exc)
        return None

    if row is None:
        return None

    st = str(row[0] or "").strip().lower()
    if st == "running":
        return {
            "ok": True,
            "run_id": run_id,
            "status": "running",
            "message": (
                "任务台账为「执行中」。若本服务刚重启，进程内任务可能已中断，"
                "可等待片刻后刷新任务列表；若长时间不变，请重新发起重建。"
            ),
            "signals_written": None,
            "restored_from_task_log": True,
        }

    if st not in ("success", "failed"):
        return None

    rows_aff = int(row[1] or 0)
    err_msg = str(row[2] or "") if row[2] is not None else ""
    result_json = row[3]

    message = "已从任务台账恢复该次重建结果。"
    if st == "success" and result_json:
        try:
            payload = json.loads(str(result_json))
            if isinstance(payload, dict) and payload.get("message"):
                message = str(payload["message"])
        except Exception:  # noqa: BLE001
            pass

    out: dict[str, Any] = {
        "ok": True,
        "run_id": run_id,
        "status": st,
        "message": message,
        "restored_from_task_log": True,
    }
    if st == "success":
        out["signals_written"] = rows_aff
    else:
        out["signals_written"] = None
        out["error"] = {"message": err_msg or "重建失败"}
    return out


def get_subject_rename_rebuild_status(run_id: str) -> dict[str, Any]:
    rid = (run_id or "").strip()
    if not rid:
        return {
            "ok": False,
            "error": {"message": "run_id 不能为空"},
        }
    with _rename_jobs_lock:
        job = _rename_jobs.get(rid)
    if job is None:
        restored = _rename_status_from_ads_task_log(rid)
        if restored is not None:
            return restored
        return {
            "ok": False,
            "error": {
                "message": (
                    "run_id 不存在，或任务仍在排队/执行中但本服务已重启（内存状态丢失）。"
                    "若该次重建已结束，可在「DWD→DIM 任务运行」中按 run_id 查看台账。"
                ),
            },
        }
    out: dict[str, Any] = {
        "ok": True,
        "run_id": rid,
        "status": job.get("status"),
        "message": job.get("message"),
        "signals_written": job.get("signals_written"),
    }
    if job.get("error") is not None:
        out["error"] = job.get("error")
    return out


def _run_subject_rename_rebuild_job(run_id: str) -> None:
    from db.duckdb_conn import get_conn

    started = time.time()
    ledger_started_ts: float | None = None
    with _rename_jobs_lock:
        j = _rename_jobs.get(run_id)
        if j is not None:
            ledger_started_ts = j.get("ledger_started_ts")
            if isinstance(ledger_started_ts, (int, float)):
                ledger_started_ts = float(ledger_started_ts)
            else:
                ledger_started_ts = None
            j["status"] = "running"
            j["message"] = "正在聚合全量 dwd_inv_header 并写入 dim_subject_rename_signal…"

    result: dict[str, Any]
    try:
        conn = get_conn()
        result = rebuild_subject_rename_signals(conn, run_id=run_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("后台重建更名信号失败")
        result = {
            "ok": False,
            "error": {
                "message": f"后台异常：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    finished = time.time()
    err_obj = result.get("error") if isinstance(result.get("error"), dict) else None
    err_msg = None
    if err_obj:
        err_msg = str(err_obj.get("message") or err_obj.get("detail") or "")

    with _rename_jobs_lock:
        job = _rename_jobs.get(run_id)
        if job is not None:
            job["finished_at_ms"] = finished * 1000.0
            if result.get("ok"):
                job["status"] = "success"
                job["signals_written"] = result.get("signals_written")
                job["message"] = result.get("message") or "完成"
                job["error"] = None
            else:
                job["status"] = "failed"
                job["signals_written"] = result.get("signals_written")
                job["message"] = err_msg or "重建失败"
                job["error"] = err_obj or {"message": str(result.get("error") or "未知错误")}

    _record_rename_task_run_log(run_id, ledger_started_ts if ledger_started_ts is not None else started, result)
