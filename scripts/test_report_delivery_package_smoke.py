"""Smoke: 报告一键交付包 API（ZIP = Word + 疑点 CSV + manifest）。"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.audit_flag_api import export_audit_flags_csv_bytes
from src.local_api.license_gate import check_export_allowed
from src.local_api.report_api import api_report_delivery_package, reports_dir


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_header (
            header_uuid VARCHAR PRIMARY KEY,
            stat_year SMALLINT,
            stat_month SMALLINT,
            gfsbh VARCHAR,
            xfsbh VARCHAR,
            sdfphm VARCHAR,
            fpdm VARCHAR,
            fphm VARCHAR,
            is_balanced VARCHAR,
            import_batch_id VARCHAR,
            import_session_id VARCHAR,
            dwd_build_ts TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_inv_detail (
            detail_uuid VARCHAR,
            header_uuid VARCHAR,
            stat_year SMALLINT,
            import_batch_id VARCHAR,
            import_session_id VARCHAR
        )
        """
    )
    conn.execute("DELETE FROM dwd_inv_header")
    conn.execute("DELETE FROM dwd_inv_detail")
    conn.execute(
        """
        INSERT INTO dwd_inv_header VALUES
        (
            'HDR-SMOKE-001', 2026, 1,
            '91110000TEST001', '91110000TEST002',
            'SD001', '', '',
            '平账', 'batch_smoke', 'sess_smoke', CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_inv_trend (
            stat_year SMALLINT,
            stat_month SMALLINT,
            entity_id VARCHAR,
            net_jshj DECIMAL(18,2),
            normal_cnt INTEGER,
            red_cnt INTEGER,
            cancel_cnt INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dws_sup_conc (
            stat_year SMALLINT,
            supplier_id VARCHAR,
            supplier_name VARCHAR,
            net_jshj DECIMAL(18,2),
            share_pct DOUBLE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ads_scorecard (
            stat_year SMALLINT,
            entity_id VARCHAR,
            entity_name VARCHAR,
            net_jshj DECIMAL(18,2),
            flag_cnt INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dm_audit_flag (
            flag_id VARCHAR PRIMARY KEY,
            rule_id VARCHAR,
            risk_level VARCHAR,
            flag_type VARCHAR,
            group_id VARCHAR,
            entity_id VARCHAR,
            entity_name VARCHAR,
            seller_name VARCHAR,
            seller_tax_no VARCHAR,
            amount DECIMAL(18,2),
            description VARCHAR,
            suggestion VARCHAR,
            is_confirmed BOOLEAN DEFAULT FALSE,
            confirm_note VARCHAR,
            analysis_batch VARCHAR,
            created_at TIMESTAMP
        )
        """
    )
    conn.execute("DELETE FROM dws_inv_trend")
    conn.execute("DELETE FROM dws_sup_conc")
    conn.execute("DELETE FROM ads_scorecard")
    conn.execute("DELETE FROM dm_audit_flag")
    conn.execute(
        """
        INSERT INTO dws_inv_trend VALUES
        (2026, 1, '91110000TEST001', 100000.00, 10, 0, 0)
        """
    )
    conn.execute(
        """
        INSERT INTO dws_sup_conc VALUES
        (2026, 'SUP001', '示例供应商', 50000.00, 0.5)
        """
    )
    conn.execute(
        """
        INSERT INTO dm_audit_flag VALUES
        (
            'FLAG-DP-001', 'RULE-01', '高风险', '测试',
            'Y2026', '91110000TEST001', '示例企业', NULL, NULL,
            12345.67, '交付包 smoke 疑点', '复核凭证', FALSE, NULL,
            'smoke', CURRENT_TIMESTAMP
        )
        """
    )


def test_export_audit_flags_csv_bytes() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)
    data, count = export_audit_flags_csv_bytes(conn, stat_year=2026)
    assert count == 1
    assert b"\xef\xbb\xbf" in data[:4] or data.startswith(b"\xef\xbb\xbf")
    text = data.decode("utf-8-sig")
    assert "FLAG-DP-001" in text
    assert "高风险" in text


