"""单主体跨年结构对比 API。"""

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


def api_dws_year_over_year_compare(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    try:
        from src.local_api.dws_dashboard_api import api_dws_overview_tax, api_dws_supplier_churn, api_dws_supplier_top

        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "跨年对比需指定主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        prior = y - 1
        if prior < 1990:
            return {"ok": False, "error": {"message": "无法对比：当前年度过小", "exception_type": "ValidationError"}}

        tax_cur = api_dws_overview_tax(conn, stat_year=str(y), entity_id=eid, role_type="进项")
        tax_prior = api_dws_overview_tax(conn, stat_year=str(prior), entity_id=eid, role_type="进项")
        sup_cur = api_dws_supplier_top(conn, stat_year=str(y), entity_id=eid, limit=5)
        sup_prior = api_dws_supplier_top(conn, stat_year=str(prior), entity_id=eid, limit=5)
        churn = api_dws_supplier_churn(conn, stat_year=str(y), entity_id=eid, kind="new", limit=1)

        cat_cur = conn.execute(
            """
            SELECT tax_code_short, tax_code_level2, sum(net_jshj)
            FROM dws_goods_cat
            WHERE stat_year = ? AND entity_id = ?
            GROUP BY tax_code_short, tax_code_level2
            ORDER BY sum(net_jshj) DESC NULLS LAST
            LIMIT 5
            """,
            [y, eid],
        ).fetchall()
        cat_prior = conn.execute(
            """
            SELECT tax_code_short, tax_code_level2, sum(net_jshj)
            FROM dws_goods_cat
            WHERE stat_year = ? AND entity_id = ?
            GROUP BY tax_code_short, tax_code_level2
            ORDER BY sum(net_jshj) DESC NULLS LAST
            LIMIT 5
            """,
            [prior, eid],
        ).fetchall()

        cust_cur = conn.execute(
            """
            SELECT counterparty_id, max(counterparty_name), sum(total_amount)
            FROM dws_trade_sum
            WHERE stat_year = ? AND entity_id = ? AND counterparty_role = '客户'
            GROUP BY counterparty_id
            ORDER BY sum(total_amount) DESC NULLS LAST
            LIMIT 5
            """,
            [y, eid],
        ).fetchall()
        cust_prior = conn.execute(
            """
            SELECT counterparty_id, max(counterparty_name), sum(total_amount)
            FROM dws_trade_sum
            WHERE stat_year = ? AND entity_id = ? AND counterparty_role = '客户'
            GROUP BY counterparty_id
            ORDER BY sum(total_amount) DESC NULLS LAST
            LIMIT 5
            """,
            [prior, eid],
        ).fetchall()

        def _bucket_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
            if not payload.get("ok"):
                return []
            return [
                {
                    "tax_bucket": str(r.get("tax_bucket") or ""),
                    "amount_ratio": float(r.get("amount_ratio") or 0),
                    "amount_je": float(r.get("amount_je") or 0),
                }
                for r in payload.get("rows") or []
            ]

        def _top_rows(rows: list[tuple[Any, ...]], id_idx: int = 0, name_idx: int = 1, amt_idx: int = 2):
            return [
                {
                    "id": str(r[id_idx] or ""),
                    "name": str(r[name_idx] or r[id_idx] or ""),
                    "amount": round(float(r[amt_idx] or 0), 2),
                }
                for r in rows or []
            ]

        churn_summary = churn.get("summary") if churn.get("ok") else {}

        return {
            "ok": True,
            "stat_year": str(y),
            "prior_year": str(prior),
            "entity_id": eid,
            "tax_buckets": {
                "current": _bucket_rows(tax_cur),
                "prior": _bucket_rows(tax_prior),
            },
            "top_suppliers": {
                "current": (sup_cur.get("rows") or [])[:5] if sup_cur.get("ok") else [],
                "prior": (sup_prior.get("rows") or [])[:5] if sup_prior.get("ok") else [],
            },
            "top_customers": {
                "current": _top_rows(cust_cur),
                "prior": _top_rows(cust_prior),
            },
            "category_mix": {
                "current": _top_rows(cat_cur, 0, 1, 2),
                "prior": _top_rows(cat_prior, 0, 1, 2),
            },
            "churn_summary": {
                "new_total": int(churn_summary.get("new_total") or 0),
                "disappeared_total": int(churn_summary.get("disappeared_total") or 0),
            },
        }
    except Exception as exc:
        logger.exception("dws_year_over_year_compare")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
