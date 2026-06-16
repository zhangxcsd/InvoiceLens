"""CI smoke: 审计规则 SQL 编译/运行 + 进销偏离阈值标记逻辑 + detail_json 深链字段。"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.audit.types import RuleContext
from src.audit_rules.rule_01_duplicate import run_rule as run_rule_01
from src.audit_rules.rule_09_circular import run_rule as run_rule_09
from src.audit_rules.rule_10_internal import run_rule as run_rule_10
from src.local_api.finance_reconcile_api import _fin_flag_detail_json
from src.local_api.dws_dashboard_api import (
    _sync_tax_deviation_flags,
    build_tax_deviation_compare_rows,
)
from src.local_api.tax_code_analysis_api import _tax_flag_detail_json
from src.local_api.data_quality import _semantic_flag_detail_json
from src.local_api.invoice_export_api import api_export_invoices_count


def _ensure_header_table(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT NOT NULL,
            stat_month SMALLINT NOT NULL,
            fpdm VARCHAR, fphm VARCHAR, sdfphm VARCHAR,
            xfsbh VARCHAR, xfmc VARCHAR,
            gfsbh VARCHAR, gfmc VARCHAR,
            kprq VARCHAR,
            invoice_date DATE,
            invoice_time TIME,
            je DECIMAL(18,2), se DECIMAL(18,2), jshj DECIMAL(18,2),
            fpzt VARCHAR,
            net_jshj DECIMAL(18,2),
            net_calc_status VARCHAR DEFAULT '蓝票已计算',
            is_orphan_red BOOLEAN DEFAULT FALSE,
            first_import_batch_id VARCHAR NOT NULL,
            first_import_file VARCHAR NOT NULL
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")


def test_tax_deviation_threshold_marking() -> None:
    input_map = {
        "13%": {"amount_je": 1000, "amount_ratio": 0.7, "line_cnt": 1},
        "6%": {"amount_je": 300, "amount_ratio": 0.3, "line_cnt": 1},
    }
    output_map = {
        "13%": {"amount_je": 500, "amount_ratio": 0.5, "line_cnt": 1},
        "6%": {"amount_je": 500, "amount_ratio": 0.32, "line_cnt": 1},
    }
    rows, exceeded, mix_l1 = build_tax_deviation_compare_rows(
        input_map, output_map, threshold_pct=10.0
    )
    assert mix_l1 > 0
    bucket_13 = next(r for r in rows if r["tax_bucket"] == "13%")
    bucket_6 = next(r for r in rows if r["tax_bucket"] == "6%")
    assert bucket_13["exceeded_threshold"] is True
    assert bucket_6["exceeded_threshold"] is False
    assert "13%" in exceeded

    rows2, exceeded2, _ = build_tax_deviation_compare_rows(
        input_map, output_map, threshold_pct=25.0
    )
    assert all(not r["exceeded_threshold"] for r in rows2)
    assert exceeded2 == []


def test_rule_01_duplicate_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _ensure_header_table(conn)
    y = 2024
    base = {
        "stat_year": y,
        "stat_month": 6,
        "xfsbh": "SELLER01",
        "xfmc": "销方甲",
        "gfsbh": "BUYER01",
        "gfmc": "购方乙",
        "je": 10000,
        "se": 1300,
        "jshj": 11300,
        "net_jshj": 11300,
        "fpzt": "正常",
        "first_import_batch_id": "b1",
        "first_import_file": "f1.xlsx",
    }
    for i, d in enumerate((date(2024, 6, 1), date(2024, 6, 10))):
        conn.execute(
            """
            INSERT INTO dwd_inv_header (
                header_uuid, stat_year, stat_month, xfsbh, xfmc, gfsbh, gfmc,
                invoice_date, je, se, jshj, net_jshj, fpzt,
                first_import_batch_id, first_import_file
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                f"hdr-dup-{i}",
                base["stat_year"],
                base["stat_month"],
                base["xfsbh"],
                base["xfmc"],
                base["gfsbh"],
                base["gfmc"],
                d,
                base["je"],
                base["se"],
                base["jshj"],
                base["net_jshj"],
                base["fpzt"],
                base["first_import_batch_id"],
                base["first_import_file"],
            ],
        )
    ctx: RuleContext = {
        "stat_year": y,
        "group_id": f"Y{y}",
        "analysis_batch": "smoke",
        "entity_id": None,
    }
    flags = run_rule_01(conn, ctx)
    assert len(flags) >= 1
    assert flags[0]["rule_id"] == "RULE-01"
    detail = json.loads(flags[0]["detail_json"] or "{}")
    assert "seller_tax_no" in detail


