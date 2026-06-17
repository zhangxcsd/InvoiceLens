"""企业开票行为画像只读 API（dws_enterprise_invoice_profile）。"""

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


def _profile_row(r: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "stat_month": str(r[0] or ""),
        "stat_month_no": int(r[1] or 0),
        "inv_cnt_total": int(r[2] or 0),
        "inv_amt_total": round(float(r[3] or 0), 2),
        "inv_cnt_output": int(r[4] or 0),
        "inv_amt_output": round(float(r[5] or 0), 2),
        "inv_cnt_input": int(r[6] or 0),
        "inv_amt_input": round(float(r[7] or 0), 2),
        "counterparty_cnt_output": int(r[8] or 0),
        "counterparty_cnt_input": int(r[9] or 0),
        "red_inv_ratio": round(float(r[10] or 0), 6) if r[10] is not None else None,
        "amt_mom_change": round(float(r[11] or 0), 6) if r[11] is not None else None,
        "cnt_mom_change": round(float(r[12] or 0), 6) if r[12] is not None else None,
        "abnormal_red_flag": bool(r[13]),
        "abnormal_spike_flag": bool(r[14]),
        "abnormal_counterparty_concentration_flag": bool(r[15]),
        "risk_level": str(r[16] or ""),
    }


def api_dws_enterprise_behavior_profile(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    """按月返回企业开票行为画像。"""
    try:
        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "开票行为画像需指定主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }

        rows = conn.execute(
            """
            -- 审计含义：按月展示开票规模、红票占比、环比与异常标记
            SELECT
                stat_month,
                stat_month_no,
                inv_cnt_total,
                inv_amt_total,
                inv_cnt_output,
                inv_amt_output,
                inv_cnt_input,
                inv_amt_input,
                counterparty_cnt_output,
                counterparty_cnt_input,
                red_inv_ratio,
                amt_mom_change,
                cnt_mom_change,
                abnormal_red_flag,
                abnormal_spike_flag,
                abnormal_counterparty_concentration_flag,
                risk_level
            FROM dws_enterprise_invoice_profile
            WHERE stat_year = ? AND enterprise_id = ?
            ORDER BY stat_month_no
            """,
            [y, eid],
        ).fetchall()

        months = [_profile_row(r) for r in rows or []]
        abnormal_cnt = sum(
            1
            for m in months
            if m["abnormal_red_flag"] or m["abnormal_spike_flag"] or m["abnormal_counterparty_concentration_flag"]
        )
        high_risk_cnt = sum(1 for m in months if str(m.get("risk_level") or "").upper() in ("HIGH", "高", "高风险"))

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "months": months,
            "summary": {
                "month_count": len(months),
                "abnormal_month_count": abnormal_cnt,
                "high_risk_month_count": high_risk_cnt,
            },
            "hint": None
            if months
            else f"{y} 年度暂无企业开票行为画像（请先执行「企业画像构建」任务）。",
        }
    except Exception as exc:
        logger.exception("dws_enterprise_behavior_profile")
        return {"ok": False, "months": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}
