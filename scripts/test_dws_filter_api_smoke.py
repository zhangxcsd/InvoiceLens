"""Smoke: DWS 看板 stat_month / date_from / date_to 过滤（summary / supplier_cr / overview_tax）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.dws_dashboard_api import (
    api_dws_overview_summary,
    api_dws_overview_tax,
    api_dws_supplier_cr,
    api_dws_supplier_top,
    api_dws_trade_graph,
    api_dws_trade_relationships,
)


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
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
            net_jshj DECIMAL(18,2) DEFAULT 0,
            update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_inv_trend")
    conn.execute(
        """
        INSERT INTO dws_inv_trend (
            trend_uuid, entity_id, entity_name, stat_year, stat_month, role_type,
            normal_cnt, red_cnt, cancel_cnt, net_jshj
        ) VALUES
            ('t1', 'BUYER001', '购方A', 2024, 1, '进项', 1, 0, 0, 100),
            ('t2', 'BUYER001', '购方A', 2024, 2, '进项', 1, 0, 0, 200),
            ('t3', 'BUYER001', '购方A', 2024, 1, '销项', 1, 0, 0, 50),
            ('t4', 'BUYER001', '购方A', 2024, 2, '销项', 1, 0, 0, 80)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_quality (
            quality_uuid VARCHAR PRIMARY KEY,
            entity_id VARCHAR NOT NULL,
            stat_year SMALLINT NOT NULL,
            header_unbalanced INT DEFAULT 0,
            unmatched_red_cnt INT DEFAULT 0,
            quality_score DECIMAL(5,2),
            update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_quality")
    conn.execute(
        """
        INSERT INTO dws_quality (quality_uuid, entity_id, stat_year, quality_score)
        VALUES ('q1', 'BUYER001', 2024, 95.0)
        """
    )

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
            update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_sup_conc")
    conn.execute(
        """
        INSERT INTO dws_sup_conc (
            conc_uuid, entity_id, stat_year, supplier_id, supplier_name,
            net_jshj, invoice_cnt, amount_rank, amount_ratio, cumulative_ratio
        ) VALUES
            ('c1', 'BUYER001', 2024, 'SELLER002', '销方2', 400, 1, 1, 0.8, 0.8),
            ('c2', 'BUYER001', 2024, 'SELLER001', '销方1', 100, 1, 2, 0.2, 1.0)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            stat_month SMALLINT,
            invoice_date DATE,
            xfsbh VARCHAR,
            xfmc VARCHAR,
            gfsbh VARCHAR,
            gfmc VARCHAR,
            jshj DECIMAL(18,2),
            net_jshj DECIMAL(18,2),
            fpzt VARCHAR DEFAULT '正常',
            net_calc_status VARCHAR,
            is_orphan_red BOOLEAN DEFAULT FALSE,
            is_balanced VARCHAR DEFAULT '平账'
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute(
        """
        INSERT INTO dwd_inv_header (
            header_uuid, stat_year, stat_month, invoice_date,
            xfsbh, xfmc, gfsbh, gfmc, jshj, net_jshj
        ) VALUES
            ('h1', 2024, 1, DATE '2024-01-15', 'SELLER001', '销方1', 'BUYER001', '购方A', 100, 100),
            ('h2', 2024, 2, DATE '2024-02-15', 'SELLER002', '销方2', 'BUYER001', '购方A', 400, 400),
            ('h3', 2024, 5, DATE '2024-05-15', 'SELLER003', '销方3', 'BUYER001', '购方A', 300, 300)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_detail (
            detail_uuid VARCHAR PRIMARY KEY,
            header_uuid VARCHAR,
            stat_year SMALLINT,
            stat_month SMALLINT,
            logic_line_no INTEGER,
            je DECIMAL(18,2),
            slv_num DOUBLE,
            slv VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_detail")
    conn.execute(
        """
        INSERT INTO dwd_inv_detail (
            detail_uuid, header_uuid, stat_year, stat_month, logic_line_no, je, slv_num, slv
        ) VALUES
            ('d1', 'h1', 2024, 1, 1, 88.50, 0.13, '13%'),
            ('d2', 'h2', 2024, 2, 1, 353.98, 0.13, '13%')
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
            counterparty_name VARCHAR NOT NULL,
            counterparty_role VARCHAR NOT NULL,
            total_amount DECIMAL(18,2) NOT NULL,
            invoice_cnt INT NOT NULL,
            max_invoice_amt DECIMAL(18,2) NOT NULL,
            latest_invoice_date DATE NOT NULL,
            update_time TIMESTAMP NOT NULL
        )
        """
    )
    conn.execute("DELETE FROM dws_trade_sum")
    conn.execute(
        """
        INSERT INTO dws_trade_sum (
            trade_sum_uuid, stat_year, entity_id, entity_name, role_type,
            counterparty_id, counterparty_name, counterparty_role,
            total_amount, invoice_cnt, max_invoice_amt, latest_invoice_date, update_time
        ) VALUES
            ('ts1', 2024, 'BUYER001', '购方A', '购方', 'SELLER001', '销方1', '供应商', 100, 1, 100, DATE '2024-01-15', CURRENT_TIMESTAMP),
            ('ts2', 2024, 'BUYER001', '购方A', '购方', 'SELLER002', '销方2', '供应商', 400, 1, 400, DATE '2024-02-15', CURRENT_TIMESTAMP),
            ('ts3', 2024, 'BUYER001', '购方A', '销方', 'SELLER003', '销方3', '客户', 80, 1, 80, DATE '2024-02-20', CURRENT_TIMESTAMP)
        """
    )


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    full = api_dws_overview_summary(conn, stat_year="2024", entity_id="BUYER001")
    _assert(full.get("ok") is True, f"summary full year failed: {full}")
    _assert(float(full["total_net_jshj"]) == 430.0, f"expected 430, got {full['total_net_jshj']}")

    m1 = api_dws_overview_summary(
        conn, stat_year="2024", entity_id="BUYER001", stat_month="1"
    )
    _assert(m1.get("ok") is True, f"summary month 1 failed: {m1}")
    _assert(float(m1["total_net_jshj"]) == 150.0, f"expected 150, got {m1['total_net_jshj']}")
    _assert(m1.get("filter_stat_month") == 1, "missing filter_stat_month meta")
    _assert(m1.get("supplier_cnt_source") == "dwd_inv_header", "entity+m1 should use DWD supplier cnt")
    _assert(m1.get("quality_metrics_source") == "dwd_inv_header", "entity+m1 should use DWD quality")
    _assert(int(m1["supplier_cnt"]) == 1, f"month1 entity supplier_cnt expected 1, got {m1['supplier_cnt']}")

    m1_no_entity = api_dws_overview_summary(conn, stat_year="2024", stat_month="1")
    _assert(m1_no_entity.get("ok") is True, f"summary month 1 no entity failed: {m1_no_entity}")
    _assert(float(m1_no_entity["total_net_jshj"]) == 150.0, f"no-entity m1 net expected 150, got {m1_no_entity['total_net_jshj']}")
    _assert(
        m1_no_entity.get("supplier_cnt_source") == "dwd_inv_header",
        "no-entity+m1 should use DWD supplier cnt, not annual dws_sup_conc",
    )
    _assert(
        m1_no_entity.get("quality_metrics_source") == "dwd_inv_header",
        "no-entity+m1 should use DWD quality metrics",
    )
    _assert(
        int(m1_no_entity["supplier_cnt"]) == 1,
        f"no-entity month1 supplier_cnt expected 1 (SELLER001 only), got {m1_no_entity['supplier_cnt']}",
    )
    full_sup = int(full["supplier_cnt"])
    _assert(
        int(m1_no_entity["supplier_cnt"]) < full_sup or full_sup == 2,
        "filtered supplier_cnt should differ from or be less than annual when dws_sup_conc has more suppliers",
    )

    cr_full = api_dws_supplier_cr(conn, stat_year="2024", entity_id="BUYER001")
    _assert(cr_full.get("ok") is True, f"cr full year failed: {cr_full}")
    _assert(float(cr_full["cr1"]) == 0.8, f"annual cr1 expected 0.8, got {cr_full['cr1']}")

    cr_m1 = api_dws_supplier_cr(
        conn, stat_year="2024", entity_id="BUYER001", stat_month="1"
    )
    _assert(cr_m1.get("ok") is True, f"cr month 1 failed: {cr_m1}")
    _assert(float(cr_m1["cr1"]) == 1.0, f"month1 cr1 expected 1.0, got {cr_m1['cr1']}")
    _assert(cr_m1.get("filter_source") == "dwd_inv_header", "cr should use DWD when filtered")

    tax_full = api_dws_overview_tax(
        conn, stat_year="2024", entity_id="BUYER001", role_type="进项"
    )
    _assert(tax_full.get("ok") is True, f"tax full year failed: {tax_full}")
    _assert(float(tax_full["total_amount_je"]) == 442.48, f"tax full got {tax_full['total_amount_je']}")

    tax_m1 = api_dws_overview_tax(
        conn, stat_year="2024", entity_id="BUYER001", role_type="进项", stat_month="1"
    )
    _assert(tax_m1.get("ok") is True, f"tax month 1 failed: {tax_m1}")
    _assert(float(tax_m1["total_amount_je"]) == 88.5, f"tax m1 expected 88.5, got {tax_m1['total_amount_je']}")
    _assert(tax_m1.get("filter_stat_month") == 1, "tax missing filter_stat_month meta")

    rel_all = api_dws_trade_relationships(conn, stat_year="2024", entity_id="BUYER001")
    _assert(rel_all.get("ok") is True, f"trade rel all failed: {rel_all}")
    _assert(rel_all["total"] == 3, f"expected 3 counterparties, got {rel_all['total']}")

    rel_cp = api_dws_trade_relationships(
        conn,
        stat_year="2024",
        entity_id="BUYER001",
        counterparty_id="SELLER002",
    )
    _assert(rel_cp.get("ok") is True, f"trade rel cp filter failed: {rel_cp}")
    _assert(rel_cp["total"] == 1, f"expected 1 counterparty, got {rel_cp['total']}")
    _assert(rel_cp["rows"][0]["counterparty_id"] == "SELLER002", "wrong counterparty row")

    rel_pair = api_dws_trade_relationships(
        conn,
        stat_year="2024",
        entity_id="BUYER001",
        party_a_tax="BUYER001",
        party_b_tax="SELLER001",
    )
    _assert(rel_pair.get("ok") is True, f"trade rel pair filter failed: {rel_pair}")
    _assert(rel_pair["total"] == 1, f"expected 1 pair match, got {rel_pair['total']}")

    graph = api_dws_trade_graph(
        conn,
        stat_year="2024",
        entity_id="BUYER001",
        min_amount=0,
        counterparty_id="SELLER001",
    )
    _assert(graph.get("ok") is True, f"trade graph failed: {graph}")
    cp_nodes = [n for n in graph.get("nodes") or [] if not n.get("is_center")]
    _assert(len(cp_nodes) == 1, f"expected 1 counterparty node, got {len(cp_nodes)}")
    _assert(cp_nodes[0]["id"] == "SELLER001", "graph counterparty mismatch")

    top_q1 = api_dws_supplier_top(
        conn, stat_year="2024", entity_id="BUYER001", quarter="1", limit=20
    )
    _assert(top_q1.get("ok") is True, f"supplier top Q1 failed: {top_q1}")
    _assert(top_q1.get("filter_quarter") == 1, "missing filter_quarter meta")
    _assert(int(top_q1["total"]) == 2, f"Q1 expected 2 suppliers, got {top_q1['total']}")

    top_q2 = api_dws_supplier_top(
        conn, stat_year="2024", entity_id="BUYER001", quarter="2", limit=20
    )
    _assert(top_q2.get("ok") is True, f"supplier top Q2 failed: {top_q2}")
    _assert(int(top_q2["total"]) == 1, f"Q2 expected 1 supplier, got {top_q2['total']}")
    _assert(top_q2["rows"][0]["supplier_id"] == "SELLER003", "Q2 supplier mismatch")

    print("OK: DWS filter API smoke passed")


if __name__ == "__main__":
    main()
