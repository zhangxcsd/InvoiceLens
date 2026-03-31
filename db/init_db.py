"""
InvoiceLens · 票鉴
init_db.py

一键初始化数据库（单表版，决策九）。
运行：python init_db.py
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db.duckdb_conn import get_conn, close_conn, get_db_mode, rebuild_database_files
from db.schema_sqlfiles import init_all_tables


def main():
    print("=" * 56)
    print("  InvoiceLens · 票鉴  数据库初始化（单表版）")
    print("=" * 56)

    # 开发期：允许重建数据库文件，避免旧表结构残留
    if get_db_mode() == "dev":
        rebuild_database_files(remove_tmp=False)
    conn = get_conn()
    db_path = Path("data/database/warehouse.duckdb").resolve()
    print(f"\nOK 数据库连接成功")
    print(f"  位置：{db_path}")
    print(f"  架构：单表 + stat_year 列（决策九，无年度分表）")

    print("\n正在建表...")
    stats = init_all_tables(conn)

    print(f"\n建表结果：")
    print(f"  DIM 层：{stats['dim']} 张表")
    print(f"  ODS 层：{stats['ods']} 张表")
    print(f"  DWD 层：{stats['dwd']} 张表（单表，含 stat_year 列）")
    print(f"  DWS 层：{stats['dws']} 张表（单表，含 stat_year 列）")
    print(f"  DM  层：{stats['dm']} 张表")
    print(f"  ADS 层：{stats['ads']} 张表")
    print(f"  合计：{stats['total']} 张表（无年度视图）")

    print(f"\n预置数据：")
    for row in conn.execute("SELECT sys_id, sys_name FROM dim_org_sys").fetchall():
        print(f"  · dim_org_sys：{row[0]} ({row[1]})")
    for row in conn.execute("SELECT entity_id, entity_shortname FROM dim_org_node").fetchall():
        print(f"  · dim_org_node：{row[0]} ({row[1]})")

    close_conn()
    print(f"\nOK 初始化完成！运行 python verify_db.py 验证")
    print("=" * 56)


if __name__ == "__main__":
    main()
