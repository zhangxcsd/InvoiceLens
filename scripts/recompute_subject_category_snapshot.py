from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.subject_category.recompute import recompute_org_subject_categories
from src.subject_category.recompute import recompute_org_subject_categories_and_relations


def main() -> None:
    ap = argparse.ArgumentParser(description="仅重算组织主体分类并写入快照")
    ap.add_argument("--db", default=str(ROOT / "data" / "warehouse.duckdb"), help="DuckDB 路径")
    ap.add_argument("--run-id", default=None, help="可选：指定 run_id")
    ap.add_argument("--snapshot-id", default=None, help="可选：指定 snapshot_id")
    ap.add_argument("--with-relations", action="store_true", help="联动重建主体关系快照")
    args = ap.parse_args()

    conn = duckdb.connect(args.db)
    try:
        if args.with_relations:
            ret = recompute_org_subject_categories_and_relations(
                conn,
                run_id=args.run_id,
                snapshot_id=args.snapshot_id,
            )
        else:
            ret = recompute_org_subject_categories(
                conn,
                run_id=args.run_id,
                snapshot_id=args.snapshot_id,
            )
    finally:
        conn.close()
    print(json.dumps(ret, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
