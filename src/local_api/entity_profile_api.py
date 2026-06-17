"""被审主体画像聚合 API（集中度 / 供应商变动 / 税率与税码 / 关联 / 疑点）。"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _norm_entity(v: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    from datetime import date

    d = date.today().year if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _entity_name(conn: Any, entity_id: str, stat_year: int) -> str:
    try:
        row = conn.execute(
            """
            SELECT coalesce(entity_name, entity_id)
            FROM dws_inv_trend
            WHERE stat_year = ? AND entity_id = ?
            LIMIT 1
            """,
            [stat_year, entity_id],
        ).fetchone()
        if row and row[0]:
            return str(row[0])
    except Exception:
        pass
    try:
        row = conn.execute(
            """
            SELECT coalesce(enterprise_name, enterprise_id)
            FROM dim_enterprise_year_roster
            WHERE stat_year = ? AND enterprise_id = ?
            LIMIT 1
            """,
            [stat_year, entity_id],
        ).fetchone()
        if row and row[0]:
            return str(row[0])
    except Exception:
        pass
    return entity_id


def _flags_by_rule(conn: Any, *, stat_year: int, entity_id: str) -> list[dict[str, Any]]:
    group_id = f"Y{stat_year}"
    try:
        rows = conn.execute(
            """
            -- 审计含义：按规则统计该主体未确认/全部疑点规模
            SELECT
                rule_id,
                count(*)::BIGINT AS flag_cnt,
                sum(CASE WHEN COALESCE(is_confirmed, FALSE) THEN 0 ELSE 1 END)::BIGINT AS pending_cnt,
                sum(coalesce(amount, 0)) AS amount_sum
            FROM dm_audit_flag
            WHERE group_id = ?
              AND upper(regexp_replace(trim(coalesce(entity_id, '')), '[\\s-]+', '', 'g')) = ?
            GROUP BY rule_id
            ORDER BY pending_cnt DESC, flag_cnt DESC, rule_id
            LIMIT 50
            """,
            [group_id, entity_id],
        ).fetchall()
        return [
            {
                "rule_id": str(r[0] or ""),
                "flag_count": int(r[1] or 0),
                "pending_count": int(r[2] or 0),
                "amount_sum": round(float(r[3] or 0), 2),
            }
            for r in rows or []
        ]
    except Exception:
        logger.exception("entity_profile flags_by_rule")
        return []


def api_dws_entity_profile(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    min_invoice_count: int | None = None,
) -> dict[str, Any]:
    """单主体年度画像：聚合 DWS / 税码 / 疑点等已有口径。"""
    try:
        from src.local_api.dws_dashboard_api import (
            api_dws_customer_cr,
            api_dws_customer_top,
            api_dws_overview_tax,
            api_dws_supplier_churn,
            api_dws_supplier_cr,
            api_dws_supplier_top,
            api_dws_trade_graph,
        )
        from src.local_api.dws_enterprise_behavior_api import api_dws_enterprise_behavior_profile
        from src.local_api.dws_goods_cat_api import api_dws_goods_cat_overview
        from src.local_api.counterparty_risk_api import api_dws_counterparty_risk_list
        from src.local_api.year_over_year_api import api_dws_year_over_year_compare
        from src.local_api.tax_code_analysis_api import (
            _compute_tax_code_fluctuation,
            api_tax_code_analysis_overview,
        )

        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "主体画像需指定 entity_id（纳税人识别号）",
                    "exception_type": "ValidationError",
                },
            }

        cr = api_dws_supplier_cr(conn, stat_year=str(y), entity_id=eid)
        customer_cr = api_dws_customer_cr(conn, stat_year=str(y), entity_id=eid)
        top = api_dws_supplier_top(conn, stat_year=str(y), entity_id=eid, limit=5)
        customer_top = api_dws_customer_top(conn, stat_year=str(y), entity_id=eid, limit=5)
        churn = api_dws_supplier_churn(conn, stat_year=str(y), entity_id=eid, kind="new", limit=1)
        behavior = api_dws_enterprise_behavior_profile(conn, stat_year=str(y), entity_id=eid)
        goods_cat = api_dws_goods_cat_overview(conn, stat_year=str(y), entity_id=eid)
        cp_risk = api_dws_counterparty_risk_list(conn, stat_year=str(y), entity_id=eid, limit=5)
        yoy = api_dws_year_over_year_compare(conn, stat_year=str(y), entity_id=eid)
        tax_in = api_dws_overview_tax(conn, stat_year=str(y), entity_id=eid, role_type="进项")
        tax_code = api_tax_code_analysis_overview(conn, stat_year=str(y), entity_id=eid)
        fluctuation = _compute_tax_code_fluctuation(conn, stat_year=y, entity_id=eid)
        graph = api_dws_trade_graph(conn, stat_year=str(y), entity_id=eid)
        flags = _flags_by_rule(conn, stat_year=y, entity_id=eid)

        flag_total = sum(x["flag_count"] for x in flags)
        flag_pending = sum(x["pending_count"] for x in flags)

        graph_nodes = 0
        graph_edges = 0
        if graph.get("ok"):
            graph_nodes = len(graph.get("nodes") or [])
            graph_edges = len(graph.get("edges") or [])

        churn_summary = churn.get("summary") if churn.get("ok") else {}

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "entity_name": _entity_name(conn, eid, y),
            "concentration": {
                "cr1": cr.get("cr1") if cr.get("ok") else None,
                "cr3": cr.get("cr3") if cr.get("ok") else None,
                "cr10": cr.get("cr10") if cr.get("ok") else None,
                "total_net_jshj": cr.get("total_net_jshj") if cr.get("ok") else None,
                "top_suppliers": (top.get("rows") or [])[:5] if top.get("ok") else [],
            },
            "customer_concentration": {
                "cr1": customer_cr.get("cr1") if customer_cr.get("ok") else None,
                "cr3": customer_cr.get("cr3") if customer_cr.get("ok") else None,
                "cr10": customer_cr.get("cr10") if customer_cr.get("ok") else None,
                "total_net_jshj": customer_cr.get("total_net_jshj") if customer_cr.get("ok") else None,
                "top_customers": (customer_top.get("rows") or [])[:5] if customer_top.get("ok") else [],
            },
            "behavior": {
                "summary": behavior.get("summary") if behavior.get("ok") else {},
                "month_count": len(behavior.get("months") or []) if behavior.get("ok") else 0,
            },
            "goods_category": {
                "total_net_jshj": goods_cat.get("total_net_jshj") if goods_cat.get("ok") else None,
                "top_categories": (goods_cat.get("top_categories") or [])[:5] if goods_cat.get("ok") else [],
            },
            "counterparty_risk": {
                "rows": (cp_risk.get("rows") or [])[:5] if cp_risk.get("ok") else [],
            },
            "year_over_year": {
                "prior_year": yoy.get("prior_year") if yoy.get("ok") else str(y - 1),
                "churn_summary": yoy.get("churn_summary") if yoy.get("ok") else {},
                "tax_buckets": yoy.get("tax_buckets") if yoy.get("ok") else {},
            },
            "churn": {
                "new_total": int(churn_summary.get("new_total") or 0),
                "new_top10": int(churn_summary.get("new_top10") or 0),
                "disappeared_total": int(churn_summary.get("disappeared_total") or 0),
                "prior_year": str(churn_summary.get("prior_year") or y - 1),
            },
            "tax_structure": {
                "buckets": (tax_in.get("rows") or [])[:6] if tax_in.get("ok") else [],
                "total_amount_je": tax_in.get("total_amount_je") if tax_in.get("ok") else None,
                "total_line_cnt": tax_in.get("total_line_cnt") if tax_in.get("ok") else None,
            },
            "tax_code": {
                "match_rate": tax_code.get("match_rate") if tax_code.get("ok") else None,
                "high_risk_amount_share": tax_code.get("high_risk_amount_share")
                if tax_code.get("ok")
                else None,
                "top_category_name": tax_code.get("top_category_name") if tax_code.get("ok") else None,
                "top_category_share": tax_code.get("top_category_share") if tax_code.get("ok") else None,
                **fluctuation,
            },
            "related": {
                "graph_node_count": graph_nodes,
                "graph_edge_count": graph_edges,
                "graph_ok": bool(graph.get("ok")),
            },
            "audit_flags": {
                "total": flag_total,
                "pending": flag_pending,
                "by_rule": flags,
            },
            "min_invoice_count": min_invoice_count,
        }
    except Exception as exc:
        logger.exception("dws_entity_profile")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
