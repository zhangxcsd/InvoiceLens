from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.local_api.subject_library_dwd_ingest import ingest_dim_subject_master_from_dwd
from src.subject_category.recompute import recompute_org_subject_categories_and_relations


def main() -> int:
    out_path = Path("tmp_subject_pipeline_result.json")
    out: dict = {"ok": False}
    try:
        conn = get_conn()
        init_all_tables(conn)
        ingest = ingest_dim_subject_master_from_dwd(conn)
        recompute = recompute_org_subject_categories_and_relations(conn)
        subject_total = int(conn.execute("SELECT COUNT(*) FROM dim_subject_master").fetchone()[0] or 0)
        relation_total = int(conn.execute("SELECT COUNT(*) FROM dim_subject_relation_current").fetchone()[0] or 0)
        out = {
            "ok": True,
            "ingest": ingest,
            "recompute": recompute,
            "subject_master_total": subject_total,
            "relation_current_total": relation_total,
        }
    except Exception as exc:  # noqa: BLE001
        out = {"ok": False, "error_type": type(exc).__name__, "error": str(exc)}

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"WROTE {out_path}")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
