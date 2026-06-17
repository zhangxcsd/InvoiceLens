"""Smoke: D+1/D+2/D+3 分析包 API。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.counterparty_risk_api import api_dws_counterparty_risk_list
from src.local_api.dws_enterprise_behavior_api import api_dws_enterprise_behavior_profile
from src.local_api.dws_goods_cat_api import api_dws_goods_cat_overview
from src.local_api.dws_dashboard_api import api_dws_customer_cr, api_dws_customer_top
from src.local_api.entity_profile_api import api_dws_entity_profile
from src.local_api.invoice_timing_api import api_dws_invoice_timing_overview
from src.local_api.red_offset_api import api_dws_red_offset_overview
from src.local_api.year_over_year_api import api_dws_year_over_year_compare
from scripts.test_dws_package_d_smoke import _seed_dws
from scripts.test_tax_code_analysis_api_smoke import _seed as seed_tax


def _seed_dplus(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_goods_cat (
            category_uuid VARCHAR PRIMARY KEY,
            entity_id VARCHAR NOT NULL,
            stat_year SMALLINT NOT NULL,
            stat_quarter TINYINT NOT NULL,
            tax_code_short VARCHAR,
            tax_code_level2 VARCHAR,
            net_jshj DECIMAL(18,2) DEFAULT 0,
            invoice_cnt INT DEFAULT 0,
            supplier_cnt INT DEFAULT 0,
            avg_single_amt DECIMAL(18,2),
            max_single_amt DECIMAL(18,2),
            distinct_tax_rates INT DEFAULT 1,
            update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_goods_cat")
    conn.execute(
        """
        INSERT INTO dws_goods_cat (
            category_uuid, entity_id, stat_year, stat_quarter, tax_code_short, tax_code_level2,
            net_jshj, invoice_cnt, supplier_cnt
        ) VALUES
            ('g1', '91310000MA1BBBBBBB', 2026, 1, '1', '10', 300, 5, 2),
            ('g2', '91310000MA1BBBBBBB', 2026, 2, '3', '30', 200, 3, 1)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_trade_sum (
            trade_sum_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT NOT NULL,
            entity_id VARCHAR NOT NULL,
            entity_name VARCHAR,
            role_type VARCHAR NOT NULL,
            counterparty_id VARCHAR NOT NULL,
            counterparty_name VARCHAR,
            counterparty_role VARCHAR,
            total_amount DECIMAL(18,2) DEFAULT 0,
            invoice_cnt INT DEFAULT 0,
            max_invoice_amt DECIMAL(18,2),
            latest_invoice_date DATE,
            update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_trade_sum")
    conn.execute(
        """
        INSERT INTO dws_trade_sum (
            trade_sum_uuid, stat_year, entity_id, role_type,
            counterparty_id, counterparty_name, counterparty_role,
            total_amount, invoice_cnt, latest_invoice_date
        ) VALUES
            ('t1', 2026, '91310000MA1BBBBBBB', '销方', '91310000MA1DDDDDDD', '客户D', '客户', 500, 2, DATE '2026-03-01'),
            ('t2', 2026, '91310000MA1BBBBBBB', '销方', '91310000MA1EEEEEEE', '客户E', '客户', 100, 1, DATE '2026-02-15')
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_enterprise_invoice_profile (
            enterprise_id VARCHAR NOT NULL,
            stat_month VARCHAR NOT NULL,
            stat_year SMALLINT NOT NULL,
            stat_month_no SMALLINT NOT NULL,
            inv_cnt_total BIGINT DEFAULT 0,
            inv_amt_total DECIMAL(18,2) DEFAULT 0,
            inv_cnt_output BIGINT DEFAULT 0,
            inv_amt_output DECIMAL(18,2) DEFAULT 0,
            inv_cnt_input BIGINT DEFAULT 0,
            inv_amt_input DECIMAL(18,2) DEFAULT 0,
            counterparty_cnt_output BIGINT DEFAULT 0,
            counterparty_cnt_input BIGINT DEFAULT 0,
            red_inv_ratio DECIMAL(18,6),
            amt_mom_change DECIMAL(18,6),
            cnt_mom_change DECIMAL(18,6),
            abnormal_red_flag BOOLEAN DEFAULT FALSE,
            abnormal_spike_flag BOOLEAN DEFAULT FALSE,
            abnormal_counterparty_concentration_flag BOOLEAN DEFAULT FALSE,
            risk_level VARCHAR,
            PRIMARY KEY (enterprise_id, stat_month)
        )
        """
    )
    conn.execute("DELETE FROM dws_enterprise_invoice_profile")
    conn.execute(
        """
        INSERT INTO dws_enterprise_invoice_profile (
            enterprise_id, stat_month, stat_year, stat_month_no,
            inv_cnt_total, inv_amt_total, red_inv_ratio, risk_level
        ) VALUES
            ('91310000MA1BBBBBBB', '2026-01', 2026, 1, 10, 1000, 0.05, 'LOW'),
            ('91310000MA1BBBBBBB', '2026-02', 2026, 2, 12, 1200, 0.08, 'MEDIUM')
        """
    )
    for col, typedef in (("holiday_cnt", "INT DEFAULT 0"), ("weekend_large_cnt", "INT DEFAULT 0")):
        try:
            conn.execute(f"ALTER TABLE dws_inv_trend ADD COLUMN {col} {typedef}")
        except Exception:
            pass
    conn.execute(
        "UPDATE dws_inv_trend SET holiday_cnt = 1, weekend_large_cnt = 0 WHERE trend_uuid = 't1'"
    )


def main() -> int:
    conn = duckdb.connect(":memory:")
    seed_tax(conn)
    _seed_dws(conn)
    _seed_dplus(conn)

    eid = "91310000MA1BBBBBBB"
    year = "2026"

    goods = api_dws_goods_cat_overview(conn, stat_year=year, entity_id=eid)
    assert goods.get("ok"), goods
    assert goods["total_net_jshj"] > 0

    behavior = api_dws_enterprise_behavior_profile(conn, stat_year=year, entity_id=eid)
    assert behavior.get("ok"), behavior
    assert len(behavior.get("months") or []) >= 1

    cust_cr = api_dws_customer_cr(conn, stat_year=year, entity_id=eid)
    assert cust_cr.get("ok"), cust_cr
    assert cust_cr.get("cr1") is not None

    cust_top = api_dws_customer_top(conn, stat_year=year, entity_id=eid, limit=5)
    assert cust_top.get("ok") and len(cust_top.get("rows") or []) >= 1

    red = api_dws_red_offset_overview(conn, stat_year=year, entity_id=eid)
    assert red.get("ok"), red

    timing = api_dws_invoice_timing_overview(conn, stat_year=year, entity_id=eid)
    assert timing.get("ok"), timing

    risk = api_dws_counterparty_risk_list(conn, stat_year=year, entity_id=eid, limit=10)
    assert risk.get("ok"), risk

    yoy = api_dws_year_over_year_compare(conn, stat_year=year, entity_id=eid)
    assert yoy.get("ok"), yoy

    profile = api_dws_entity_profile(conn, stat_year=year, entity_id=eid)
    assert profile.get("ok"), profile
    assert profile.get("customer_concentration") is not None
    assert profile.get("goods_category") is not None

    print("SMOKE PASS: D+1/D+2/D+3 analysis package APIs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
