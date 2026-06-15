"""Smoke: 年度口径版本 list / draft / publish API。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.dim_caliber_version_api import (
    api_dim_caliber_version_create_draft,
    api_dim_caliber_version_publish,
    api_dim_caliber_versions_list,
    compute_live_kpis,
)


def main() -> None:
    conn = duckdb.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE dim_subject_master (
            subject_id VARCHAR PRIMARY KEY,
            subject_name VARCHAR,
            subject_category VARCHAR,
            subject_no VARCHAR,
            first_source_system VARCHAR,
            first_import_batch_id VARCHAR,
            last_import_batch_id VARCHAR,
            category_rule_version VARCHAR
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE dwd_inv_header (
            stat_year SMALLINT,
            xfsbh VARCHAR,
            gfsbh VARCHAR,
            import_batch_id VARCHAR
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE dim_enterprise_year_roster (
            stat_year SMALLINT,
            enterprise_id VARCHAR,
            subject_id VARCHAR
        )
        """
    )
    conn.execute(
        """
        INSERT INTO dim_subject_master VALUES
          ('s1', '企业A', 'org', '91330100123456789X', 'invoice', 'b1', 'b2', 'rv1'),
          ('s2', '个人B', 'person', '110101199001011234', 'invoice', 'b1', 'b1', 'rv1')
        """
    )
    conn.execute(
        """
        INSERT INTO dwd_inv_header VALUES
          (2026, '91330100123456789X', '91330100987654321Y', '20260401_A01'),
          (2026, '91330100123456789X', '91330100987654321Y', '20260420_A03')
        """
    )
    conn.execute(
        """
        INSERT INTO dim_enterprise_year_roster VALUES
          (2026, '91330100123456789X', 's1'),
          (2026, '91330100987654321Y', NULL)
        """
    )

    kpis = compute_live_kpis(conn, 2026)
    assert kpis["subjectTotal"] >= 1
    assert "mappingCoverage" in kpis

    listed = api_dim_caliber_versions_list(conn)
    assert listed.get("ok"), listed
    versions = listed.get("versions") or []
    assert len(versions) >= 1
    v1 = versions[0]
    assert v1["status"] == "published"
    assert v1["isCurrent"] is True

    draft = api_dim_caliber_version_create_draft(conn, {"stat_year": 2026})
    assert draft.get("ok"), draft
    draft_id = draft["version"]["id"]
    assert draft["version"]["status"] == "draft"

    pub = api_dim_caliber_version_publish(conn, {"version_id": draft_id})
    assert pub.get("ok"), pub
    assert pub["version"]["status"] == "published"
    assert pub["version"]["isCurrent"] is True

    listed2 = api_dim_caliber_versions_list(conn)
    current = [v for v in listed2["versions"] if v["statYear"] == "2026" and v["isCurrent"]]
    assert len(current) == 1
    assert current[0]["id"] == draft_id

    print("OK: dim caliber version smoke passed")


if __name__ == "__main__":
    main()
