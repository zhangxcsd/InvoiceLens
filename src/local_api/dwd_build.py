"""
ODS → DWD 构建 API 支撑：调用 etl.cleaner.run_cleaner 落盘 dwd_inv_header / dwd_inv_detail。
"""

from __future__ import annotations

from typing import Any

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import ensure_ods_inv_views_materialized, init_all_tables
from src.etl.cleaner import (
    _pick_first_column,
    _sql_invoice_date_try_expr,
    _sql_quoted_identifier,
    _sql_string_literal,
    _view_column_names,
    run_cleaner,
)
from src.etl.invoice_date_parse import ODS_INVOICE_DATE_CANDIDATES
from src.local_api.dwd_preview import _delete_rows_by_session_batched


RETRYABLE_DWD_STEP_IDS = frozenset({"standardize", "write_dwd", "validate"})


def _attach_build_log(out: dict[str, Any], *, run_id: str, import_batch_id: str) -> None:
    try:
        from src.local_api.dwd_build_log import write_dwd_build_log

        log_path = write_dwd_build_log(run_id=run_id, import_batch_id=import_batch_id, payload=out)
        if log_path:
            out["build_run_id"] = run_id
            out["log_file"] = log_path
    except Exception:
        pass


def _http_status_for_dwd_error(err: dict[str, Any] | None) -> int:
    if not isinstance(err, dict):
        return 500
    code = str(err.get("code") or "")
    if code in {"no_ods_batch", "stat_year_required", "invalid_stat_year", "step_not_retryable", "session_not_found"}:
        return 400
    if code == "rel_rebuild_busy" or str(err.get("exception_type") or "") == "ConflictError":
        return 409
    return 500


def _session_scope_sql(import_session_ids: list[str] | None) -> tuple[str, list[str]]:
    """返回会话筛选 SQL 片段（含旧数据 source_parquet_file 兜底）与规范化 sid 列表。"""
    if import_session_ids is None:
        return "", []
    sid_vals = [str(s).strip() for s in import_session_ids if str(s).strip()]
    if not sid_vals:
        return " AND 1=0", []
    in_list = ", ".join(_sql_string_literal(s) for s in sid_vals)
    needle_conds = " OR ".join(
        f"strpos(CAST(source_parquet_file AS VARCHAR), {_sql_string_literal(f'会话={s}')}) > 0"
        for s in sid_vals
    )
    sess_cond = (
        " AND ("
        f"import_session_id IN ({in_list})"
        " OR ("
        "  (import_session_id IS NULL OR trim(CAST(import_session_id AS VARCHAR)) = '')"
        f"  AND ({needle_conds})"
        " )"
        ")"
    )
    return sess_cond, sid_vals


def _ods_header_invoice_date_try_sql(conn: Any) -> str:
    """与 cleaner 中 date_try 一致：按实际存在的列名解析开票日期。"""
    cols = _view_column_names(conn, "ods_inv_header")
    name = _pick_first_column(cols, ODS_INVOICE_DATE_CANDIDATES)
    if not name:
        kprq_raw = "CAST(NULL AS VARCHAR)"
    else:
        kprq_raw = _sql_quoted_identifier(name)
    return _sql_invoice_date_try_expr(kprq_raw)


def _ods_detail_invoice_date_try_sql(conn: Any) -> str:
    """与 cleaner 中明细 date_try 一致：按 ods_inv_detail 实际列解析开票日期。"""
    cols = _view_column_names(conn, "ods_inv_detail")
    name = _pick_first_column(cols, ODS_INVOICE_DATE_CANDIDATES)
    if not name:
        kprq_raw = "CAST(NULL AS VARCHAR)"
    else:
        kprq_raw = _sql_quoted_identifier(name)
    return _sql_invoice_date_try_expr(kprq_raw)


