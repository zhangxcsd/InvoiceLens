from __future__ import annotations

"""
主体库列表展示字段物化：dim_subject_master.source_bucket、rename_edge_count。

在 DWD 归集、外部导入、更名信号重建后刷新，读路径避免对 dwd_inv_header 全表 JOIN。
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _subject_pid_norm_sql(table_alias: str) -> str:
    m = table_alias
    return (
        f"upper(regexp_replace(trim(COALESCE({m}.subject_no,'')), "
        r"'[\s-]+', '', 'g'))"
    )


def display_cache_columns_ready(conn) -> bool:
    from db.schema_sqlfiles import _column_exists

    try:
        return _column_exists(conn, "dim_subject_master", "source_bucket") and _column_exists(
            conn, "dim_subject_master", "rename_edge_count"
        )
    except Exception:
        return False


def _dwd_inv_header_readable(conn) -> bool:
    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
        return True
    except Exception:
        return False


def refresh_subject_library_rename_counts(conn) -> dict[str, Any]:
    """仅刷新 rename_edge_count（更名信号重建后调用，不扫描 dwd_inv_header）。"""
    if not display_cache_columns_ready(conn):
        return {"ok": False, "skipped": True, "reason": "columns_missing"}

    pid = _subject_pid_norm_sql("m2")
    try:
        conn.execute(
            f"""
            UPDATE dim_subject_master AS m
            SET rename_edge_count = calc.edge_cnt
            FROM (
                SELECT
                    m2.subject_id,
                    COALESCE(rs.edge_cnt, 0)::BIGINT AS edge_cnt
                FROM dim_subject_master m2
                LEFT JOIN (
                    SELECT normalized_subject_no, COUNT(*)::BIGINT AS edge_cnt
                    FROM dim_subject_rename_signal
                    GROUP BY normalized_subject_no
                ) rs
                  ON length(trim(COALESCE(m2.subject_no,''))) > 0
                 AND {pid} = rs.normalized_subject_no
            ) calc
            WHERE m.subject_id = calc.subject_id
            """
        )
        row = conn.execute("SELECT COUNT(*)::BIGINT FROM dim_subject_master").fetchone()
        n = int(row[0] or 0) if row else 0
        return {"ok": True, "rows_refreshed": n, "scope": "rename_edge_count"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("刷新 rename_edge_count 失败：%s: %s", type(exc).__name__, exc)
        return {"ok": False, "error": {"message": f"{type(exc).__name__}: {exc}"}}


def refresh_subject_library_display_cache(conn) -> dict[str, Any]:
    """全量刷新 source_bucket 与 rename_edge_count。"""
    from db.schema_sqlfiles import migrate_dim_subject_display_cache_columns

    migrate_dim_subject_display_cache_columns(conn)
    if not display_cache_columns_ready(conn):
        return {"ok": False, "skipped": True, "reason": "columns_missing"}

    has_dwd = _dwd_inv_header_readable(conn)
    pid = _subject_pid_norm_sql("m2")
    inv_join = ""
    inv_platform = "FALSE"
    if has_dwd:
        inv_join = f"""
                LEFT JOIN (
                    SELECT DISTINCT u.pid FROM (
                        SELECT upper(regexp_replace(trim(COALESCE(xfsbh,'')), '[\\s-]+', '', 'g')) AS pid
                        FROM dwd_inv_header
                        WHERE length(trim(COALESCE(xfsbh,''))) > 0
                        UNION
                        SELECT upper(regexp_replace(trim(COALESCE(gfsbh,'')), '[\\s-]+', '', 'g')) AS pid
                        FROM dwd_inv_header
                        WHERE length(trim(COALESCE(gfsbh,''))) > 0
                    ) u
                    WHERE length(u.pid) > 0
                ) h
                  ON length(trim(COALESCE(m2.subject_no,''))) > 0
                 AND {pid} = h.pid
        """
        inv_platform = "h.pid IS NOT NULL"

    try:
        conn.execute(
            f"""
            UPDATE dim_subject_master AS m
            SET
                source_bucket = calc.bucket,
                rename_edge_count = calc.edge_cnt
            FROM (
                SELECT
                    m2.subject_id,
                    CASE
                        WHEN lower(trim(COALESCE(m2.first_source_system,''))) <> 'external'
                        THEN 'platform'
                        WHEN {inv_platform} THEN 'platform'
                        ELSE 'external'
                    END AS bucket,
                    COALESCE(rs.edge_cnt, 0)::BIGINT AS edge_cnt
                FROM dim_subject_master m2
                {inv_join}
                LEFT JOIN (
                    SELECT normalized_subject_no, COUNT(*)::BIGINT AS edge_cnt
                    FROM dim_subject_rename_signal
                    GROUP BY normalized_subject_no
                ) rs
                  ON length(trim(COALESCE(m2.subject_no,''))) > 0
                 AND {pid} = rs.normalized_subject_no
            ) calc
            WHERE m.subject_id = calc.subject_id
            """
        )
        row = conn.execute("SELECT COUNT(*)::BIGINT FROM dim_subject_master").fetchone()
        n = int(row[0] or 0) if row else 0
        return {"ok": True, "rows_refreshed": n, "scope": "full"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("刷新主体库展示缓存失败：%s: %s", type(exc).__name__, exc)
        return {"ok": False, "error": {"message": f"{type(exc).__name__}: {exc}"}}


def ensure_subject_library_display_cache_fresh(conn) -> None:
    """旧库补列后 source_bucket 为空时，首次列表/汇总请求触发一次全量刷新（跑批后通常已由任务刷新）。"""
    if not display_cache_columns_ready(conn):
        return
    try:
        row = conn.execute(
            """
            SELECT COUNT(*)::BIGINT
            FROM dim_subject_master
            WHERE source_bucket IS NULL OR trim(COALESCE(source_bucket,'')) = ''
            """
        ).fetchone()
        pending = int(row[0] or 0) if row else 0
        if pending > 0:
            refresh_subject_library_display_cache(conn)
    except Exception as exc:  # noqa: BLE001
        logger.debug("检查主体库展示缓存待刷新状态失败：%s", exc)
