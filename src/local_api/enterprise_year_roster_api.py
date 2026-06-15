"""
企业年度花名册（dim_enterprise_year_roster）查询与维护 API。
"""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any

from src.local_api.enterprise_year_roster_build import ensure_enterprise_year_roster_schema

logger = logging.getLogger(__name__)

_NORM_ID_RE = re.compile(r"[\s-]+")


def _norm_id(raw: str) -> str:
    return _NORM_ID_RE.sub("", str(raw or "").strip()).upper()


def _calendar_year() -> int:
    return date.today().year


def _practice_year_options(extra_years: list[str] | None = None) -> list[str]:
    cy = _calendar_year()
    y_set: set[int] = {cy, cy + 1}
    for i in range(11):
        y_set.add(cy - i)
    for s in extra_years or []:
        try:
            yi = int(str(s).strip())
        except (TypeError, ValueError):
            continue
        if 1990 <= yi <= 2100:
            y_set.add(yi)
    return [str(y) for y in sorted(y_set, reverse=True)]


def _default_practice_stat_year(years: list[str]) -> str:
    cy = str(_calendar_year())
    if cy in years:
        return cy
    return years[0] if years else cy


def _safe_int_year(v: str | None) -> int:
    cy = _calendar_year()
    if not v or not str(v).strip().isdigit():
        return cy
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return cy
    return y


def _roster_years(conn: Any) -> list[str]:
    try:
        rows = conn.execute(
            "SELECT DISTINCT stat_year FROM dim_enterprise_year_roster WHERE stat_year IS NOT NULL ORDER BY stat_year DESC"
        ).fetchall()
        return [str(int(r[0])) for r in rows if r and r[0] is not None]
    except Exception as exc:  # noqa: BLE001
        logger.debug("读取花名册年度失败: %s", exc)
        return []


def _table_ready(conn: Any) -> bool:
    try:
        conn.execute("SELECT 1 FROM dim_enterprise_year_roster LIMIT 1")
        return True
    except Exception:
        return False


def _fetch_roster_rows(conn: Any, sql: str, params: list[Any]) -> list[tuple[Any, ...]]:
    """
    读取花名册行。DuckDB 在 ORDER BY 中文 VARCHAR + LIMIT 时会报
    InvalidInputException（unicode byte sequence mismatch）；连接层已禁用 top_n，
    列表查询改用 ASCII 友好排序键，此处再兜底禁用 top_n。
    """
    try:
        conn.execute("SET disabled_optimizers='top_n'")
    except Exception:
        pass
    return conn.execute(sql, params).fetchall()


# 避免 ORDER BY 中文列 + LIMIT 触发 DuckDB unicode 排序缺陷；同国家出资企业仍相邻展示。
_ROSTER_LIST_ORDER = (
    "COALESCE(state_investor_unified_credit_code, '') ASC, enterprise_id ASC"
)


def _build_list_where(
    *,
    year_i: int,
    state_investor_kw: str = "",
    enterprise_kw: str = "",
    state_investor: str = "",
    state_investor_code: str = "",
    quality_status: str = "",
    data_source: str = "",
) -> tuple[str, list[Any]]:
    clauses = ["stat_year = ?"]
    params: list[Any] = [year_i]

    si_kw = (state_investor_kw or "").strip().lower()
    if si_kw:
        clauses.append("lower(COALESCE(state_investor, '')) LIKE ?")
        params.append(f"%{si_kw}%")
    si = (state_investor or "").strip()
    if si:
        clauses.append("trim(COALESCE(state_investor, '')) = ?")
        params.append(si)
    sic = _norm_id(state_investor_code)
    if sic:
        clauses.append(
            "upper(regexp_replace(trim(COALESCE(state_investor_unified_credit_code, '')), '[\\s-]+', '', 'g')) = ?"
        )
        params.append(sic)
    ekw = (enterprise_kw or "").strip().lower()
    if ekw:
        clauses.append(
            "(lower(COALESCE(enterprise_name, '')) LIKE ? OR lower(COALESCE(enterprise_id, '')) LIKE ?)"
        )
        params.extend([f"%{ekw}%", f"%{ekw}%"])
    qs = (quality_status or "").strip().lower()
    if qs in ("ok", "conflict"):
        clauses.append("lower(COALESCE(quality_status, '')) = ?")
        params.append(qs)
    ds = (data_source or "").strip().lower()
    if ds in ("registry", "manual", "registry+manual"):
        clauses.append("lower(COALESCE(data_source, '')) = ?")
        params.append(ds)

    return " AND ".join(clauses), params


def _roster_kpi_for_year(conn: Any, year_i: int) -> dict[str, int]:
    row = _fetch_roster_rows(
        conn,
        """
        SELECT
            COUNT(DISTINCT trim(COALESCE(state_investor, '')))::BIGINT AS group_count,
            COUNT(*)::BIGINT AS total_members,
            SUM(CASE WHEN COALESCE(is_member, TRUE) THEN 1 ELSE 0 END)::BIGINT AS active_member_count,
            SUM(CASE WHEN quality_status = 'conflict' THEN 1 ELSE 0 END)::BIGINT AS conflict_count
        FROM dim_enterprise_year_roster
        WHERE stat_year = ?
        """,
        [year_i],
    )[0]
    return {
        "group_count": int(row[0] or 0),
        "total_members": int(row[1] or 0),
        "active_member_count": int(row[2] or 0),
        "conflict_count": int(row[3] or 0),
    }


