"""D+1/D+2/D+3 分析包 GET 路由分发（供 sheet_mapping_server 调用）。"""

from __future__ import annotations

from typing import Any, Callable


DWS_DPLUS_GET_PATHS = frozenset(
    {
        "/api/dws/goods-cat/overview",
        "/api/dws/goods-cat/list",
        "/api/dws/enterprise-behavior/profile",
        "/api/dws/customer/cr",
        "/api/dws/customer/top",
        "/api/dws/customer/churn",
        "/api/dws/red-offset/overview",
        "/api/dws/red-offset/list",
        "/api/dws/invoice-timing/overview",
        "/api/dws/counterparty-risk/list",
        "/api/dws/year-over-year/compare",
    }
)


def is_dws_dplus_get_path(path: str) -> bool:
    return path in DWS_DPLUS_GET_PATHS or path == "/api/dws/red-offset/export"


def _qs_val(qs: dict[str, list[str]], key: str, default: str = "") -> str:
    return (qs.get(key, [default])[0] or default).strip()


def _int_qs(qs: dict[str, list[str]], key: str, default: int) -> int:
    raw = _qs_val(qs, key, str(default))
    try:
        return int(raw) if raw.isdigit() else default
    except Exception:
        return default


def dispatch_dws_dplus_get(path: str, qs: dict[str, list[str]], conn: Any) -> tuple[int, dict[str, Any]] | None:
    """匹配 D+ 分析包只读 API；未匹配返回 None。"""
    if path == "/api/dws/goods-cat/overview":
        from src.local_api.dws_goods_cat_api import api_dws_goods_cat_overview

        payload = api_dws_goods_cat_overview(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            stat_quarter=_qs_val(qs, "stat_quarter") or None,
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/goods-cat/list":
        from src.local_api.dws_goods_cat_api import api_dws_goods_cat_list

        payload = api_dws_goods_cat_list(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            stat_quarter=_qs_val(qs, "stat_quarter") or None,
            limit=_int_qs(qs, "limit", 50),
            offset=_int_qs(qs, "offset", 0),
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/enterprise-behavior/profile":
        from src.local_api.dws_enterprise_behavior_api import api_dws_enterprise_behavior_profile

        payload = api_dws_enterprise_behavior_profile(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/customer/cr":
        from src.local_api.dws_dashboard_api import api_dws_customer_cr

        payload = api_dws_customer_cr(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/customer/top":
        from src.local_api.dws_dashboard_api import api_dws_customer_top

        payload = api_dws_customer_top(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            limit=_int_qs(qs, "limit", 20),
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/customer/churn":
        from src.local_api.dws_dashboard_api import api_dws_customer_churn

        top_only = _qs_val(qs, "top_only").lower() in ("1", "true", "yes")
        payload = api_dws_customer_churn(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            kind=_qs_val(qs, "kind", "new") or "new",
            top_only=top_only,
            keyword=_qs_val(qs, "keyword") or None,
            limit=_int_qs(qs, "limit", 50),
            offset=_int_qs(qs, "offset", 0),
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/red-offset/overview":
        from src.local_api.red_offset_api import api_dws_red_offset_overview

        payload = api_dws_red_offset_overview(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/red-offset/list":
        from src.local_api.red_offset_api import api_dws_red_offset_list

        payload = api_dws_red_offset_list(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            kind=_qs_val(qs, "kind", "all") or "all",
            limit=_int_qs(qs, "limit", 50),
            offset=_int_qs(qs, "offset", 0),
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/invoice-timing/overview":
        from src.local_api.invoice_timing_api import api_dws_invoice_timing_overview

        payload = api_dws_invoice_timing_overview(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            role_type=_qs_val(qs, "role_type") or None,
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/counterparty-risk/list":
        from src.local_api.counterparty_risk_api import api_dws_counterparty_risk_list

        payload = api_dws_counterparty_risk_list(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
            limit=_int_qs(qs, "limit", 30),
            offset=_int_qs(qs, "offset", 0),
        )
        return (200 if payload.get("ok") else 400, payload)

    if path == "/api/dws/year-over-year/compare":
        from src.local_api.year_over_year_api import api_dws_year_over_year_compare

        payload = api_dws_year_over_year_compare(
            conn,
            stat_year=_qs_val(qs, "stat_year") or None,
            entity_id=_qs_val(qs, "entity_id") or None,
        )
        return (200 if payload.get("ok") else 400, payload)

    return None


def handle_dws_dplus_get(
    path: str,
    qs: dict[str, list[str]],
    send: Callable[..., None],
) -> bool:
    """在 sheet_mapping_server.do_GET 中调用；已处理则返回 True。"""
    try:
        from db.duckdb_conn import get_conn
        from db.schema_sqlfiles import init_all_tables

        conn = get_conn()
        init_all_tables(conn)
        result = dispatch_dws_dplus_get(path, qs, conn)
        if result is None:
            return False
        status, payload = result
        send(status, payload)
        return True
    except Exception as exc:
        send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
        return True
