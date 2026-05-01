"""一次性冒烟：ODS 占位视图修复 + run_cleaner（仓库根目录：python scripts/_smoke_dwd_ods_views.py）"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import (
    _ods_inv_core_view_needs_parquet_mount,
    ensure_ods_inv_views_materialized,
    force_remount_ods_inv_core_views,
    init_all_tables,
)
from src.etl.cleaner import run_cleaner


def main() -> None:
    c = get_conn()
    init_all_tables(c)
    print("after init:")
    for vn in ("ods_inv_header", "ods_inv_detail"):
        print(f"  {vn} broken={_ods_inv_core_view_needs_parquet_mount(c, vn)}")

    ensure_ods_inv_views_materialized(c)
    print("ensure: ok")

    # 模拟占位视图
    c.execute(
        "CREATE OR REPLACE VIEW ods_inv_header AS "
        "SELECT NULL::VARCHAR AS __placeholder__ WHERE FALSE"
    )
    print(
        "simulated placeholder ods_inv_header broken=",
        _ods_inv_core_view_needs_parquet_mount(c, "ods_inv_header"),
    )
    force_remount_ods_inv_core_views(c)
    ensure_ods_inv_views_materialized(c)
    print(
        "after force_remount ods_inv_header broken=",
        _ods_inv_core_view_needs_parquet_mount(c, "ods_inv_header"),
    )

    r = c.execute("SELECT import_batch_id FROM ods_load_log LIMIT 1").fetchone()
    if not r:
        print("no ods_load_log row, skip run_cleaner")
        return
    bid = str(r[0])
    print("sample batch", bid)
    out = run_cleaner(stat_year=2021, import_batch_id=bid, import_session_ids=None)
    print("run_cleaner status=", out.get("status"), "written hdr=", out.get("rows_written_header"))


if __name__ == "__main__":
    main()
