"""Smoke: ODS inventory overview aggregates from ods_load_log without reading Parquet bodies."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db.schema_sqlfiles import init_all_tables
from src.local_api.ods_preview import list_ods_inventory_overview


def _setup(conn):
    init_all_tables(conn)
    paths_a = [
        str(Path("data/ods") / "批次=b1" / "表类型=inv_header" / "ods_file_seq=1" / "a.parquet"),
        str(Path("data/ods") / "批次=b1" / "表类型=inv_detail" / "ods_file_seq=1" / "b.parquet"),
    ]
    paths_b = [
        str(Path("data/ods") / "批次=b2" / "表类型=inv_header" / "ods_file_seq=1" / "c.parquet"),
    ]
    conn.execute(
        """
        INSERT INTO ods_load_log(
          import_batch_id, import_session_id, load_time,
          file_count, total_rows, success_count, fail_count, warn_count,
          parquet_paths, detail_json
        ) VALUES
          ('b1', 's1', TIMESTAMP '2026-08-01 10:00:00', 2, 100, 2, 0, 0, ?, '[]'),
          ('b1', 's0', TIMESTAMP '2026-07-01 10:00:00', 1, 40, 1, 0, 0, ?, '[]'),
          ('b2', 's2', TIMESTAMP '2026-08-02 10:00:00', 1, 50, 1, 0, 0, ?, '[]')
        """,
        [json.dumps(paths_a), json.dumps([]), json.dumps(paths_b)],
    )


def main() -> None:
    import duckdb

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "t.duckdb"
        conn = duckdb.connect(str(db))
        try:
            _setup(conn)
            payload = list_ods_inventory_overview(conn, limit=100)
            assert payload.get("ok") is True, payload
            kpi = payload["kpi"]
            assert kpi["batch_count"] == 2
            assert kpi["session_count"] == 3
            assert kpi["sessions_with_parquet"] == 2
            assert kpi["total_rows"] == 190
            assert kpi["parquet_path_count"] == 3
            assert kpi["table_type_count"] == 2

            by_tt = {r["table_type"]: r for r in payload["table_types"]}
            assert by_tt["inv_header"]["parquet_path_count"] == 2
            assert by_tt["inv_header"]["batch_count"] == 2
            assert by_tt["inv_detail"]["parquet_path_count"] == 1
            assert by_tt["inv_detail"]["batch_count"] == 1

            by_batch = {r["batch_id"]: r for r in payload["batches"]}
            assert by_batch["b1"]["session_count"] == 2
            assert by_batch["b1"]["sessions_with_parquet"] == 1
            assert by_batch["b1"]["latest_session_id"] == "s1"
            assert by_batch["b2"]["total_rows"] == 50

            sessions = payload["sessions"]
            assert len(sessions) == 3
            header_sessions = [s for s in sessions if "inv_header" in s["table_types"]]
            assert len(header_sessions) == 2
            detail_sessions = [s for s in sessions if "inv_detail" in s["table_types"]]
            assert len(detail_sessions) == 1
            print("ok: ods inventory overview smoke")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
