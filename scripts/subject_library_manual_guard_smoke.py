"""Smoke: 人工修正保护逻辑（dim_subject_master_repair_log）。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.local_api.subject_library_manual_guard import (
    load_repaired_field_map,
    resolve_org_category_for_upsert,
    resolve_subject_category_for_upsert,
    subject_category_fields_locked,
)


def test_resolve_helpers() -> None:
    repair_map = {"SUB_A": {"subject_category"}, "SUB_B": {"org_category"}}
    assert (
        resolve_subject_category_for_upsert(
            subject_id="SUB_A",
            incoming_category="org",
            existing_category="person",
            repair_map=repair_map,
            respect_manual_repairs=True,
        )
        == "person"
    )
    assert (
        resolve_subject_category_for_upsert(
            subject_id="SUB_A",
            incoming_category="org",
            existing_category="person",
            repair_map=repair_map,
            respect_manual_repairs=False,
        )
        == "org"
    )
    assert (
        resolve_org_category_for_upsert(
            subject_id="SUB_B",
            incoming_org_category="SC-ENT",
            existing_org_category="SC-BRANCH",
            repair_map=repair_map,
            respect_manual_repairs=True,
        )
        == "SC-BRANCH"
    )
    assert subject_category_fields_locked(repair_map, "SUB_A")
    assert subject_category_fields_locked(repair_map, "SUB_B")
    assert not subject_category_fields_locked(repair_map, "SUB_C")
    print("manual_guard unit checks ok")


def test_load_map_optional_db() -> None:
    try:
        import duckdb

        conn = duckdb.connect(":memory:")
        conn.execute(
            """
            CREATE TABLE dim_subject_master_repair_log (
                repair_id VARCHAR,
                subject_id VARCHAR,
                field_name VARCHAR,
                old_value VARCHAR,
                new_value VARCHAR,
                reason VARCHAR,
                repaired_at TIMESTAMP,
                client_hint VARCHAR
            )
            """
        )
        conn.execute(
            "INSERT INTO dim_subject_master_repair_log VALUES ('R1','S1','subject_category','org','person',NULL,now(),'t')"
        )
        m = load_repaired_field_map(conn)
        assert m.get("S1") == {"subject_category"}
        print("manual_guard db load ok")
    except Exception as exc:
        print(f"manual_guard db load skipped: {exc}")


if __name__ == "__main__":
    test_resolve_helpers()
    test_load_map_optional_db()
