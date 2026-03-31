"""
InvoiceLens · 票鉴
verify_db.py

数据库结构验证（单表版，决策九）。
运行：python verify_db.py
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from db.duckdb_conn import get_conn, close_conn

# ── 期望存在的所有表（单表版，无年度后缀）────────────────────
EXPECTED_TABLES = [
    # DIM
    "dim_org_sys", "dim_org_node", "dim_org_hier",
    "dim_org_hier_log", "dim_tax_code", "dim_ind_rule",
    # DWD（单表，含 stat_year 列）
    "dwd_inv_header", "dwd_inv_detail", "dwd_inv_map",
    # DWS（单表，含 stat_year 列）
    "dws_trade_sum", "dws_inv_trend", "dws_sup_conc",
    "dws_goods_cat", "dws_quality",
    # DM
    "dm_audit_flag", "dm_circ_inv", "dm_shell_co",
    # ADS
    "ads_scorecard", "ads_group", "ads_org_member", "ads_import_log",
]

# ── 期望包含 stat_year 列的表────────────────────────────────
TABLES_WITH_STAT_YEAR = [
    "dwd_inv_header", "dwd_inv_detail", "dwd_inv_map",
    "dws_trade_sum", "dws_inv_trend", "dws_sup_conc",
    "dws_goods_cat", "dws_quality",
]

# ── 期望不存在的旧年度分表（确认已清除）────────────────────
OBSOLETE_PATTERNS = [
    "dwd_inv_header_2021", "dwd_inv_header_2022",
    "dwd_inv_detail_2023", "dwd_inv_map_2024",
    "dws_trade_sum_2021", "dws_inv_trend_2024",
]


def check(label: str, ok: bool) -> bool:
    print(f"  {'✓' if ok else '✗'} {label}")
    return ok


def main():
    print("=" * 56)
    print("  InvoiceLens · 票鉴  数据库结构验证")
    print("=" * 56)

    conn = get_conn()
    all_ok = True

    actual_tables = {
        r[0] for r in conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='main' AND table_type='BASE TABLE'"
        ).fetchall()
    }

    # ── 表存在性检查
    print(f"\n── 表检查（期望 {len(EXPECTED_TABLES)} 张）")
    for t in EXPECTED_TABLES:
        all_ok &= check(t, t in actual_tables)

    # ── stat_year 列检查（核心：确认是单表而非年度分表）
    print(f"\n── stat_year 列检查（决策九：单表 + stat_year）")
    for t in TABLES_WITH_STAT_YEAR:
        if t not in actual_tables:
            all_ok &= check(f"{t}.stat_year", False)
            continue
        cols = {r[0] for r in conn.execute(
            f"SELECT column_name FROM information_schema.columns "
            f"WHERE table_name='{t}'"
        ).fetchall()}
        all_ok &= check(f"{t}.stat_year 列存在", "stat_year" in cols)

    # ── 确认旧年度分表已不存在
    print(f"\n── 旧年度分表清除验证")
    for t in OBSOLETE_PATTERNS:
        ok = t not in actual_tables
        all_ok &= check(f"{t} 不存在（应已清除）", ok)

    # ── 预置数据
    print(f"\n── 预置数据")
    sys_ok = "PROV_SD" in {r[0] for r in conn.execute(
        "SELECT sys_id FROM dim_org_sys").fetchall()}
    all_ok &= check("dim_org_sys 含 PROV_SD", sys_ok)

    node_ok = "ROOT_PROV_SD" in {r[0] for r in conn.execute(
        "SELECT entity_id FROM dim_org_node").fetchall()}
    all_ok &= check("dim_org_node 含 ROOT_PROV_SD", node_ok)

    # ── 关键字段精度抽查（防 AI 悄悄改精度）
    print(f"\n── 关键字段精度（防劣化）")
    decimal_checks = [
        ("dwd_inv_header", "je"),
        ("dwd_inv_header", "net_jshj"),
        ("dwd_inv_header", "balance_tolerance"),
    ]
    for table, col in decimal_checks:
        row = conn.execute(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name=? AND column_name=?", [table, col]
        ).fetchone()
        is_decimal = row and "DECIMAL" in row[0].upper()
        all_ok &= check(f"{table}.{col} 是 DECIMAL 类型", is_decimal)

    close_conn()

    print("\n" + "=" * 56)
    if all_ok:
        print("  ✓ 全部验证通过，阶段一完成！")
        print("  下一步：阶段二 —— DIM 层维度数据导入")
    else:
        print("  ✗ 有项目未通过，请重新运行 python init_db.py")
    print("=" * 56)


if __name__ == "__main__":
    main()
