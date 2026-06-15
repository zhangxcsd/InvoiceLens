"""Smoke test: 花名册增量同步 + 人工维护（内存 DuckDB）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_list
from src.local_api.enterprise_year_roster_build import (
    ensure_enterprise_year_roster_schema,
    rebuild_enterprise_year_roster_from_registry,
)
from src.local_api.enterprise_year_roster_manual import api_enterprise_year_roster_manual_upsert


def main() -> None:
    conn = duckdb.connect(":memory:")
    ensure_enterprise_year_roster_schema(conn)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dim_audited_enterprise_registry (
            row_id VARCHAR,
            snapshot_year SMALLINT,
            unified_social_credit_code VARCHAR,
            enterprise_name VARCHAR,
            state_investor VARCHAR,
            PRIMARY KEY (snapshot_year, unified_social_credit_code)
        )
        """
    )
    conn.execute(
        "INSERT INTO dim_audited_enterprise_registry VALUES ('r1', 2025, 'SOE001', '国家出资A', '国家出资A')"
    )
    conn.execute(
        "INSERT INTO dim_audited_enterprise_registry VALUES ('r2', 2025, 'MEM001', '成员企业1', '国家出资A')"
    )

    manual = api_enterprise_year_roster_manual_upsert(
        conn,
        {
            "stat_year": 2025,
            "enterprise_id": "MEM999",
            "enterprise_name": "人工企业",
            "state_investor": "国家出资A",
            "state_investor_unified_credit_code": "SOE001",
        },
    )
    assert manual.get("ok"), manual

    sync = rebuild_enterprise_year_roster_from_registry(
        conn, stat_years=[2025], chain_rel_rebuild=False
    )
    assert sync.get("ok"), sync

    manual_cnt = conn.execute(
        "SELECT COUNT(*) FROM dim_enterprise_year_roster WHERE enterprise_id = 'MEM999'"
    ).fetchone()[0]
    assert int(manual_cnt) == 1, "仅人工行应在同步后保留"

    lst = api_enterprise_year_roster_list(conn, stat_year="2025", limit=100)
    assert lst.get("ok"), lst
    assert int(lst.get("total") or 0) >= 2
    row = next(x for x in lst["rows"] if x["enterprise_id"] == "MEM999")
    assert row["in_manual"] and row["data_source"] == "manual"
    print("ok", "total=", lst["total"])


if __name__ == "__main__":
    main()
