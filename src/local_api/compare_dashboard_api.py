"""子公司横向对比（ads_scorecard）只读 API 与刷新入口。"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)


def _calendar_year() -> int:
    return date.today().year


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = _calendar_year() if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _distinct_scorecard_years(conn: Any) -> list[str]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM ads_scorecard WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM dws_inv_trend WHERE stat_year IS NOT NULL",
    ):
        try:
            for (yv,) in conn.execute(sql).fetchall() or []:
                if yv is not None:
                    yi = int(yv)
                    if 1990 <= yi <= 2100:
                        years.add(yi)
        except Exception:
            continue
    if not years:
        return [str(_calendar_year())]
    return [str(y) for y in sorted(years, reverse=True)]


def api_compare_meta(conn: Any) -> dict[str, Any]:
    try:
        from src.local_api.license_gate import check_cross_group_allowed, get_license_config

        denied = check_cross_group_allowed()
        if denied:
            return denied

        years = _distinct_scorecard_years(conn)
        cy = str(_calendar_year())
        default_y = cy if cy in years else years[0]
        cnt = 0
        entity_cnt = 0
        try:
            cnt = int(conn.execute("SELECT COUNT(*)::BIGINT FROM ads_scorecard").fetchone()[0] or 0)
        except Exception:
            pass
        try:
            entity_cnt = int(
                conn.execute("SELECT COUNT(DISTINCT entity_id)::BIGINT FROM ads_scorecard").fetchone()[0] or 0
            )
        except Exception:
            pass
        lic = get_license_config()
        max_ent = lic.get("max_entities")
        hints: list[str] = []
        if cnt <= 0:
            hints.append("评分卡尚无数据。请先完成 DWS 聚合与审计疑点扫描，再点击「刷新评分卡」。")
        if isinstance(max_ent, int) and max_ent > 0 and entity_cnt > max_ent:
            hints.append(
                f"当前评分卡含 {entity_cnt} 个主体，超过试用版上限 {max_ent}。"
                "对比分析结果可能不完整，升级授权后可解除限制。"
            )
        return {
            "ok": True,
            "stat_years": years,
            "default_stat_year": default_y,
            "scorecard_ready": cnt > 0,
            "entity_count": entity_cnt,
            "max_entities": max_ent,
            "hint": " ".join(hints) if hints else None,
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_compare_rank_list(
    conn: Any,
    *,
    stat_year: str | None,
    risk_level: str | None = None,
    keyword: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        from src.local_api.license_gate import check_cross_group_allowed, compare_entity_cap

        denied = check_cross_group_allowed()
        if denied:
            return {**denied, "rows": [], "total": 0, "summary": {}}

        y = _safe_int_year(stat_year)
        from src.audit.config_loader import group_id_for_year

        gid = group_id_for_year(y)
        entity_cap = compare_entity_cap()
        entity_cap_clause = ""
        cap_params: list[Any] = []
        if entity_cap is not None:
            entity_cap_clause = """
            AND entity_id IN (
                SELECT entity_id FROM (
                    SELECT entity_id
                    FROM ads_scorecard
                    WHERE group_id = ? AND stat_year = ?
                    GROUP BY entity_id
                    ORDER BY MIN(risk_score) ASC NULLS LAST, entity_id
                    LIMIT ?
                ) capped
            )
            """
            cap_params = [gid, y, entity_cap]
        clauses = ["group_id = ?", "stat_year = ?"]
        params: list[Any] = [gid, y]
        rl = (risk_level or "").strip()
        if rl and rl not in ("all", "全部"):
            clauses.append("risk_level = ?")
            params.append(rl)
        kw = (keyword or "").strip()
        if kw:
            clauses.append("(entity_name ILIKE ? OR entity_id ILIKE ?)")
            like = f"%{kw}%"
            params.extend([like, like])
        where = " AND ".join(clauses) + entity_cap_clause
        lim = max(1, min(int(limit or 500), 2000))
        off = max(0, int(offset or 0))
        count_params = [*params, *cap_params]
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM ads_scorecard WHERE {where}", count_params).fetchone()[0]
            or 0
        )
        rows = conn.execute(
            f"""
            SELECT
                scorecard_id, entity_id, entity_name, stat_year,
                total_amount, total_count, supplier_count,
                flag_total, flag_high, flag_medium, flag_low,
                risk_score, risk_level, cr1, cancel_ratio, quality_score,
                analysis_batch, updated_at
            FROM ads_scorecard
            WHERE {where}
            ORDER BY risk_score ASC, flag_high DESC, total_amount DESC NULLS LAST, entity_id
            LIMIT ? OFFSET ?
            """,
            [*count_params, lim, off],
        ).fetchall()

        summary_where = "group_id = ? AND stat_year = ?" + entity_cap_clause
        summary_row = conn.execute(
            f"""
            SELECT
                count(*)::BIGINT,
                count(*) FILTER (WHERE risk_level = '正常')::BIGINT,
                count(*) FILTER (WHERE risk_level = '关注')::BIGINT,
                count(*) FILTER (WHERE risk_level = '重点关注')::BIGINT
            FROM ads_scorecard
            WHERE {summary_where}
            """,
            count_params,
        ).fetchone()
        summary = {
            "total": int(summary_row[0] or 0) if summary_row else 0,
            "normal": int(summary_row[1] or 0) if summary_row else 0,
            "watch": int(summary_row[2] or 0) if summary_row else 0,
            "critical": int(summary_row[3] or 0) if summary_row else 0,
        }

        out_rows = [
            {
                "scorecard_id": str(r[0] or ""),
                "entity_id": str(r[1] or ""),
                "entity_name": str(r[2] or r[1] or ""),
                "stat_year": int(r[3] or y),
                "total_amount": float(r[4] or 0),
                "total_count": int(r[5] or 0),
                "supplier_count": int(r[6] or 0),
                "flag_total": int(r[7] or 0),
                "flag_high": int(r[8] or 0),
                "flag_medium": int(r[9] or 0),
                "flag_low": int(r[10] or 0),
                "risk_score": float(r[11] or 0),
                "risk_level": str(r[12] or ""),
                "cr1": float(r[13]) if r[13] is not None else None,
                "cancel_ratio": float(r[14] or 0),
                "quality_score": float(r[15]) if r[15] is not None else None,
                "analysis_batch": str(r[16] or ""),
                "updated_at": str(r[17] or ""),
            }
            for r in rows or []
        ]
        return {
            "ok": True,
            "stat_year": str(y),
            "group_id": gid,
            "total": total,
            "summary": summary,
            "rows": out_rows,
            "entity_cap": entity_cap,
            "entity_cap_applied": entity_cap is not None,
        }
    except Exception as exc:
        logger.exception("compare_rank_list")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


_COMPARE_CHART_METRICS: dict[str, tuple[str, str]] = {
    "amount": ("total_amount DESC NULLS LAST", "total_amount"),
    "flags": ("flag_high DESC NULLS LAST, flag_total DESC", "flag_high"),
    "score": ("risk_score ASC NULLS LAST", "risk_score"),
    "cr1": ("cr1 DESC NULLS LAST", "cr1"),
    "cancel": ("cancel_ratio DESC NULLS LAST", "cancel_ratio"),
}


def api_compare_charts_series(
    conn: Any,
    *,
    stat_year: str | None,
    metric: str = "amount",
    limit: int = 15,
) -> dict[str, Any]:
    """返回子公司横向对比图表序列（Top N，基于 ads_scorecard）。"""
    try:
        from src.local_api.license_gate import check_cross_group_allowed, compare_entity_cap

        denied = check_cross_group_allowed()
        if denied:
            return {**denied, "series": []}

        y = _safe_int_year(stat_year)
        from src.audit.config_loader import group_id_for_year

        gid = group_id_for_year(y)
        mkey = (metric or "amount").strip().lower()
        if mkey not in _COMPARE_CHART_METRICS:
            mkey = "amount"
        order_sql, value_col = _COMPARE_CHART_METRICS[mkey]
        lim = max(3, min(int(limit or 15), 30))
        entity_cap = compare_entity_cap()
        chart_cap = min(lim, entity_cap) if entity_cap is not None else lim

        out_rows_raw = conn.execute(
            f"""
            SELECT
                entity_id, entity_name, risk_level, risk_score,
                total_amount, flag_high, flag_total, cr1, cancel_ratio, supplier_count
            FROM ads_scorecard
            WHERE group_id = ? AND stat_year = ?
            ORDER BY {order_sql}, entity_id
            LIMIT ?
            """,
            [gid, y, chart_cap],
        ).fetchall()

        col_idx = {
            "total_amount": 4,
            "flag_high": 5,
            "risk_score": 3,
            "cr1": 7,
            "cancel_ratio": 8,
        }
        vidx = col_idx.get(value_col, 4)

        series = []
        for r in out_rows_raw or []:
            raw_val = r[vidx]
            series.append(
                {
                    "entity_id": str(r[0] or ""),
                    "entity_name": str(r[1] or r[0] or ""),
                    "risk_level": str(r[2] or ""),
                    "risk_score": float(r[3] or 0),
                    "total_amount": float(r[4] or 0),
                    "flag_high": int(r[5] or 0),
                    "flag_total": int(r[6] or 0),
                    "cr1": float(r[7]) if r[7] is not None else None,
                    "cancel_ratio": float(r[8] or 0),
                    "supplier_count": int(r[9] or 0),
                    "value": float(raw_val) if raw_val is not None else 0.0,
                }
            )

        dist_row = conn.execute(
            """
            SELECT
                count(*) FILTER (WHERE risk_level = '正常')::BIGINT,
                count(*) FILTER (WHERE risk_level = '关注')::BIGINT,
                count(*) FILTER (WHERE risk_level = '重点关注')::BIGINT,
                count(*)::BIGINT
            FROM ads_scorecard
            WHERE group_id = ? AND stat_year = ?
            """,
            [gid, y],
        ).fetchone()
        risk_distribution = {
            "normal": int(dist_row[0] or 0) if dist_row else 0,
            "watch": int(dist_row[1] or 0) if dist_row else 0,
            "critical": int(dist_row[2] or 0) if dist_row else 0,
            "total": int(dist_row[3] or 0) if dist_row else 0,
        }

        return {
            "ok": True,
            "stat_year": str(y),
            "group_id": gid,
            "metric": mkey,
            "limit": lim,
            "series": series,
            "risk_distribution": risk_distribution,
        }
    except Exception as exc:
        logger.exception("compare_charts_series")
        return {"ok": False, "series": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_compare_rebuild(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        from src.local_api.license_gate import check_cross_group_allowed

        denied = check_cross_group_allowed()
        if denied:
            return denied

        from src.etl.ads_scorecard_build import refresh_ads_scorecard_years

        raw_years = body.get("stat_years")
        years: list[int] | None = None
        if isinstance(raw_years, list) and raw_years:
            years = [int(str(y)) for y in raw_years if str(y).strip().isdigit()]
        elif body.get("stat_year"):
            ys = str(body.get("stat_year") or "").strip()
            if ys.isdigit():
                years = [int(ys)]
        return refresh_ads_scorecard_years(conn, stat_years=years)
    except Exception as exc:
        logger.exception("compare_rebuild")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
