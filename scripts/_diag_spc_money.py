"""一次性诊断：专项 je/se/jshj 与 ODS、dwd_inv_detail 对齐（默认 batch_id=20260414）。"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "database" / "warehouse.duckdb"
BID = sys.argv[1] if len(sys.argv) > 1 else "20260414"


def main() -> None:
    if not DB.exists():
        print("DB missing:", DB)
        return
    con = duckdb.connect(str(DB), read_only=True)
    print("DB:", DB)
    print("batch:", BID)

    for t in (
        "dwd_spc_construction_service",
        "dwd_inv_detail",
        "ods_spc_construction",
    ):
        try:
            n = con.execute(
                f"SELECT COUNT(*) FROM {t} WHERE import_batch_id = ?",
                [BID],
            ).fetchone()[0]
            print(f"{t}: rows={n}")
        except Exception as exc:  # noqa: BLE001
            print(f"{t}: ERROR {exc}")

    # ODS 建筑：列名 + 金额列样本
    try:
        cols = con.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='main' AND table_name='ods_spc_construction' ORDER BY ordinal_position"
        ).fetchall()
        print("ods_spc_construction columns:", [c[0] for c in cols])
    except Exception as exc:  # noqa: BLE001
        print("list ods cols ERR", exc)

    try:
        q = """
        SELECT
          COUNT(*) AS n,
          COUNT(amount) AS n_amount_nn,
          COUNT(tax_amount) AS n_tax_nn,
          COUNT(total_amount) AS n_tot_nn,
          SUM(CASE WHEN amount IS NOT NULL AND trim(CAST(amount AS VARCHAR)) <> '' THEN 1 ELSE 0 END) AS n_amount_nonempty
        FROM ods_spc_construction
        WHERE batch_id = ?
        """
        print("ods_spc_construction amount stats:", con.execute(q, [BID]).fetchdf().to_dict("records"))
    except Exception as exc:  # noqa: BLE001
        print("ods amount stats ERR", exc)

    # 专项 DWD vs 明细：UUID 交集
    try:
        q = """
        WITH s AS (
          SELECT detail_uuid, logic_line_no, je, se, jshj, source_sheet
          FROM dwd_spc_construction_service
          WHERE import_batch_id = ?
        ),
        d AS (
          SELECT detail_uuid, logic_line_no, je, se, jshj, source_sheet
          FROM dwd_inv_detail
          WHERE import_batch_id = ?
        )
        SELECT
          (SELECT COUNT(*) FROM s) AS n_spc,
          (SELECT COUNT(*) FROM d) AS n_dtl,
          (SELECT COUNT(*) FROM s INNER JOIN d USING (detail_uuid)) AS n_uuid_both,
          (SELECT COUNT(*) FROM s LEFT JOIN d USING (detail_uuid) WHERE d.detail_uuid IS NULL) AS n_spc_no_dtl
        """
        print("uuid overlap:", con.execute(q, [BID, BID]).fetchdf().to_dict("records"))
    except Exception as exc:  # noqa: BLE001
        print("overlap ERR", exc)

    # 样本：专项有、明细无的 header_uuid + logic_line_no
    try:
        q = """
        SELECT s.detail_uuid, s.header_uuid, s.logic_line_no, s.je, s.source_sheet AS spc_sheet,
               d.je AS dtl_je, d.source_sheet AS dtl_sheet
        FROM dwd_spc_construction_service s
        LEFT JOIN dwd_inv_detail d ON d.detail_uuid = s.detail_uuid AND d.import_batch_id = s.import_batch_id
        WHERE s.import_batch_id = ?
        LIMIT 20
        """
        print("sample join:\n", con.execute(q, [BID]).fetchdf().to_string())
    except Exception as exc:  # noqa: BLE001
        print("sample ERR", exc)


def _coalesce_sim(con: duckdb.DuckDBPyConnection) -> None:
    r = con.execute(
        """
        SELECT COALESCE(
          CAST(NULL AS DECIMAL(18,2)),
          (SELECT je FROM dwd_inv_detail di
           WHERE di.detail_uuid = '4d9a7b72409f22e5105c3d47c1dab934'
             AND di.stat_year = 2024 AND di.import_batch_id = '20260414' LIMIT 1)
        ) AS x
        """
    ).fetchone()
    print("coalesce_sim", r)


if __name__ == "__main__":
    main()
    if DB.exists():
        cx = duckdb.connect(str(DB), read_only=True)
        try:
            _coalesce_sim(cx)
        finally:
            cx.close()
