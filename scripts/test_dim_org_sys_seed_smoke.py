"""Smoke test: dim_org_sys 补全缺失初始模板（不覆盖已有 PROV_SD）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from db.schema_sqlfiles import init_all_tables
from src.local_api.dim_org_sys_api import (
    _DEFAULT_TEMPLATES,
    api_org_sys_bootstrap_demo,
    api_org_sys_delete,
    api_org_sys_list,
)


def test_seed_missing_when_prov_sd_exists() -> None:
    conn = duckdb.connect(":memory:")
    init_all_tables(conn, force=True)
    conn.execute(
        """
        INSERT INTO dim_org_sys (sys_id, sys_name, admin_level, gov_owner, description, sort_no, is_active)
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
        """,
        [
            "PROV_SD",
            "山东省属企业",
            "省",
            "山东省国有资产监督管理委员会",
            "山东省省属国有企业，由省国资委统一监管",
            1,
        ],
    )

    listed = api_org_sys_list(conn)
    assert listed["ok"] is True
    assert len(listed["items"]) == 1
    assert listed["items"][0]["sys_id"] == "PROV_SD"

    boot = api_org_sys_bootstrap_demo(conn)
    assert boot["ok"] is True
    assert boot["seeded_count"] == len(_DEFAULT_TEMPLATES)
    assert boot["seeded_count"] == 6

    items = boot["items"] or []
    assert len(items) == 7
    seeded_ids = {row["sys_id"] for row in items if row["sys_id"] != "PROV_SD"}
    expected_ids = {tpl[0] for tpl in _DEFAULT_TEMPLATES}
    assert seeded_ids == expected_ids

    prov_sd = next(row for row in items if row["sys_id"] == "PROV_SD")
    assert prov_sd["is_active"] is True
    assert prov_sd["sys_name"] == "山东省属企业"

    for tpl_id in expected_ids:
        row = next(r for r in items if r["sys_id"] == tpl_id)
        assert row["is_active"] is False, tpl_id

    again = api_org_sys_bootstrap_demo(conn)
    assert again["ok"] is True
    assert again["seeded_count"] == 0


def test_list_does_not_auto_seed_when_empty() -> None:
    conn = duckdb.connect(":memory:")
    init_all_tables(conn, force=True)
    listed = api_org_sys_list(conn)
    assert listed["ok"] is True
    assert len(listed["items"]) == 0


def test_delete_unreferenced_prov_sd() -> None:
    conn = duckdb.connect(":memory:")
    init_all_tables(conn, force=True)
    conn.execute(
        """
        INSERT INTO dim_org_sys (sys_id, sys_name, admin_level, gov_owner, description, sort_no, is_active)
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
        """,
        ["PROV_SD", "山东省属企业", "省", "山东省国资委", "说明", 1],
    )
    deleted = api_org_sys_delete(conn, {"sys_id": "PROV_SD"})
    assert deleted["ok"] is True
    assert deleted.get("deleted") is True

    listed = api_org_sys_list(conn)
    assert listed["ok"] is True
    assert len(listed["items"]) == 0


def test_delete_prov_sd_with_only_virtual_root() -> None:
    """仅存在 ROOT_{sys_id} 虚拟根节点时，引用数应为 0，可物理删除。"""
    conn = duckdb.connect(":memory:")
    init_all_tables(conn, force=True)
    conn.execute(
        """
        INSERT INTO dim_org_sys (sys_id, sys_name, admin_level, gov_owner, description, sort_no, is_active)
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
        """,
        ["PROV_SD", "山东省属企业", "省", "山东省国资委", "说明", 1],
    )
    conn.execute(
        """
        INSERT INTO dim_org_node (
            entity_id, sys_id, entity_fullname, entity_shortname, entity_type, is_stat_inc, is_active
        ) VALUES (?, ?, ?, ?, ?, FALSE, TRUE)
        """,
        ["ROOT_PROV_SD", "PROV_SD", "山东省国有资产监督管理委员会", "省国资委", "根节点"],
    )

    listed = api_org_sys_list(conn)
    assert listed["ok"] is True
    prov = next(row for row in listed["items"] if row["sys_id"] == "PROV_SD")
    assert prov["node_count"] == 0
    assert prov["hier_count"] == 0

    deleted = api_org_sys_delete(conn, {"sys_id": "PROV_SD"})
    assert deleted["ok"] is True
    assert deleted.get("deleted") is True
    assert not deleted.get("deactivated")

    assert conn.execute("SELECT COUNT(*) FROM dim_org_sys WHERE sys_id = 'PROV_SD'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM dim_org_node WHERE sys_id = 'PROV_SD'").fetchone()[0] == 0


def main() -> None:
    test_seed_missing_when_prov_sd_exists()
    test_list_does_not_auto_seed_when_empty()
    test_delete_unreferenced_prov_sd()
    test_delete_prov_sd_with_only_virtual_root()
    print("dim_org_sys_seed_smoke: OK")


if __name__ == "__main__":
    main()
