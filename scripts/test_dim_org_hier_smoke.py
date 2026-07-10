"""Smoke test: dim_org_hier Excel 导入 + 树/对照 API（内存 DuckDB）。"""
from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb
import pandas as pd

from db.schema_sqlfiles import init_all_tables
from src.local_api.dim_org_hier_api import (
    api_org_hier_diff_summary,
    api_org_hier_rows,
    api_org_hier_template_download,
    api_org_hier_tree,
)
from src.local_api.dim_org_hier_build import generate_org_hier_import_template, import_org_hierarchy_from_excel


def _seed_prov_sd(conn) -> None:
    conn.execute(
        """
        INSERT INTO dim_org_sys (sys_id, sys_name, admin_level, gov_owner, description, sort_no, is_active)
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
        ON CONFLICT (sys_id) DO NOTHING
        """,
        ["PROV_SD", "山东省属企业", "省", "山东省国有资产监督管理委员会", "山东省省属国有企业，由省国资委统一监管", 1],
    )


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
        "state_investor_id",
        "state_investor_name",
        "mg_parent_id",
        "mg_parent_name",
        "mg_sort_no",
        "eq_parent_id",
        "eq_parent_name",
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
            "其他",
            "PROV_SD",
            "2024",
            "",
            "",
            "",
            "否",
            "",
            "",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "0",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
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
            "有限责任公司",
            "PROV_SD",
            "2024",
            "",
            "",
            "",
            "是",
            "913700001630477270",
            "浪潮集团有限公司",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "1",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
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
            "股份有限公司",
            "PROV_SD",
            "2024",
            "",
            "",
            "",
            "是",
            "913700001630477270",
            "浪潮集团有限公司",
            "913700001630477270",
            "浪潮集团有限公司",
            "1",
            "913700001630477270",
            "浪潮集团有限公司",
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
    _seed_prov_sd(conn)

    tpl_bytes, tpl_name = generate_org_hier_import_template(conn)
    assert tpl_bytes and tpl_name.endswith(".xlsx"), tpl_name
    tpl_status, tpl_body, _, _ = api_org_hier_template_download(conn)
    assert tpl_status == 200 and isinstance(tpl_body, bytes) and len(tpl_body) > 100

    dry = import_org_hierarchy_from_excel(conn, file_bytes=_sample_xlsx(), upload_filename="org.xlsx", dry_run=True)
    assert dry.get("ok"), dry
    assert int(dry.get("row_count") or 0) == 3, dry

    imp = import_org_hierarchy_from_excel(conn, file_bytes=_sample_xlsx(), upload_filename="org.xlsx")
    assert imp.get("ok"), imp
    assert int(imp.get("success") or 0) == 3, imp

    cnt = conn.execute("SELECT COUNT(*) FROM dim_org_hier WHERE stat_year = 2024").fetchone()[0]
    assert int(cnt) == 3

    si = conn.execute(
        """
        SELECT state_investor_id, state_investor_name
        FROM dim_org_hier
        WHERE entity_id = '913700140000000001' AND stat_year = 2024
        """
    ).fetchone()
    assert si[0] == "913700001630477270"
    assert si[1] == "浪潮集团有限公司"

    tree = api_org_hier_tree(conn, stat_year="2024", tree="mg")
    assert tree.get("ok"), tree
    assert len(tree.get("nodes") or []) >= 1

    rows = api_org_hier_rows(conn, stat_year="2024", page=1, page_size=20)
    assert rows.get("ok"), rows
    assert int(rows.get("total") or 0) == 3
    sub_row = next(r for r in rows["rows"] if r["code"] == "913700140000000001")
    assert sub_row["state_investor_enterprise"] == "浪潮集团有限公司"

    summary = api_org_hier_diff_summary(conn, stat_year="2024")
    assert summary.get("ok"), summary
    assert int(summary["kpis"]["total"]) == 3

    # 导入 2025 并改管理上级 → 应写 dim_org_hier_log
    rows_2025 = [
        [
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "省国资委",
            "其他",
            "PROV_SD",
            "2025",
            "",
            "",
            "",
            "否",
            "",
            "",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "0",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
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
            "有限责任公司",
            "PROV_SD",
            "2025",
            "",
            "",
            "",
            "是",
            "913700001630477270",
            "浪潮集团有限公司",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "1",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
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
            "股份有限公司",
            "PROV_SD",
            "2025",
            "",
            "",
            "",
            "是",
            "913700001630477270",
            "浪潮集团有限公司",
            "ROOT_PROV_SD",
            "山东省国有资产监督管理委员会",
            "1",
            "913700001630477270",
            "浪潮集团有限公司",
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
        "state_investor_id",
        "state_investor_name",
        "mg_parent_id",
        "mg_parent_name",
        "mg_sort_no",
        "eq_parent_id",
        "eq_parent_name",
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

    # 旧版 20 列模板（无国家出资企业列）仍可导入并自动推断
    legacy_header = [c for c in header if c not in ("state_investor_id", "state_investor_name")]
    skip = {i for i, c in enumerate(header) if c in ("state_investor_id", "state_investor_name")}
    legacy_rows = [[v for i, v in enumerate(row) if i not in skip] for row in rows_2025]
    bio_legacy = io.BytesIO()
    with pd.ExcelWriter(bio_legacy, engine="openpyxl") as writer:
        pd.DataFrame([legacy_header, legacy_header, *legacy_rows]).to_excel(writer, index=False, header=False)
    legacy = import_org_hierarchy_from_excel(
        conn, file_bytes=bio_legacy.getvalue(), upload_filename="legacy.xlsx", dry_run=True
    )
    assert legacy.get("ok"), legacy

    print("ok", "rows=", cnt, "log=", log_cnt, "legacy=", legacy.get("row_count"))


if __name__ == "__main__":
    main()