def infer_distinct_stat_years_from_ods(
    conn: Any,
    batch_id: str,
    import_session_ids: list[str] | None = None,
) -> list[int]:
    """从该批次 ODS 发票头可解析开票日期得到**所有** distinct 统计年度（升序）。

    import_session_ids 非 None 时仅统计这些会话；空列表返回 []。
    """
    if import_session_ids is not None and len(import_session_ids) == 0:
        return []
    date_try_h = _ods_header_invoice_date_try_sql(conn)
    date_try_d = _ods_detail_invoice_date_try_sql(conn)
    sess_cond = ""
    params: list[Any] = [batch_id]
    if import_session_ids is not None:
        sess_cond, sid_vals = _session_scope_sql(import_session_ids)
        if not sid_vals:
            return []
    try:
        rows = conn.execute(
            f"""
            SELECT DISTINCT CAST(date_part('year', dt) AS INTEGER) AS y
            FROM (
              SELECT {date_try_h} AS dt
              FROM ods_inv_header
              WHERE batch_id = ?{sess_cond}
              UNION ALL
              SELECT {date_try_d} AS dt
              FROM ods_inv_detail
              WHERE batch_id = ?{sess_cond}
            ) s
            WHERE dt IS NOT NULL
            ORDER BY y
            """,
            [*params, *params],
        ).fetchall()
    except Exception:
        return []
    out: list[int] = []
    for (yv,) in rows:
        if yv is None:
            continue
        try:
            yi = int(yv)
        except Exception:
            continue
        if 1990 <= yi <= 2100:
            out.append(yi)
    return out


def _stat_year_diagnostics(
    conn: Any,
    *,
    batch_id: str,
    import_session_ids: list[str] | None,
) -> dict[str, Any]:
    """返回用于定位 stat_year 推断失败的诊断计数。"""
    sess_cond, sid_vals = _session_scope_sql(import_session_ids)
    params: list[Any] = [batch_id]
    date_try_h = _ods_header_invoice_date_try_sql(conn)
    date_try_d = _ods_detail_invoice_date_try_sql(conn)

    def _diag_for_table(table: str, date_try_sql: str) -> dict[str, int]:
        try:
            row = conn.execute(
                f"""
                SELECT
                  COUNT(*)::BIGINT AS rows_total,
                  SUM(
                    CASE
                      WHEN trim(CAST({date_try_sql} AS VARCHAR)) <> '' THEN 1
                      ELSE 0
                    END
                  )::BIGINT AS rows_date_parseable
                FROM {table}
                WHERE batch_id = ?{sess_cond}
                """,
                params,
            ).fetchone()
            total = int((row[0] if row else 0) or 0)
            parseable = int((row[1] if row else 0) or 0)
            return {"rows_total": total, "rows_date_parseable": parseable}
        except Exception:
            return {"rows_total": -1, "rows_date_parseable": -1}

    return {
        "batch_id": batch_id,
        "session_scope": sid_vals if import_session_ids is not None else "all_pending_or_all_batch",
        "header": _diag_for_table("ods_inv_header", date_try_h),
        "detail": _diag_for_table("ods_inv_detail", date_try_d),
    }


def infer_stat_year_from_ods(
    conn: Any,
    batch_id: str,
    import_session_ids: list[str] | None = None,
) -> int | None:
    """兼容单年推断：取 distinct 年度中的最大年（旧逻辑；新构建请用 infer_distinct + 循环）。"""
    years = infer_distinct_stat_years_from_ods(conn, batch_id, import_session_ids)
    return years[-1] if years else None


def batch_has_ods_data(conn: Any, import_batch_id: str) -> bool:
    n = conn.execute(
        "SELECT COUNT(*) FROM ods_load_log WHERE import_batch_id = ?",
        [import_batch_id],
    ).fetchone()[0]
    return int(n or 0) > 0


def _all_sessions_in_batch(conn: Any, import_batch_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT import_session_id FROM ods_load_log WHERE import_batch_id = ?",
        [import_batch_id],
    ).fetchall()
    return [str(r[0]) for r in rows if r and r[0] is not None]


def _pending_dwd_sessions(conn: Any, import_batch_id: str) -> list[str]:
    """增量构建：尚未写入 DWD 水位的 import_session_id（dwd_session_processed_at IS NULL）。"""
    rows = conn.execute(
        """
        SELECT import_session_id FROM ods_load_log
        WHERE import_batch_id = ? AND dwd_session_processed_at IS NULL
        """,
        [import_batch_id],
    ).fetchall()
    return [str(r[0]) for r in rows if r and r[0] is not None]


