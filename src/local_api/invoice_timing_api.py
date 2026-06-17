"""开票时间行为分析 API（dws_inv_trend + dwd_inv_header）。"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    from datetime import date

    d = date.today().year if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _norm_entity(v: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _role_clause(role_type: str) -> str:
    norm_gfs = "upper(regexp_replace(trim(coalesce(h.gfsbh, '')), '[\\\\s-]+', '', 'g'))"
    norm_xfs = "upper(regexp_replace(trim(coalesce(h.xfsbh, '')), '[\\\\s-]+', '', 'g'))"
    return f" AND {norm_gfs} = ?" if role_type == "进项" else f" AND {norm_xfs} = ?"


def api_dws_invoice_timing_overview(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    role_type: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "开票时间行为分析需指定主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        rt = (role_type or "进项").strip()
        if rt not in ("进项", "销项"):
            rt = "进项"

        holiday_cnt = 0
        weekend_large_cnt = 0
        normal_cnt = 0
        monthly: list[tuple[Any, ...]] = []
        try:
            trend = conn.execute(
                """
                -- 审计含义：汇总节假日/周末大额开票次数（预聚合 dws_inv_trend）
                SELECT
                    coalesce(sum(holiday_cnt), 0)::BIGINT,
                    coalesce(sum(weekend_large_cnt), 0)::BIGINT,
                    coalesce(sum(normal_cnt), 0)::BIGINT
                FROM dws_inv_trend
                WHERE stat_year = ? AND entity_id = ? AND role_type = ?
                """,
                [y, eid, rt],
            ).fetchone()
            holiday_cnt = int(trend[0] or 0) if trend else 0
            weekend_large_cnt = int(trend[1] or 0) if trend else 0
            normal_cnt = int(trend[2] or 0) if trend else 0
            monthly = conn.execute(
                """
                SELECT stat_month, coalesce(holiday_cnt, 0), coalesce(weekend_large_cnt, 0)
                FROM dws_inv_trend
                WHERE stat_year = ? AND entity_id = ? AND role_type = ?
                ORDER BY stat_month
                """,
                [y, eid, rt],
            ).fetchall()
        except Exception:
            logger.exception("dws_inv_trend timing aggregate fallback")

        role_clause = _role_clause(rt)

        dow_rows = conn.execute(
            f"""
            -- 审计含义：按星期分布观察开票习惯（非工作日集中需关注）
            SELECT
                dayofweek(h.invoice_date) AS dow,
                count(*)::BIGINT AS cnt
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND h.invoice_date IS NOT NULL{role_clause}
            GROUP BY 1
            ORDER BY 1
            """,
            [y, eid],
        ).fetchall()

        yearend = conn.execute(
            f"""
            -- 审计含义：11–12 月开票占全年比例（年末突击开票风险）
            SELECT
                sum(CASE WHEN h.stat_month IN (11, 12) THEN 1 ELSE 0 END)::BIGINT,
                count(*)::BIGINT
            FROM dwd_inv_header h
            WHERE h.stat_year = ?{role_clause}
            """,
            [y, eid],
        ).fetchone()
        yearend_cnt = int(yearend[0] or 0) if yearend else 0
        total_cnt = int(yearend[1] or 0) if yearend else 0
        yearend_ratio = round(yearend_cnt / total_cnt, 6) if total_cnt > 0 else None

        if normal_cnt <= 0 and total_cnt > 0:
            normal_cnt = total_cnt

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "role_type": rt,
            "stats": {
                "holiday_cnt": holiday_cnt,
                "weekend_large_cnt": weekend_large_cnt,
                "normal_cnt": normal_cnt,
                "yearend_cnt": yearend_cnt,
                "yearend_ratio": yearend_ratio,
            },
            "day_of_week": [{"dow": int(r[0] or 0), "cnt": int(r[1] or 0)} for r in dow_rows or []],
            "monthly": [
                {
                    "stat_month": int(r[0] or 0),
                    "holiday_cnt": int(r[1] or 0),
                    "weekend_large_cnt": int(r[2] or 0),
                }
                for r in monthly or []
            ],
            "hint": None if total_cnt > 0 or normal_cnt > 0 else f"{y} 年度该主体暂无时间行为数据。",
        }
    except Exception as exc:
        logger.exception("dws_invoice_timing_overview")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
