"""Smoke: ODS inventory overview aggregates rows/size from parquet metadata + disk."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db.schema_sqlfiles import init_all_tables
from src.local_api.ods_preview import list_ods_inventory_overview


def _write_parquet(path: Path, rows: list[dict]) -> None:
    import pandas as pd

    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_parquet(path, index=False)


def _setup(conn, root: Path):
    init_all_tables(conn)
    p_h1 = root / "ods" / "批次=b1" / "表类型=inv_header" / "ods_file_seq=1" / "a.parquet"
    p_d1 = root / "ods" / "批次=b1" / "表类型=inv_detail" / "ods_file_seq=1" / "b.parquet"
    p_h2 = root / "ods" / "批次=b2" / "表类型=inv_header" / "ods_file_seq=1" / "c.parquet"
    _write_parquet(p_h1, [{"id": i} for i in range(10)])
    _write_parquet(p_d1, [{"id": i} for i in range(25)])
    _write_parquet(p_h2, [{"id": i} for i in range(5)])

    paths_a = [str(p_h1), str(p_d1)]
    paths_b = [str(p_h2)]
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
    return root / "ods"


def main() -> None:
    import duckdb
    import os

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        db = root / "t.duckdb"
        conn = duckdb.connect(str(db))
        try:
            ods_root = _setup(conn, root)
            os.environ["INVOICELENS_ODS_DIR"] = str(ods_root)
            payload = list_ods_inventory_overview(conn, limit=100)
            assert payload.get("ok") is True, payload
            kpi = payload["kpi"]
            assert kpi["batch_count"] == 2
            assert kpi["session_count"] == 3
            assert kpi["sessions_with_parquet"] == 2
            assert kpi["total_rows"] == 190
            assert kpi["parquet_path_count"] == 3
            assert kpi["unique_path_count"] == 3
            assert kpi["table_type_count"] == 2
            assert kpi["parquet_row_count"] == 40, kpi
            assert kpi["size_bytes"] is not None and kpi["size_bytes"] > 0
            assert kpi["missing_path_count"] == 0

            by_tt = {r["table_type"]: r for r in payload["table_types"]}
            assert by_tt["inv_header"]["row_count"] == 15
            assert by_tt["inv_detail"]["row_count"] == 25
            assert by_tt["inv_header"]["size_bytes"] > 0

            by_batch = {r["batch_id"]: r for r in payload["batches"]}
            assert by_batch["b1"]["row_count"] == 35
            assert by_batch["b2"]["row_count"] == 5

            storage = payload.get("storage") or {}
            assert storage.get("batch_dir_count") == 2
            assert storage.get("batch_dirs_size_bytes", 0) > 0
            dirs = {d["batch_id"]: d for d in storage.get("batch_dirs") or []}
            assert dirs["b1"]["parquet_file_count"] == 2
            assert dirs["b2"]["parquet_file_count"] == 1

            sessions = payload["sessions"]
            assert len(sessions) == 3
            header_sessions = [s for s in sessions if "inv_header" in s["table_types"]]
            assert len(header_sessions) == 2
            print("ok: ods inventory overview smoke (rows+storage)")
        finally:
            conn.close()
            os.environ.pop("INVOICELENS_ODS_DIR", None)


if __name__ == "__main__":
    main()
