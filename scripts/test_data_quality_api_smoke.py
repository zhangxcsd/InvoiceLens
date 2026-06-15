"""Smoke: 红票质量概览/明细/趋势与质量域概览 API 函数。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.data_quality import (
    load_dq_domain_details,
    load_dq_domain_overview,
    load_dwd_lineage_quality_trend,
    load_lineage_reject_quality_trend,
    load_quality_import_batches,
    load_red_invoice_quality_details,
    load_red_invoice_quality_overview,
    load_red_invoice_quality_trend,
)


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            stat_month SMALLINT,
            fpdm VARCHAR, fphm VARCHAR, sdfphm VARCHAR,
            kprq VARCHAR,
            invoice_date DATE,
            je DECIMAL(18,2), se DECIMAL(18,2), jshj DECIMAL(18,2),
            bz VARCHAR,
            xfsbh VARCHAR, xfmc VARCHAR,
            gfsbh VARCHAR, gfmc VARCHAR,
            is_balanced VARCHAR DEFAULT '未校验',
            detail_total_amount DECIMAL(18,2),
            balance_diff DECIMAL(18,2),
            net_calc_status VARCHAR,
            is_orphan_red BOOLEAN DEFAULT FALSE,
            related_blue_invoice_uuid VARCHAR,
            import_batch_id VARCHAR,
            import_session_id VARCHAR,
            source_excel_file VARCHAR,
            source_sheet VARCHAR,
            ods_file_seq INTEGER,
            dwd_build_ts TIMESTAMP
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
            hwlwmc VARCHAR,
            import_batch_id VARCHAR,
            import_session_id VARCHAR,
            source_excel_file VARCHAR,
            source_sheet VARCHAR,
            ods_file_seq INTEGER
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute("DELETE FROM dwd_inv_detail")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ods_load_log (
            import_batch_id TEXT NOT NULL,
            import_session_id TEXT NOT NULL,
            load_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            file_count INTEGER,
            total_rows INTEGER,
            success_count INTEGER,
            fail_count INTEGER,
            warn_count INTEGER,
            parquet_paths VARCHAR,
            detail_json TEXT,
            dwd_session_processed_at TIMESTAMP,
            PRIMARY KEY (import_batch_id, import_session_id)
        )
        """
    )
    conn.execute("DELETE FROM ods_load_log")
    detail = [
        {
            "import_batch_id": "b1",
            "import_session_id": "s1",
            "file_name": "bad.xlsx",
            "source_excel_file": "D:/data/bad.xlsx",
            "status": "警告",
            "file_blocking": False,
            "rows_dropped_within_file": 2,
            "reject_row_samples": [
                {
                    "seq_no": 5,
                    "sheet": "发票基础信息",
                    "field": "je",
                    "reason": "金额无效",
                    "exception_type": "RowValidationError",
                }
            ],
            "reject_row_ranges": [{"seq_no_start": 5, "seq_no_end": 6, "reason": "金额无效"}],
        },
        {
            "import_batch_id": "b1",
            "import_session_id": "s1",
            "file_name": "broken.xlsx",
            "source_excel_file": "D:/data/broken.xlsx",
            "status": "失败",
            "file_blocking": True,
            "reason": "文件损坏",
            "exception_type": "BadZipFile",
            "reject_row_samples": [],
            "reject_row_ranges": [],
        },
    ]
    conn.execute(
        """
        INSERT INTO ods_load_log (
            import_batch_id, import_session_id, file_count, total_rows,
            success_count, fail_count, warn_count, parquet_paths, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ["b1", "s1", 2, 100, 1, 1, 1, "[]", json.dumps(detail, ensure_ascii=False)],
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_header VALUES
          ('r1', 2026, 3, 'A', '1', 'SD001', '2026-03-10', DATE '2026-03-10', -100, -13, -113,
           '', '91330100123456789X', '销A', '', '购A', '未校验', NULL, NULL, '未匹配', FALSE, NULL, 'b1', 's1', NULL, NULL, NULL, CURRENT_TIMESTAMP),
          ('r2', 2026, 3, 'A', '2', 'SD002', '2026-03-12', DATE '2026-03-12', -200, -26, -226,
           '对应正数发票代码：123 号码：456', '91330100123456789X', '销A', '123', '购B', '不平账', -180, -46, '孤立红票', TRUE, NULL, 'b1', 's1', NULL, NULL, NULL, CURRENT_TIMESTAMP),
          ('r3', 2026, 4, 'A', '3', 'SD003', '2026-04-01', DATE '2026-04-01', -50, -6.5, -56.5,
           '', '91330100123456789X', '销A', '913301001234567890', '购C', '平账', -50, 0, '已匹配', FALSE, 'blue-uuid-1', 'b1', 's1', 'D:/data/f.xlsx', '发票基础信息', 1, CURRENT_TIMESTAMP),
          ('dup1', 2026, 4, 'B', '9', '', '2026-04-02', DATE '2026-04-02', 100, 13, 113,
           '', '91330100123456789X', '销A', '913301001234567890', '购C', '平账', 100, 0, '已匹配', FALSE, NULL, 'b1', 's1', 'D:/data/f.xlsx', '发票基础信息', 1, CURRENT_TIMESTAMP),
          ('dup2', 2026, 4, 'B', '9', '', '2026-04-02', DATE '2026-04-02', 100, 13, 113,
           '', '91330100123456789X', '销A', '913301001234567890', '购C', '平账', 100, 0, '已匹配', FALSE, NULL, 'b1', 's1', 'D:/data/f.xlsx', '发票基础信息', 1, CURRENT_TIMESTAMP)
        """
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_detail VALUES
          ('d1', 'r3', 2026, 1, '办公用品', 'b1', 's1', 'f.xlsx', '明细', 1),
          ('d1-dup-uuid', 'dup1', 2026, 1, '重复行', 'b1', 's1', 'f.xlsx', '明细', 1),
          ('d-sum', 'dup1', 2026, 0, '详见销货清单', 'b1', 's1', 'f.xlsx', '明细', 1)
        """
    )


def test_red_invoice_quality_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    ov = load_red_invoice_quality_overview(conn)
    assert ov["ok"] is True
    assert ov["red_invoice_count"] == 3
    assert ov["unmatched_blue_count"] == 2
    assert ov["orphan_red_count"] == 1
    assert ov["matched_blue_count"] == 1

    ov_b = load_red_invoice_quality_overview(conn, batch_id="b1")
    assert ov_b["red_invoice_count"] == 3

    det = load_red_invoice_quality_details(conn, only_unmatched=True, limit=10)
    assert det["ok"] is True
    assert len(det["rows"]) == 2
    assert all(r["related_blue_invoice_uuid"] == "" for r in det["rows"])

    trend = load_red_invoice_quality_trend(conn, granularity="week", limit=12)
    assert trend["ok"] is True
    assert len(trend["rows"]) >= 1
    total_unmatched = sum(r["unmatched_count"] for r in trend["rows"])
    assert total_unmatched == 2

    trend_m = load_red_invoice_quality_trend(conn, granularity="month", limit=12)
    assert trend_m["ok"] is True
    assert len(trend_m["rows"]) == 2


def test_dq_domain_overview_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    batches = load_quality_import_batches(conn)
    assert batches["ok"] is True
    assert len(batches["batches"]) == 1
    assert batches["batches"][0]["batch_id"] == "b1"

    dom = load_dq_domain_overview(conn, batch_id="b1")
    assert dom["ok"] is True
    assert dom["kpi"]["scanned_headers"] == 5
    assert dom["domains"]["uniqueness"]["dup_groups"] == 1
    assert dom["domains"]["tax_id"]["empty_count"] >= 1
    assert dom["domains"]["red_link"]["orphan_red_count"] == 1
    assert dom["dup_counts"]["header_groups"] == 1
    assert dom["domains"]["header_detail"]["unbalanced_count"] >= 1
    assert dom["domains"]["semantic"]["summary_line_count"] >= 1
    assert dom["dup_counts"]["spc_groups"] == 0
    assert dom["domains"]["lineage_reject"]["row_reject_count"] == 2
    assert dom["domains"]["lineage_reject"]["file_blocking_count"] == 1
    assert dom["domains"]["lineage_reject"]["reject_sample_count"] == 1
    assert dom["domains"]["dwd_lineage"]["missing_header_count"] == 2
    assert dom["domains"]["dwd_lineage"]["distinct_source_files"] == 2
    assert dom["domains"]["dwd_lineage"]["coverage_rate"] == 60.0
    assert "lineage_reject_samples" not in (dom.get("gaps") or [])


def test_dq_lineage_reject_details_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    lr = load_dq_domain_details(conn, domain="lineage_reject", batch_id="b1", limit=20)
    assert lr["ok"] is True
    assert len(lr["rows"]) >= 2
    assert any(r["rule_id"] == "row_reject" for r in lr["rows"])
    assert any(r["rule_id"] == "file_blocking" for r in lr["rows"])
    sample = next(r for r in lr["rows"] if r["rule_id"] == "row_reject")
    assert sample["extra"]["seq_no"] == 5
    assert sample["extra"]["sheet"] == "发票基础信息"


def test_dwd_lineage_details_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    dl = load_dq_domain_details(conn, domain="dwd_lineage", batch_id="b1", limit=20)
    assert dl["ok"] is True
    assert dl["total_count"] >= 1
    assert len(dl["rows"]) >= 1
    assert any(r["rule_id"] == "missing_header_source" for r in dl["rows"])
    assert any(r["rule_id"] == "lineage_trace" for r in dl["rows"])
    trace = next(r for r in dl["rows"] if r["rule_id"] == "lineage_trace" and r["extra"].get("logic_line_no") == 1)
    assert trace["extra"]["source_sheet"] == "明细"
    assert trace["extra"]["row_kind"] == "detail"

    filtered = load_dq_domain_details(
        conn,
        domain="dwd_lineage",
        batch_id="b1",
        ticket_key="SD001",
        limit=10,
    )
    assert filtered["ok"] is True
    assert all("SD001" in r["ticket_key"] for r in filtered["rows"])

    paged = load_dq_domain_details(
        conn,
        domain="dwd_lineage",
        batch_id="b1",
        limit=2,
        offset=0,
    )
    assert paged["ok"] is True
    assert len(paged["rows"]) <= 2
    assert paged["total_count"] >= len(paged["rows"])


def test_dwd_lineage_trend_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    trend = load_dwd_lineage_quality_trend(conn, batch_id="b1", granularity="week", limit=12)
    assert trend["ok"] is True
    assert trend["time_basis"] == "dwd_build_ts"
    assert len(trend["rows"]) >= 1
    row = trend["rows"][0]
    assert "coverage_rate" in row
    assert row["header_count"] >= 1


def test_lineage_reject_trend_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    trend = load_lineage_reject_quality_trend(conn, granularity="week", limit=12)
    assert trend["ok"] is True
    assert len(trend["rows"]) >= 1
    total_reject = sum(r["row_reject_count"] for r in trend["rows"])
    total_block = sum(r["file_blocking_count"] for r in trend["rows"])
    assert total_reject == 2
    assert total_block == 1


def test_dq_domain_details_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    uni = load_dq_domain_details(conn, domain="uniqueness", batch_id="b1", limit=20)
    assert uni["ok"] is True
    assert len(uni["rows"]) >= 2

    tax = load_dq_domain_details(conn, domain="tax_id", batch_id="b1", limit=20)
    assert tax["ok"] is True
    assert any(r["rule_id"] == "tax_id_empty" for r in tax["rows"])

    hdr = load_dq_domain_details(conn, domain="header_detail", batch_id="b1", limit=20)
    assert hdr["ok"] is True
    assert len(hdr["rows"]) >= 1

    sem = load_dq_domain_details(conn, domain="semantic", batch_id="b1", limit=20)
    assert sem["ok"] is True
    assert any(r["rule_id"] == "summary_reference_line" for r in sem["rows"])

    red = load_dq_domain_details(conn, domain="red_link", batch_id="b1", only_unmatched=True, limit=20)
    assert red["ok"] is True
    assert len(red["rows"]) == 2


if __name__ == "__main__":
    test_red_invoice_quality_smoke()
    test_dq_domain_overview_smoke()
    test_dq_lineage_reject_details_smoke()
    test_dwd_lineage_details_smoke()
    test_dwd_lineage_trend_smoke()
    test_lineage_reject_trend_smoke()
    test_dq_domain_details_smoke()
    print("OK: data quality API smoke passed")
