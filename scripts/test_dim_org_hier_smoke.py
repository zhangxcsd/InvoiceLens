"""Smoke test: dim_org_hier Excel 导入 + 树/对照 API（内存 DuckDB）。"""
from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb
import pandas as pd

from db.schema_sqlfiles import init_all_tables
from src.local_api.dim_org_hier_api import api_org_hier_diff_summary, api_org_hier_rows, api_org_hier_tree
from src.local_api.dim_org_hier_build import import_org_hierarchy_from_excel


def _sample_xlsx() -> bytes:
    header = [
        "entity_id",
        "entity_fullname",
        "entity_shortname",
        "entity_type",
        "sys_id",
        "stat_year",
        "main_business",
        "industry_id",
        "industry_name",
        "is_stat_inc",
        "mg_parent_id",
        "mg_sort_no",
        "eq_parent_id",
        "eq_sort_no",
        "eq_shareholding_ratio",
        "reg_capital",
        "is_active",
        "hier_diff_note",
    ]
    desc = ["统一社会信用代码"] * len(header)
    rows = [
        [
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "省国资委",
            "根节点",
            "PROV_SD",
            "2024",
            "",
            "",
            "",
            "否",
            "ROOT_PROV_SD",
            "0",
            "ROOT_PROV_SD",
            "0",
            "",
            "",
            "是",
            "",
        ],
        [
            "913700001630477270",
            "浪潮集团有限公司",
            "浪潮集团",
            "一级集团",
            "PROV_SD",
            "2024",
            "",
            "",
            "",
            "是",
            "ROOT_PROV_SD",
            "1",
            "ROOT_PROV_SD",
            "1",
            "",
            "",
            "是",
            "",
        ],
        [
            "913700140000000001",
            "浪潮信息技术股份有限公司",
            "浪潮信息",
            "二级及以下",
            "PROV_SD",
            "2024",
            "",
            "",
            "",
            "是",
            "913700001630477270",
            "1",
            "913700001630477270",
            "1",
            "0.51",
            "",
            "是",
            "",
        ],
    ]
    bio = io.BytesIO()
    with pd.ExcelWriter(bio, engine="openpyxl") as writer:
        pd.DataFrame([header, desc, *rows]).to_excel(writer, index=False, header=False)
    return bio.getvalue()


def main() -> None:
    conn = duckdb.connect(":memory:")
    init_all_tables(conn)

    dry = import_org_hierarchy_from_excel(conn, file_bytes=_sample_xlsx(), upload_filename="org.xlsx", dry_run=True)
    assert dry.get("ok"), dry
    assert int(dry.get("row_count") or 0) == 3, dry

    imp = import_org_hierarchy_from_excel(conn, file_bytes=_sample_xlsx(), upload_filename="org.xlsx")
    assert imp.get("ok"), imp
    assert int(imp.get("success") or 0) == 3, imp

    cnt = conn.execute("SELECT COUNT(*) FROM dim_org_hier WHERE stat_year = 2024").fetchone()[0]
    assert int(cnt) == 3

    tree = api_org_hier_tree(conn, stat_year="2024", tree="mg")
    assert tree.get("ok"), tree
    assert len(tree.get("nodes") or []) >= 1

    rows = api_org_hier_rows(conn, stat_year="2024", page=1, page_size=20)
    assert rows.get("ok"), rows
    assert int(rows.get("total") or 0) == 3

    summary = api_org_hier_diff_summary(conn, stat_year="2024")
    assert summary.get("ok"), summary
    assert int(summary["kpis"]["total"]) == 3

    # 导入 2025 并改管理上级 → 应写 dim_org_hier_log
    rows_2025 = [
        [
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "省国资委",
            "根节点",
            "PROV_SD",
            "2025",
            "",
            "",
            "",
            "否",
            "ROOT_PROV_SD",
            "0",
            "ROOT_PROV_SD",
            "0",
            "",
            "",
            "是",
            "",
        ],
        [
            "913700001630477270",
            "浪潮集团有限公司",
            "浪潮集团",
            "一级集团",
            "PROV_SD",
            "2025",
            "",
            "",
            "",
            "是",
            "ROOT_PROV_SD",
            "1",
            "ROOT_PROV_SD",
            "1",
            "",
            "",
            "是",
            "",
        ],
        [
            "913700140000000001",
            "浪潮信息技术股份有限公司",
            "浪潮信息",
            "二级及以下",
            "PROV_SD",
            "2025",
            "",
            "",
            "",
            "是",
            "ROOT_PROV_SD",
            "1",
            "913700001630477270",
            "1",
            "0.51",
            "",
            "是",
            "管理口径调整",
        ],
    ]
    bio2 = io.BytesIO()
    header = [
        "entity_id",
        "entity_fullname",
        "entity_shortname",
        "entity_type",
        "sys_id",
        "stat_year",
        "main_business",
        "industry_id",
        "industry_name",
        "is_stat_inc",
        "mg_parent_id",
        "mg_sort_no",
        "eq_parent_id",
        "eq_sort_no",
        "eq_shareholding_ratio",
        "reg_capital",
        "is_active",
        "hier_diff_note",
    ]
    with pd.ExcelWriter(bio2, engine="openpyxl") as writer:
        pd.DataFrame([header, header, *rows_2025]).to_excel(writer, index=False, header=False)
    imp2 = import_org_hierarchy_from_excel(conn, file_bytes=bio2.getvalue(), upload_filename="org2025.xlsx")
    assert imp2.get("ok"), imp2
    log_cnt = conn.execute(
        "SELECT COUNT(*) FROM dim_org_hier_log WHERE stat_year = 2025 AND entity_id = '913700140000000001'"
    ).fetchone()[0]
    assert int(log_cnt) >= 1

    print("ok", "rows=", cnt, "log=", log_cnt)


if __name__ == "__main__":
    main()
