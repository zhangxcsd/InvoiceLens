"""Smoke: 被审主体关系树 / 管产关系清单 API（含 >500 行台账分页一致性）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import ensure_audited_enterprise_registry_table, init_all_tables
from src.local_api.audited_enterprise_dims import (
    api_registry_bootstrap_demo,
    api_registry_list,
    fetch_all_registry_rows,
)
from src.local_api.audited_enterprise_relation_api import (
    api_audited_enterprise_relation_rows,
    api_audited_enterprise_relation_tree,
)

_SMOKE_ROW_PREFIX = "smoke_bulk_reg_"
_BULK_YEAR = 2026
_BULK_COUNT = 520
_CHUNK = 500


def _ensure_registry(conn) -> None:
    ensure_audited_enterprise_registry_table(conn)
    reg = api_registry_list(conn, snapshot_year="2026", limit=1, offset=0)
    if not reg.get("rows"):
        boot = api_registry_bootstrap_demo(conn)
        assert boot.get("ok"), boot


def _seed_bulk_registry(conn, *, count: int, year: int = _BULK_YEAR) -> int:
    """写入 count 条合成台账行（row_id 前缀 smoke_bulk_reg_，便于隔离）。"""
    ensure_audited_enterprise_registry_table(conn)
    conn.execute(f"DELETE FROM dim_audited_enterprise_registry WHERE row_id LIKE '{_SMOKE_ROW_PREFIX}%'")
    rows: list[tuple] = []
    for i in range(count):
        rows.append(
            (
                f"{_SMOKE_ROW_PREFIX}{i}",
                year,
                f"91330100SMOKE{i:06d}",
                f"SmokeTestCorp{i:04d}",
                "境内",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "测试国资",
                2,
                "SmokeParent",
                2,
                "SmokeParent（100%）",
            )
        )
    conn.executemany(
        """
        INSERT INTO dim_audited_enterprise_registry (
            row_id, snapshot_year, unified_social_credit_code, enterprise_name,
            domestic_overseas, detail_address, currency, registered_capital,
            registration_date, national_economy_industry_major, enterprise_category,
            sasac_authority, sasac_relation, consolidated_reporting, listed_company,
            main_business, state_investor, mgmt_level, mgmt_parent, equity_level, shareholders
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        rows,
    )
    return int(
        conn.execute(
            "SELECT COUNT(*) FROM dim_audited_enterprise_registry WHERE snapshot_year = ?",
            [year],
        ).fetchone()[0]
        or 0
    )


def _count_tree_nodes(nodes: list[dict]) -> int:
    total = 0
    for node in nodes:
        total += 1
        total += _count_tree_nodes(node.get("children") or [])
    return total


def _simulate_frontend_registry_merge(conn, *, chunk: int = _CHUNK) -> list[dict]:
    """
    复刻 frontend/src/dim/auditedEnterpriseRegistryHelpers.ts 中
    fetchAllAuditedEnterpriseRegistryRows 的分页合并逻辑，用于离线校验。
    """

    def fetch_registry(params: dict) -> dict:
        return api_registry_list(
            conn,
            snapshot_year=params["snapshotYear"],
            limit=int(params.get("limit") or chunk),
            offset=int(params.get("offset") or 0),
            include_years=bool(params.get("includeYears")),
        )

    first = fetch_registry({"snapshotYear": "2026", "limit": chunk, "offset": 0, "includeYears": True})
    assert first.get("ok"), first
    years = first.get("snapshot_years") or [first.get("selected_year") or "2026"]
    merged: list[dict] = []

    def fetch_year_all(year: str, seed: dict | None = None) -> None:
        initial = seed or fetch_registry(
            {"snapshotYear": year, "limit": chunk, "offset": 0, "includeYears": False}
        )
        assert initial.get("ok"), initial
        total = int(initial.get("total") or len(initial.get("rows") or []))
        rows = list(initial.get("rows") or [])
        offset = len(rows)
        while offset < total:
            part = fetch_registry(
                {"snapshotYear": year, "limit": chunk, "offset": offset, "includeYears": False}
            )
            assert part.get("ok"), part
            rows.extend(part.get("rows") or [])
            offset += chunk
        merged.extend(rows)

    anchor = str(first.get("selected_year") or years[0])
    for year in years:
        fetch_year_all(year, first if year == anchor else None)
    return merged


def _assert_no_duplicate_row_ids(rows: list[dict]) -> None:
    ids = [str(r.get("rowId") or "") for r in rows]
    assert len(ids) == len(set(ids)), f"duplicate rowId in merged rows: {len(ids) - len(set(ids))}"