def test_delivery_package_license_denied() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    def run(_root: Path) -> None:
        denied = check_export_allowed()
        assert denied is not None
        status, payload, ctype, fname = api_report_delivery_package(
            conn,
            {"stat_year": "2026", "title": "Smoke 交付包"},
        )
        assert status == 403
        assert isinstance(payload, dict)
        assert payload.get("ok") is False
        assert ctype == ""
        assert fname == ""

    with tempfile.TemporaryDirectory() as td:
        lic = Path(td) / "license_override.json"
        with patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", lic):
            run(Path(td))


def test_delivery_package_ok() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    with tempfile.TemporaryDirectory() as td:
        reports = Path(td) / "reports"
        reports.mkdir(parents=True)
        lic = Path(td) / "license_override.json"
        audit = Path(td) / "audit_log.json"
        audit.write_text("[]", encoding="utf-8")

        with (
            patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", lic),
            patch("src.local_api.report_api._DEFAULT_REPORTS_DIR", reports),
            patch("src.local_api.report_api.reports_dir", lambda: reports),
            patch("src.local_api.users_api._AUDIT_PATH", audit),
        ):
            imported = __import__(
                "src.local_api.license_gate",
                fromlist=["api_settings_license_post"],
            ).api_settings_license_post(
                {
                    "license": {
                        "tier": "pro",
                        "export_report": True,
                        "expires_at": "2099-12-31",
                    }
                }
            )
            assert imported.get("ok") is True

            status, payload, ctype, fname = api_report_delivery_package(
                conn,
                {
                    "stat_year": "2026",
                    "title": "Smoke 交付包",
                    "chapters": {
                        "overview": True,
                        "audit_flags": True,
                        "structure": False,
                        "supplier": False,
                        "flags_track": False,
                        "related": False,
                        "compare": False,
                        "supplier_new": False,
                        "trade_relationships": False,
                        "tax_in_out_deviation": False,
                        "finance_reconcile": False,
                        "data_quality_summary": False,
                        "tax_code_analysis": False,
                    },
                    "include_invoices": False,
                    "include_finance": False,
                    "include_data_quality": True,
                    "actor": "smoke",
                },
            )
            assert status == 200, payload
            assert isinstance(payload, bytes)
            assert ctype == "application/zip"
            assert fname.endswith(".zip")

            with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                names = zf.namelist()
                assert any(n.startswith("report/") and n.endswith(".docx") for n in names)
                assert "exports/audit_flags_2026.csv" in names
                assert "exports/data_quality_domain_summary_2026.csv" in names
                assert "manifest.json" in names
                assert "README.txt" in names
                manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
                assert manifest.get("stat_year") == 2026
                assert manifest.get("ok") is True
                assert manifest.get("chapter_files")
                assert manifest.get("chapter_labels")
                content_types = {c.get("type") for c in manifest.get("contents") or []}
                assert "data_quality_summary_csv" in content_types
                flags_csv = zf.read("exports/audit_flags_2026.csv").decode("utf-8-sig")
                assert "FLAG-DP-001" in flags_csv
                dq_csv = zf.read("exports/data_quality_domain_summary_2026.csv").decode("utf-8-sig")
                assert "质量域" in dq_csv

            log = json.loads(audit.read_text(encoding="utf-8"))
            assert any(e.get("action") == "report_delivery_package" for e in log)


