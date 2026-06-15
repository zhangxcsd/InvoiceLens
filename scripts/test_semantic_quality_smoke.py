"""Smoke: 语义质量趋势 / 明细分页 / sync-flags API。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.data_quality import (
    load_dq_domain_details,
    load_semantic_quality_trend,
    sync_semantic_quality_flags,
)


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            fpdm VARCHAR, fphm VARCHAR, sdfphm VARCHAR,
            invoice_date DATE,
            xfsbh VARCHAR, xfmc VARCHAR,
            gfsbh VARCHAR, gfmc VARCHAR,
            import_batch_id VARCHAR,
            import_session_id VARCHAR
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
            source_sheet VARCHAR
        )
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
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute("DELETE FROM dwd_inv_detail")
    conn.execute("DELETE FROM dm_audit_flag")
    conn.execute(
        """
        INSERT INTO dwd_inv_header VALUES
          ('h1', 2026, 'A', '1', 'SD001', DATE '2026-03-10', '91330100123456789X', '销A', '91330100987654321Y', '购A', 'b1', 's1'),
          ('h2', 2026, 'A', '2', 'SD002', DATE '2026-04-01', '91330100123456789X', '销A', '91330100987654321Y', '购A', 'b1', 's1')
        """
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_detail VALUES
          ('d-sum', 'h1', 2026, 0, '详见销货清单', 'b1', 's1', '明细'),
          ('d-pos', 'h2', 2026, 1, '运输服务', 'b1', 's1', '明细')
        """
    )


def test_semantic_trend_and_details_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    trend = load_semantic_quality_trend(conn, batch_id="b1", granularity="month", limit=12)
    assert trend["ok"] is True
    assert trend["time_basis"] == "invoice_date"
    assert len(trend["rows"]) >= 1
    assert sum(r["summary_line_count"] for r in trend["rows"]) >= 1

    sem = load_dq_domain_details(conn, domain="semantic", batch_id="b1", limit=10, offset=0)
    assert sem["ok"] is True
    assert sem["total_count"] >= 1
    assert any(r["rule_id"] == "summary_reference_line" for r in sem["rows"])

    filtered = load_dq_domain_details(
        conn,
        domain="semantic",
        batch_id="b1",
        rule_id="summary_reference_line",
        ticket_key="SD001",
        limit=10,
    )
    assert filtered["ok"] is True
    assert all(r["rule_id"] == "summary_reference_line" for r in filtered["rows"])

    paged = load_dq_domain_details(conn, domain="semantic", batch_id="b1", limit=1, offset=0)
    assert paged["ok"] is True
    assert len(paged["rows"]) <= 1
    assert paged["total_count"] >= 1


def test_semantic_sync_flags_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    sync = sync_semantic_quality_flags(conn, batch_id="b1", stat_year=2026)
    assert sync["ok"] is True
    assert sync["inserted"] >= 1
    cnt = conn.execute("SELECT COUNT(*) FROM dm_audit_flag").fetchone()[0]
    assert int(cnt) >= 1
    import json

    detail_row = conn.execute(
        "SELECT rule_id, detail_json FROM dm_audit_flag WHERE detail_json IS NOT NULL LIMIT 1"
    ).fetchone()
    assert detail_row
    detail = json.loads(str(detail_row[1] or "{}"))
    assert detail.get("batch_id") == "b1"
    assert detail.get("domain") in ("semantic", "cross_table")
    assert detail.get("stat_year") == 2026

    conn.execute(
        "UPDATE dm_audit_flag SET is_confirmed = TRUE WHERE flag_id LIKE 'DQSEM_%_SUMMARY'"
    )
    sync2 = sync_semantic_quality_flags(conn, batch_id="b1", stat_year=2026)
    assert sync2["ok"] is True
    assert sync2["skipped_confirmed"] >= 1


if __name__ == "__main__":
    test_semantic_trend_and_details_smoke()
    test_semantic_sync_flags_smoke()
    print("OK: semantic quality smoke passed")
