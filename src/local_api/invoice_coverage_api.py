from __future__ import annotations

"""
发票报送覆盖分析：基于 vw_audit_invoice_coverage_group_member / vw_audit_invoice_coverage_soe_year
的只读查询，供本地 API 与前端使用。
"""

import logging
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)


def _calendar_year() -> int:
    return date.today().year


def _practice_year_options(extra_years: list[str] | None = None) -> list[str]:
    """实务可选年度：下一年（预编）+ 当前年往回 11 年，并与库内已有年度合并。"""
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


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = _calendar_year() if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _norm_kw(v: str | None) -> str:
    return (v or "").strip().lower()


def _coverage_views_ready(conn: Any) -> bool:
    try:
        conn.execute("SELECT 1 FROM vw_audit_invoice_coverage_group_member LIMIT 1")
        return True
    except Exception as exc:
        logger.debug("报送覆盖视图不可用: %s", exc)
        return False


def _distinct_stat_years(conn: Any, sql: str) -> list[str]:
    try:
        rows = conn.execute(sql).fetchall()
        return [str(int(r[0])) for r in rows if r and r[0] is not None]
    except Exception:
        return []


def api_invoice_coverage_meta(conn: Any) -> dict[str, Any]:
    """返回可选统计年度（集团台账年度 ∪ 发票 DWD 年度，去重降序），避免仅有单源年度时漏选。"""
    try:
        if not _coverage_views_ready(conn):
            return {
                "ok": True,
                "views_ready": False,
                "stat_years": [],
                "default_stat_year": None,
                "hint": "请先执行数据库初始化（init_all_tables）并维护台账、同步 dim_enterprise_year_roster 后重试。",
            }
        y_set: set[int] = set()
        for sql in (
            "SELECT DISTINCT stat_year FROM dim_enterprise_year_roster WHERE stat_year IS NOT NULL",
            "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL",
        ):
            for s in _distinct_stat_years(conn, sql):
                try:
                    yi = int(s)
                except (TypeError, ValueError):
                    continue
                if 1990 <= yi <= 2100:
                    y_set.add(yi)
        data_years = [str(y) for y in sorted(y_set, reverse=True)]
        if not data_years:
            data_years = _distinct_stat_years(
                conn, "SELECT DISTINCT stat_year FROM vw_audit_invoice_coverage_group_member ORDER BY stat_year DESC"
            )
        if not data_years:
            data_years = _distinct_stat_years(
                conn, "SELECT DISTINCT stat_year FROM dim_enterprise_year_rel ORDER BY stat_year DESC"
            )
        years = _practice_year_options(data_years)
        default_y = _default_practice_stat_year(years)
        group_years = _distinct_stat_years(
            conn,
            "SELECT DISTINCT stat_year FROM dim_enterprise_year_roster WHERE stat_year IS NOT NULL ORDER BY stat_year DESC",
        )
        level1_years = _distinct_stat_years(
            conn,
            "SELECT DISTINCT stat_year FROM dim_level1_enterprise_year WHERE stat_year IS NOT NULL ORDER BY stat_year DESC",
        )
        mapping_ready = _mapping_status_table_ready(conn)
        return {
            "ok": True,
            "views_ready": True,
            "stat_years": years,
            "default_stat_year": default_y,
            "group_member_stat_years": group_years,
            "roster_stat_years": group_years,
            "level1_stat_years": level1_years,
            "mapping_status_ready": mapping_ready,
        }
    except Exception as exc:
        return {
            "ok": False,
            "views_ready": False,
            "stat_years": [],
            "default_stat_year": None,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def api_invoice_coverage_soe_options(conn: Any, *, stat_year: str | None) -> dict[str, Any]:
    """指定年度下可选国家出资企业锚点（去重）。"""
    try:
        if not _coverage_views_ready(conn):
            return {"ok": True, "views_ready": False, "options": []}
        y = _safe_int_year(stat_year)
        rows = conn.execute(
            """
            SELECT DISTINCT soe_anchor_enterprise_id, soe_anchor_enterprise_name
            FROM vw_audit_invoice_coverage_group_member
            WHERE stat_year = ?
              AND trim(COALESCE(soe_anchor_enterprise_id, '')) <> ''
            ORDER BY soe_anchor_enterprise_name NULLS LAST, soe_anchor_enterprise_id
            """,
            [y],
        ).fetchall()
        options: list[dict[str, str]] = []
        for r in rows:
            if not r:
                continue
            eid = str(r[0] or "").strip()
            if not eid:
                continue
            options.append(
                {
                    "soe_anchor_enterprise_id": eid,
                    "soe_anchor_enterprise_name": str(r[1] or "").strip() or eid,
                }
            )
        return {"ok": True, "views_ready": True, "stat_year": str(y), "options": options}
    except Exception as exc:
        return {
            "ok": False,
            "options": [],
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def _mapping_status_table_ready(conn: Any) -> bool:
    try:
        conn.execute("SELECT 1 FROM dwd_enterprise_mapping_status LIMIT 1")
        return True
    except Exception:
        return False


def _latest_mapping_calc_run_id(conn: Any) -> str | None:
    try:
        row = conn.execute(
            """
            SELECT calc_run_id
            FROM dwd_enterprise_mapping_status
            GROUP BY calc_run_id
            ORDER BY max(calc_time) DESC NULLS LAST
            LIMIT 1
            """
        ).fetchone()
    except Exception:
        return None
    if not row or not row[0]:
        return None
    return str(row[0]).strip() or None


def _member_base_sql() -> str:
    return """
        SELECT
            v.stat_year,
            v.enterprise_id,
            v.enterprise_name,
            v.norm_enterprise_id,
            v.level1_group_id,
            v.level1_group_name,
            v.soe_anchor_enterprise_id,
            v.soe_anchor_enterprise_name,
            v.soe_anchor_source,
            v.subject_id,
            v.is_reported_both,
            v.in_coverage_denominator,
            v.has_seller_role,
            v.has_buyer_role,
            v.is_member,
            r.year_last_seen_batch_id
        FROM vw_audit_invoice_coverage_group_member v
        LEFT JOIN dim_enterprise_year_rel r
            ON r.subject_id = v.subject_id AND r.stat_year = v.stat_year
    """


def _append_member_filters(
    clauses: list[str],
    params: list[Any],
    *,
    stat_year: int,
    soe_anchor_id: str,
    soe_anchor_kw: str,
    level1_group_kw: str,
    enterprise_kw: str,
) -> None:
    clauses.append("v.stat_year = ?")
    params.append(stat_year)
    sid = (soe_anchor_id or "").strip()
    if sid:
        clauses.append("v.soe_anchor_enterprise_id = ?")
        params.append(sid)
    else:
        sk = _norm_kw(soe_anchor_kw)
        if sk:
            clauses.append(
                "(lower(v.soe_anchor_enterprise_name) LIKE ? OR lower(v.soe_anchor_enterprise_id) LIKE ?)"
            )
            like = f"%{sk}%"
            params.extend([like, like])
    gk = _norm_kw(level1_group_kw)
    if gk:
        clauses.append("(lower(v.level1_group_name) LIKE ? OR lower(v.level1_group_id) LIKE ?)")
        like_g = f"%{gk}%"
        params.extend([like_g, like_g])
    ek = _norm_kw(enterprise_kw)
    if ek:
        clauses.append(
            "("
            "lower(COALESCE(v.enterprise_name, '')) LIKE ? OR "
            "lower(COALESCE(v.enterprise_id, '')) LIKE ? OR "
            "lower(COALESCE(v.norm_enterprise_id, '')) LIKE ?"
            ")"
        )
        like_e = f"%{ek}%"
        params.extend([like_e, like_e, like_e])


def api_invoice_coverage_summary(
    conn: Any,
    *,
    stat_year: str | None,
    soe_anchor_id: str = "",
    soe_anchor_kw: str = "",
    level1_group_kw: str = "",
    enterprise_kw: str = "",
) -> dict[str, Any]:
    """与成员列表共用筛选条件，返回聚合 KPI。"""
    try:
        if not _coverage_views_ready(conn):
            return {
                "ok": True,
                "views_ready": False,
                "stat_year": None,
                "member_row_count": 0,
                "denominator_mapped_members": 0,
                "reported_both_members": 0,
                "unmapped_member_rows": 0,
                "coverage_ratio": None,
            }
        y = _safe_int_year(stat_year)
        clauses: list[str] = []
        params: list[Any] = []
        _append_member_filters(
            clauses,
            params,
            stat_year=y,
            soe_anchor_id=soe_anchor_id,
            soe_anchor_kw=soe_anchor_kw,
            level1_group_kw=level1_group_kw,
            enterprise_kw=enterprise_kw,
        )
        where_sql = " AND ".join(clauses) if clauses else "TRUE"
        sql = f"""
            SELECT
                COUNT(*) FILTER (WHERE COALESCE(v.is_member, TRUE)) AS member_row_count,
                COUNT(*) FILTER (WHERE v.in_coverage_denominator) AS denominator_mapped_members,
                COUNT(*) FILTER (WHERE v.is_reported_both AND v.in_coverage_denominator) AS reported_both_members,
                COUNT(*) FILTER (
                    WHERE COALESCE(v.is_member, TRUE)
                      AND v.subject_id IS NULL
                      AND length(trim(COALESCE(v.enterprise_id, ''))) > 0
                ) AS unmapped_member_rows
            FROM vw_audit_invoice_coverage_group_member v
            WHERE {where_sql}
        """
        row = conn.execute(sql, params).fetchone()
        if not row:
            return {
                "ok": True,
                "views_ready": True,
                "stat_year": str(y),
                "member_row_count": 0,
                "denominator_mapped_members": 0,
                "reported_both_members": 0,
                "unmapped_member_rows": 0,
                "coverage_ratio": None,
            }
        m_total = int(row[0] or 0)
        denom = int(row[1] or 0)
        reported = int(row[2] or 0)
        unmapped = int(row[3] or 0)
        ratio: float | None
        if denom <= 0:
            ratio = None
        else:
            ratio = round(float(reported) / float(denom), 6)
        return {
            "ok": True,
            "views_ready": True,
            "stat_year": str(y),
            "member_row_count": m_total,
            "denominator_mapped_members": denom,
            "reported_both_members": reported,
            "unmapped_member_rows": unmapped,
            "coverage_ratio": ratio,
        }
    except Exception as exc:
        logger.exception("invoice_coverage_summary")
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def api_invoice_coverage_members(
    conn: Any,
    *,
    stat_year: str | None,
    list_view: str = "unreported",
    soe_anchor_id: str = "",
    soe_anchor_kw: str = "",
    level1_group_kw: str = "",
    enterprise_kw: str = "",
    limit: int = 2000,
) -> dict[str, Any]:
    """成员明细列表。"""
    try:
        if not _coverage_views_ready(conn):
            return {"ok": True, "views_ready": False, "rows": [], "total": 0}
        y = _safe_int_year(stat_year)
        lv = (list_view or "unreported").strip().lower()
        if lv not in ("unreported", "reported", "all", "unmapped"):
            lv = "unreported"
        clauses: list[str] = []
        params: list[Any] = []
        _append_member_filters(
            clauses,
            params,
            stat_year=y,
            soe_anchor_id=soe_anchor_id,
            soe_anchor_kw=soe_anchor_kw,
            level1_group_kw=level1_group_kw,
            enterprise_kw=enterprise_kw,
        )
        if lv == "unreported":
            clauses.append("v.in_coverage_denominator AND NOT v.is_reported_both")
        elif lv == "reported":
            clauses.append("v.in_coverage_denominator AND v.is_reported_both")
        elif lv == "unmapped":
            clauses.append(
                "COALESCE(v.is_member, TRUE)"
                " AND v.subject_id IS NULL"
                " AND length(trim(COALESCE(v.enterprise_id, ''))) > 0"
            )
        else:
            clauses.append("COALESCE(v.is_member, TRUE)")
        where_sql = " AND ".join(clauses) if clauses else "TRUE"
        lim = max(1, min(int(limit or 2000), 5000))
        count_sql = f"""
            SELECT COUNT(*)
            FROM vw_audit_invoice_coverage_group_member v
            LEFT JOIN dim_enterprise_year_rel r
                ON r.subject_id = v.subject_id AND r.stat_year = v.stat_year
            WHERE {where_sql}
        """
        total = int(conn.execute(count_sql, list(params)).fetchone()[0] or 0)
        list_sql = f"""
            {_member_base_sql()}
            WHERE {where_sql}
            ORDER BY COALESCE(v.enterprise_name, ''), v.enterprise_id
            LIMIT {lim}
        """
        rows_out: list[dict[str, Any]] = []
        for r in conn.execute(list_sql, list(params)).fetchall():
            if not r:
                continue
            hs = bool(r[12])
            hb = bool(r[13])
            if hs and hb:
                role = "both"
            elif hs:
                role = "seller"
            elif hb:
                role = "buyer"
            else:
                role = "unknown"
            rows_out.append(
                {
                    "enterprise_id": str(r[1] or ""),
                    "enterprise_name": str(r[2] or ""),
                    "norm_enterprise_id": str(r[3] or ""),
                    "level1_group_id": str(r[4] or ""),
                    "level1_group_name": str(r[5] or ""),
                    "soe_anchor_enterprise_id": str(r[6] or ""),
                    "soe_anchor_enterprise_name": str(r[7] or ""),
                    "soe_anchor_source": str(r[8] or ""),
                    "subject_id": str(r[9] or "") if r[9] is not None else None,
                    "is_reported_both": bool(r[10]),
                    "in_coverage_denominator": bool(r[11]),
                    "has_seller_role": hs,
                    "has_buyer_role": hb,
                    "role_tag": role,
                    "year_last_seen_batch_id": str(r[15] or "") if r[15] is not None else "",
                }
            )
        return {
            "ok": True,
            "views_ready": True,
            "stat_year": str(y),
            "list_view": lv,
            "rows": rows_out,
            "total": total,
            "limit": lim,
        }
    except Exception as exc:
        logger.exception("invoice_coverage_members")
        return {
            "ok": False,
            "rows": [],
            "total": 0,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def api_invoice_coverage_mapping_status(
    conn: Any,
    *,
    stat_year: str | None,
    enterprise_kw: str = "",
    match_status: str = "pending",
    limit: int = 2000,
) -> dict[str, Any]:
    """票面销购方与 dim_enterprise 映射质检（dwd_enterprise_mapping_status 最新批次）。"""
    try:
        if not _mapping_status_table_ready(conn):
            return {
                "ok": True,
                "mapping_status_ready": False,
                "rows": [],
                "total": 0,
                "hint": "尚未执行「企业→票映射质检」任务（enterprise_mapping_check），请到加工中心 → DWD→DIM 运行任务 6。",
            }
        run_id = _latest_mapping_calc_run_id(conn)
        if not run_id:
            return {
                "ok": True,
                "mapping_status_ready": True,
                "rows": [],
                "total": 0,
                "hint": "映射质检表为空，请先运行 enterprise_mapping_check 任务。",
            }
        y = _safe_int_year(stat_year) if stat_year else None
        ms = (match_status or "pending").strip().lower()
        if ms not in ("pending", "name_fallback", "matched", "all"):
            ms = "pending"
        clauses = ["m.calc_run_id = ?"]
        params: list[Any] = [run_id]
        if ms != "all":
            clauses.append("m.match_status = ?")
            params.append("name_fallback" if ms == "name_fallback" else ms)
        ek = _norm_kw(enterprise_kw)
        if ek:
            clauses.append(
                "("
                "lower(COALESCE(m.enterprise_name_raw, '')) LIKE ? OR "
                "lower(COALESCE(m.taxpayer_id, '')) LIKE ? OR "
                "lower(COALESCE(m.enterprise_name_std, '')) LIKE ?"
                ")"
            )
            like_e = f"%{ek}%"
            params.extend([like_e, like_e, like_e])
        if y is not None:
            clauses.append(
                "("
                "EXISTS ("
                "  SELECT 1 FROM dim_enterprise_year_roster ro"
                "  WHERE ro.stat_year = ?"
                "    AND upper(regexp_replace(trim(COALESCE(ro.enterprise_id, '')), '[\\s-]+', '', 'g'))"
                "      = upper(trim(COALESCE(m.taxpayer_id, '')))"
                ") OR EXISTS ("
                "  SELECT 1 FROM dwd_inv_header h"
                "  WHERE h.stat_year = ?"
                "    AND ("
                "      upper(trim(COALESCE(h.xfsbh, ''))) = upper(trim(COALESCE(m.taxpayer_id, '')))"
                "      OR upper(trim(COALESCE(h.gfsbh, ''))) = upper(trim(COALESCE(m.taxpayer_id, '')))"
                "    )"
                ")"
                ")"
            )
            params.extend([y, y])
        where_sql = " AND ".join(clauses)
        lim = max(1, min(int(limit or 2000), 5000))
        count_sql = f"SELECT COUNT(*) FROM dwd_enterprise_mapping_status m WHERE {where_sql}"
        total = int(conn.execute(count_sql, list(params)).fetchone()[0] or 0)
        list_sql = f"""
            SELECT
                m.taxpayer_id,
                m.enterprise_name_raw,
                m.enterprise_name_std,
                m.linked_enterprise_id,
                m.linked_taxpayer_id,
                m.match_key,
                m.match_status,
                m.pending_reason,
                m.import_batch_id,
                m.calc_run_id,
                m.calc_time
            FROM dwd_enterprise_mapping_status m
            WHERE {where_sql}
            ORDER BY
                CASE m.match_status WHEN 'pending' THEN 0 WHEN 'name_fallback' THEN 1 ELSE 2 END,
                COALESCE(m.enterprise_name_raw, ''),
                COALESCE(m.taxpayer_id, '')
            LIMIT {lim}
        """
        rows_out: list[dict[str, Any]] = []
        for r in conn.execute(list_sql, list(params)).fetchall():
            if not r:
                continue
            status_raw = str(r[6] or "pending")
            status_label = {
                "matched": "已匹配",
                "name_fallback": "名称兜底",
                "pending": "待匹配",
            }.get(status_raw, status_raw)
            reason_raw = str(r[7] or "")
            reason_label = {
                "missing_taxpayer_id": "缺少税号",
                "taxpayer_not_in_dim_enterprise": "税号未入 dim_enterprise",
            }.get(reason_raw, reason_raw)
            rows_out.append(
                {
                    "taxpayer_id": str(r[0] or ""),
                    "enterprise_name_raw": str(r[1] or ""),
                    "enterprise_name_std": str(r[2] or ""),
                    "linked_enterprise_id": str(r[3] or "") if r[3] is not None else "",
                    "linked_taxpayer_id": str(r[4] or "") if r[4] is not None else "",
                    "match_key": str(r[5] or ""),
                    "match_status": status_raw,
                    "match_status_label": status_label,
                    "pending_reason": reason_raw,
                    "pending_reason_label": reason_label,
                    "import_batch_id": str(r[8] or "") if r[8] is not None else "",
                    "calc_run_id": str(r[9] or ""),
                    "calc_time": str(r[10] or "") if r[10] is not None else "",
                }
            )
        return {
            "ok": True,
            "mapping_status_ready": True,
            "calc_run_id": run_id,
            "stat_year": str(y) if y is not None else None,
            "match_status": ms,
            "rows": rows_out,
            "total": total,
            "limit": lim,
        }
    except Exception as exc:
        logger.exception("invoice_coverage_mapping_status")
        return {
            "ok": False,
            "rows": [],
            "total": 0,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