def api_enterprise_year_roster_kpi(
    conn: Any,
    *,
    stat_year: str | None,
) -> dict[str, Any]:
    """年度 KPI 汇总（单次聚合，供顶栏卡片使用；比按国家出资企业 GROUP BY 更轻）。"""
    ensure_enterprise_year_roster_schema(conn)
    year_i = _safe_int_year(stat_year)
    try:
        kpi = _roster_kpi_for_year(conn, year_i)
    except Exception as exc:
        logger.exception("roster kpi failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    return {
        "ok": True,
        "stat_year": str(year_i),
        **kpi,
    }


def _roster_list_page(
    conn: Any,
    *,
    year_i: int,
    where_sql: str,
    params: list[Any],
    lim: int,
    off: int,
) -> tuple[list[tuple[Any, ...]], int]:
    """分页列表；用 COUNT(*) OVER() 与 SELECT 合并为一次扫描。"""
    rows = _fetch_roster_rows(
        conn,
        f"""
        SELECT
            enterprise_id,
            enterprise_name,
            state_investor,
            state_investor_unified_credit_code,
            COALESCE(is_member, TRUE),
            quality_status,
            quality_issue,
            source_record_id,
            updated_at,
            COALESCE(in_registry, FALSE),
            COALESCE(in_manual, FALSE),
            data_source,
            manual_note,
            COUNT(*) OVER()::BIGINT AS _total
        FROM dim_enterprise_year_roster
        WHERE {where_sql}
        ORDER BY {_ROSTER_LIST_ORDER}
        LIMIT ? OFFSET ?
        """,
        [*params, lim, off],
    )
    total = int(rows[0][13] or 0) if rows else 0
    return rows, total


