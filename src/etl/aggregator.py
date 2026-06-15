from typing import Any

from src.etl.dws_build import refresh_dws, refresh_dws_years


def run_aggregator(*, stat_year: int, conn: Any | None = None) -> dict[str, Any]:
    """
    DWD -> DWS 聚合写入契约：

    - 覆盖刷新边界：`stat_year`
    - 采用 DELETE+INSERT 写入单表 DWS（必须带 stat_year 过滤）
    """
    if conn is None:
        from db.duckdb_conn import get_conn
        from db.schema_sqlfiles import init_all_tables

        conn = get_conn()
        init_all_tables(conn)
    payload = refresh_dws(conn, stat_year=stat_year)
    return {
        "status": "success" if payload.get("ok") else "failed",
        "stage": "aggregator",
        "stat_year": stat_year,
        **payload,
    }


__all__ = ["run_aggregator", "refresh_dws", "refresh_dws_years"]