def _ensure_detail_table(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_detail (
            header_uuid VARCHAR,
            detail_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            logic_line_no INTEGER,
            hwlwmc VARCHAR,
            je DECIMAL(18,2),
            se DECIMAL(18,2),
            jshj DECIMAL(18,2),
            slv VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_detail")


def test_invoice_export_seller_filter_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _ensure_header_table(conn)
    _ensure_detail_table(conn)
    y = 2024
    rows = [
        ("hdr-a", "SELLER01", "BUYER01", 1000),
        ("hdr-b", "SELLER02", "BUYER01", 2000),
    ]
    for uid, seller, buyer, amt in rows:
        conn.execute(
            """
            INSERT INTO dwd_inv_header (
                header_uuid, stat_year, stat_month, xfsbh, xfmc, gfsbh, gfmc,
                invoice_date, je, se, jshj, net_jshj, fpzt,
                first_import_batch_id, first_import_file
            ) VALUES (?, ?, 6, ?, '销方', ?, '购方', DATE '2024-06-01', ?, 0, ?, ?, '正常', 'b1', 'f1.xlsx')
            """,
            [uid, y, seller, buyer, amt, amt, amt],
        )
        conn.execute(
            """
            INSERT INTO dwd_inv_detail (
                header_uuid, detail_uuid, stat_year, logic_line_no, hwlwmc, je, se, jshj, slv
            ) VALUES (?, ?, ?, 1, '货物', ?, 0, ?, '13%')
            """,
            [uid, f"{uid}-d1", y, amt, amt],
        )
    all_cnt = api_export_invoices_count(conn, stat_year=str(y), entity_id="BUYER01")["row_count"]
    seller_cnt = api_export_invoices_count(
        conn, stat_year=str(y), entity_id="BUYER01", seller_tax_no="SELLER01"
    )["row_count"]
    assert all_cnt == 2
    assert seller_cnt == 1


def _ensure_circ_table(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_circ_inv (
            circ_id VARCHAR PRIMARY KEY,
            group_id VARCHAR NOT NULL,
            party_a_tax VARCHAR NOT NULL,
            party_a_name VARCHAR,
            party_b_tax VARCHAR NOT NULL,
            party_b_name VARCHAR,
            amount_a_to_b DECIMAL(18,2),
            amount_b_to_a DECIMAL(18,2),
            circular_ratio DECIMAL(8,6),
            risk_level VARCHAR NOT NULL,
            analysis_batch VARCHAR NOT NULL,
            UNIQUE (group_id, party_a_tax, party_b_tax, analysis_batch)
        )
        """
    )


def test_rule_09_circular_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _ensure_header_table(conn)
    _ensure_circ_table(conn)
    y = 2024
    pairs = [
        ("A001", "甲公司", "B002", "乙公司", 50000, "hdr-ab"),
        ("B002", "乙公司", "A001", "甲公司", 48000, "hdr-ba"),
    ]
    for xfs, xfmc, gfs, gfmc, amt, uid in pairs:
        conn.execute(
            """
            INSERT INTO dwd_inv_header (
                header_uuid, stat_year, stat_month, xfsbh, xfmc, gfsbh, gfmc,
                invoice_date, je, se, jshj, net_jshj, fpzt,
                first_import_batch_id, first_import_file
            ) VALUES (?, ?, 3, ?, ?, ?, ?, DATE '2024-03-15', ?, 0, ?, ?, '正常', 'b1', 'f1.xlsx')
            """,
            [uid, y, xfs, xfmc, gfs, gfmc, amt, amt, amt],
        )
    ctx: RuleContext = {
        "stat_year": y,
        "group_id": f"Y{y}",
        "analysis_batch": "smoke",
        "entity_id": None,
    }
    flags = run_rule_09(conn, ctx)
    assert len(flags) >= 1
    assert flags[0]["rule_id"] == "RULE-09"
    detail = json.loads(flags[0]["detail_json"] or "{}")
    assert detail.get("party_a_tax")
    assert detail.get("party_b_tax")
    assert detail.get("stat_year") == y
    assert detail.get("counterparty_id") == detail.get("party_b_tax")


def test_rule_10_internal_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _ensure_header_table(conn)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dim_enterprise_year_roster (
            stat_year INTEGER NOT NULL,
            enterprise_id VARCHAR NOT NULL,
            enterprise_name VARCHAR
        )
        """
    )
    y = 2024
    conn.execute(
        "INSERT INTO dim_enterprise_year_roster VALUES (?, ?, ?), (?, ?, ?)",
        [y, "BUY001", "买方公司", y, "SEL002", "卖方公司"],
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_header (
            header_uuid, stat_year, stat_month, xfsbh, xfmc, gfsbh, gfmc,
            invoice_date, je, se, jshj, net_jshj, fpzt,
            first_import_batch_id, first_import_file
        ) VALUES ('hdr-int', ?, 3, 'SEL002', '卖方公司', 'BUY001', '买方公司',
                  DATE '2024-03-15', 50000, 0, 50000, 50000, '正常', 'b1', 'f1.xlsx')
        """,
        [y],
    )
    ctx: RuleContext = {
        "stat_year": y,
        "group_id": f"Y{y}",
        "analysis_batch": "smoke",
        "entity_id": None,
    }
    flags = run_rule_10(conn, ctx)
    assert len(flags) >= 1
    assert flags[0]["rule_id"] == "RULE-10"
    detail = json.loads(flags[0]["detail_json"] or "{}")
    assert detail.get("buyer_tax_no") == "BUY001"
    assert detail.get("seller_tax_no") == "SEL002"
    assert detail.get("stat_year") == y
    assert detail.get("counterparty_id") == "SEL002"


def test_tax_deviation_flag_detail_json_smoke() -> None:
    conn = duckdb.connect(":memory:")
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
    y = 2024
    eid = "DEMO01"
    input_map = {
        "13%": {"amount_je": 1000, "amount_ratio": 0.7, "line_cnt": 1},
        "6%": {"amount_je": 300, "amount_ratio": 0.3, "line_cnt": 1},
    }
    output_map = {
        "13%": {"amount_je": 500, "amount_ratio": 0.5, "line_cnt": 1},
        "6%": {"amount_je": 500, "amount_ratio": 0.32, "line_cnt": 1},
    }
    compare_rows, exceeded, _ = build_tax_deviation_compare_rows(
        input_map, output_map, threshold_pct=10.0
    )
    _sync_tax_deviation_flags(
        conn,
        stat_year=y,
        entity_id=eid,
        entity_name="演示主体",
        exceeded_buckets=exceeded,
        compare_rows=compare_rows,
        threshold_pct=10.0,
    )
    rows = conn.execute(
        "SELECT flag_id, rule_id, detail_json FROM dm_audit_flag WHERE rule_id = 'RULE-TAX-DEV'"
    ).fetchall()
    assert len(rows) >= 1
    detail = json.loads(str(rows[0][2] or "{}"))
    assert detail.get("stat_year") == y
    assert detail.get("entity_id") == eid
    assert detail.get("tax_bucket")
    assert "ratio_diff" in detail


def test_synthetic_flag_detail_json_helpers_smoke() -> None:
    fin = json.loads(
        _fin_flag_detail_json(
            {
                "stat_year": 2026,
                "tax_id": "TAX001",
                "batch_id": "fin_batch_1",
                "diff_type": "C",
                "stat_month": 3,
            },
            batch_id="fin_batch_1",
        )
    )
    assert fin["entity_id"] == "TAX001"
    assert fin["batch_id"] == "fin_batch_1"
    assert fin["diff_type"] == "C"

    tax = json.loads(
        _tax_flag_detail_json(
            {
                "rule_id": "RULE-TAX-UNMATCH",
                "stat_year": 2026,
                "entity_id": "ENT01",
                "line_count": 12,
                "amount_sum": 5000.0,
            }
        )
    )
    assert tax["stat_year"] == 2026
    assert tax["line_count"] == 12

    dq = json.loads(
        _semantic_flag_detail_json(
            {
                "rule_id": "RULE-DQ-SUMMARY-LINE",
                "stat_year": 2026,
                "entity_id": "ENT01",
                "batch_id": "b1",
                "header_uuid": "h1",
                "ticket_key": "T-001",
                "summary_line_count": 2,
            },
            batch_id="b1",
        )
    )
    assert dq["domain"] == "semantic"
    assert dq["batch_id"] == "b1"


def test_audit_rules_execution_mode_smoke() -> None:
    from src.local_api.audit_flag_api import api_audit_rules_config_get

    resp = api_audit_rules_config_get(None)
    assert resp.get("ok") is True
    rules_list = resp.get("rules_list") or []
    assert len(rules_list) > 0
    by_id = {str(r["rule_id"]): r for r in rules_list}
    assert "execution_mode" in by_id["RULE-01"]
    assert by_id["RULE-01"]["execution_mode"] == "sql_scan"
    assert by_id["RULE-01"]["rescan_included"] is True
    assert by_id["RULE-SHELL"]["execution_mode"] == "post_scan"
    assert by_id["RULE-FIN-DIFF"]["execution_mode"] == "sync"
    assert by_id["RULE-FIN-DIFF"]["rescan_included"] is False
    assert "trigger_hint" in by_id["RULE-FIN-DIFF"]
    assert by_id.get("RULE-TAX-DEV", {}).get("execution_mode") == "sync"


def main() -> None:
    test_audit_rules_execution_mode_smoke()
    test_tax_deviation_threshold_marking()
    test_synthetic_flag_detail_json_helpers_smoke()
    test_tax_deviation_flag_detail_json_smoke()
    test_rule_01_duplicate_smoke()
    test_rule_09_circular_smoke()
    test_rule_10_internal_smoke()
    test_invoice_export_seller_filter_smoke()
    print("ok audit rules smoke")


if __name__ == "__main__":
    main()
