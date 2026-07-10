"""Smoke: 台账写入后自动同步集团成员表与 dim_org_hier 物化。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db.schema_sqlfiles import init_all_tables
from src.local_api.audited_enterprise_dims import (
    api_registry_bootstrap_demo,
    api_registry_update_hierarchy,
)
from src.local_api.registry_derivative_sync import sync_registry_derivatives

import duckdb


def _mem_conn():
    conn = duckdb.connect(":memory:")
    init_all_tables(conn)
    conn.execute(
        """
        INSERT INTO dim_org_sys (sys_id, sys_name, admin_level, gov_owner, description, sort_no, is_active)
        VALUES ('PROV_SD', '山东省属企业', '省', '山东省国资委', '测试监管体系', 1, TRUE)
        ON CONFLICT (sys_id) DO NOTHING
        """
    )
    return conn


if __name__ == "__main__":
    conn = _mem_conn()
    boot = api_registry_bootstrap_demo(conn)
    assert boot.get("ok"), boot
    assert int(boot.get("roster_rows_written") or 0) > 0, boot
    assert int(boot.get("org_hier_rows_written") or 0) > 0, boot
    gy = conn.execute("SELECT COUNT(*) FROM dim_group_enterprise_year WHERE stat_year = 2026").fetchone()[0]
    oh = conn.execute("SELECT COUNT(*) FROM dim_org_hier WHERE stat_year = 2026").fetchone()[0]
    assert gy > 0 and oh > 0
    print("bootstrap_sync ok", {"group_year": gy, "org_hier": oh})

    row = conn.execute(
        """
        SELECT row_id, enterprise_name, mgmt_parent
        FROM dim_audited_enterprise_registry
        WHERE snapshot_year = 2026 AND trim(COALESCE(mgmt_parent, '')) <> ''
        LIMIT 1
        """
    ).fetchone()
    assert row
    row_id, ename, old_parent = str(row[0]), str(row[1]), str(row[2])
    upd = api_registry_update_hierarchy(conn, {"rowId": row_id, "mode": "management", "parentName": old_parent})
    assert upd.get("ok"), upd
    new_parent = "华能示范集团有限公司"
    upd2 = api_registry_update_hierarchy(conn, {"rowId": row_id, "mode": "management", "parentName": new_parent})
    assert upd2.get("ok"), upd2
    mgmt_parent = conn.execute(
        "SELECT mgmt_parent FROM dim_audited_enterprise_registry WHERE row_id = ?",
        [row_id],
    ).fetchone()[0]
    assert str(mgmt_parent) == new_parent
    print("hierarchy_update ok", {"entity": ename, "mgmt_parent": mgmt_parent})

    p1 = sync_registry_derivatives(conn, stat_years=[2026], replace_years=True)
    p2 = sync_registry_derivatives(conn, stat_years=[2026], replace_years=True)
    assert p1.get("ok") and p2.get("ok")
    cnt = conn.execute("SELECT COUNT(*) FROM dim_org_hier WHERE stat_year = 2026").fetchone()[0]
    assert cnt > 0
    print("idempotent_sync ok", {"org_hier_rows": cnt})
    print("ALL OK")
