"""
企业-年度关系 dim_enterprise_year_rel 从 dwd_inv_header 按年重算。

口径（与 `vw_audit_invoice_coverage_group_member` 对齐）：
- **行范围**：仅「当年在 dim_group_enterprise_year 中有台账的成员」且能映射到
  `dim_subject_master`（subject_category='org'、规范化税号命中）的 subject_id；
  不在集团年度成员中的 org 主体**不写**本表（与报送覆盖分母一致）。
- **购销标志**：在上述成员集合上，按 stat_year 将 dwd_inv_header 销方/购方与成员 norm_no 对齐后聚合。
- **重算年度**：请求未指定 stat_years 时，取 **dwd_inv_header 中出现的 stat_year ∪
  dim_group_enterprise_year 中出现的 stat_year** 并去重，以便「仅有集团台账年、或仅有发票年」
  都能逐年落一行（无票年购销标志为假、计数为 0）。

自动化编排可引用：
- 任务码：`dim.enterprise_year_rel.rebuild`
- HTTP：`POST /api/dim/enterprise-year-rel/rebuild`（JSON：`stat_years`、`dry_run`、`run_id`、`trigger_source` 等）
- 元数据：`GET /api/dim/enterprise-year-rel/meta`
- 运行台账：非 dry_run 时写入 `ads_etl_task_run_log`（与 `/api/dim/task-runs` 联查）
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

from db.schema_sqlfiles import init_all_tables

logger = logging.getLogger(__name__)

AUTOMATION_TASK_CODE = "dim.enterprise_year_rel.rebuild"
TASK_DISPLAY_NAME = "企业年度购销标志重算"

_YEAR_RE = re.compile(r"^\d{4}$")


def _safe_record_dim_task_running(**kwargs: Any) -> None:
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run_running

        record_dim_task_run_running(**kwargs)
    except Exception:
        logger.exception("写入 ads_etl_task_run_log（running）失败")


def _safe_record_dim_task_run(**kwargs: Any) -> None:
    try:
        from src.local_api.dwd_to_dim_build import record_dim_task_run

        record_dim_task_run(**kwargs)
    except Exception:
        logger.exception("写入 ads_etl_task_run_log 失败")


def _utc_run_id(prefix: str = "REL") -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{ts}"


def parse_stat_years_request(raw: Any) -> list[int] | None:
    """解析请求中的 stat_years：None 表示「由 DWD ∪ 集团台账推断全部目标年度」。"""
    if raw is None:
        return None
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("", "all", "*"):
            return None
        parts = [p.strip() for p in s.replace("，", ",").split(",") if p.strip()]
        out: list[int] = []
        for p in parts:
            if p.isdigit() and _YEAR_RE.match(p):
                y = int(p)
                if 1990 <= y <= 2100:
                    out.append(y)
        return sorted(set(out)) if out else None
    if isinstance(raw, list):
        out2: list[int] = []
        for x in raw:
            try:
                y = int(x)
            except (TypeError, ValueError):
                continue
            if 1990 <= y <= 2100:
                out2.append(y)
        return sorted(set(out2)) if out2 else None
    try:
        y = int(raw)
        return [y] if 1990 <= y <= 2100 else None
    except (TypeError, ValueError):
        return None


def _distinct_stat_years_from_dwd(conn: Any) -> list[int]:
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT CAST(stat_year AS INTEGER) AS y
            FROM dwd_inv_header
            WHERE stat_year IS NOT NULL
            ORDER BY y
            """
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取 dwd_inv_header 统计年度失败: %s", exc)
        return []
    out: list[int] = []
    for (yv,) in rows:
        if yv is None:
            continue
        try:
            yi = int(yv)
        except (TypeError, ValueError):
            continue
        if 1990 <= yi <= 2100:
            out.append(yi)
    return out


