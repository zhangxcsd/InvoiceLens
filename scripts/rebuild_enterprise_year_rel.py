#!/usr/bin/env python3
"""
按年度重算 dim_enterprise_year_rel（集团台账成员 × DWD 购销标志）。

用法示例：
  python scripts/rebuild_enterprise_year_rel.py --years 2024,2025
  python scripts/rebuild_enterprise_year_rel.py --all
  python scripts/rebuild_enterprise_year_rel.py --all --dry-run
  python scripts/rebuild_enterprise_year_rel.py --years 2025 --db data/database/warehouse.duckdb
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _parse_years(raw: str | None) -> list[int] | None:
    if raw is None or str(raw).strip().lower() in ("", "all", "*"):
        return None
    out: list[int] = []
    for part in str(raw).replace("，", ",").split(","):
        p = part.strip()
        if not p.isdigit() or len(p) != 4:
            continue
        y = int(p)
        if 1990 <= y <= 2100:
            out.append(y)
    return sorted(set(out)) if out else None


def main() -> int:
    ap = argparse.ArgumentParser(description="重算 dim_enterprise_year_rel（集团成员口径）")
    ap.add_argument("--years", help="逗号分隔统计年度，如 2024,2025；省略且未指定 --all 时等同 --all")
    ap.add_argument("--all", action="store_true", help="DWD 发票年度 ∪ 集团台账年度（与 API 默认一致）")
    ap.add_argument("--dry-run", action="store_true", help="预演，不写库")
    ap.add_argument("--db", help="DuckDB 文件路径（默认使用项目 get_conn 配置）")
    ap.add_argument("--trigger-source", default="cli_script", help="写入 ads_etl_task_run_log 的来源标识")
    args = ap.parse_args()

    stat_years = None if args.all or not (args.years or "").strip() else _parse_years(args.years)
    if stat_years is not None and not stat_years:
        print("error: --years 未解析到有效年度", file=sys.stderr)
        return 2

    try:
        if args.db:
            import duckdb

            conn = duckdb.connect(str(Path(args.db).resolve()))
        else:
            from db.duckdb_conn import get_conn

            conn = get_conn()
        from src.local_api.enterprise_year_rel_build import rebuild_dim_enterprise_year_rel

        out = rebuild_dim_enterprise_year_rel(
            conn,
            stat_years=stat_years,
            dry_run=bool(args.dry_run),
            trigger_source=str(args.trigger_source or "cli_script").strip() or "cli_script",
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
    return 0 if out.get("ok") or out.get("skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
