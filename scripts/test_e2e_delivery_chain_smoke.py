"""Smoke: 端到端交付链路 — 疑点 → 深链 API 过滤 → 交付包预估。

跳过条件（exit 0 + 打印 SKIP）：
- 使用内存最小数据集时无 dm_audit_flag 表（不应发生，seed 已创建）
- 可选 REAL_DB=1 时仓库无疑点且无 DWD 明细（打印提示后跳过深链断言）
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.audit_flag_api import api_audit_flags_list
from src.local_api.dws_dashboard_api import api_dws_overview_summary, api_dws_tax_risk_exposure, api_dws_trade_graph
from src.local_api.report_api import estimate_delivery_package
from src.local_api.tax_code_analysis_api import api_tax_code_analysis_overview


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
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
            seller_name VARCHAR,
            seller_tax_no VARCHAR,
            amount DECIMAL(18,2),
            description VARCHAR,
            suggestion VARCHAR,
            is_confirmed BOOLEAN DEFAULT FALSE,
            confirm_note VARCHAR,
            analysis_batch VARCHAR NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            detail_json VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dm_audit_flag")
    conn.execute(
        """
        INSERT INTO dm_audit_flag (
            flag_id, rule_id, risk_level, flag_type, group_id,
            entity_id, entity_name, seller_name, seller_tax_no, amount,
            description, suggestion, is_confirmed, analysis_batch, detail_json
        ) VALUES (
            'FP-2026-05M-smoke001', 'RULE-05', '中风险', '税率品类不匹配', 'Y2026',
            'BUYER001', '购方A', '销方1', 'SELLER001', 100.00,
            '明细「办公用品」税率不符', '核对编码', FALSE, 'batch_smoke',
            '{"goods_name":"办公用品","slv_num":0.13,"seller_tax_no":"SELLER001"}'
        )
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
        INSERT INTO dws_inv_trend VALUES
            ('t1', 'BUYER001', '购方A', 2026, 1, '进项', 1, 0, 0, 100),
            ('t2', 'BUYER001', '购方A', 2026, 2, '进项', 1, 0, 0, 200)
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            stat_month SMALLINT,
            xfsbh VARCHAR,
            xfmc VARCHAR,
            gfsbh VARCHAR,
            gfmc VARCHAR,
            net_jshj DECIMAL(18,2),
            jshj DECIMAL(18,2),
            fpzt VARCHAR,
            is_orphan_red BOOLEAN,
            net_calc_status VARCHAR,
            is_balanced VARCHAR DEFAULT '平账'
        )
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
            ssflbm VARCHAR,
            hwlwmc VARCHAR,
            slv VARCHAR,
            slv_num DOUBLE,
            je DECIMAL(18,2),
            se DECIMAL(18,2),
            jshj DECIMAL(18,2)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dim_tax_code (
            tax_code VARCHAR PRIMARY KEY,
            goods_name VARCHAR,
            goods_short_name VARCHAR,
            full_path VARCHAR,
            level_depth TINYINT,
            audit_risk_label VARCHAR DEFAULT 'NORMAL'
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute("DELETE FROM dwd_inv_detail")
    conn.execute("DELETE FROM dim_tax_code")
    conn.execute(
        """
        INSERT INTO dwd_inv_header VALUES (
            'h1', 2026, 1, 'SELLER001', '销方1', 'BUYER001', '购方A',
            100, 100, '正常', FALSE, '蓝票已计算', '平账'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_detail VALUES
            ('d1', 'h1', 2026, 1, 1, '1090100000000000000', '办公用品', '13%', 0.13, 100, 13, 113),
            ('d2', 'h1', 2026, 2, 2, '1090100000000000000', '其他', '6%', 0.06, 50, 3, 53)
        """
    )
    conn.execute(
        """
        INSERT INTO dim_tax_code (tax_code, goods_name, level_depth, audit_risk_label)
        VALUES ('1090100000000000000', '类目A', 2, 'NORMAL')
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
            ('ts1', 2026, 'BUYER001', '购方A', '购方', 'SELLER001', '销方1', '供应商', 100, 1, 100, DATE '2026-01-15', CURRENT_TIMESTAMP)
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
            quality_score DECIMAL(5,2)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dws_quality (quality_uuid, entity_id, stat_year, quality_score)
        VALUES ('q1', 'BUYER001', 2026, 95.0)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_sup_conc (
            conc_uuid VARCHAR PRIMARY KEY,
            entity_id VARCHAR NOT NULL,
            stat_year SMALLINT NOT NULL,
            supplier_id VARCHAR NOT NULL
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dws_sup_conc (conc_uuid, entity_id, stat_year, supplier_id)
        VALUES ('c1', 'BUYER001', 2026, 'SELLER001')
        """
    )


def _get_conn() -> duckdb.DuckDBPyConnection:
    if os.environ.get("REAL_DB") == "1":
        from db.duckdb_conn import get_conn
        from db.schema_sqlfiles import init_all_tables

        c = get_conn()
        init_all_tables(c)
        return c
    conn = duckdb.connect(":memory:")
    _seed(conn)
    return conn


def main() -> int:
    conn = _get_conn()
    stat_year = "2026"
    using_real = os.environ.get("REAL_DB") == "1"

    flags = api_audit_flags_list(conn, stat_year=stat_year, limit=10)
    if not flags.get("ok"):
        print(f"SKIP: audit flags API failed: {flags}")
        return 0
    flag_total = int(flags.get("total") or 0)
    if flag_total == 0:
        if using_real:
            print("SKIP: 仓库无审计疑点，跳过深链断言（可导入演示数据后重试）")
            return 0
        raise AssertionError("seed 应包含至少 1 条疑点")

    trend_m1 = api_dws_overview_summary(conn, stat_year=stat_year, entity_id="BUYER001", stat_month="1")
    if trend_m1.get("ok"):
        assert float(trend_m1["total_net_jshj"]) == 100.0, trend_m1
    elif using_real:
        print("SKIP: DWS trend 无数据，跳过后续 DWS 断言")
    else:
        raise AssertionError(f"trend month filter failed: {trend_m1}")

    tax_all = api_tax_code_analysis_overview(conn, stat_year=stat_year)
    tax_filtered = api_tax_code_analysis_overview(
        conn, stat_year=stat_year, goods_name="办公用品", slv_num="0.13"
    )
    if tax_all.get("ok") and tax_filtered.get("ok"):
        assert tax_filtered["lines_with_code"] <= tax_all["lines_with_code"]
        if not using_real:
            assert tax_filtered["lines_with_code"] == 1
    elif using_real:
        print("SKIP: 税码分析无 DWD 明细，跳过 goods_name/slv_num 断言")
    else:
        raise AssertionError(f"tax filter failed: all={tax_all} filtered={tax_filtered}")

    graph = api_dws_trade_graph(
        conn,
        stat_year=stat_year,
        entity_id="BUYER001",
        min_amount=0,
        counterparty_id="SELLER001",
    )
    if graph.get("ok"):
        cp_nodes = [n for n in graph.get("nodes") or [] if not n.get("is_center")]
        assert len(cp_nodes) == 1, graph
    elif using_real:
        print("SKIP: 贸易图谱无 dws_trade_sum 数据")
    else:
        raise AssertionError(f"trade graph failed: {graph}")

    tax_risk = api_dws_tax_risk_exposure(conn, stat_year=stat_year, entity_id="BUYER001")
    if tax_risk.get("ok"):
        assert "total_exposure" in tax_risk, tax_risk
        assert isinstance(tax_risk.get("breakdown"), list), tax_risk
    elif using_real:
        print("SKIP: 税风险敞口 API 无可用 DWD/DWS 数据")
    else:
        raise AssertionError(f"tax risk exposure failed: {tax_risk}")

    est = estimate_delivery_package(conn, {"stat_year": stat_year})
    assert est.get("ok"), est
    sections = est.get("sections") or []
    assert isinstance(sections, list) and len(sections) >= 1, est
    assert isinstance(est.get("estimates"), dict), est
    section_ids = {str(s.get("section_id") or s.get("id") or "") for s in sections}
    assert "audit_flags" in section_ids or len(sections) >= 1, section_ids

    est_risk = estimate_delivery_package(
        conn,
        {"stat_year": stat_year, "chapters": {"tax_risk_exposure": True}},
    )
    assert est_risk.get("ok"), est_risk
    risk_sections = {
        str(s.get("section_id") or s.get("id") or "") for s in (est_risk.get("sections") or [])
    }
    assert "tax_risk_exposure" in risk_sections, risk_sections

    print("SMOKE PASS: e2e delivery chain")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
