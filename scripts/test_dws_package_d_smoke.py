"""Smoke: 套餐 D — entity-profile 与 invoice-detail API。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.dws_invoice_detail_api import (
    api_dws_invoice_detail_list,
    export_dws_invoice_detail_csv_bytes,
)
from src.local_api.entity_profile_api import api_dws_entity_profile
from scripts.test_tax_code_analysis_api_smoke import _seed as seed_tax


def _seed_dws(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_sup_conc (
            conc_uuid VARCHAR PRIMARY KEY,
            entity_id VARCHAR NOT NULL,
            stat_year SMALLINT NOT NULL,
            supplier_id VARCHAR NOT NULL,
            supplier_name VARCHAR,
            net_jshj DECIMAL(18,2) NOT NULL,
            invoice_cnt INT NOT NULL,
            amount_rank INT,
            amount_ratio DECIMAL(8,6),
            cumulative_ratio DECIMAL(8,6),
            is_new_supplier BOOLEAN DEFAULT FALSE,
            first_invoice_date DATE,
            last_invoice_date DATE,
            update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_sup_conc")
    conn.execute(
        """
        INSERT INTO dws_sup_conc (
            conc_uuid, entity_id, stat_year, supplier_id, supplier_name,
            net_jshj, invoice_cnt, amount_rank, amount_ratio, cumulative_ratio,
            is_new_supplier, first_invoice_date, last_invoice_date
        ) VALUES
            ('c1', '91310000MA1BBBBBBB', 2026, '91310000MA1AAAAAAA', '销方A', 400, 2, 1, 0.7, 0.7, TRUE, DATE '2026-01-15', DATE '2026-02-20'),
            ('c2', '91310000MA1BBBBBBB', 2026, '91310000MA1CCCCCCC', '销方C', 200, 1, 2, 0.3, 1.0, FALSE, DATE '2026-02-10', DATE '2026-02-10')
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_inv_trend (
            trend_uuid VARCHAR PRIMARY KEY,
            entity_id VARCHAR NOT NULL,
            entity_name VARCHAR,
            stat_year SMALLINT NOT NULL,
            stat_month TINYINT NOT NULL,
            role_type VARCHAR NOT NULL,
            normal_cnt INT DEFAULT 0,
            red_cnt INT DEFAULT 0,
            cancel_cnt INT DEFAULT 0,
            net_jshj DECIMAL(18,2) DEFAULT 0
        )
        """
    )
    conn.execute("DELETE FROM dws_inv_trend")
    conn.execute(
        """
        INSERT INTO dws_inv_trend (
            trend_uuid, entity_id, entity_name, stat_year, stat_month, role_type, net_jshj
        ) VALUES ('t1', '91310000MA1BBBBBBB', '购方B', 2026, 1, '进项', 500)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_audit_flag (
            flag_id VARCHAR PRIMARY KEY,
            rule_id VARCHAR NOT NULL,
            risk_level VARCHAR NOT NULL,
            flag_type VARCHAR NOT NULL,
            group_id VARCHAR NOT NULL,
            entity_id VARCHAR,
            entity_name VARCHAR,
            amount DECIMAL(18,2),
            description VARCHAR,
            suggestion VARCHAR,
            is_confirmed BOOLEAN DEFAULT FALSE,
            analysis_batch VARCHAR NOT NULL,
            detail_json VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dm_audit_flag")
    conn.execute(
        """
        INSERT INTO dm_audit_flag (
            flag_id, rule_id, risk_level, flag_type, group_id,
            entity_id, entity_name, amount, description, suggestion, is_confirmed, analysis_batch
        ) VALUES (
            'f1', 'RULE-TAX-UNMATCH', '中风险', '税码未匹配', 'Y2026',
            '91310000MA1BBBBBBB', '购方B', 56.5, '测试', '核查', FALSE, 'test'
        )
        """
    )


def main() -> int:
    conn = duckdb.connect(":memory:")
    seed_tax(conn)
    _seed_dws(conn)

    profile = api_dws_entity_profile(
        conn, stat_year="2026", entity_id="91310000MA1BBBBBBB"
    )
    assert profile.get("ok"), profile
    assert profile["entity_id"] == "91310000MA1BBBBBBB"
    assert profile["concentration"]["cr1"] is not None
    assert profile["audit_flags"]["total"] >= 1
    assert profile["tax_code"].get("match_rate") is not None
    assert profile["related"]["graph_ok"] is False or profile["related"]["graph_node_count"] >= 0

    missing = api_dws_entity_profile(conn, stat_year="2026", entity_id=None)
    assert not missing.get("ok")

    listed = api_dws_invoice_detail_list(
        conn,
        stat_year="2026",
        entity_id="91310000MA1BBBBBBB",
        limit=20,
        offset=0,
    )
    assert listed.get("ok"), listed
    assert listed["total"] >= 1
    assert listed["rows"][0]["hwlwmc"]

    by_seller = api_dws_invoice_detail_list(
        conn,
        stat_year="2026",
        entity_id="91310000MA1BBBBBBB",
        seller_tax_no="91310000MA1AAAAAAA",
        limit=10,
    )
    assert by_seller.get("ok") and by_seller["total"] >= 1

    csv_bytes, exported, total = export_dws_invoice_detail_csv_bytes(
        conn, stat_year="2026", entity_id="91310000MA1BBBBBBB"
    )
    assert total >= 1 and exported >= 1 and csv_bytes

    print("SMOKE PASS: package D entity-profile & invoice-detail APIs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