def _distinct_stat_years_from_group(conn: Any) -> list[int]:
    """dim_group_enterprise_year 中出现的统计年度（集团台账年度）。"""
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT CAST(stat_year AS INTEGER) AS y
            FROM dim_enterprise_year_roster
            WHERE stat_year IS NOT NULL
            ORDER BY y
            """
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取 dim_group_enterprise_year 统计年度失败: %s", exc)
        return []
    out: list[int] = []
    for (yv,) in rows or []:
        if yv is None:
            continue
        try:
            yi = int(yv)
        except (TypeError, ValueError):
            continue
        if 1990 <= yi <= 2100:
            out.append(yi)
    return out


def merge_stat_years_for_chain_rebuild(conn: Any, stat_years_built: list[int]) -> list[int]:
    """ODS→DWD 链式重算：合并本次构建年度与集团台账中出现的年度，避免漏刷仅有台账或仅有发票的年份。"""
    built = set()
    for y in stat_years_built or []:
        try:
            yi = int(y)
        except (TypeError, ValueError):
            continue
        if 1990 <= yi <= 2100:
            built.add(yi)
    grp = set(_distinct_stat_years_from_group(conn))
    return sorted(built | grp)


def _merge_auto_target_years(conn: Any) -> list[int]:
    """未显式传 stat_years 时：DWD 发票年度 ∪ 集团台账年度。"""
    dwd = set(_distinct_stat_years_from_dwd(conn))
    grp = set(_distinct_stat_years_from_group(conn))
    return sorted({y for y in dwd | grp if 1990 <= int(y) <= 2100})


def _year_agg_count_sql(ph: str) -> str:
    """与写入路径相同的 CTE，仅输出 COUNT(*)。"""
    return f"""
WITH group_member_norm AS (
    SELECT DISTINCT
        CAST(stat_year AS SMALLINT) AS stat_year,
        upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g')) AS norm_no
    FROM dim_enterprise_year_roster
    WHERE CAST(stat_year AS INTEGER) IN ({ph})
      AND trim(COALESCE(enterprise_id, '')) <> ''
      AND length(upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g'))) > 0
),
org_subject_ranked AS (
    SELECT
        subject_id,
        subject_no,
        upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\\s-]+', '', 'g')) AS norm_no,
        ROW_NUMBER() OVER (
            PARTITION BY upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\\s-]+', '', 'g'))
            ORDER BY subject_id
        ) AS rn
    FROM dim_subject_master
    WHERE subject_category = 'org'
      AND trim(COALESCE(subject_no, '')) <> ''
),
org_subject_dedup AS (
    SELECT subject_id, subject_no, norm_no
    FROM org_subject_ranked
    WHERE rn = 1
),
group_member_subjects AS (
    SELECT DISTINCT
        gm.stat_year,
        m.subject_id,
        m.norm_no
    FROM group_member_norm gm
    INNER JOIN org_subject_dedup m ON m.norm_no = gm.norm_no
),
dwd_subject_union AS (
    SELECT
        h.stat_year,
        TRIM(h.xfsbh) AS subject_no_raw,
        'seller' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE CAST(h.stat_year AS INTEGER) IN ({ph})
      AND TRIM(COALESCE(h.xfsbh, '')) <> ''

    UNION ALL

    SELECT
        h.stat_year,
        TRIM(h.gfsbh) AS subject_no_raw,
        'buyer' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE CAST(h.stat_year AS INTEGER) IN ({ph})
      AND TRIM(COALESCE(h.gfsbh, '')) <> ''
),
normed_union AS (
    SELECT
        *,
        upper(regexp_replace(trim(COALESCE(subject_no_raw, '')), '[\\s-]+', '', 'g')) AS norm_no
    FROM dwd_subject_union
),
year_agg AS (
    SELECT
        gms.subject_id,
        gms.stat_year,
        COALESCE(BOOL_OR(u.role_tag = 'seller'), FALSE) AS has_seller_role,
        COALESCE(BOOL_OR(u.role_tag = 'buyer'), FALSE) AS has_buyer_role,
        COALESCE(COUNT(u.role_tag), 0)::BIGINT AS invoice_count,
        COALESCE(SUM(u.amount_jshj), 0) AS amount_jshj_sum,
        MIN(u.invoice_date) AS year_first_seen_date,
        MAX(u.invoice_date) AS year_last_seen_date,
        MIN(u.import_batch_id) AS year_first_seen_batch_id,
        MAX(u.import_batch_id) AS year_last_seen_batch_id,
        MIN(u.import_session_id) AS year_first_seen_session_id,
        MAX(u.import_session_id) AS year_last_seen_session_id
    FROM group_member_subjects gms
    LEFT JOIN normed_union u
        ON CAST(u.stat_year AS INTEGER) = CAST(gms.stat_year AS INTEGER)
       AND u.norm_no = gms.norm_no
       AND length(u.norm_no) > 0
    GROUP BY gms.subject_id, gms.stat_year
)
SELECT COUNT(*)::BIGINT FROM year_agg
"""


def _year_agg_insert_sql(ph: str) -> str:
    return f"""