def _run_basic_smoke(conn) -> None:
    tree_mgmt = api_audited_enterprise_relation_tree(conn, snapshot_year="2026", mode="management")
    assert tree_mgmt.get("ok"), tree_mgmt
    assert "nodes" in tree_mgmt
    assert isinstance(tree_mgmt["nodes"], list)
    if tree_mgmt["nodes"]:
        root = tree_mgmt["nodes"][0]
        assert "id" in root and "name" in root and "children" in root
        assert "registry" in root
        assert "enrichment" in root

    tree_eq = api_audited_enterprise_relation_tree(conn, snapshot_year="2026", mode="equity")
    assert tree_eq.get("ok"), tree_eq

    rows = api_audited_enterprise_relation_rows(
        conn,
        snapshot_year="2026",
        page=1,
        page_size=20,
        sort="name_asc",
    )
    assert rows.get("ok"), rows
    assert "kpis" in rows
    kpis = rows["kpis"]
    assert "total" in kpis and "relation_mismatch" in kpis
    assert "mapped" in kpis and "unmapped" in kpis and "in_analysis_pool" in kpis
    assert rows.get("total", 0) >= len(rows.get("rows") or [])
    if rows.get("rows"):
        row0 = rows["rows"][0]
        for key in (
            "name",
            "mgmt_path",
            "equity_path",
            "relation_type",
            "match_status",
            "in_roster",
        ):
            assert key in row0, f"missing {key} in row"


def _run_bulk_pagination_smoke(conn, *, ledger_count: int) -> None:
    db_total = _seed_bulk_registry(conn, count=ledger_count)
    assert db_total == ledger_count, f"seed count mismatch: {db_total} != {ledger_count}"

    page1 = api_registry_list(conn, snapshot_year=str(_BULK_YEAR), limit=_CHUNK, offset=0)
    assert page1.get("ok"), page1
    assert page1["total"] == ledger_count
    assert len(page1["rows"]) == min(_CHUNK, ledger_count)

    if ledger_count > _CHUNK:
        page2 = api_registry_list(
            conn, snapshot_year=str(_BULK_YEAR), limit=_CHUNK, offset=_CHUNK
        )
        assert page2.get("ok"), page2
        assert page2["total"] == ledger_count
        assert len(page2["rows"]) == min(_CHUNK, ledger_count - _CHUNK)
        if ledger_count > _CHUNK * 2:
            page3 = api_registry_list(
                conn, snapshot_year=str(_BULK_YEAR), limit=_CHUNK, offset=_CHUNK * 2
            )
            assert page3.get("ok"), page3
            assert len(page3["rows"]) == ledger_count - _CHUNK * 2

    full = fetch_all_registry_rows(
        conn, snapshot_year=str(_BULK_YEAR), include_years=False, chunk_size=_CHUNK
    )
    assert full.get("ok"), full
    assert full["total"] == ledger_count
    assert len(full["rows"]) == ledger_count
    _assert_no_duplicate_row_ids(full["rows"])

    frontend_merged = _simulate_frontend_registry_merge(conn, chunk=_CHUNK)
    assert len(frontend_merged) == ledger_count, (
        f"frontend merge got {len(frontend_merged)}, expected {ledger_count}"
    )
    _assert_no_duplicate_row_ids(frontend_merged)

    rel = api_audited_enterprise_relation_rows(
        conn,
        snapshot_year=str(_BULK_YEAR),
        page=1,
        page_size=50,
    )
    assert rel.get("ok"), rel
    assert rel["total"] == ledger_count
    assert rel["kpis"]["total"] == ledger_count
    assert rel["kpis"]["mapped"] + rel["kpis"]["unmapped"] <= ledger_count

    last_page = (ledger_count + 49) // 50
    rel_last = api_audited_enterprise_relation_rows(
        conn,
        snapshot_year=str(_BULK_YEAR),
        page=last_page,
        page_size=50,
    )
    assert rel_last.get("ok"), rel_last
    expected_last = ledger_count - (last_page - 1) * 50
    assert len(rel_last["rows"]) == expected_last

    tree_mgmt = api_audited_enterprise_relation_tree(
        conn, snapshot_year=str(_BULK_YEAR), mode="management"
    )
    assert tree_mgmt.get("ok"), tree_mgmt
    assert _count_tree_nodes(tree_mgmt["nodes"]) == ledger_count

    tree_eq = api_audited_enterprise_relation_tree(
        conn, snapshot_year=str(_BULK_YEAR), mode="equity"
    )
    assert tree_eq.get("ok"), tree_eq
    assert _count_tree_nodes(tree_eq["nodes"]) == ledger_count


def main() -> None:
    conn = get_conn()
    init_all_tables(conn)
    _ensure_registry(conn)
    _run_basic_smoke(conn)

    mem_conn = duckdb.connect(":memory:")
    init_all_tables(mem_conn, force=True)
    _run_bulk_pagination_smoke(mem_conn, ledger_count=_BULK_COUNT)
    _run_bulk_pagination_smoke(mem_conn, ledger_count=1005)

    print(
        f"OK: relation tree + relation-rows smoke passed "
        f"(basic + bulk {_BULK_COUNT} + bulk 1005 pagination)"
    )


if __name__ == "__main__":
    main()
