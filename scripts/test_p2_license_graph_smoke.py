"""CI smoke: 授权门控 + 关联图谱截断逻辑。"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.dws_dashboard_api import api_dws_trade_graph
from src.local_api.invoice_export_api import api_export_invoices
from src.local_api.license_gate import api_settings_license, check_export_allowed
from src.local_api.report_api import api_report_generate


def test_license_export_denied_by_default() -> None:
    lic = api_settings_license()
    assert lic.get("ok") is True
    assert lic.get("export_report") is False
    denied = check_export_allowed()
    assert denied is not None
    assert denied["error"]["code"] == "license_export_denied"


def test_report_generate_blocked_when_trial() -> None:
    conn = duckdb.connect(":memory:")
    res = api_report_generate(conn, {"stat_year": "2024", "title": "test"})
    assert res.get("ok") is False
    assert res.get("error", {}).get("code") == "license_export_denied"


def test_export_invoices_blocked_when_trial() -> None:
    conn = duckdb.connect(":memory:")
    status, body, _, _ = api_export_invoices(conn, stat_year="2024")
    assert status == 403
    assert isinstance(body, dict)
    assert body.get("error", {}).get("code") == "license_export_denied"


def test_trade_graph_truncation() -> None:
    conn = duckdb.connect(":memory:")
    y = 2024
    eid = "CENTER01"
    rows = []
    for i in range(60):
        cp = f"CP{i:03d}"
        rows.append(
            {
                "counterparty_id": cp,
                "counterparty_name": f"对手{i}",
                "counterparty_role": "供应商",
                "purchase_amount": 50000,
                "sales_amount": 0,
                "purchase_cnt": 1,
                "sales_cnt": 0,
                "total_amount_abs": 50000,
            }
        )

    def fake_get_setting(key: str, default=None):
        if key == "max_graph_nodes":
            return 50
        if key == "min_graph_amount":
            return 1000.0
        return default

    with patch("src.local_api.settings_api.get_setting", side_effect=fake_get_setting):
        with patch("src.local_api.dws_dashboard_api.api_dws_trade_relationships", return_value={"ok": True, "rows": rows}):
            with patch("src.local_api.dws_dashboard_api._entity_display_name", return_value="中心企业"):
                with patch("src.audit.config_loader.group_id_for_year", return_value="G2024"):
                    res = api_dws_trade_graph(conn, stat_year=str(y), entity_id=eid, min_amount=1000)

    assert res.get("ok") is True
    assert res.get("truncated") is True
    assert len(res.get("nodes") or []) <= 50
    assert res.get("node_count") == 61


def main() -> None:
    test_license_export_denied_by_default()
    test_report_generate_blocked_when_trial()
    test_export_invoices_blocked_when_trial()
    test_trade_graph_truncation()
    print("p2_license_graph_smoke: OK")


if __name__ == "__main__":
    main()