WITH group_member_norm AS (
    SELECT DISTINCT
        CAST(stat_year AS SMALLINT) AS stat_year,
        upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g')) AS norm_no
    FROM dim_enterprise_year_roster
    WHERE CAST(stat_year AS INTEGER) IN ({ph})
      AND trim(COALESCE(enterprise_id, '')) <> ''
      AND length(upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g'))) > 0
),
org_subject_ranked AS (
    SELECT
        subject_id,
        subject_no,
        upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\\s-]+', '', 'g')) AS norm_no,
        ROW_NUMBER() OVER (
            PARTITION BY upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\\s-]+', '', 'g'))
            ORDER BY subject_id
        ) AS rn
    FROM dim_subject_master
    WHERE subject_category = 'org'
      AND trim(COALESCE(subject_no, '')) <> ''
),
org_subject_dedup AS (
    SELECT subject_id, subject_no, norm_no
    FROM org_subject_ranked
    WHERE rn = 1
),
group_member_subjects AS (
    SELECT DISTINCT
        gm.stat_year,
        m.subject_id,
        m.norm_no
    FROM group_member_norm gm
    INNER JOIN org_subject_dedup m ON m.norm_no = gm.norm_no
),
dwd_subject_union AS (
    SELECT
        h.stat_year,
        TRIM(h.xfsbh) AS subject_no_raw,
        'seller' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE CAST(h.stat_year AS INTEGER) IN ({ph})
      AND TRIM(COALESCE(h.xfsbh, '')) <> ''

    UNION ALL

    SELECT
        h.stat_year,
        TRIM(h.gfsbh) AS subject_no_raw,
        'buyer' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE CAST(h.stat_year AS INTEGER) IN ({ph})
      AND TRIM(COALESCE(h.gfsbh, '')) <> ''
),
normed_union AS (
    SELECT
        *,
        upper(regexp_replace(trim(COALESCE(subject_no_raw, '')), '[\\s-]+', '', 'g')) AS norm_no
    FROM dwd_subject_union
),
year_agg AS (
    SELECT
        gms.subject_id,
        gms.stat_year,
        COALESCE(BOOL_OR(u.role_tag = 'seller'), FALSE) AS has_seller_role,
        COALESCE(BOOL_OR(u.role_tag = 'buyer'), FALSE) AS has_buyer_role,
        COALESCE(COUNT(u.role_tag), 0)::BIGINT AS invoice_count,
        COALESCE(SUM(u.amount_jshj), 0) AS amount_jshj_sum,
        MIN(u.invoice_date) AS year_first_seen_date,
        MAX(u.invoice_date) AS year_last_seen_date,
        MIN(u.import_batch_id) AS year_first_seen_batch_id,
        MAX(u.import_batch_id) AS year_last_seen_batch_id,
        MIN(u.import_session_id) AS year_first_seen_session_id,
        MAX(u.import_session_id) AS year_last_seen_session_id
    FROM group_member_subjects gms
    LEFT JOIN normed_union u
        ON CAST(u.stat_year AS INTEGER) = CAST(gms.stat_year AS INTEGER)
       AND u.norm_no = gms.norm_no
       AND length(u.norm_no) > 0
    GROUP BY gms.subject_id, gms.stat_year
)
INSERT INTO dim_enterprise_year_rel (
    subject_id,
    stat_year,
    year_role_tag,
    has_seller_role,
    has_buyer_role,
    year_first_seen_batch_id,
    year_last_seen_batch_id,
    year_first_seen_session_id,
    year_last_seen_session_id,
    year_first_seen_date,
    year_last_seen_date,
    invoice_count,
    amount_jshj_sum,
    relation_build_run_id,
    relation_snapshot_id,
    quality_status,
    quality_issue,
    updated_at
)
SELECT
    subject_id,
    stat_year,
    CASE
        WHEN has_seller_role AND has_buyer_role THEN 'both'
        WHEN has_seller_role THEN 'seller'
        WHEN has_buyer_role THEN 'buyer'
        ELSE 'unknown'
    END AS year_role_tag,
    has_seller_role,
    has_buyer_role,
    year_first_seen_batch_id,
    year_last_seen_batch_id,
    year_first_seen_session_id,
    year_last_seen_session_id,
    year_first_seen_date,
    year_last_seen_date,
    invoice_count,
    amount_jshj_sum,
    ? AS relation_build_run_id,
    ? AS relation_snapshot_id,
    'ok' AS quality_status,
    CAST(NULL AS VARCHAR) AS quality_issue,
    CURRENT_TIMESTAMP AS updated_at
