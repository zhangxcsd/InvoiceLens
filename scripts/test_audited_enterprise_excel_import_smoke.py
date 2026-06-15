"""Smoke: 被审企业管理与产权 / 出资股权 Excel 导入（内存 DuckDB）。"""
from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb
import pandas as pd

from db.schema_sqlfiles import init_all_tables
from src.local_api.audited_enterprise_dims import (
    api_contribution_import_excel,
    api_registry_import_excel,
)


def _registry_xlsx() -> bytes:
    cols = [
        "快照年度",
        "统一社会信用代码",
        "企业名称",
        "国家出资企业",
        "管理层级",
        "产权层级",
    ]
    rows = [
        ["2026", "91370000MA01TEST01", "导入测试企业A", "测试集团", "2", "2"],
        ["2026", "", "缺代码企业", "测试集团", "2", "2"],
    ]
    bio = io.BytesIO()
    pd.DataFrame(rows, columns=cols).to_excel(bio, index=False, sheet_name="台账")
    return bio.getvalue()


def _contrib_xlsx() -> bytes:
    cols = ["快照年度", "企业名称", "出资人名称", "股权比例", "认缴金额（万元）"]
    rows = [
        ["2026", "导入测试企业A", "测试股东1", "60", "1000"],
        ["2026", "导入测试企业A", "", "40", "500"],
    ]
    bio = io.BytesIO()
    pd.DataFrame(rows, columns=cols).to_excel(bio, index=False, sheet_name="出资")
    return bio.getvalue()


def main() -> None:
    conn = duckdb.connect()
    init_all_tables(conn)

    reg = api_registry_import_excel(conn, file_bytes=_registry_xlsx(), upload_filename="reg.xlsx")
    assert reg.get("ok") is True
    assert int(reg.get("imported") or 0) == 1
    assert int(reg.get("rejected") or 0) == 1

    contrib = api_contribution_import_excel(conn, file_bytes=_contrib_xlsx(), upload_filename="c.xlsx")
    assert contrib.get("ok") is True
    assert int(contrib.get("imported") or 0) == 1
    assert int(contrib.get("rejected") or 0) == 1

    print("test_audited_enterprise_excel_import_smoke: OK")


if __name__ == "__main__":
    main()
