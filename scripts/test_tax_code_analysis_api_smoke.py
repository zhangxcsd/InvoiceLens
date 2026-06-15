"""Smoke: 税码结构分析 API（overview / unmatched / enterprise-summary）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.tax_code_analysis_api import (
    api_tax_code_analysis_enterprise_summary,
    api_tax_code_analysis_overview,
    api_tax_code_analysis_unmatched,
    sync_tax_code_flags,
)


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dim_tax_code (
            tax_code VARCHAR PRIMARY KEY,
            goods_name VARCHAR,
            goods_short_name VARCHAR,
            level_depth TINYINT,
            full_path TEXT,
            audit_risk_label VARCHAR DEFAULT 'NORMAL'
        )
        """
    )
    conn.execute("DELETE FROM dim_tax_code")
    conn.execute(
        """
        INSERT INTO dim_tax_code (tax_code, goods_name, goods_short_name, level_depth, full_path, audit_risk_label)
        VALUES
            ('1090100000000000000', '二级类目A', '类目A', 2, '篇 > 类A', 'NORMAL'),
            ('1090200000000000000', '二级类目B', '类目B', 2, '篇 > 类B', 'HIGH'),
            ('1090201010000000000', '明细编码B1', 'B1', 10, '篇 > 类B > 明细', 'HIGH')
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            xfsbh VARCHAR,
            xfmc VARCHAR,
            gfsbh VARCHAR,
            gfmc VARCHAR,
            import_batch_id VARCHAR
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_detail (
            detail_uuid VARCHAR PRIMARY KEY,
            header_uuid VARCHAR,
            stat_year SMALLINT,
            logic_line_no INTEGER,
            ssflbm VARCHAR,
            hwlwmc VARCHAR,
            slv_num DOUBLE,
            je DECIMAL(18,2),
            se DECIMAL(18,2),
            jshj DECIMAL(18,2),
            import_batch_id VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute("DELETE FROM dwd_inv_detail")

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
        INSERT INTO dwd_inv_header VALUES
            ('h1', 2026, '91310000MA1AAAAAAA', '销方A', '91310000MA1BBBBBBB', '购方B', 'batch1'),
            ('h2', 2026, '91310000MA1CCCCCCC', '销方C', '91310000MA1BBBBBBB', '购方B', 'batch1')
        """
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_detail VALUES
            ('d1', 'h1', 2026, 1, '1090100000000000000', '办公用品', 0.13, 100.00, 13.00, 113.00, 'batch1'),
            ('d2', 'h1', 2026, 2, '1090201010000000000', '咨询服务', 0.06, 200.00, 12.00, 212.00, 'batch1'),
            ('d3', 'h2', 2026, 1, '9999999999999999999', '办公用品', 0.13, 50.00, 6.50, 56.50, 'batch1'),
            ('d4', 'h2', 2026, 2, NULL, '其他货物', 0.13, 10.00, 1.30, 11.30, 'batch1')
        """
    )

    for tbl in (
        "dim_subject_master",
        "dim_enterprise_year_roster",
        "dim_enterprise_year_rel",
    ):
        conn.execute(f"CREATE TABLE IF NOT EXISTS {tbl} AS SELECT * FROM (VALUES (1)) t(x) WHERE 1=0")

    conn.execute("DELETE FROM dim_subject_master")
    conn.execute("DELETE FROM dim_enterprise_year_roster")
    conn.execute("DELETE FROM dim_enterprise_year_rel")

    conn.execute(
        """
        CREATE OR REPLACE TABLE dim_subject_master (
            subject_id VARCHAR,
            subject_name VARCHAR,
            subject_no VARCHAR,
            subject_category VARCHAR
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dim_subject_master VALUES
            ('sub-b', '购方B', '91310000MA1BBBBBBB', 'org')
        """
    )
    conn.execute(
        """
        CREATE OR REPLACE TABLE dim_enterprise_year_roster (
            stat_year SMALLINT,
            enterprise_id VARCHAR,
            enterprise_name VARCHAR,
            is_member BOOLEAN
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dim_enterprise_year_roster VALUES
            (2026, '91310000MA1BBBBBBB', '购方B有限公司', TRUE)
        """
    )
    conn.execute(
        """
        CREATE OR REPLACE TABLE dim_enterprise_year_rel (
            subject_id VARCHAR,
            stat_year SMALLINT,
            has_seller_role BOOLEAN,
            has_buyer_role BOOLEAN,
            invoice_count BIGINT,
            amount_jshj_sum DOUBLE
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dim_enterprise_year_rel VALUES
            ('sub-b', 2026, TRUE, TRUE, 20, 5000.0)
        """
    )


def main() -> int:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    overview = api_tax_code_analysis_overview(conn, stat_year="2026")
    assert overview.get("ok"), overview
    assert overview["lines_with_code"] == 3
    assert overview["matched_line_count"] == 2
    assert overview["unmatched_line_count"] == 1
    assert 0 < overview["match_rate"] < 1
    assert overview["high_risk_amount_share"] > 0

    unmatched = api_tax_code_analysis_unmatched(conn, stat_year="2026", page=1, page_size=10)
    assert unmatched.get("ok"), unmatched
    assert unmatched["total"] >= 1
    codes = {r["ssflbm"] for r in unmatched["rows"]}
    assert "9999999999999999999" in codes

    kw = api_tax_code_analysis_unmatched(conn, stat_year="2026", keyword="9999", page=1, page_size=10)
    assert kw.get("ok") and kw["total"] >= 1

    goods_filter = api_tax_code_analysis_overview(conn, stat_year="2026", goods_name="办公用品")
    assert goods_filter.get("ok"), goods_filter
    assert goods_filter["lines_with_code"] == 2
    assert goods_filter["lines_with_code"] < overview["lines_with_code"]

    slv_filter = api_tax_code_analysis_overview(conn, stat_year="2026", slv_num="0.06")
    assert slv_filter.get("ok"), slv_filter
    assert slv_filter["lines_with_code"] == 1

    both = api_tax_code_analysis_overview(
        conn, stat_year="2026", goods_name="办公用品", slv_num="0.13"
    )
    assert both.get("ok") and both["lines_with_code"] == 2

    ent = api_tax_code_analysis_enterprise_summary(
        conn, stat_year="2026", min_invoice_count=1, page=1, page_size=10
    )
    assert ent.get("ok"), ent
    assert ent["total"] >= 1
    assert ent["rows"][0]["entity_id"] == "91310000MA1BBBBBBB"
    assert ent["kpis"]["enterprise_coverage"] >= 0

    ent_goods = api_tax_code_analysis_enterprise_summary(
        conn,
        stat_year="2026",
        entity_id="91310000MA1BBBBBBB",
        goods_name="办公用品",
        min_invoice_count=1,
        page=1,
        page_size=10,
    )
    assert ent_goods.get("ok") and ent_goods["total"] >= 1

    empty_dim = duckdb.connect(":memory:")
    _seed(empty_dim)
    empty_dim.execute("DELETE FROM dim_tax_code")
    ov2 = api_tax_code_analysis_overview(empty_dim, stat_year="2026")
    assert ov2.get("ok") and ov2.get("hint")

    sync = sync_tax_code_flags(conn, stat_year=2026, min_line_count=1, min_high_risk_amount=1)
    assert sync.get("ok"), sync
    assert sync.get("inserted", 0) >= 1
    flag_cnt = int(conn.execute("SELECT COUNT(*) FROM dm_audit_flag").fetchone()[0])
    assert flag_cnt >= 1
    import json

    detail_row = conn.execute(
        "SELECT rule_id, detail_json FROM dm_audit_flag WHERE detail_json IS NOT NULL LIMIT 1"
    ).fetchone()
    assert detail_row
    detail = json.loads(str(detail_row[1] or "{}"))
    assert detail.get("stat_year") == 2026
    assert detail.get("entity_id")

    print("SMOKE PASS: tax code analysis API")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
