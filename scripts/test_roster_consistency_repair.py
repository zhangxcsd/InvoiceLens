"""CI smoke: 花名册 data_source 修复 + 一致性 SQL 脚本结构校验。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from src.local_api.enterprise_year_roster_build import ensure_enterprise_year_roster_schema
from src.local_api.enterprise_year_roster_store import repair_roster_data_source

_REQUIRED_CHECK_IDS = frozenset(
    {
        "roster_row_count",
        "roster_member_missing_rel",
        "rel_outside_roster",
        "coverage_denominator_mismatch",
        "roster_quality_conflict",
        "orphan_no_source",
        "data_source_mismatch",
        "manual_only_with_registry_id",
    }
)


def _assert_sql_script_structure() -> None:
    sql_path = Path(__file__).resolve().parents[1] / "scripts" / "check_enterprise_year_roster_consistency.sql"
    assert sql_path.is_file(), f"missing consistency SQL: {sql_path}"
    text = sql_path.read_text(encoding="utf-8")
    for check_id in _REQUIRED_CHECK_IDS:
        assert check_id in text, f"check_id missing in SQL script: {check_id}"


def _assert_repair_fixes_mismatch() -> None:
    conn = duckdb.connect(":memory:")
    ensure_enterprise_year_roster_schema(conn)
    conn.execute(
        """
        INSERT INTO dim_enterprise_year_roster (
            stat_year, enterprise_id, enterprise_name,
            state_investor, is_member, data_source, in_registry, in_manual
        ) VALUES (2024, 'ENT001', '测试企业', '出资A', TRUE, 'manual', TRUE, FALSE)
        """
    )
    mismatch = conn.execute(
        """
        SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_roster
        WHERE data_source IS DISTINCT FROM (
            CASE
                WHEN COALESCE(in_registry, FALSE) AND COALESCE(in_manual, FALSE) THEN 'registry+manual'
                WHEN COALESCE(in_registry, FALSE) THEN 'registry'
                WHEN COALESCE(in_manual, FALSE) THEN 'manual'
                ELSE NULL
            END
        )
        """
    ).fetchone()[0]
    assert int(mismatch) == 1

    repaired = repair_roster_data_source(conn, stat_year=2024)
    assert repaired == 1

    fixed = conn.execute(
        "SELECT data_source FROM dim_enterprise_year_roster WHERE enterprise_id = 'ENT001'"
    ).fetchone()[0]
    assert str(fixed) == "registry"

    again = repair_roster_data_source(conn, stat_year=2024)
    assert again == 0


def main() -> None:
    _assert_sql_script_structure()
    _assert_repair_fixes_mismatch()
    print("ok roster consistency repair smoke")


if __name__ == "__main__":
    main()