FROM year_agg
"""


def rebuild_dim_enterprise_year_rel(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    dry_run: bool = False,
    run_id: str | None = None,
    relation_snapshot_id: str | None = None,
    trigger_source: str = "manual_api",
) -> dict[str, Any]:
    """
    按年度重算 dim_enterprise_year_rel（先删目标年再插入）。

    - **行范围**：仅当年 `dim_group_enterprise_year` 台账成员且能映射到 org 主体的 subject_id。
    - stat_years 为 None 或空列表：目标年度 = **dwd_inv_header 中的 stat_year ∪ dim_group_enterprise_year 中的 stat_year**（去重）。
    - dry_run：只统计将写入的行数，不删不插。
    - trigger_source：写入 ads_etl_task_run_log，便于加工中心查看来源（如 dwd_build_chain、manual_api）。
    """
    ts = (trigger_source or "").strip() or "manual_api"

    try:
        init_all_tables(conn)
    except Exception as exc:  # noqa: BLE001
        err = {
            "ok": False,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "error": {"message": f"init_all_tables 失败: {exc}", "exception_type": type(exc).__name__},
        }
        t0 = time.time()
        rid0 = _utc_run_id("REL")
        _safe_record_dim_task_run(
            run_id=rid0,
            task_code=AUTOMATION_TASK_CODE,
            task_name=TASK_DISPLAY_NAME,
            status="failed",
            trigger_source=ts,
            run_mode="by_year",
            params={"stage": "init_all_tables"},
            result=err,
            rows_affected=0,
            error_message=str(err["error"].get("message") or ""),
            started_at_ts=t0,
        )
        return err

    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
    except Exception as exc:  # noqa: BLE001
        err = {
            "ok": False,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "error": {
                "message": "dwd_inv_header 不可读或不存在，请先完成 ODS→DWD。",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }
        t0 = time.time()
        rid0 = _utc_run_id("REL")
        _safe_record_dim_task_run(
            run_id=rid0,
            task_code=AUTOMATION_TASK_CODE,
            task_name=TASK_DISPLAY_NAME,
            status="failed",
            trigger_source=ts,
            run_mode="by_year",
            params={"stage": "dwd_header_check"},
            result=err,
            rows_affected=0,
            error_message=str(err["error"].get("message") or ""),
            started_at_ts=t0,
        )
        return err

    years = list(stat_years) if stat_years else _merge_auto_target_years(conn)
    years = sorted({int(y) for y in years if 1990 <= int(y) <= 2100})

    if not years:
        out = {
            "ok": True,
            "skipped": True,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "message": "无目标统计年度（未传 stat_years 且 dwd_inv_header 与 dim_group_enterprise_year 均无 stat_year）。",
            "stat_years": [],
            "dry_run": dry_run,
        }
        if not dry_run:
            t0 = time.time()
            rid0 = _utc_run_id("REL")
            _safe_record_dim_task_run(
                run_id=rid0,
                task_code=AUTOMATION_TASK_CODE,
                task_name=TASK_DISPLAY_NAME,
                status="success",
                trigger_source=ts,
                run_mode="by_year",
                params={"stat_years": [], "dry_run": False, "note": "skipped_no_years"},
                result=out,
                rows_affected=0,
                error_message=None,
                started_at_ts=t0,
            )
        return out

    rid = (run_id or "").strip() or _utc_run_id("REL")
    snap = (relation_snapshot_id or "").strip() or f"SNAP_{rid}"
    ph = ",".join(["?"] * len(years))
    bind = [*years, *years, *years]

    try:
        cnt_row = conn.execute(_year_agg_count_sql(ph), bind).fetchone()
        agg_rows = int((cnt_row[0] if cnt_row else 0) or 0)
    except Exception as exc:  # noqa: BLE001
        logger.exception("enterprise_year_rel 预聚合失败")
        err = {
            "ok": False,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "stat_years": years,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
        if not dry_run:
            t0 = time.time()
            _safe_record_dim_task_run(
                run_id=rid,
                task_code=AUTOMATION_TASK_CODE,
                task_name=TASK_DISPLAY_NAME,
                status="failed",
                trigger_source=ts,
                run_mode="by_year",
                params={"stat_years": years, "stage": "year_agg_count"},
                result=err,
                rows_affected=0,
                error_message=str(exc),
                started_at_ts=t0,
            )
        return err

    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "stat_years": years,
            "relation_build_run_id": rid,
            "relation_snapshot_id": snap,
            "rows_that_would_insert": agg_rows,
        }

    t0 = time.time()
    _safe_record_dim_task_running(
        run_id=rid,
        task_code=AUTOMATION_TASK_CODE,
        task_name=TASK_DISPLAY_NAME,
        trigger_source=ts,
        run_mode="by_year",
        params={"stat_years": years, "relation_snapshot_id": snap},
        started_at_ts=t0,
    )

    try:
        prev_row = conn.execute(
            f"SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_rel WHERE stat_year IN ({ph})",
            years,
        ).fetchone()
        rows_before = int((prev_row[0] if prev_row else 0) or 0)
    except Exception as exc:  # noqa: BLE001
        err = {
            "ok": False,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "stat_years": years,
            "error": {"message": f"读取旧行数失败: {exc}", "exception_type": type(exc).__name__},
        }
        _safe_record_dim_task_run(
            run_id=rid,
            task_code=AUTOMATION_TASK_CODE,
            task_name=TASK_DISPLAY_NAME,
            status="failed",
            trigger_source=ts,
            run_mode="by_year",
            params={"stat_years": years, "stage": "count_before_delete"},
            result=err,
            rows_affected=0,
            error_message=str(exc),
            started_at_ts=t0,
        )
        return err

    try:
        conn.execute(f"DELETE FROM dim_enterprise_year_rel WHERE stat_year IN ({ph})", years)
        conn.execute(_year_agg_insert_sql(ph), [*bind, rid, snap])
        post_row = conn.execute(
            f"SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_rel WHERE stat_year IN ({ph})",
            years,
        ).fetchone()
        rows_after = int((post_row[0] if post_row else 0) or 0)
    except Exception as exc:  # noqa: BLE001
        logger.exception("enterprise_year_rel 写入失败")
        err = {
            "ok": False,
            "automation_task_code": AUTOMATION_TASK_CODE,
            "stat_years": years,
            "relation_build_run_id": rid,
            "relation_snapshot_id": snap,
            "rows_before_delete": rows_before,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
        _safe_record_dim_task_run(
            run_id=rid,
            task_code=AUTOMATION_TASK_CODE,
            task_name=TASK_DISPLAY_NAME,
            status="failed",
            trigger_source=ts,
            run_mode="by_year",
            params={"stat_years": years},
            result=err,
            rows_affected=0,
            error_message=str(exc),
            started_at_ts=t0,
        )
        return err

    ok_out = {
        "ok": True,
        "dry_run": False,
        "automation_task_code": AUTOMATION_TASK_CODE,
        "stat_years": years,
        "relation_build_run_id": rid,
        "relation_snapshot_id": snap,
        "rows_before_delete": rows_before,
        "rows_after_insert": rows_after,
        "aggregated_subject_year_rows": agg_rows,
    }
    _safe_record_dim_task_run(
        run_id=rid,
        task_code=AUTOMATION_TASK_CODE,
        task_name=TASK_DISPLAY_NAME,
        status="success",
        trigger_source=ts,
        run_mode="by_year",
        params={"stat_years": years},
        result=ok_out,
        rows_affected=rows_after,
        error_message=None,
        started_at_ts=t0,
    )
    return ok_out


def api_dim_enterprise_year_rel_meta(conn: Any) -> dict[str, Any]:
    """GET：返回 DWD / 集团台账年度、合并年度及 dim 表行数（只读）。"""
    try:
        init_all_tables(conn)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    dwd_years: list[int] = []
    group_years: list[int] = []
    dim_counts: dict[str, int] = {}
    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
        dwd_years = _distinct_stat_years_from_dwd(conn)
    except Exception:
        pass

    try:
        conn.execute("SELECT 1 FROM dim_enterprise_year_roster LIMIT 1")
        group_years = _distinct_stat_years_from_group(conn)
    except Exception:
        pass

    try:
        rows = conn.execute(
            """
            SELECT CAST(stat_year AS INTEGER) AS y, COUNT(*)::BIGINT AS n
            FROM dim_enterprise_year_rel
            GROUP BY stat_year
            ORDER BY y
            """
        ).fetchall()
        for yv, nv in rows or []:
            if yv is not None:
                dim_counts[str(int(yv))] = int(nv or 0)
    except Exception:
        pass

    union_sorted = sorted({*dwd_years, *group_years})

    return {
        "ok": True,
        "automation_task_code": AUTOMATION_TASK_CODE,
        "dwd_stat_years": [str(y) for y in dwd_years],
        "group_stat_years": [str(y) for y in group_years],
        "rel_rebuild_union_stat_years": [str(y) for y in union_sorted],
        "dim_enterprise_year_rel_row_counts_by_year": dim_counts,
    }
