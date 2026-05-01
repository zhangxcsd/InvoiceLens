from __future__ import annotations

from pathlib import Path

import duckdb


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    db = root / "data" / "database" / "warehouse.duckdb"
    out = root / "assets" / "bootstrap" / "dim_tax_code_seed.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)

    conn = duckdb.connect(str(db))
    sql = f"""
    COPY (
      SELECT
        cast(tax_code as varchar) as tax_code,
        cast(goods_name as varchar) as goods_name,
        cast(goods_short_name as varchar) as goods_short_name,
        cast(description as varchar) as description,
        cast(level_pian as varchar) as level_pian,
        cast(level_lei as varchar) as level_lei,
        cast(level_zhang as varchar) as level_zhang,
        cast(level_jie as varchar) as level_jie,
        cast(level_tiao as varchar) as level_tiao,
        cast(level_kuan as varchar) as level_kuan,
        cast(level_xiang as varchar) as level_xiang,
        cast(level_mu as varchar) as level_mu,
        cast(level_zimu as varchar) as level_zimu,
        cast(level_ximu as varchar) as level_ximu,
        cast(level_depth as tinyint) as level_depth,
        cast(is_leaf as boolean) as is_leaf,
        cast(parent_code as varchar) as parent_code,
        cast(full_path as varchar) as full_path,
        cast(data_version as varchar) as data_version,
        cast(clean_status as varchar) as clean_status,
        cast(audit_risk_label as varchar) as audit_risk_label,
        cast(import_batch_id as varchar) as import_batch_id,
        cast(import_session_id as varchar) as import_session_id,
        cast(ods_file_seq as integer) as ods_file_seq,
        cast(source_excel_file as varchar) as source_excel_file,
        cast(source_parquet_file as varchar) as source_parquet_file,
        cast(source_sheet as varchar) as source_sheet,
        cast(ingest_ts as timestamp) as ingest_ts
      FROM dim_tax_code
    ) TO '{str(out).replace("\\", "/")}' (FORMAT PARQUET)
    """
    conn.execute(sql)
    n = conn.execute("SELECT COUNT(*) FROM dim_tax_code").fetchone()[0]
    print(f"seed exported: {out} rows={n}")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