def _attach_enterprise_year_rel_rebuild_if_requested(
    conn: Any, out: dict[str, Any], rebuild_enterprise_year_rel: bool
) -> None:
    """DWD 成功后可选：按本次构建涉及年度重算 dim_enterprise_year_rel（写入 out 子键）。"""
    if not rebuild_enterprise_year_rel or not out.get("ok"):
        return
    sy = out.get("stat_years_built") or []
    if not isinstance(sy, list) or not sy:
        return
    years_int: list[int] = []
    for y in sy:
        try:
            years_int.append(int(y))
        except (TypeError, ValueError):
            continue
    if not years_int:
        return
    try:
        from src.local_api.enterprise_year_rel_build import (
            merge_stat_years_for_chain_rebuild,
            rebuild_dim_enterprise_year_rel,
        )

        chain_years = merge_stat_years_for_chain_rebuild(conn, years_int)
        out["enterprise_year_rel_rebuild"] = rebuild_dim_enterprise_year_rel(
            conn, stat_years=chain_years, trigger_source="dwd_build_chain"
        )
    except Exception as exc:  # noqa: BLE001
        out["enterprise_year_rel_rebuild"] = {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def _attach_dws_refresh_if_requested(conn: Any, out: dict[str, Any], refresh_dws_after: bool) -> None:
    """DWD 成功后可选：按本次构建涉及年度刷新 DWS 五表（写入 out 子键）。"""
    if not refresh_dws_after or not out.get("ok"):
        return
    sy = out.get("stat_years_built") or []
    if not isinstance(sy, list) or not sy:
        return
    years_int: list[int] = []
    for y in sy:
        try:
            years_int.append(int(y))
        except (TypeError, ValueError):
            continue
    if not years_int:
        return
    try:
        from src.etl.dws_build import refresh_dws_years

        out["dws_refresh"] = refresh_dws_years(conn, stat_years=years_int)
    except Exception as exc:  # noqa: BLE001
        out["dws_refresh"] = {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def _mark_sessions_dwd_processed(conn: Any, import_batch_id: str, session_ids: list[str]) -> None:
    if not session_ids:
        return
    qs = ",".join(["?"] * len(session_ids))
    conn.execute(
        f"""
        UPDATE ods_load_log
        SET dwd_session_processed_at = CURRENT_TIMESTAMP
        WHERE import_batch_id = ? AND import_session_id IN ({qs})
        """,
        [import_batch_id, *session_ids],
    )


def resolve_stat_year(
    conn: Any,
    import_batch_id: str,
    stat_year: int | None,
    *,
    import_session_ids: list[str] | None = None,
) -> tuple[int | None, str]:
    """
    返回 (stat_year, source)。

    source:
    - request：请求体显式传入的 stat_year
    - ods_infer：由该批次 ODS 发票头可解析开票日期推断（取最大年份；**构建**时用 distinct 全年循环，见 build_dwd_for_batch）
    - no_parseable_dates：未传 stat_year 且本批次无任何可解析开票日期（**不用批次 ID 推断**，批次与年度无关）
    - invalid：传入的 stat_year 非法

    说明：批次 ID 仅标识一次导入，与票面统计年度无任何关系，不得作为 stat_year 兜底。
    """
    if stat_year is not None:
        try:
            y = int(stat_year)
        except Exception:
            return None, "invalid"
        if 1990 <= y <= 2100:
            return y, "request"
        return None, "invalid"
    yo = infer_stat_year_from_ods(conn, import_batch_id, import_session_ids)
    if yo is not None:
        return yo, "ods_infer"
    return None, "no_parseable_dates"


def _dwd_build_loop(
    conn: Any,
    *,
    import_batch_id: str,
    stat_year: int | None,
    import_session_ids: list[str] | None,
    sessions_to_mark: list[str],
) -> dict[str, Any]:
    """在已持有 conn 上执行按年 run_cleaner，成功后写入 ods_load_log 水位。"""
    bid = import_batch_id
    infer_scope = import_session_ids

    years_to_run: list[int]
    src: str
    if stat_year is not None:
        yr, src = resolve_stat_year(conn, bid, stat_year, import_session_ids=infer_scope)
        if src == "invalid":
            return {
                "ok": False,
                "error": {"message": "stat_year 无效，须为 1990–2100 的整数", "code": "invalid_stat_year"},
            }
        if yr is None:
            return {
                "ok": False,
                "error": {
                    "message": "无法确定统计年度。",
                    "code": "stat_year_required",
                    "stat_year_source": src,
                },
            }
        years_to_run = [yr]
    else:
        years_to_run = infer_distinct_stat_years_from_ods(conn, bid, infer_scope)
        if not years_to_run:
            diag = _stat_year_diagnostics(conn, batch_id=bid, import_session_ids=infer_scope)
            return {
                "ok": False,
                "error": {
                    "message": (
                        "无法确定统计年度：当前筛选范围内 ODS 发票头中没有任何可解析的开票日期（请检查列映射与数据质量）。"
                        "批次 ID 仅用于区分导入，与年度无关，不会用作兜底。"
                        "请在导入预检中修复日期问题，或在确有把握时在请求体中显式传入 stat_year。"
                    ),
                    "code": "stat_year_required",
                    "stat_year_source": "no_parseable_dates",
                    "diagnostics": diag,
                },
            }
        src = "ods_infer_multi" if len(years_to_run) > 1 else "ods_infer"

    cleaner_session_arg: list[str] | None
    if import_session_ids is not None:
        cleaner_session_arg = import_session_ids
    else:
        cleaner_session_arg = None

    per_year: list[dict[str, Any]] = []
    try:
        for y in years_to_run:
            per_year.append(
                run_cleaner(
                    stat_year=y,
                    import_batch_id=bid,
                    import_session_ids=cleaner_session_arg,
                )
            )
    except Exception as exc:
        fail_y = years_to_run[len(per_year)] if len(per_year) < len(years_to_run) else None
        succ = [int(x.get("stat_year", 0)) for x in per_year]
        return {
            "ok": False,
            "import_batch_id": bid,
            "stat_years_planned": years_to_run,
            "stat_years_built": succ,
            "stat_years_succeeded": succ,
            "failed_stat_year": fail_y,
            "stat_year_source": src,
            "error": {
                "message": (
                    f"DWD 构建失败（失败年度 stat_year={fail_y}）：{type(exc).__name__}: {exc}"
                    if fail_y is not None
                    else f"DWD 构建失败：{type(exc).__name__}: {exc}"
                ),
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    _mark_sessions_dwd_processed(conn, bid, sessions_to_mark)

    cleaner_out = _merge_cleaner_outputs(per_year)
    steps = _build_step_summary(cleaner_out)

    return {
        "ok": True,
        "import_batch_id": bid,
        "stat_year": years_to_run[-1] if len(years_to_run) == 1 else None,
        "stat_years_built": years_to_run,
        "stat_year_source": src,
        "cleaner": cleaner_out,
        "cleaner_by_year": per_year,
        "steps": steps,
        "dwd_row_estimate": int(cleaner_out.get("rows_written_header") or 0)
        + int(cleaner_out.get("rows_written_detail") or 0),
    }


def build_dwd_for_batch(
    *,
    import_batch_id: str,
    stat_year: int | None = None,
    incremental: bool = True,
    import_session_ids: list[str] | None = None,
    rebuild_enterprise_year_rel: bool = False,
    refresh_dws: bool = False,
) -> dict[str, Any]:
    """
    执行 ODS→DWD 落盘。import_batch_id 与 ODS 目录「批次=」及 ods_load_log 一致。

    - incremental=True（默认）：仅处理 `ods_load_log.dwd_session_processed_at IS NULL` 的会话；成功后写入水位。
    - `import_session_ids`：在 incremental=True 时可选；若传入非空列表，则仅在该批次的**待处理**会话中取交集（用于批量中只跑所选 session）。不传或传 None 表示该批次全部待处理会话。
    - incremental=False：对该批次全量会话跑清洗（不按水位跳过），成功后为**本批次全部会话**写入水位；`import_session_ids` 忽略。
    - stat_year 可选。省略时：在筛选范围内枚举可解析开票年度，按年依次 run_cleaner。
    - rebuild_enterprise_year_rel=True：在**本次构建成功**且 `stat_years_built` 非空时，按
      **本次构建年度 ∪ dim_enterprise_year_roster 中出现的年度** 重算 `dim_enterprise_year_rel`
      （仅集团台账成员行；结果置于返回 JSON 的 `enterprise_year_rel_rebuild`）。
    - refresh_dws=True：在**本次构建成功**且 `stat_years_built` 非空时，按相同年度刷新五张 DWS 表（`dws_refresh`）。

    正常增量构建**不会**删除或回滚已落盘 DWD；运维「强制重洗」请使用 `force_rebuild_dwd_session`。
    """
    from src.local_api.dwd_build_log import new_dwd_run_id

    bid = (import_batch_id or "").strip()
    run_id = new_dwd_run_id(import_batch_id=bid or "unknown")

    def _finish(out: dict[str, Any]) -> dict[str, Any]:
        if bid:
            _attach_build_log(out, run_id=run_id, import_batch_id=bid)
        return out

    if not bid:
        return _finish({"ok": False, "error": {"message": "import_batch_id 不能为空"}})

    conn = get_conn()
    init_all_tables(conn)
    ensure_ods_inv_views_materialized(conn)

    if not batch_has_ods_data(conn, bid):
        return _finish(
            {
                "ok": False,
                "error": {
                    "message": "ods_load_log 中无该批次记录，请先完成 Excel→ODS 导入",
                    "code": "no_ods_batch",
                },
            }
        )

    if incremental:
        pending = _pending_dwd_sessions(conn, bid)
        if import_session_ids is not None:
            want = {str(x).strip() for x in import_session_ids if str(x).strip()}
            if not want:
                pending = []
            else:
                pending = [s for s in pending if s in want]
        if not pending:
            return _finish(
                {
                    "ok": True,
                    "import_batch_id": bid,
                    "incremental": True,
                    "stat_years_built": [],
                    "stat_year_source": "skipped_incremental_empty",
                    "message": "本批次无待增量处理的 import_session（均已记录 dwd_session_processed_at）",
                    "cleaner": {"status": "skipped", "rows_rejected": 0},
                    "cleaner_by_year": [],
                    "steps": _build_step_summary({"status": "success", "rows_rejected": 0}),
                    "dwd_row_estimate": 0,
                }
            )
        out = _dwd_build_loop(
            conn,
            import_batch_id=bid,
            stat_year=stat_year,
            import_session_ids=pending,
            sessions_to_mark=pending,
        )
        if out.get("ok"):
            out["incremental"] = True
            _attach_enterprise_year_rel_rebuild_if_requested(conn, out, rebuild_enterprise_year_rel)
            _attach_dws_refresh_if_requested(conn, out, refresh_dws)
        return _finish(out)

    all_sess = _all_sessions_in_batch(conn, bid)
    out = _dwd_build_loop(
        conn,
        import_batch_id=bid,
        stat_year=stat_year,
        import_session_ids=None,
        sessions_to_mark=all_sess,
    )
    if out.get("ok"):
        out["incremental"] = False
        _attach_enterprise_year_rel_rebuild_if_requested(conn, out, rebuild_enterprise_year_rel)
        _attach_dws_refresh_if_requested(conn, out, refresh_dws)
    return _finish(out)


def rollback_dwd_batch(*, import_batch_id: str) -> dict[str, Any]:
    """运维回滚：删除批次全部 DWD 行并重置 ods_load_log 水位（不删 ODS、不重跑清洗）。"""
    bid = (import_batch_id or "").strip()
    if not bid:
        return {"ok": False, "error": {"message": "import_batch_id 不能为空"}}

    conn = get_conn()
    init_all_tables(conn)
    try:
        from src.local_api.dwd_preview import delete_dwd_load_batch

        out = delete_dwd_load_batch(conn, batch_id=bid)
        if out.get("ok"):
            out["rollback"] = True
        return out
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "error": {
                "message": f"DWD 批次回滚失败：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }


def force_rebuild_dwd_session(
    *,
    import_batch_id: str,
    import_session_id: str,
    stat_year: int | None = None,
    rebuild_enterprise_year_rel: bool = False,
    refresh_dws: bool = False,
) -> dict[str, Any]:
    """
    运维「强制重洗」：删除该会话曾写入的 DWD 行，重置 ods_load_log 水位后按年重跑清洗。

    仅应通过显式 API 触发；与正常增量构建隔离，不会在增量路径中自动调用。
    """
    bid = (import_batch_id or "").strip()
    sid = (import_session_id or "").strip()
    if not bid or not sid:
        return {"ok": False, "error": {"message": "import_batch_id 与 import_session_id 均不能为空"}}

    conn = get_conn()
    init_all_tables(conn)
    ensure_ods_inv_views_materialized(conn)

    n = conn.execute(
        "SELECT COUNT(*) FROM ods_load_log WHERE import_batch_id = ? AND import_session_id = ?",
        [bid, sid],
    ).fetchone()[0]
    if int(n or 0) == 0:
        return {
            "ok": False,
            "error": {"message": "ods_load_log 中无该批次与会话记录", "code": "session_not_found"},
        }

    # 兼容旧库：早期写入的 DWD 行可能 import_session_id 为空（NULL/空串），导致按会话删除无法命中。
    # 此处增加 source_parquet_file 的兜底：ODS 分区路径包含 `会话=<sid>` 时视为该会话血缘。
    # 注意：该兜底仅用于运维「强制重洗」的显式删除路径，避免影响正常增量/全量的幂等写入语义。
    sess_needle = f"会话={sid}"
    # 先明细后主表（与 DWD 预览整批删除顺序一致），避免宽表 swap 后明细仍指向已删主表键。
    _delete_rows_by_session_batched(
        conn,
        table="dwd_inv_detail",
        pk="detail_uuid",
        import_batch_id=bid,
        import_session_id=sid,
        sess_needle=sess_needle,
    )
    _delete_rows_by_session_batched(
        conn,
        table="dwd_inv_header",
        pk="header_uuid",
        import_batch_id=bid,
        import_session_id=sid,
        sess_needle=sess_needle,
    )
    init_all_tables(conn)
    conn.execute(
        """
        UPDATE ods_load_log
        SET dwd_session_processed_at = NULL
        WHERE import_batch_id = ? AND import_session_id = ?
        """,
        [bid, sid],
    )

    out = _dwd_build_loop(
        conn,
        import_batch_id=bid,
        stat_year=stat_year,
        import_session_ids=[sid],
        sessions_to_mark=[sid],
    )
    if out.get("ok"):
        out["force_rebuild"] = True
        out["import_session_id"] = sid
        _attach_enterprise_year_rel_rebuild_if_requested(conn, out, rebuild_enterprise_year_rel)
        _attach_dws_refresh_if_requested(conn, out, refresh_dws)
    from src.local_api.dwd_build_log import new_dwd_run_id

    run_id = new_dwd_run_id(import_batch_id=bid, prefix="dwd_force")
    _attach_build_log(out, run_id=run_id, import_batch_id=bid)
    return out


def retry_dwd_build_step(
    *,
    import_batch_id: str,
    step_id: str,
    stat_year: int | None = None,
    import_session_ids: list[str] | None = None,
    rebuild_enterprise_year_rel: bool = False,
    refresh_dws: bool = False,
) -> dict[str, Any]:
    """
    ODS→DWD 单步重跑：cleaner 相关步骤（standardize / write_dwd / validate）均映射为重新执行 run_cleaner。
    与任务链 retry-step 的 single_step_only 语义对齐，仅重跑指定 cleaner 阶段，不触发后续 DIM 链。
    """
    sid = (step_id or "").strip()
    if sid not in RETRYABLE_DWD_STEP_IDS:
        return {
            "ok": False,
            "error": {
                "message": (
                    f"步骤「{sid or '—'}」不支持单步重跑。"
                    "可重跑 cleaner 步骤：standardize（清洗）、write_dwd（写入 DWD）、validate（质量校验）。"
                    "读取 ODS / 去重 / 维度关联为 cleaner 内部阶段，请重跑上述步骤之一。"
                ),
                "code": "step_not_retryable",
            },
        }
    out = build_dwd_for_batch(
        import_batch_id=import_batch_id,
        stat_year=stat_year,
        incremental=True,
        import_session_ids=import_session_ids,
        rebuild_enterprise_year_rel=rebuild_enterprise_year_rel,
        refresh_dws=refresh_dws,
    )
    out["retry_step_id"] = sid
    out["single_step_only"] = True
    return out


def _merge_cleaner_outputs(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """将按年度多次 run_cleaner 的结果合并为一条汇总（供步骤与兼容字段）。"""
    if not parts:
        return {"status": "success", "rows_rejected": 0}
    hdr_w = sum(int(p.get("rows_written_header") or 0) for p in parts)
    dtl_w = sum(int(p.get("rows_written_detail") or 0) for p in parts)
    hdr_s = max((int(p.get("rows_scanned_header") or 0) for p in parts), default=0)
    dtl_s = max((int(p.get("rows_scanned_detail") or 0) for p in parts), default=0)
    # reject_sql 按整批 _ods_hdr 计算，各年度轮次结果相同，不可累加
    rej = int(parts[0].get("rows_rejected") or 0)
    status = "success" if rej == 0 else "warning"
    ranges = list(parts[0].get("reject_row_ranges") or [])
    samples = list(parts[0].get("reject_row_samples") or [])
    sample_cap = 80
    out: dict[str, Any] = {
        "status": status,
        "stage": "cleaner",
        "import_batch_id": parts[0].get("import_batch_id"),
        "rows_scanned_header": hdr_s,
        "rows_written_header": hdr_w,
        "rows_scanned_detail": dtl_s,
        "rows_written_detail": dtl_w,
        "rows_rejected": rej,
        "reject_row_ranges": ranges,
        "reject_row_samples": samples[:sample_cap],
        "message": f"DWD 清洗完成（按 {len(parts)} 个 stat_year 依次落盘；header+detail 写入已汇总）",
    }
    _hdr_dtl_scan = {
        "rows_scanned_header",
        "rows_written_header",
        "rows_scanned_detail",
        "rows_written_detail",
    }
    for p in parts:
        for k, v in p.items():
            if k in out or k in _hdr_dtl_scan:
                continue
            if k.startswith("dq_") and isinstance(v, list):
                cur = out.get(k)
                if isinstance(cur, list):
                    cur.extend(v)
                else:
                    out[k] = list(v)
            elif k.startswith("rows_"):
                try:
                    n = int(v or 0)
                except (TypeError, ValueError):
                    n = 0
                out[k] = int(out.get(k) or 0) + n
    return out


def _build_step_summary(cleaner_out: dict[str, Any]) -> list[dict[str, Any]]:
    """与前端流水线步骤名称对齐的简要结果（非独立子任务，仅供展示）。"""
    st = str(cleaner_out.get("status") or "")
    ok = st == "success"
    warn = st == "warning"
    tail = "ok" if ok else ("warning" if warn else "error")
    return [
        {"id": "read_ods", "label": "读取 ODS", "status": "ok", "detail": "已自 inv_header/inv_detail 视图按 batch_id 筛选"},
        {"id": "standardize", "label": "清洗/标准化", "status": tail, "detail": "金额/日期解析与拒收规则已执行"},
        {
            "id": "dedupe",
            "label": "主键去重",
            "status": "ok",
            "detail": "header_uuid/detail_uuid 冲突时 ON CONFLICT DO NOTHING",
        },
        {
            "id": "enrich",
            "label": "维度关联",
            "status": "skipped",
            "detail": "主体维度等在 DM 层处理；红冲关联已在 cleaner post_etl 写入 related_blue 等",
        },
        {
            "id": "write_dwd",
            "label": "写入 DWD",
            "status": tail,
            "detail": f"header +{cleaner_out.get('rows_written_header', 0)} 行, detail +{cleaner_out.get('rows_written_detail', 0)} 行",
        },
        {
            "id": "validate",
            "label": "质量校验",
            "status": "warning"
            if int(cleaner_out.get("rows_rejected") or 0) > 0
            or sum(len(v) for k, v in cleaner_out.items() if k.startswith("dq_") and isinstance(v, list))
            > 0
            else tail,
            "detail": _validate_step_detail(cleaner_out),
        },
    ]


def _validate_step_detail(cleaner_out: dict[str, Any]) -> str:
    rej = int(cleaner_out.get("rows_rejected") or 0)
    dq_n = sum(len(v) for k, v in cleaner_out.items() if k.startswith("dq_") and isinstance(v, list))
    base = f"拒收 {rej} 行（header 解析/必填规则）"
    if dq_n <= 0:
        return base
    return f"{base}；专项与 inv_detail 对账异常 {dq_n} 条（见 cleaner dq_*）"
