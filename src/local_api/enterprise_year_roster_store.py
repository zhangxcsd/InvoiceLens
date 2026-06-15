"""dim_enterprise_year_roster 读写辅助。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from src.local_api.enterprise_year_roster_merge import ROSTER_FETCH_COLUMNS, roster_row_to_dict

_UPSERT_SQL = """
INSERT INTO dim_enterprise_year_roster (
    stat_year, enterprise_id, enterprise_name,
    state_investor, state_investor_unified_credit_code,
    is_member, registry_row_id,
    data_source, source_record_id, calc_version,
    quality_status, quality_issue,
    in_registry, in_manual, manual_updated_at, manual_note,
    updated_at
) VALUES (
    ?, ?, ?,
    ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?,
    now()
)
ON CONFLICT (stat_year, enterprise_id) DO UPDATE SET
    enterprise_name = excluded.enterprise_name,
    state_investor = excluded.state_investor,
    state_investor_unified_credit_code = excluded.state_investor_unified_credit_code,
    is_member = excluded.is_member,
    registry_row_id = excluded.registry_row_id,
    data_source = excluded.data_source,
    source_record_id = excluded.source_record_id,
    calc_version = excluded.calc_version,
    quality_status = excluded.quality_status,
    quality_issue = excluded.quality_issue,
    in_registry = excluded.in_registry,
    in_manual = excluded.in_manual,
    manual_updated_at = COALESCE(excluded.manual_updated_at, dim_enterprise_year_roster.manual_updated_at),
    manual_note = excluded.manual_note,
    updated_at = now()
"""


def fetch_roster_row(conn: Any, *, stat_year: int, enterprise_id: str) -> dict[str, Any] | None:
    cols = ", ".join(ROSTER_FETCH_COLUMNS)
    rows = conn.execute(
        f"""
        SELECT {cols}
        FROM dim_enterprise_year_roster
        WHERE stat_year = ? AND enterprise_id = ?
        """,
        [stat_year, enterprise_id],
    ).fetchall()
    if not rows:
        return None
    return roster_row_to_dict(rows[0], ROSTER_FETCH_COLUMNS)


def upsert_roster_row(conn: Any, item: dict[str, Any], *, touch_manual: bool = False) -> None:
    manual_at = datetime.now() if touch_manual else item.get("manual_updated_at")
    conn.execute(
        _UPSERT_SQL,
        [
            item["stat_year"],
            item["enterprise_id"],
            item["enterprise_name"],
            item["state_investor"],
            item.get("state_investor_unified_credit_code"),
            item.get("is_member", True),
            item.get("registry_row_id"),
            item.get("data_source"),
            item.get("source_record_id"),
            item.get("calc_version", "v2"),
            item.get("quality_status"),
            item.get("quality_issue"),
            bool(item.get("in_registry", False)),
            bool(item.get("in_manual", False)),
            manual_at,
            item.get("manual_note"),
        ],
    )


def repair_roster_data_source(conn: Any, *, stat_year: int | None = None) -> int:
    """按 in_registry/in_manual 重算 data_source（修复历史 demo 或迁移遗留）。"""
    where = "WHERE stat_year = ?" if stat_year is not None else ""
    params: list[Any] = [stat_year] if stat_year is not None else []
    mismatch_sql = f"""
        SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_roster
        {where}
          AND data_source IS DISTINCT FROM (
            CASE
                WHEN COALESCE(in_registry, FALSE) AND COALESCE(in_manual, FALSE) THEN 'registry+manual'
                WHEN COALESCE(in_registry, FALSE) THEN 'registry'
                WHEN COALESCE(in_manual, FALSE) THEN 'manual'
                ELSE NULL
            END
          )
    """
    cnt_row = conn.execute(mismatch_sql, params).fetchone()
    mismatch_cnt = int(cnt_row[0] or 0) if cnt_row else 0
    if mismatch_cnt <= 0:
        return 0
    update_sql = f"""
        UPDATE dim_enterprise_year_roster
        SET data_source = (
            CASE
                WHEN COALESCE(in_registry, FALSE) AND COALESCE(in_manual, FALSE) THEN 'registry+manual'
                WHEN COALESCE(in_registry, FALSE) THEN 'registry'
                WHEN COALESCE(in_manual, FALSE) THEN 'manual'
                ELSE NULL
            END
        )
        {where}
          AND data_source IS DISTINCT FROM (
            CASE
                WHEN COALESCE(in_registry, FALSE) AND COALESCE(in_manual, FALSE) THEN 'registry+manual'
                WHEN COALESCE(in_registry, FALSE) THEN 'registry'
                WHEN COALESCE(in_manual, FALSE) THEN 'manual'
                ELSE NULL
            END
          )
    """
    conn.execute(update_sql, params)
    return mismatch_cnt


def count_manual_only_rows(conn: Any, *, stat_year: int) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*)::BIGINT
        FROM dim_enterprise_year_roster
        WHERE stat_year = ?
          AND COALESCE(in_manual, FALSE) = TRUE
          AND COALESCE(in_registry, FALSE) = FALSE
        """,
        [stat_year],
    ).fetchone()
    return int(row[0] or 0) if row else 0
