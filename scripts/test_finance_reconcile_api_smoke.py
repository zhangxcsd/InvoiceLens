"""Smoke: 财务账表导入与发票净额核对 API。"""
from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.audit_flag_api import api_audit_flags_list
from src.local_api.finance_reconcile_api import (
    api_ledger_batches,
    api_ledger_import,
    api_reconcile_details,
    api_reconcile_diff_summary,
    api_reconcile_overview,
    api_reconcile_sync_flags,
    sync_finance_reconcile_flags,
)


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_finance_ledger_batch (
            batch_id VARCHAR PRIMARY KEY,
            batch_name VARCHAR,
            source_file VARCHAR,
            stat_year SMALLINT,
            row_count INTEGER,
            reject_count INTEGER,
            import_status VARCHAR,
            detail_json TEXT,
            imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_finance_ledger (
            row_id VARCHAR PRIMARY KEY,
            batch_id VARCHAR NOT NULL,
            seq_no INTEGER,
            tax_id VARCHAR NOT NULL,
            entity_name VARCHAR,
            stat_year SMALLINT NOT NULL,
            stat_month SMALLINT,
            role_type VARCHAR DEFAULT '销项',
            subject_code VARCHAR,
            subject_name VARCHAR,
            ledger_amount DECIMAL(18,2) NOT NULL,
            source_excel_file VARCHAR,
            source_sheet VARCHAR,
            ingest_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dm_finance_ledger")
    conn.execute("DELETE FROM dm_finance_ledger_batch")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            stat_month SMALLINT,
            xfsbh VARCHAR, xfmc VARCHAR,
            gfsbh VARCHAR, gfmc VARCHAR,
            net_jshj DECIMAL(18,2),
            jshj DECIMAL(18,2)
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_audit_flag (
            flag_id        VARCHAR NOT NULL PRIMARY KEY,
            rule_id        VARCHAR NOT NULL,
            risk_level     VARCHAR NOT NULL,
            flag_type      VARCHAR NOT NULL,
            group_id       VARCHAR NOT NULL,
            entity_id      VARCHAR,
            entity_name    VARCHAR,
            seller_name    VARCHAR,
            seller_tax_no  VARCHAR,
            amount         DECIMAL(18,2),
            invoice_list   VARCHAR,
            description    VARCHAR,
            suggestion     VARCHAR,
            is_confirmed   BOOLEAN DEFAULT FALSE,
            confirm_note   VARCHAR,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            analysis_batch VARCHAR NOT NULL,
            detail_json    VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dm_audit_flag")
    conn.execute(
        """
        INSERT INTO dwd_inv_header VALUES
          ('h1', 2026, 3, '91330100123456789X', '测试企业A', '91330100999999999X', '购方B', 1000.00, 1000.00),
          ('h2', 2026, 4, '91330100123456789X', '测试企业A', '91330100888888888X', '购方C', 500.00, 500.00),
          ('h3', 2026, 5, '91330100777777777X', '测试企业D', '91330100123456789X', '测试企业A', 200.00, 200.00)
        """
    )


def _csv_bytes() -> bytes:
    content = (
        "税号,主体名称,年度,月份,账表金额,科目编码\n"
        "91330100123456789X,测试企业A,2026,3,1000.00,6001\n"
        "91330100123456789X,测试企业A,2026,4,480.00,6001\n"
        "91330100555555555X,账面独有,2026,6,300.00,1122\n"
        ",,2026,1,100,\n"
    )
    return content.encode("utf-8-sig")


def test_ledger_import_and_reconcile_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    imp = api_ledger_import(
        conn,
        file_bytes=_csv_bytes(),
        upload_filename="ledger.csv",
        batch_name="smoke-ledger",
        default_stat_year=2026,
    )
    assert imp["ok"] is True, imp
    assert imp["row_count"] == 3
    assert imp["reject_count"] == 1
    batch_id = imp["batch_id"]

    batches = api_ledger_batches(conn, limit=10)
    assert batches["ok"] is True
    assert len(batches["batches"]) == 1
    assert batches["batches"][0]["batch_id"] == batch_id

    ov = api_reconcile_overview(conn, batch_id=batch_id)
    assert ov["ok"] is True
    assert ov["ledger_ready"] is True
    assert ov["dwd_ready"] is True
    assert ov["kpi"]["total_rows"] >= 3
    assert ov["kpi"]["matched_count"] >= 1
    assert ov["kpi"]["type_c_count"] >= 1
    assert ov["kpi"]["type_b_count"] >= 1

    diff = api_reconcile_diff_summary(conn, batch_id=batch_id)
    assert diff["ok"] is True
    assert diff["by_type"]["C"]["count"] >= 1
    assert diff["by_type"]["B"]["count"] >= 1

    det = api_reconcile_details(conn, batch_id=batch_id, diff_type="C", limit=20)
    assert det["ok"] is True
    assert det["total"] >= 1
    assert all(r["diff_type"] == "C" for r in det["rows"])


def test_sync_flags_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    imp = api_ledger_import(
        conn,
        file_bytes=_csv_bytes(),
        upload_filename="ledger.csv",
        batch_name="smoke-flags",
        default_stat_year=2026,
    )
    assert imp["ok"] is True
    batch_id = imp["batch_id"]

    sync1 = api_reconcile_sync_flags(conn, batch_id=batch_id)
    assert sync1["ok"] is True, sync1
    assert sync1["inserted"] >= 2
    assert sync1["by_rule"]["RULE-FIN-DIFF"] >= 1
    assert sync1["by_rule"]["RULE-FIN-LEDGER-ONLY"] >= 1

    flag_row = conn.execute(
        "SELECT flag_id, detail_json FROM dm_audit_flag WHERE rule_id = 'RULE-FIN-DIFF' LIMIT 1"
    ).fetchone()
    assert flag_row
    import json

    detail = json.loads(str(flag_row[1] or "{}"))
    assert detail.get("batch_id")
    assert detail.get("diff_type")
    assert detail.get("stat_year") == 2026
    conn.execute(
        "UPDATE dm_audit_flag SET is_confirmed = TRUE WHERE flag_id = ?",
        [flag_row[0]],
    )
    sync2 = sync_finance_reconcile_flags(conn, batch_id=batch_id)
    assert sync2["ok"] is True
    assert sync2["skipped_confirmed"] >= 1

    confirmed = conn.execute(
        "SELECT count(*)::BIGINT FROM dm_audit_flag WHERE rule_id = 'RULE-FIN-DIFF' AND is_confirmed = TRUE"
    ).fetchone()[0]
    assert int(confirmed or 0) >= 1


def test_flags_list_batch_filter_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    imp = api_ledger_import(
        conn,
        file_bytes=_csv_bytes(),
        upload_filename="ledger.csv",
        batch_name="smoke-batch-filter",
        default_stat_year=2026,
    )
    assert imp["ok"] is True
    batch_id = imp["batch_id"]

    sync = api_reconcile_sync_flags(conn, batch_id=batch_id)
    assert sync["ok"] is True, sync
    assert sync["inserted"] >= 1

    all_flags = api_audit_flags_list(conn, stat_year="2026", limit=100)
    assert all_flags["ok"] is True, all_flags
    assert int(all_flags.get("total") or 0) >= sync["inserted"]

    filtered = api_audit_flags_list(conn, stat_year="2026", batch_id=batch_id, limit=100)
    assert filtered["ok"] is True, filtered
    assert int(filtered.get("total") or 0) == sync["inserted"]
    assert all(
        str(r.get("rule_id") or "").startswith("RULE-FIN-") for r in (filtered.get("rows") or [])
    )

    other = api_audit_flags_list(conn, stat_year="2026", batch_id="nonexistent_batch", limit=100)
    assert other["ok"] is True, other
    assert int(other.get("total") or 0) == 0


def test_file_blocking_smoke() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)
    imp = api_ledger_import(
        conn,
        file_bytes=b"not-a-real-xlsx",
        upload_filename="broken.xlsx",
    )
    assert imp["ok"] is False
    assert imp["import_status"] == "失败"
    assert imp["detail"]["file_logs"][0]["file_blocking"] is True


def main() -> int:
    test_ledger_import_and_reconcile_smoke()
    test_sync_flags_smoke()
    test_flags_list_batch_filter_smoke()
    test_file_blocking_smoke()
    print("finance reconcile API smoke: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
