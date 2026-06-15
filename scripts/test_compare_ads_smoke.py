"""CI smoke: 子公司横向对比（ads_scorecard / compare API）。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.compare_dashboard_api import api_compare_charts_series, api_compare_meta, api_compare_rank_list
from src.local_api.license_gate import api_settings_license_post, check_cross_group_allowed


def _seed(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ads_scorecard (
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
    conn.execute("DELETE FROM ads_scorecard")
    conn.execute(
        """
        INSERT INTO ads_scorecard (
            scorecard_id, group_id, entity_id, entity_name, stat_year,
            total_amount, total_count, supplier_count,
            flag_total, flag_high, risk_score, risk_level, cr1, cancel_ratio,
            analysis_batch
        ) VALUES
            ('sc1', 'Y2026', 'ENT-A', '子公司A', 2026, 1000, 10, 3, 2, 1, 72.5, '关注', 0.35, 0.02, 'batch_smoke'),
            ('sc2', 'Y2026', 'ENT-B', '子公司B', 2026, 800, 8, 2, 0, 0, 88.0, '正常', 0.22, 0.01, 'batch_smoke')
        """
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        lic = Path(td) / "license_override.json"
        with patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", lic):
            imported = api_settings_license_post(
                {
                    "license": {"cross_group": True, "expires_at": "2099-12-31"},
                    "actor": "smoke",
                }
            )
            assert imported.get("ok") is True, imported
            assert check_cross_group_allowed() is None

            conn = duckdb.connect(":memory:")
            _seed(conn)
            stat_year = "2026"

            meta = api_compare_meta(conn)
            assert meta.get("ok"), meta
            assert meta.get("scorecard_ready") is True, meta

            rank = api_compare_rank_list(conn, stat_year=stat_year, limit=10)
            assert rank.get("ok"), rank
            assert int(rank.get("total") or 0) == 2, rank
            rows = rank.get("rows") or []
            assert len(rows) == 2, rank
            assert rows[0].get("entity_id") in ("ENT-A", "ENT-B"), rows

            charts = api_compare_charts_series(conn, stat_year=stat_year, metric="amount", limit=5)
            assert charts.get("ok"), charts
            assert len(charts.get("series") or []) >= 1, charts

    print("SMOKE PASS: compare ads")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