def _rows_to_members(rows: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    for r in rows or []:
        members.append(
            {
                "enterprise_id": str(r[0] or ""),
                "enterprise_name": str(r[1] or ""),
                "state_investor": str(r[2] or ""),
                "state_investor_unified_credit_code": str(r[3] or "") if r[3] else "",
                "is_member": bool(r[4]),
                "quality_status": str(r[5] or ""),
                "quality_issue": str(r[6] or "") if r[6] else "",
                "source_record_id": str(r[7] or "") if r[7] else "",
                "updated_at": str(r[8] or "") if r[8] is not None else "",
                "in_registry": bool(r[9]),
                "in_manual": bool(r[10]),
                "data_source": str(r[11] or "") if r[11] else "",
                "manual_note": str(r[12] or "") if r[12] else "",
            }
        )
    return members


def api_enterprise_year_roster_bootstrap(
    conn: Any,
    *,
    stat_year: str | None = None,
    state_investor_kw: str = "",
    enterprise_kw: str = "",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """首屏一次返回 meta + KPI + 列表（最少 SQL 往返）。"""
    ensure_enterprise_year_roster_schema(conn)
    data_years = _roster_years(conn)
    options = _practice_year_options(data_years)
    year_i = _safe_int_year(stat_year or _default_practice_stat_year(options))
    lim = max(1, min(int(limit or 50), 500))
    off = max(0, int(offset or 0))
    where_sql, params = _build_list_where(
        year_i=year_i,
        state_investor_kw=state_investor_kw,
        enterprise_kw=enterprise_kw,
    )
    try:
        kpi = _roster_kpi_for_year(conn, year_i)
        page_rows, total = _roster_list_page(
            conn,
            year_i=year_i,
            where_sql=where_sql,
            params=params,
            lim=lim,
            off=off,
        )
    except Exception as exc:
        logger.exception("roster bootstrap failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    table_ready = bool(data_years) or total > 0 or bool(page_rows)
    return {
        "ok": True,
        "stat_years": options,
        "data_stat_years": data_years,
        "default_stat_year": _default_practice_stat_year(options),
        "table_ready": table_ready,
        "stat_year": str(year_i),
        **kpi,
        "rows": _rows_to_members(page_rows),
        "total": total,
        "limit": lim,
        "offset": off,
    }


def api_enterprise_year_roster_meta(conn: Any) -> dict[str, Any]:
    ensure_enterprise_year_roster_schema(conn)
    data_years = _roster_years(conn)
    options = _practice_year_options(data_years)
    return {
        "ok": True,
        "table_ready": bool(data_years) or _table_ready(conn),
        "stat_years": options,
        "data_stat_years": data_years,
        "default_stat_year": _default_practice_stat_year(options),
    }


def api_enterprise_year_roster_summary(
    conn: Any,
    *,
    stat_year: str | None,
    state_investor_kw: str = "",
) -> dict[str, Any]:
    ensure_enterprise_year_roster_schema(conn)
    year_i = _safe_int_year(stat_year)
    kw = (state_investor_kw or "").strip().lower()
    clauses = ["CAST(stat_year AS INTEGER) = ?"]
    params: list[Any] = [year_i]
    if kw:
        clauses.append("lower(COALESCE(state_investor, '')) LIKE ?")
        params.append(f"%{kw}%")
    where_sql = " AND ".join(clauses)
    try:
        rows = _fetch_roster_rows(
            conn,
            f"""
            SELECT
                trim(COALESCE(state_investor, '')) AS state_investor,
                NULLIF(trim(COALESCE(state_investor_unified_credit_code, '')), '') AS state_investor_code,
                COUNT(*)::BIGINT AS member_count,
                SUM(CASE WHEN COALESCE(is_member, TRUE) THEN 1 ELSE 0 END)::BIGINT AS active_member_count,
                SUM(CASE WHEN quality_status = 'conflict' THEN 1 ELSE 0 END)::BIGINT AS conflict_count
            FROM dim_enterprise_year_roster
            WHERE {where_sql}
            GROUP BY state_investor, state_investor_code
            ORDER BY state_investor_code NULLS LAST, state_investor NULLS LAST
            """,
            params,
        )
    except Exception as exc:
        logger.exception("roster summary failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    groups: list[dict[str, Any]] = []
    total_members = 0
    for r in rows or []:
        cnt = int(r[2] or 0)
        total_members += cnt
        groups.append(
            {
                "state_investor": str(r[0] or ""),
                "state_investor_unified_credit_code": str(r[1] or "") if r[1] else "",
                "member_count": cnt,
                "active_member_count": int(r[3] or 0),
                "conflict_count": int(r[4] or 0),
            }
        )
    return {
        "ok": True,
        "stat_year": str(year_i),
        "group_count": len(groups),
        "total_members": total_members,
        "groups": groups,
    }


def api_enterprise_year_roster_list(
    conn: Any,
    *,
    stat_year: str | None,
    state_investor: str = "",
    state_investor_code: str = "",
    state_investor_kw: str = "",
    enterprise_kw: str = "",
    quality_status: str = "",
    data_source: str = "",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    ensure_enterprise_year_roster_schema(conn)
    year_i = _safe_int_year(stat_year)
    lim = max(1, min(int(limit or 50), 500))
    off = max(0, int(offset or 0))
    where_sql, params = _build_list_where(
        year_i=year_i,
        state_investor_kw=state_investor_kw,
        enterprise_kw=enterprise_kw,
        state_investor=state_investor,
        state_investor_code=state_investor_code,
        quality_status=quality_status,
        data_source=data_source,
    )
    try:
        page_rows, total = _roster_list_page(
            conn,
            year_i=year_i,
            where_sql=where_sql,
            params=params,
            lim=lim,
            off=off,
        )
    except Exception as exc:
        logger.exception("roster list failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    return {
        "ok": True,
        "stat_year": str(year_i),
        "rows": _rows_to_members(page_rows),
        "total": total,
        "limit": lim,
        "offset": off,
    }


_INFO_CHECK_IDS = frozenset({"roster_row_count", "roster_quality_conflict"})


def api_enterprise_year_roster_consistency(
    conn: Any,
    *,
    stat_year: str | None,
    repair: bool = False,
) -> dict[str, Any]:
    """运行花名册一致性核对 SQL；可选 repair 修复 data_source 派生字段。"""
    ensure_enterprise_year_roster_schema(conn)
    year_i = _safe_int_year(stat_year)
    from src.local_api.enterprise_year_roster_store import repair_roster_data_source

    # 始终按 in_registry/in_manual 重算 data_source（幂等；修复 demo/迁移遗留，不影响正常数据）
    repaired = repair_roster_data_source(conn, stat_year=year_i)
    _ = repair  # 保留参数以兼容 ?repair=true 显式调用

    from pathlib import Path

    sql_path = Path(__file__).resolve().parents[2] / "scripts" / "check_enterprise_year_roster_consistency.sql"
    try:
        raw_sql = sql_path.read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": f"读取核对脚本失败：{exc}"}}

    sql = raw_sql.replace("CAST(2024 AS SMALLINT)", f"CAST({year_i} AS SMALLINT)", 1)
    try:
        rows = conn.execute(sql).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.exception("roster consistency check failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    checks: list[dict[str, Any]] = []
    hard_fail = 0
    for r in rows or []:
        check_id = str(r[0] or "")
        description = str(r[1] or "")
        violation_cnt = int(r[2] or 0)
        is_info = check_id in _INFO_CHECK_IDS
        failed = (not is_info) and violation_cnt > 0
        if failed:
            hard_fail += 1
        checks.append(
            {
                "check_id": check_id,
                "description": description,
                "violation_cnt": violation_cnt,
                "is_info": is_info,
                "passed": not failed,
            }
        )
    return {
        "ok": hard_fail == 0,
        "stat_year": str(year_i),
        "checks": checks,
        "hard_fail_count": hard_fail,
        "repaired_rows": repaired,
        "message": "核对通过" if hard_fail == 0 else f"发现 {hard_fail} 项硬违规",
    }
