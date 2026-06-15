"""CI smoke: 授权门控（export_report / cross_group / RSA .lic / 配额）。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from scripts.sign_license import sign_payload
from src.local_api.compare_dashboard_api import (
    api_compare_charts_series,
    api_compare_meta,
    api_compare_rank_list,
    api_compare_rebuild,
)
from src.local_api.license_gate import (
    _LICENSE_FILE_PATH,
    _LICENSE_OVERRIDE_PATH,
    api_settings_license_post,
    check_cross_group_allowed,
    check_export_allowed,
    check_invoice_quota,
    check_year_quota_for_build,
    get_license_config,
    get_license_source,
    license_gate_http_status,
)


def _with_temp_license(fn) -> None:
    with tempfile.TemporaryDirectory() as td:
        lic = Path(td) / "license_override.json"
        with patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", lic):
            fn(lic)


def test_cross_group_denied_by_default() -> None:
    denied = check_cross_group_allowed()
    assert denied is not None
    assert denied["error"]["code"] == "license_cross_group_denied"
    assert license_gate_http_status(denied) == 403


def test_compare_apis_blocked_when_trial() -> None:
    conn = duckdb.connect(":memory:")
    cases: list[tuple[str, object]] = [
        ("meta", lambda: api_compare_meta(conn)),
        ("rank", lambda: api_compare_rank_list(conn, stat_year="2026")),
        ("charts", lambda: api_compare_charts_series(conn, stat_year="2026")),
        ("rebuild", lambda: api_compare_rebuild(conn, {"stat_year": "2026"})),
    ]
    for name, call in cases:
        res = call()
        assert res.get("ok") is False, (name, res)
        assert res["error"]["code"] == "license_cross_group_denied", (name, res)


def test_compare_allowed_after_license_import() -> None:
    def run(_lic: Path) -> None:
        imported = api_settings_license_post(
            {
                "license": {
                    "cross_group": True,
                    "expires_at": "2099-12-31",
                },
                "actor": "admin",
            }
        )
        assert imported.get("ok") is True
        assert check_cross_group_allowed() is None

        conn = duckdb.connect(":memory:")
        conn.execute(
            """
            CREATE TABLE ads_scorecard (
                scorecard_id VARCHAR PRIMARY KEY,
                group_id VARCHAR NOT NULL,
                entity_id VARCHAR NOT NULL,
                entity_name VARCHAR,
                stat_year SMALLINT NOT NULL,
                total_amount DECIMAL(18,2),
                total_count INT,
                supplier_count INT,
                flag_total INT DEFAULT 0,
                flag_high INT DEFAULT 0,
                flag_medium INT DEFAULT 0,
                flag_low INT DEFAULT 0,
                risk_score DECIMAL(5,2) DEFAULT 100,
                risk_level VARCHAR,
                cr1 DECIMAL(8,6),
                cancel_ratio DECIMAL(8,6),
                quality_score DECIMAL(5,2),
                analysis_batch VARCHAR NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            INSERT INTO ads_scorecard (
                scorecard_id, group_id, entity_id, entity_name, stat_year,
                total_amount, total_count, supplier_count,
                flag_total, flag_high, risk_score, risk_level, cr1, cancel_ratio,
                analysis_batch
            ) VALUES (
                'sc1', 'Y2026', 'ENT-A', '子公司A', 2026,
                1000, 10, 3, 2, 1, 72.5, '关注', 0.35, 0.02, 'batch_smoke'
            )
            """
        )

        meta = api_compare_meta(conn)
        assert meta.get("ok") is True, meta
        rank = api_compare_rank_list(conn, stat_year="2026")
        assert rank.get("ok") is True, rank
        charts = api_compare_charts_series(conn, stat_year="2026")
        assert charts.get("ok") is True, charts

        reset = api_settings_license_post({"reset": True})
        assert reset.get("ok") is True
        assert check_cross_group_allowed() is not None

    _with_temp_license(run)


def test_export_and_cross_group_codes_distinct() -> None:
    export_denied = check_export_allowed()
    cross_denied = check_cross_group_allowed()
    assert export_denied is not None
    assert cross_denied is not None
    assert export_denied["error"]["code"] == "license_export_denied"
    assert cross_denied["error"]["code"] == "license_cross_group_denied"


def test_signed_lic_file_priority_over_default() -> None:
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        print("test_signed_lic_file_priority_over_default: SKIP (cryptography)")
        return

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        override = td_path / "license_override.json"
        lic_file = td_path / "license.lic"
        pub = td_path / "public.pem"
        priv = td_path / "private.pem"

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pub.write_bytes(
            key.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        priv.write_bytes(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

        payload = {
            "tier": "pro",
            "cross_group": True,
            "export_report": True,
            "max_entities": 7,
            "expires_at": "2099-12-31",
        }
        lic_file.write_text(json.dumps(sign_payload(payload, priv), ensure_ascii=False, indent=2), encoding="utf-8")

        with (
            patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", override),
            patch("src.local_api.license_gate._LICENSE_FILE_PATH", lic_file),
            patch("src.local_api.license_gate._public_key_path", lambda: pub),
        ):
            assert get_license_source() == "lic"
            cfg = get_license_config()
            assert cfg.get("tier") == "pro"
            assert cfg.get("max_entities") == 7
            assert check_cross_group_allowed() is None

            lic_file.write_text('{"payload": {"tier": "evil"}, "signature": "AAAA"}', encoding="utf-8")
            assert get_license_source() == "lic_invalid"


def test_invoice_and_year_quota() -> None:
    conn = duckdb.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE dwd_inv_header (
            invoice_uuid VARCHAR,
            stat_year SMALLINT
        )
        """
    )
    for i in range(5):
        conn.execute("INSERT INTO dwd_inv_header VALUES (?, 2024)", [f"inv{i}"])

    with tempfile.TemporaryDirectory() as td:
        override = Path(td) / "license_override.json"
        override.write_text(
            json.dumps({"max_invoices": 5, "max_years": 1}, ensure_ascii=False),
            encoding="utf-8",
        )
        with patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", override):
            denied = check_invoice_quota(conn)
            assert denied is not None
            assert denied["error"]["code"] == "license_invoice_cap_denied"
            assert license_gate_http_status(denied) == 403

            year_denied = check_year_quota_for_build(conn, 2025)
            assert year_denied is not None
            assert year_denied["error"]["code"] == "license_year_cap_denied"


def main() -> None:
    test_cross_group_denied_by_default()
    test_compare_apis_blocked_when_trial()
    test_compare_allowed_after_license_import()
    test_export_and_cross_group_codes_distinct()
    test_signed_lic_file_priority_over_default()
    test_invoice_and_year_quota()
    print("test_license_gate_smoke: OK")


if __name__ == "__main__":
    main()