def test_delivery_package_async_list() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)

    with tempfile.TemporaryDirectory() as td:
        reports = Path(td) / "reports"
        reports.mkdir(parents=True)
        history = Path(td) / "delivery_history.json"
        lic = Path(td) / "license_override.json"
        audit = Path(td) / "audit_log.json"
        audit.write_text("[]", encoding="utf-8")

        with (
            patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", lic),
            patch("src.local_api.report_api._DEFAULT_REPORTS_DIR", reports),
            patch("src.local_api.report_api.reports_dir", lambda: reports),
            patch("src.local_api.report_api._DELIVERY_PACKAGES_DIR", reports / "delivery_packages"),
            patch("src.local_api.report_api._DELIVERY_HISTORY_PATH", history),
            patch("src.local_api.users_api._AUDIT_PATH", audit),
        ):
            imported = __import__(
                "src.local_api.license_gate",
                fromlist=["api_settings_license_post"],
            ).api_settings_license_post(
                {
                    "license": {
                        "tier": "pro",
                        "export_report": True,
                        "expires_at": "2099-12-31",
                    }
                }
            )
            assert imported.get("ok") is True

            from src.local_api.report_api import (
                get_delivery_package_status,
                list_delivery_packages,
                start_delivery_package_async,
            )

            def fake_get_conn():
                c = duckdb.connect(":memory:")
                _seed(c)
                return c

            with patch("db.duckdb_conn.get_conn", fake_get_conn), patch(
                "db.schema_sqlfiles.init_all_tables", lambda _conn: None
            ):
                started = start_delivery_package_async(
                    {
                        "stat_year": "2026",
                        "title": "Async Smoke",
                        "chapters": {
                            "overview": True,
                            "audit_flags": True,
                            "structure": False,
                            "supplier": False,
                            "flags_track": False,
                            "related": False,
                            "compare": False,
                            "supplier_new": False,
                            "trade_relationships": False,
                            "tax_in_out_deviation": False,
                            "finance_reconcile": False,
                        },
                        "include_invoices": False,
                        "include_finance": False,
                    }
                )
                assert started.get("ok") is True
                run_id = str(started.get("run_id") or "")
                assert run_id

                deadline = time.time() + 120
                final = None
                while time.time() < deadline:
                    final = get_delivery_package_status(run_id)
                    assert final.get("ok") is True
                    if str(final.get("status") or "") in ("success", "failed"):
                        break
                    time.sleep(0.5)
                assert final is not None
                assert str(final.get("status") or "") == "success"

                listed = list_delivery_packages(limit=5)
                assert listed.get("ok") is True
                pkgs = listed.get("packages") or []
                assert any(str(p.get("run_id") or "") == run_id for p in pkgs)


def test_estimate_delivery_package() -> None:
    conn = duckdb.connect(":memory:")
    _seed(conn)
    from src.local_api.report_api import estimate_delivery_package

    est = estimate_delivery_package(conn, {"stat_year": "2026"})
    assert est.get("ok") is True
    estimates = est.get("estimates") or {}
    assert estimates.get("audit_flags") == 1
    assert estimates.get("data_quality_scanned") == 1
    sections = est.get("sections") or []
    assert len(sections) >= 3
    assert any(s.get("id") == "audit_flags" and s.get("included") for s in sections)
    assert estimates.get("total_zip_bytes_est", 0) > 0

    est2 = estimate_delivery_package(
        conn,
        {"stat_year": "2026", "chapters": {"audit_flags": True, "finance_reconcile": False, "tax_code_analysis": False}},
    )
    assert est2.get("ok") is True
    fin = next(s for s in est2.get("sections") or [] if s.get("id") == "finance_reconcile")
    assert fin.get("included") is False

    est3 = estimate_delivery_package(
        conn,
        {"stat_year": "2026", "chapters": {"tax_risk_exposure": True}},
    )
    assert est3.get("ok") is True
    risk = next(s for s in est3.get("sections") or [] if s.get("id") == "tax_risk_exposure")
    assert risk.get("included") is True


def main() -> None:
    test_export_audit_flags_csv_bytes()
    test_delivery_package_license_denied()
    test_delivery_package_ok()
    test_estimate_delivery_package()
    test_delivery_package_async_list()
    print("OK: report delivery package smoke passed")


if __name__ == "__main__":
    main()
