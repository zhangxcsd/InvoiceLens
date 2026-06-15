"""DWS 看板只读 API 与手动刷新入口。"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)


def _calendar_year() -> int:
    return date.today().year


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = _calendar_year() if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _norm_entity(v: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _distinct_dws_years(conn: Any) -> list[str]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM dws_inv_trend WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL",
    ):
        try:
            for (yv,) in conn.execute(sql).fetchall() or []:
                if yv is not None:
                    yi = int(yv)
                    if 1990 <= yi <= 2100:
                        years.add(yi)
        except Exception:
            continue
    if not years:
        return [str(_calendar_year())]
    return [str(y) for y in sorted(years, reverse=True)]


def _entity_filter_clause(entity_id: str | None, col: str = "entity_id") -> tuple[str, list[Any]]:
    eid = _norm_entity(entity_id)
    if not eid:
        return "", []
    return f" AND {col} = ?", [eid]


def _parse_iso_date(v: str | None) -> date | None:
    if not v or not str(v).strip():
        return None
    s = str(v).strip()[:10]
    try:
        y, m, d = (int(x) for x in s.split("-", 2))
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def _parse_stat_month_param(v: str | None, stat_year: int) -> int | None:
    """解析 stat_month 查询参数：1–12 或 YYYY-MM（须与 stat_year 一致）。"""
    if not v or not str(v).strip():
        return None
    s = str(v).strip()
    if "-" in s:
        parts = s.split("-", 2)
        try:
            y = int(parts[0])
            m = int(parts[1])
            if y == stat_year and 1 <= m <= 12:
                return m
        except (ValueError, TypeError, IndexError):
            pass
        return None
    try:
        m = int(s)
        if 1 <= m <= 12:
            return m
    except ValueError:
        pass
    return None


def _month_bounds_from_date_range(
    date_from: str | None, date_to: str | None, stat_year: int
) -> tuple[int | None, int | None]:
    """由开票日期区间推导 stat_month 上下界（裁剪至 stat_year 年度内）。"""
    d_from = _parse_iso_date(date_from)
    d_to = _parse_iso_date(date_to)
    if d_from is None and d_to is None:
        return None, None
    year_start = date(stat_year, 1, 1)
    year_end = date(stat_year, 12, 31)
    if d_from is None:
        d_from = year_start
    if d_to is None:
        d_to = year_end
    if d_from < year_start:
        d_from = year_start
    if d_to > year_end:
        d_to = year_end
    if d_from > d_to or d_from.year != stat_year:
        return None, None
    return d_from.month, d_to.month


def _dws_trend_time_filter(
    *,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
    stat_year: int,
) -> tuple[str, list[Any], dict[str, Any]]:
    """dws_inv_trend 可选月份/日期区间过滤（预聚合表按 stat_month 粒度）。"""
    meta: dict[str, Any] = {}
    m_exact = _parse_stat_month_param(stat_month, stat_year)
    if m_exact is not None:
        meta["filter_stat_month"] = m_exact
        return " AND stat_month = ?", [m_exact], meta
    m_lo, m_hi = _month_bounds_from_date_range(date_from, date_to, stat_year)
    if m_lo is not None and m_hi is not None:
        meta["filter_stat_month_from"] = m_lo
        meta["filter_stat_month_to"] = m_hi
        if date_from:
            meta["filter_date_from"] = str(date_from).strip()[:10]
        if date_to:
            meta["filter_date_to"] = str(date_to).strip()[:10]
        return " AND stat_month BETWEEN ? AND ?", [m_lo, m_hi], meta
    return "", [], meta


def _has_dws_time_filter(
    stat_month: str | None, date_from: str | None, date_to: str | None
) -> bool:
    return bool(
        (stat_month and str(stat_month).strip())
        or (date_from and str(date_from).strip())
        or (date_to and str(date_to).strip())
    )


def _summary_supplier_cnt_from_dwd(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
) -> int:
    """有时间筛选时从 DWD 动态统计供应商数（与金额月份口径一致）。"""
    norm_xfs = _NORM_TAX_H.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX_H.format(col="h.gfsbh")
    htf, htp, _ = _dwd_header_time_filter(
        stat_month=stat_month, date_from=date_from, date_to=date_to, stat_year=stat_year
    )
    eid = _norm_entity(entity_id)
    if eid:
        sql = f"""
            SELECT count(DISTINCT {norm_xfs})::BIGINT
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {norm_gfs} = ?
              AND length({norm_xfs}) > 0
              {htf}
        """
        params: list[Any] = [stat_year, eid, *htp]
    else:
        sql = f"""
            SELECT count(DISTINCT {norm_xfs})::BIGINT
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND length({norm_xfs}) > 0
              AND length({norm_gfs}) > 0
              {htf}
        """
        params = [stat_year, *htp]
    return int(conn.execute(sql, params).fetchone()[0] or 0)


def _summary_quality_from_dwd(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
) -> tuple[int, float]:
    """有时间筛选时从 DWD 重算质量异常计数与平均分（与 dws_quality 公式一致）。"""
    norm_xfs = _NORM_TAX_H.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX_H.format(col="h.gfsbh")
    htf, htp, _ = _dwd_header_time_filter(
        stat_month=stat_month, date_from=date_from, date_to=date_to, stat_year=stat_year
    )
    eid = _norm_entity(entity_id)
    seller_entity_clause = ""
    buyer_entity_clause = ""
    seller_entity_params: list[Any] = []
    buyer_entity_params: list[Any] = []
    if eid:
        seller_entity_clause = f" AND {norm_xfs} = ?"
        buyer_entity_clause = f" AND {norm_gfs} = ?"
        seller_entity_params = [eid]
        buyer_entity_params = [eid]
    row = conn.execute(
        f"""
        WITH seller_hdr AS (
            SELECT
                {norm_xfs} AS entity_id,
                h.header_uuid,
                h.is_balanced,
                COALESCE(h.is_orphan_red, FALSE) AS is_orphan_red
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND length({norm_xfs}) > 0
              {htf}{seller_entity_clause}
        ),
        buyer_hdr AS (
            SELECT
                {norm_gfs} AS entity_id,
                h.header_uuid,
                h.is_balanced,
                COALESCE(h.is_orphan_red, FALSE) AS is_orphan_red
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND length({norm_gfs}) > 0
              {htf}{buyer_entity_clause}
        ),
        hdr AS (
            SELECT * FROM seller_hdr
            UNION ALL
            SELECT * FROM buyer_hdr
        ),
        dtl AS (
            SELECT header_uuid, count(*)::BIGINT AS cnt
            FROM dwd_inv_detail
            WHERE stat_year = ?
            GROUP BY header_uuid
        ),
        ent AS (
            SELECT
                h.entity_id,
                sum(
                    CASE
                        WHEN coalesce(h.is_balanced, '未校验') NOT IN ('平账', '差异可接受', '强制通过')
                        THEN 1 ELSE 0
                    END
                )::INT AS header_unbalanced,
                sum(CASE WHEN h.is_orphan_red THEN 1 ELSE 0 END)::INT AS unmatched_red_cnt,
                sum(CASE WHEN coalesce(d.cnt, 0) = 0 THEN 1 ELSE 0 END)::INT AS header_missing_detail
            FROM hdr h
            LEFT JOIN dtl d ON d.header_uuid = h.header_uuid
            WHERE length(h.entity_id) > 0
            GROUP BY h.entity_id
        )
        SELECT
            coalesce(sum(header_unbalanced + unmatched_red_cnt), 0)::BIGINT,
            coalesce(
                avg(
                    greatest(
                        0,
                        100
                        - least(40, header_unbalanced * 2)
                        - least(30, unmatched_red_cnt * 3)
                        - least(20, header_missing_detail)
                    )
                ),
                0
            )
        FROM ent
        """,
        [stat_year, *htp, *seller_entity_params, stat_year, *htp, *buyer_entity_params, stat_year],
    ).fetchone()
    if not row:
        return 0, 0.0
    return int(row[0] or 0), round(float(row[1] or 0), 2)


def _parse_quarter_param(v: str | None) -> int | None:
    """解析 quarter 查询参数：1–4 或 Q1–Q4。"""
    if not v or not str(v).strip():
        return None
    s = str(v).strip()
    if s.upper().startswith("Q"):
        s = s[1:]
    try:
        q = int(s)
        if 1 <= q <= 4:
            return q
    except ValueError:
        pass
    return None


def _dwd_header_time_filter(
    *,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
    stat_year: int,
    quarter: str | None = None,
) -> tuple[str, list[Any], dict[str, Any]]:
    """dwd_inv_header 可选月份/季度/开票日期过滤（supplier_top 动态聚合用）。"""
    meta: dict[str, Any] = {}
    m_exact = _parse_stat_month_param(stat_month, stat_year)
    if m_exact is not None:
        meta["filter_stat_month"] = m_exact
        return " AND h.stat_month = ?", [m_exact], meta
    q_exact = _parse_quarter_param(quarter)
    if q_exact is not None:
        lo = (q_exact - 1) * 3 + 1
        hi = q_exact * 3
        meta["filter_quarter"] = q_exact
        meta["filter_stat_month_from"] = lo
        meta["filter_stat_month_to"] = hi
        return " AND h.stat_month BETWEEN ? AND ?", [lo, hi], meta
    clauses: list[str] = []
    params: list[Any] = []
    if date_from:
        clauses.append("h.invoice_date >= ?")
        params.append(str(date_from).strip()[:10])
        meta["filter_date_from"] = str(date_from).strip()[:10]
    if date_to:
        clauses.append("h.invoice_date <= ?")
        params.append(str(date_to).strip()[:10])
        meta["filter_date_to"] = str(date_to).strip()[:10]
    if clauses:
        return " AND " + " AND ".join(clauses), params, meta
    m_lo, m_hi = _month_bounds_from_date_range(date_from, date_to, stat_year)
    if m_lo is not None and m_hi is not None:
        meta["filter_stat_month_from"] = m_lo
        meta["filter_stat_month_to"] = m_hi
        return " AND h.stat_month BETWEEN ? AND ?", [m_lo, m_hi], meta
    return "", [], meta


_NORM_TAX_H = "upper(regexp_replace(trim(COALESCE({col}, '')), '[\\s-]+', '', 'g'))"
_NET_AMT_H = "COALESCE(h.net_jshj, h.jshj, 0)"


def api_dws_meta(conn: Any) -> dict[str, Any]:
    try:
        years = _distinct_dws_years(conn)
        cy = str(_calendar_year())
        default_y = cy if cy in years else years[0]
        trend_cnt = 0
        try:
            trend_cnt = int(
                conn.execute("SELECT COUNT(*)::BIGINT FROM dws_inv_trend").fetchone()[0] or 0
            )
        except Exception:
            pass
        return {
            "ok": True,
            "stat_years": years,
            "default_stat_year": default_y,
            "dws_ready": trend_cnt > 0,
            "hint": None
            if trend_cnt > 0
            else "DWS 层尚无数据。请先完成 ODS→DWD 构建，再刷新 DWS 聚合（加工中心或 POST /api/dws/rebuild）。",
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_entity_options(conn: Any, *, stat_year: str | None) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        rows = conn.execute(
            """
            SELECT entity_id, any_value(entity_name) AS entity_name,
                   sum(net_jshj) AS total_net
            FROM dws_inv_trend
            WHERE stat_year = ?
            GROUP BY entity_id
            ORDER BY total_net DESC NULLS LAST, entity_id
            LIMIT 500
            """,
            [y],
        ).fetchall()
        options = [
            {
                "entity_id": str(r[0] or ""),
                "entity_name": str(r[1] or r[0] or ""),
                "total_net_jshj": float(r[2] or 0),
            }
            for r in rows or []
            if r and r[0]
        ]
        return {"ok": True, "stat_year": str(y), "options": options}
    except Exception as exc:
        return {"ok": False, "options": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_overview_summary(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        tf, tp, filter_meta = _dws_trend_time_filter(
            stat_month=stat_month, date_from=date_from, date_to=date_to, stat_year=y
        )
        row = conn.execute(
            f"""
            SELECT
                coalesce(sum(t.net_jshj), 0) AS total_net_jshj,
                coalesce(sum(t.normal_cnt + t.red_cnt + t.cancel_cnt), 0)::BIGINT AS invoice_cnt,
                coalesce(sum(t.red_cnt), 0)::BIGINT AS red_cnt,
                coalesce(sum(t.cancel_cnt), 0)::BIGINT AS cancel_cnt
            FROM dws_inv_trend t
            WHERE t.stat_year = ?{ef}{tf}
            """,
            [y, *ep, *tp],
        ).fetchone()
        has_time = _has_dws_time_filter(stat_month, date_from, date_to)
        if has_time:
            sup_cnt = _summary_supplier_cnt_from_dwd(
                conn,
                stat_year=y,
                entity_id=entity_id,
                stat_month=stat_month,
                date_from=date_from,
                date_to=date_to,
            )
            filter_meta["supplier_cnt_source"] = "dwd_inv_header"
            issue_cnt, avg_quality = _summary_quality_from_dwd(
                conn,
                stat_year=y,
                entity_id=entity_id,
                stat_month=stat_month,
                date_from=date_from,
                date_to=date_to,
            )
            filter_meta["quality_metrics_source"] = "dwd_inv_header"
        else:
            sup_sql = f"""
                SELECT count(DISTINCT supplier_id)::BIGINT
                FROM dws_sup_conc
                WHERE stat_year = ?{ef}
            """
            sup_cnt = int(conn.execute(sup_sql, [y, *ep]).fetchone()[0] or 0)
            filter_meta["supplier_cnt_source"] = "dws_sup_conc"
            q_sql = f"""
                SELECT
                    coalesce(sum(unmatched_red_cnt + header_unbalanced), 0)::BIGINT,
                    coalesce(avg(quality_score), 0)
                FROM dws_quality
                WHERE stat_year = ?{ef}
            """
            qrow = conn.execute(q_sql, [y, *ep]).fetchone()
            issue_cnt = int(qrow[0] or 0) if qrow else 0
            avg_quality = float(qrow[1] or 0) if qrow else 0.0
            filter_meta["quality_metrics_source"] = "dws_quality"
        out_cnt = 0.0
        in_cnt = 0.0
        role_rows = conn.execute(
            f"""
            SELECT role_type, coalesce(sum(net_jshj), 0)
            FROM dws_inv_trend
            WHERE stat_year = ?{ef}{tf}
            GROUP BY role_type
            """,
            [y, *ep, *tp],
        ).fetchall()
        for rt, amt in role_rows or []:
            if str(rt) == "销项":
                out_cnt = float(amt or 0)
            elif str(rt) == "进项":
                in_cnt = float(amt or 0)
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": _norm_entity(entity_id) or None,
            "total_net_jshj": float(row[0] or 0) if row else 0.0,
            "invoice_cnt": int(row[1] or 0) if row else 0,
            "red_cnt": int(row[2] or 0) if row else 0,
            "cancel_cnt": int(row[3] or 0) if row else 0,
            "output_net_jshj": out_cnt,
            "input_net_jshj": in_cnt,
            "supplier_cnt": sup_cnt,
            "quality_issue_cnt": issue_cnt,
            "avg_quality_score": round(avg_quality, 2),
            **filter_meta,
        }
    except Exception as exc:
        logger.exception("dws_overview_summary")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_overview_trend(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    role_type: str = "all",
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        tf, tp, filter_meta = _dws_trend_time_filter(
            stat_month=stat_month, date_from=date_from, date_to=date_to, stat_year=y
        )
        rt = (role_type or "all").strip()
        rt_clause = ""
        rt_params: list[Any] = []
        if rt in ("销项", "进项"):
            rt_clause = " AND role_type = ?"
            rt_params = [rt]
        rows = conn.execute(
            f"""
            SELECT
                stat_month,
                role_type,
                coalesce(sum(net_jshj), 0) AS net_jshj,
                coalesce(sum(normal_cnt + red_cnt + cancel_cnt), 0)::BIGINT AS invoice_cnt
            FROM dws_inv_trend
            WHERE stat_year = ?{ef}{tf}{rt_clause}
            GROUP BY stat_month, role_type
            ORDER BY stat_month, role_type
            """,
            [y, *ep, *tp, *rt_params],
        ).fetchall()
        out_rows = [
            {
                "stat_month": int(r[0]),
                "role_type": str(r[1] or ""),
                "net_jshj": float(r[2] or 0),
                "invoice_cnt": int(r[3] or 0),
            }
            for r in rows or []
        ]
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": _norm_entity(entity_id) or None,
            "role_type": rt,
            "rows": out_rows,
            **filter_meta,
        }
    except Exception as exc:
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _cr_from_sup_rows(rows: list[tuple[Any, ...]]) -> dict[str, float | None]:
    if not rows:
        return {"cr1": None, "cr3": None, "cr10": None, "total_net_jshj": 0.0}
    total = sum(float(r[2] or 0) for r in rows)
    if total <= 0:
        return {"cr1": None, "cr3": None, "cr10": None, "total_net_jshj": 0.0}

    def _cum_at(rank: int) -> float | None:
        for r in rows:
            if int(r[0] or 0) == rank:
                return round(float(r[3] or 0), 6)
        max_rank = max(int(r[0] or 0) for r in rows)
        if rank > max_rank:
            for r in rows:
                if int(r[0] or 0) == max_rank:
                    return round(float(r[3] or 0), 6)
        return None

    top1_ratio = float(rows[0][1] or 0) if rows else None
    return {
        "cr1": round(top1_ratio, 6) if top1_ratio is not None else None,
        "cr3": _cum_at(3),
        "cr10": _cum_at(10),
        "total_net_jshj": round(total, 2),
    }


def api_dws_supplier_cr(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        if not ep:
            return {
                "ok": False,
                "error": {
                    "message": "供应商集中度需指定购方企业（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        filter_meta: dict[str, Any] = {}
        if _has_dws_time_filter(stat_month, date_from, date_to):
            ranked, total, filter_meta = _supplier_ranked_rows_from_dwd(
                conn,
                stat_year=y,
                entity_id=ep[0],
                stat_month=stat_month,
                date_from=date_from,
                date_to=date_to,
                limit=None,
            )
            cr_rows = [(r[4], r[5], r[2], r[6]) for r in ranked]
            cr = _cr_from_sup_rows(cr_rows)
            supplier_cnt = total
        else:
            rows = conn.execute(
                f"""
                SELECT amount_rank, amount_ratio, net_jshj, cumulative_ratio
                FROM dws_sup_conc
                WHERE stat_year = ?{ef}
                ORDER BY amount_rank ASC
                """,
                [y, *ep],
            ).fetchall()
            cr = _cr_from_sup_rows(list(rows or []))
            supplier_cnt = len(rows or [])
            filter_meta["filter_source"] = "dws_sup_conc"
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": ep[0],
            "supplier_cnt": supplier_cnt,
            **cr,
            **filter_meta,
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _supplier_ranked_rows_from_dwd(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
    limit: int | None = None,
    quarter: str | None = None,
) -> tuple[list[tuple[Any, ...]], int, dict[str, Any]]:
    """按月份/季度/开票日期从 DWD 动态聚合供应商排名（与 dws_sup_conc 年度口径一致）。"""
    norm_xfs = _NORM_TAX_H.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX_H.format(col="h.gfsbh")
    tf, tp, filter_meta = _dwd_header_time_filter(
        stat_month=stat_month,
        date_from=date_from,
        date_to=date_to,
        stat_year=stat_year,
        quarter=quarter,
    )
    limit_clause = ""
    limit_params: list[Any] = []
    if limit is not None:
        lim = max(1, min(int(limit or 20), 100))
        limit_clause = " LIMIT ?"
        limit_params = [lim]
    base_sql = f"""
        WITH base AS (
            SELECT
                {norm_xfs} AS supplier_id,
                max(trim(COALESCE(h.xfmc, ''))) AS supplier_name,
                min(h.invoice_date) AS first_invoice_date,
                max(h.invoice_date) AS last_invoice_date,
                sum({_NET_AMT_H}) AS net_jshj,
                count(*)::INT AS invoice_cnt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {norm_gfs} = ?
              AND length({norm_xfs}) > 0
              {tf}
            GROUP BY 1
        ),
        prior AS (
            SELECT DISTINCT {norm_xfs} AS supplier_id
            FROM dwd_inv_header h
            WHERE h.stat_year < ?
              AND {norm_gfs} = ?
              AND length({norm_xfs}) > 0
        ),
        ranked AS (
            SELECT
                b.*,
                NOT EXISTS (
                    SELECT 1 FROM prior p WHERE p.supplier_id = b.supplier_id
                ) AS is_new_supplier,
                sum(b.net_jshj) OVER () AS entity_total,
                row_number() OVER (ORDER BY b.net_jshj DESC, b.supplier_id) AS amount_rank,
                sum(b.net_jshj) OVER (
                    ORDER BY b.net_jshj DESC, b.supplier_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cum_amt
            FROM base b
        )
        SELECT
            supplier_id, supplier_name, net_jshj, invoice_cnt,
            amount_rank,
            CASE WHEN entity_total = 0 THEN 0 ELSE net_jshj / entity_total END,
            CASE WHEN entity_total = 0 THEN 0 ELSE cum_amt / entity_total END,
            is_new_supplier,
            first_invoice_date, last_invoice_date
        FROM ranked
        ORDER BY amount_rank ASC
        {limit_clause}
    """
    params = [stat_year, entity_id, *tp, stat_year, entity_id, *limit_params]
    rows = conn.execute(base_sql, params).fetchall()
    count_sql = f"""
        SELECT count(DISTINCT {norm_xfs})::BIGINT
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND {norm_gfs} = ?
          AND length({norm_xfs}) > 0
          {tf}
    """
    total = int(conn.execute(count_sql, [stat_year, entity_id, *tp]).fetchone()[0] or 0)
    filter_meta["filter_source"] = "dwd_inv_header"
    return list(rows or []), total, filter_meta


def _supplier_top_from_dwd(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str,
    limit: int,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
    quarter: str | None = None,
) -> tuple[list[tuple[Any, ...]], int, dict[str, Any]]:
    return _supplier_ranked_rows_from_dwd(
        conn,
        stat_year=stat_year,
        entity_id=entity_id,
        stat_month=stat_month,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        quarter=quarter,
    )


def api_dws_supplier_top(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    limit: int = 20,
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    quarter: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        if not ep:
            return {
                "ok": False,
                "error": {
                    "message": "Top 供应商明细需指定购方企业（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        lim = max(1, min(int(limit or 20), 100))
        has_time_filter = bool(
            (stat_month and str(stat_month).strip())
            or (quarter and str(quarter).strip())
            or (date_from and str(date_from).strip())
            or (date_to and str(date_to).strip())
        )
        filter_meta: dict[str, Any] = {}
        if has_time_filter:
            rows, total, filter_meta = _supplier_top_from_dwd(
                conn,
                stat_year=y,
                entity_id=ep[0],
                limit=lim,
                stat_month=stat_month,
                date_from=date_from,
                date_to=date_to,
                quarter=quarter,
            )
        else:
            rows = conn.execute(
                f"""
                SELECT
                    supplier_id, supplier_name, net_jshj, invoice_cnt,
                    amount_rank, amount_ratio, cumulative_ratio, is_new_supplier,
                    first_invoice_date, last_invoice_date
                FROM dws_sup_conc
                WHERE stat_year = ?{ef}
                ORDER BY amount_rank ASC
                LIMIT {lim}
                """,
                [y, *ep],
            ).fetchall()
            total = int(
                conn.execute(
                    f"SELECT COUNT(*)::BIGINT FROM dws_sup_conc WHERE stat_year = ?{ef}",
                    [y, *ep],
                ).fetchone()[0]
                or 0
            )
            filter_meta["filter_source"] = "dws_sup_conc"
        out = [
            {
                "supplier_id": str(r[0] or ""),
                "supplier_name": str(r[1] or r[0] or ""),
                "net_jshj": float(r[2] or 0),
                "invoice_cnt": int(r[3] or 0),
                "amount_rank": int(r[4] or 0),
                "amount_ratio": float(r[5] or 0),
                "cumulative_ratio": float(r[6] or 0),
                "is_new_supplier": bool(r[7]),
                "first_invoice_date": str(r[8] or "") if r[8] else "",
                "last_invoice_date": str(r[9] or "") if r[9] else "",
            }
            for r in rows or []
        ]
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": ep[0],
            "rows": out,
            "total": total,
            "limit": lim,
            **filter_meta,
        }
    except Exception as exc:
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_supplier_churn(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    kind: str = "new",
    top_only: bool = False,
    keyword: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """新增 / 消失供应商清单（基于 dws_sup_conc 年度对比）。"""
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        if not ep:
            return {
                "ok": False,
                "error": {
                    "message": "新增/消失供应商分析需指定购方企业（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        k = (kind or "new").strip().lower()
        if k not in ("new", "disappeared"):
            k = "new"
        lim = max(1, min(int(limit or 50), 500))
        off = max(0, int(offset or 0))
        kw = (keyword or "").strip()
        kw_clause = ""
        kw_params: list[Any] = []
        if kw:
            kw_clause = " AND (supplier_name ILIKE ? OR supplier_id ILIKE ?)"
            like = f"%{kw}%"
            kw_params = [like, like]

        prior_y = y - 1
        summary = {"new_total": 0, "new_top10": 0, "disappeared_total": 0, "prior_year": str(prior_y)}

        try:
            new_cnt_row = conn.execute(
                f"""
                SELECT count(*)::BIGINT,
                       count(*) FILTER (WHERE amount_rank <= 10)::BIGINT
                FROM dws_sup_conc
                WHERE stat_year = ? AND entity_id = ? AND is_new_supplier = TRUE
                """,
                [y, ep[0]],
            ).fetchone()
            if new_cnt_row:
                summary["new_total"] = int(new_cnt_row[0] or 0)
                summary["new_top10"] = int(new_cnt_row[1] or 0)
        except Exception:
            pass

        if prior_y >= 1990:
            try:
                dis_cnt = conn.execute(
                    """
                    SELECT count(*)::BIGINT
                    FROM dws_sup_conc prior
                    WHERE prior.stat_year = ? AND prior.entity_id = ?
                      AND NOT EXISTS (
                        SELECT 1 FROM dws_sup_conc cur
                        WHERE cur.stat_year = ? AND cur.entity_id = prior.entity_id
                          AND cur.supplier_id = prior.supplier_id
                      )
                    """,
                    [prior_y, ep[0], y],
                ).fetchone()
                summary["disappeared_total"] = int(dis_cnt[0] or 0) if dis_cnt else 0
            except Exception:
                pass

        if k == "new":
            top_clause = " AND amount_rank <= 10" if top_only else ""
            count_sql = f"""
                SELECT count(*)::BIGINT FROM dws_sup_conc
                WHERE stat_year = ? AND entity_id = ? AND is_new_supplier = TRUE{top_clause}{kw_clause}
            """
            total = int(conn.execute(count_sql, [y, ep[0], *kw_params]).fetchone()[0] or 0)
            rows = conn.execute(
                f"""
                SELECT
                    supplier_id, supplier_name, net_jshj, invoice_cnt,
                    amount_rank, amount_ratio, cumulative_ratio,
                    first_invoice_date, last_invoice_date
                FROM dws_sup_conc
                WHERE stat_year = ? AND entity_id = ? AND is_new_supplier = TRUE{top_clause}{kw_clause}
                ORDER BY amount_rank ASC, net_jshj DESC, supplier_id
                LIMIT ? OFFSET ?
                """,
                [y, ep[0], *kw_params, lim, off],
            ).fetchall()
            out = [
                {
                    "supplier_id": str(r[0] or ""),
                    "supplier_name": str(r[1] or r[0] or ""),
                    "net_jshj": float(r[2] or 0),
                    "invoice_cnt": int(r[3] or 0),
                    "amount_rank": int(r[4] or 0),
                    "amount_ratio": float(r[5] or 0),
                    "cumulative_ratio": float(r[6] or 0),
                    "first_invoice_date": str(r[7] or "") if r[7] else "",
                    "last_invoice_date": str(r[8] or "") if r[8] else "",
                    "is_top10": int(r[4] or 0) <= 10,
                    "churn_kind": "new",
                }
                for r in rows or []
            ]
            hint = None if total > 0 else f"{y} 年度该主体无新增供应商（相对 {prior_y} 及以前年度）。"
        else:
            if prior_y < 1990:
                return {
                    "ok": True,
                    "stat_year": str(y),
                    "prior_year": str(prior_y),
                    "entity_id": ep[0],
                    "kind": k,
                    "rows": [],
                    "total": 0,
                    "summary": summary,
                    "hint": "无法计算消失供应商：当前年度过小。",
                }
            dis_kw_clause = ""
            dis_kw_params: list[Any] = []
            if kw:
                dis_kw_clause = " AND (prior.supplier_name ILIKE ? OR prior.supplier_id ILIKE ?)"
                like = f"%{kw}%"
                dis_kw_params = [like, like]
            count_sql = f"""
                SELECT count(*)::BIGINT
                FROM dws_sup_conc prior
                WHERE prior.stat_year = ? AND prior.entity_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM dws_sup_conc cur
                    WHERE cur.stat_year = ? AND cur.entity_id = prior.entity_id
                      AND cur.supplier_id = prior.supplier_id
                  ){dis_kw_clause}
            """
            total = int(
                conn.execute(count_sql, [prior_y, ep[0], y, *dis_kw_params]).fetchone()[0] or 0
            )
            rows = conn.execute(
                f"""
                SELECT
                    prior.supplier_id, prior.supplier_name, prior.net_jshj, prior.invoice_cnt,
                    prior.amount_rank, prior.amount_ratio, prior.cumulative_ratio,
                    prior.first_invoice_date, prior.last_invoice_date
                FROM dws_sup_conc prior
                WHERE prior.stat_year = ? AND prior.entity_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM dws_sup_conc cur
                    WHERE cur.stat_year = ? AND cur.entity_id = prior.entity_id
                      AND cur.supplier_id = prior.supplier_id
                  ){dis_kw_clause}
                ORDER BY prior.net_jshj DESC NULLS LAST, prior.supplier_id
                LIMIT ? OFFSET ?
                """,
                [prior_y, ep[0], y, *dis_kw_params, lim, off],
            ).fetchall()
            out = [
                {
                    "supplier_id": str(r[0] or ""),
                    "supplier_name": str(r[1] or r[0] or ""),
                    "net_jshj": float(r[2] or 0),
                    "invoice_cnt": int(r[3] or 0),
                    "amount_rank": int(r[4] or 0),
                    "amount_ratio": float(r[5] or 0),
                    "cumulative_ratio": float(r[6] or 0),
                    "first_invoice_date": str(r[7] or "") if r[7] else "",
                    "last_invoice_date": str(r[8] or "") if r[8] else "",
                    "is_top10": False,
                    "churn_kind": "disappeared",
                    "compare_year": prior_y,
                }
                for r in rows or []
            ]
            hint = (
                None
                if total > 0
                else f"{prior_y}→{y} 年度对比：该主体无消失供应商（上年有、当年无）。"
            )

        return {
            "ok": True,
            "stat_year": str(y),
            "prior_year": str(prior_y),
            "entity_id": ep[0],
            "kind": k,
            "top_only": top_only,
            "rows": out,
            "total": total,
            "limit": lim,
            "offset": off,
            "summary": summary,
            "hint": hint,
        }
    except Exception as exc:
        logger.exception("dws_supplier_churn")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


_TAX_BUCKET_SQL = """
CASE
    WHEN d.slv_num >= 0.12 THEN '13%'
    WHEN d.slv_num >= 0.08 THEN '9%'
    WHEN d.slv_num >= 0.05 THEN '6%'
    WHEN d.slv_num >= 0.025 THEN '3%'
    WHEN d.slv_num > 0 AND d.slv_num < 0.025 THEN '其他'
    WHEN coalesce(trim(cast(d.slv AS VARCHAR)), '') ILIKE '%免税%'
      OR coalesce(trim(cast(d.slv AS VARCHAR)), '') ILIKE '%零税率%'
      OR d.slv_num = 0 THEN '免税/零税率'
    ELSE '其他'
END
"""


def api_dws_overview_tax(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    role_type: str = "进项",
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """按税率档次汇总明细金额（dwd_inv_detail + header 业务口径）。"""
    try:
        y = _safe_int_year(stat_year)
        rt = (role_type or "进项").strip()
        norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
        norm_gfs = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
        eid = _norm_entity(entity_id)
        entity_clause = ""
        entity_params: list[Any] = []
        if eid:
            if rt == "销项":
                entity_clause = f" AND {norm_xfs} = ?"
            else:
                entity_clause = f" AND {norm_gfs} = ?"
            entity_params = [eid]

        role_clause = ""
        if rt == "销项":
            role_clause = f" AND length({norm_xfs}) > 0"
        elif rt == "进项":
            role_clause = f" AND length({norm_gfs}) > 0"

        htf, htp, filter_meta = _dwd_header_time_filter(
            stat_month=stat_month, date_from=date_from, date_to=date_to, stat_year=y
        )

        _net_amt = "COALESCE(h.net_jshj, h.jshj, 0)"
        _is_red = f"({_net_amt} < 0 OR COALESCE(h.is_orphan_red, FALSE))"
        _is_cancel = (
            "(coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') <> '正常' "
            "OR COALESCE(h.net_calc_status, '') = '已作废')"
        )
        biz_filter = f"NOT ({_is_red}) AND NOT ({_is_cancel})"

        rows = conn.execute(
            f"""
            SELECT
                {_TAX_BUCKET_SQL} AS tax_bucket,
                coalesce(sum(abs(d.je)), 0) AS amount_je,
                count(*)::BIGINT AS line_cnt
            FROM dwd_inv_detail d
            INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
            WHERE d.stat_year = ?
              AND d.logic_line_no > 0
              AND {biz_filter}
              {role_clause}
              {entity_clause}
              {htf}
            GROUP BY 1
            ORDER BY amount_je DESC
            """,
            [y, *entity_params, *htp],
        ).fetchall()

        bucket_order = ["13%", "9%", "6%", "3%", "免税/零税率", "其他"]
        raw_map: dict[str, dict[str, Any]] = {}
        total_amt = 0.0
        total_lines = 0
        for r in rows or []:
            bucket = str(r[0] or "其他")
            amt = float(r[1] or 0)
            cnt = int(r[2] or 0)
            raw_map[bucket] = {"tax_bucket": bucket, "amount_je": amt, "line_cnt": cnt}
            total_amt += amt
            total_lines += cnt

        out_rows = []
        seen: set[str] = set()
        for b in bucket_order:
            if b in raw_map:
                item = raw_map[b]
                seen.add(b)
            else:
                item = {"tax_bucket": b, "amount_je": 0.0, "line_cnt": 0}
            ratio = round(item["amount_je"] / total_amt, 6) if total_amt > 0 else 0.0
            out_rows.append({**item, "amount_ratio": ratio})
        for b, item in raw_map.items():
            if b not in seen:
                ratio = round(item["amount_je"] / total_amt, 6) if total_amt > 0 else 0.0
                out_rows.append({**item, "amount_ratio": ratio})

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid or None,
            "role_type": rt,
            "total_amount_je": round(total_amt, 2),
            "total_line_cnt": total_lines,
            "rows": out_rows,
            **filter_meta,
        }
    except Exception as exc:
        logger.exception("dws_overview_tax")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_overview_tax_monthly(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    role_type: str = "进项",
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """按月 + 税率档次汇总明细金额与当月占比（与 api_dws_overview_tax 同口径）。"""
    try:
        y = _safe_int_year(stat_year)
        rt = (role_type or "进项").strip()
        norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
        norm_gfs = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
        eid = _norm_entity(entity_id)
        entity_clause = ""
        entity_params: list[Any] = []
        if eid:
            if rt == "销项":
                entity_clause = f" AND {norm_xfs} = ?"
            else:
                entity_clause = f" AND {norm_gfs} = ?"
            entity_params = [eid]

        role_clause = ""
        if rt == "销项":
            role_clause = f" AND length({norm_xfs}) > 0"
        elif rt == "进项":
            role_clause = f" AND length({norm_gfs}) > 0"

        htf, htp, filter_meta = _dwd_header_time_filter(
            stat_month=stat_month, date_from=date_from, date_to=date_to, stat_year=y
        )

        _net_amt = "COALESCE(h.net_jshj, h.jshj, 0)"
        _is_red = f"({_net_amt} < 0 OR COALESCE(h.is_orphan_red, FALSE))"
        _is_cancel = (
            "(coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') <> '正常' "
            "OR COALESCE(h.net_calc_status, '') = '已作废')"
        )
        biz_filter = f"NOT ({_is_red}) AND NOT ({_is_cancel})"

        rows = conn.execute(
            f"""
            SELECT
                d.stat_month,
                {_TAX_BUCKET_SQL} AS tax_bucket,
                coalesce(sum(abs(d.je)), 0) AS amount_je,
                count(*)::BIGINT AS line_cnt
            FROM dwd_inv_detail d
            INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
            WHERE d.stat_year = ?
              AND d.logic_line_no > 0
              AND {biz_filter}
              {role_clause}
              {entity_clause}
              {htf}
            GROUP BY 1, 2
            ORDER BY 1, amount_je DESC
            """,
            [y, *entity_params, *htp],
        ).fetchall()

        bucket_order = ["13%", "9%", "6%", "3%", "免税/零税率", "其他"]
        month_map: dict[int, dict[str, dict[str, Any]]] = {}
        month_totals: dict[int, float] = {}
        for r in rows or []:
            m = int(r[0])
            bucket = str(r[1] or "其他")
            amt = float(r[2] or 0)
            cnt = int(r[3] or 0)
            if m not in month_map:
                month_map[m] = {}
            month_map[m][bucket] = {"tax_bucket": bucket, "amount_je": amt, "line_cnt": cnt}
            month_totals[m] = month_totals.get(m, 0.0) + amt

        out_rows: list[dict[str, Any]] = []
        for m in sorted(month_map.keys()):
            total_amt = month_totals.get(m, 0.0)
            raw = month_map[m]
            seen: set[str] = set()
            for b in bucket_order:
                if b in raw:
                    item = raw[b]
                    seen.add(b)
                else:
                    item = {"tax_bucket": b, "amount_je": 0.0, "line_cnt": 0}
                ratio = round(item["amount_je"] / total_amt, 6) if total_amt > 0 else 0.0
                out_rows.append(
                    {
                        "stat_month": m,
                        **item,
                        "amount_ratio": ratio,
                        "month_total_amount_je": round(total_amt, 2),
                    }
                )
            for b, item in raw.items():
                if b not in seen:
                    ratio = round(item["amount_je"] / total_amt, 6) if total_amt > 0 else 0.0
                    out_rows.append(
                        {
                            "stat_month": m,
                            **item,
                            "amount_ratio": ratio,
                            "month_total_amount_je": round(total_amt, 2),
                        }
                    )

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid or None,
            "role_type": rt,
            "rows": out_rows,
            **filter_meta,
        }
    except Exception as exc:
        logger.exception("dws_overview_tax_monthly")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _tax_bucket_rows(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str,
    role_type: str,
) -> tuple[list[dict[str, Any]], float, int]:
    """按税率档次汇总明细金额（与 api_dws_overview_tax 同口径）。"""
    rt = (role_type or "进项").strip()
    norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
    norm_gfs = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
    if rt == "销项":
        entity_clause = f" AND {norm_xfs} = ?"
        role_clause = f" AND length({norm_xfs}) > 0"
    else:
        entity_clause = f" AND {norm_gfs} = ?"
        role_clause = f" AND length({norm_gfs}) > 0"

    _net_amt = "COALESCE(h.net_jshj, h.jshj, 0)"
    _is_red = f"({_net_amt} < 0 OR COALESCE(h.is_orphan_red, FALSE))"
    _is_cancel = (
        "(coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') <> '正常' "
        "OR COALESCE(h.net_calc_status, '') = '已作废')"
    )
    biz_filter = f"NOT ({_is_red}) AND NOT ({_is_cancel})"

    rows = conn.execute(
        f"""
        SELECT
            {_TAX_BUCKET_SQL} AS tax_bucket,
            coalesce(sum(abs(d.je)), 0) AS amount_je,
            count(*)::BIGINT AS line_cnt
        FROM dwd_inv_detail d
        INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
        WHERE d.stat_year = ?
          AND d.logic_line_no > 0
          AND {biz_filter}
          {role_clause}
          {entity_clause}
        GROUP BY 1
        ORDER BY amount_je DESC
        """,
        [stat_year, entity_id],
    ).fetchall()

    bucket_order = ["13%", "9%", "6%", "3%", "免税/零税率", "其他"]
    raw_map: dict[str, dict[str, Any]] = {}
    total_amt = 0.0
    total_lines = 0
    for r in rows or []:
        bucket = str(r[0] or "其他")
        amt = float(r[1] or 0)
        cnt = int(r[2] or 0)
        raw_map[bucket] = {"tax_bucket": bucket, "amount_je": amt, "line_cnt": cnt}
        total_amt += amt
        total_lines += cnt

    out_rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for b in bucket_order:
        item = raw_map.get(b, {"tax_bucket": b, "amount_je": 0.0, "line_cnt": 0})
        seen.add(b)
        ratio = round(item["amount_je"] / total_amt, 6) if total_amt > 0 else 0.0
        out_rows.append({**item, "amount_ratio": ratio})
    for b, item in raw_map.items():
        if b not in seen:
            ratio = round(item["amount_je"] / total_amt, 6) if total_amt > 0 else 0.0
            out_rows.append({**item, "amount_ratio": ratio})
    return out_rows, round(total_amt, 2), total_lines


def api_dws_trade_relationships(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    role_filter: str = "all",
    keyword: str | None = None,
    counterparty_id: str | None = None,
    party_a_tax: str | None = None,
    party_b_tax: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """
    L2 往来关系层：合并 dws_trade_sum 双向边，判定 counterparty_role。

    口径：同一 (entity_id, counterparty_id) 若同时存在「供应商」「客户」方向则标为「往来单位」；
    仅购方方向为「供应商」，仅销方方向为「客户」。不修改底层 dws_trade_sum 定向边。
    """
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        if not ep:
            return {
                "ok": False,
                "error": {
                    "message": "往来关系分析需指定分析主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        rf = (role_filter or "all").strip()
        if rf not in ("all", "供应商", "客户", "往来单位"):
            rf = "all"
        lim = max(1, min(int(limit or 100), 500))
        off = max(0, int(offset or 0))
        kw = (keyword or "").strip()
        kw_clause = ""
        kw_params: list[Any] = []
        if kw:
            kw_clause = " AND (counterparty_name ILIKE ? OR counterparty_id ILIKE ?)"
            like = f"%{kw}%"
            kw_params = [like, like]

        cp_filter = _norm_entity(counterparty_id)
        pa = _norm_entity(party_a_tax)
        pb = _norm_entity(party_b_tax)
        if not cp_filter and pa and pb:
            # 审计含义：RULE-09 等对开发票深链，entity 为 party_a 时对手为 party_b
            if ep and ep[0] == pa:
                cp_filter = pb
            elif ep and ep[0] == pb:
                cp_filter = pa
            else:
                cp_filter = pb
        cp_clause = ""
        cp_params: list[Any] = []
        if cp_filter:
            cp_clause = " AND counterparty_id = ?"
            cp_params = [cp_filter]

        role_case = """
            CASE
                WHEN has_supplier AND has_customer THEN '往来单位'
                WHEN has_supplier THEN '供应商'
                WHEN has_customer THEN '客户'
                ELSE '未知'
            END
        """
        role_filter_clause = ""
        role_filter_params: list[Any] = []
        if rf != "all":
            role_filter_clause = f" AND counterparty_role = ?"
            role_filter_params = [rf]

        base_cte = f"""
        WITH directed AS (
            SELECT
                counterparty_id,
                max(counterparty_name) AS counterparty_name,
                counterparty_role,
                sum(total_amount) AS total_amount,
                sum(invoice_cnt)::BIGINT AS invoice_cnt,
                max(latest_invoice_date) AS latest_invoice_date
            FROM dws_trade_sum
            WHERE stat_year = ?{ef}
              AND length(counterparty_id) > 0
            GROUP BY counterparty_id, counterparty_role
        ),
        merged AS (
            SELECT
                counterparty_id,
                max(counterparty_name) AS counterparty_name,
                coalesce(sum(total_amount) FILTER (WHERE counterparty_role = '供应商'), 0) AS purchase_amount,
                coalesce(sum(total_amount) FILTER (WHERE counterparty_role = '客户'), 0) AS sales_amount,
                coalesce(sum(invoice_cnt) FILTER (WHERE counterparty_role = '供应商'), 0)::BIGINT AS purchase_cnt,
                coalesce(sum(invoice_cnt) FILTER (WHERE counterparty_role = '客户'), 0)::BIGINT AS sales_cnt,
                max(latest_invoice_date) FILTER (WHERE counterparty_role = '供应商') AS purchase_latest_date,
                max(latest_invoice_date) FILTER (WHERE counterparty_role = '客户') AS sales_latest_date,
                bool_or(counterparty_role = '供应商') AS has_supplier,
                bool_or(counterparty_role = '客户') AS has_customer
            FROM directed
            GROUP BY counterparty_id
        ),
        classified AS (
            SELECT
                counterparty_id,
                counterparty_name,
                {role_case} AS counterparty_role,
                purchase_amount,
                sales_amount,
                purchase_cnt,
                sales_cnt,
                purchase_latest_date,
                sales_latest_date,
                abs(purchase_amount) + abs(sales_amount) AS total_amount_abs
            FROM merged
        )
        """

        count_sql = f"""
        {base_cte}
        SELECT count(*)::BIGINT FROM classified
        WHERE 1=1{role_filter_clause}{cp_clause}{kw_clause}
        """
        total = int(
            conn.execute(
                count_sql,
                [y, *ep, *role_filter_params, *cp_params, *kw_params],
            ).fetchone()[0]
            or 0
        )

        list_sql = f"""
        {base_cte}
        SELECT
            counterparty_id, counterparty_name, counterparty_role,
            purchase_amount, sales_amount, purchase_cnt, sales_cnt,
            purchase_latest_date, sales_latest_date, total_amount_abs
        FROM classified
        WHERE 1=1{role_filter_clause}{cp_clause}{kw_clause}
        ORDER BY total_amount_abs DESC NULLS LAST, counterparty_id
        LIMIT ? OFFSET ?
        """
        rows = conn.execute(
            list_sql,
            [y, *ep, *role_filter_params, *cp_params, *kw_params, lim, off],
        ).fetchall()

        role_summary_rows = conn.execute(
            f"""
            {base_cte}
            SELECT counterparty_role, count(*)::BIGINT
            FROM classified
            GROUP BY counterparty_role
            """,
            [y, *ep],
        ).fetchall()
        role_summary = {str(r[0] or ""): int(r[1] or 0) for r in role_summary_rows or []}

        out = [
            {
                "counterparty_id": str(r[0] or ""),
                "counterparty_name": str(r[1] or r[0] or ""),
                "counterparty_role": str(r[2] or ""),
                "purchase_amount": float(r[3] or 0),
                "sales_amount": float(r[4] or 0),
                "purchase_cnt": int(r[5] or 0),
                "sales_cnt": int(r[6] or 0),
                "purchase_latest_date": str(r[7] or "") if r[7] else "",
                "sales_latest_date": str(r[8] or "") if r[8] else "",
                "total_amount_abs": float(r[9] or 0),
            }
            for r in rows or []
        ]
        hint = None if total > 0 else f"{y} 年度该主体暂无往来关系数据。请先刷新 DWS 聚合。"
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": ep[0],
            "counterparty_id": cp_filter or None,
            "party_a_tax": pa or None,
            "party_b_tax": pb or None,
            "role_filter": rf,
            "rows": out,
            "total": total,
            "limit": lim,
            "offset": off,
            "role_summary": role_summary,
            "hint": hint,
            "caliber_hint": (
                "L2 往来关系：基于 dws_trade_sum 定向边合并；双向交易标为「往来单位」，"
                "单向购方边为「供应商」，单向销方边为「客户」。"
            ),
        }
    except Exception as exc:
        logger.exception("dws_trade_relationships")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


_TAX_DEVIATION_BUCKETS = ["13%", "9%", "6%", "3%", "免税/零税率", "其他"]


def build_tax_deviation_compare_rows(
    input_map: dict[str, dict[str, Any]],
    output_map: dict[str, dict[str, Any]],
    *,
    threshold_pct: float = 10.0,
) -> tuple[list[dict[str, Any]], list[str], float]:
    """纯函数：构建进销偏离对比行并标记超阈值档位（供 API 与单测复用）。"""
    threshold_ratio = threshold_pct / 100.0
    compare_rows: list[dict[str, Any]] = []
    mix_deviation_sum = 0.0
    exceeded_buckets: list[str] = []
    for b in _TAX_DEVIATION_BUCKETS:
        inp = input_map.get(b, {"amount_je": 0.0, "amount_ratio": 0.0, "line_cnt": 0})
        out = output_map.get(b, {"amount_je": 0.0, "amount_ratio": 0.0, "line_cnt": 0})
        in_ratio = float(inp.get("amount_ratio") or 0)
        out_ratio = float(out.get("amount_ratio") or 0)
        ratio_diff = round(in_ratio - out_ratio, 6)
        mix_deviation_sum += abs(ratio_diff)
        exceeded = abs(ratio_diff) >= threshold_ratio
        if exceeded:
            exceeded_buckets.append(b)
        compare_rows.append(
            {
                "tax_bucket": b,
                "input_amount_je": float(inp.get("amount_je") or 0),
                "input_amount_ratio": in_ratio,
                "input_line_cnt": int(inp.get("line_cnt") or 0),
                "output_amount_je": float(out.get("amount_je") or 0),
                "output_amount_ratio": out_ratio,
                "output_line_cnt": int(out.get("line_cnt") or 0),
                "ratio_diff": ratio_diff,
                "exceeded_threshold": exceeded,
            }
        )
    return compare_rows, exceeded_buckets, round(mix_deviation_sum, 6)


def _tax_dev_flag_summary(conn: Any, *, group_id: str, entity_id: str) -> dict[str, Any]:
    try:
        row = conn.execute(
            """
            SELECT
                count(*)::INT,
                count(*) FILTER (WHERE COALESCE(is_confirmed, FALSE))::INT,
                count(*) FILTER (WHERE NOT COALESCE(is_confirmed, FALSE))::INT,
                coalesce(sum(amount), 0)
            FROM dm_audit_flag
            WHERE group_id = ? AND entity_id = ? AND rule_id = 'RULE-TAX-DEV'
            """,
            [group_id, entity_id],
        ).fetchone()
        if not row:
            return {"total": 0, "confirmed": 0, "pending": 0, "amount": 0.0}
        return {
            "total": int(row[0] or 0),
            "confirmed": int(row[1] or 0),
            "pending": int(row[2] or 0),
            "amount": float(row[3] or 0),
        }
    except Exception:
        return {"total": 0, "confirmed": 0, "pending": 0, "amount": 0.0}


def _tax_rule_flag_amounts(
    conn: Any, *, group_id: str, entity_id: str, rule_ids: tuple[str, ...]
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {rid: {"amount": 0.0, "count": 0} for rid in rule_ids}
    try:
        placeholders = ", ".join("?" for _ in rule_ids)
        rows = conn.execute(
            f"""
            SELECT rule_id, coalesce(sum(amount), 0), count(*)::INT
            FROM dm_audit_flag
            WHERE group_id = ? AND entity_id = ? AND rule_id IN ({placeholders})
            GROUP BY rule_id
            """,
            [group_id, entity_id, *rule_ids],
        ).fetchall()
        for r in rows or []:
            rid = str(r[0] or "")
            if rid in out:
                out[rid] = {"amount": float(r[1] or 0), "count": int(r[2] or 0)}
    except Exception:
        logger.exception("tax_rule_flag_amounts")
    return out


def sync_tax_deviation_flags_for_years(conn: Any, *, stat_years: list[int]) -> dict[str, Any]:
    """DWS 重建或任务链后：对具备购销角色的分析主体批量同步 RULE-TAX-DEV。"""
    from src.local_api.analysis_subject_pool import api_analysis_subject_options

    synced = 0
    errors = 0
    for y in stat_years:
        try:
            opts = api_analysis_subject_options(
                conn, stat_year=str(y), require_both_roles=True
            )
            if not opts.get("ok"):
                errors += 1
                continue
            for opt in opts.get("options") or []:
                eid = str(opt.get("entity_id") or "").strip()
                if not eid:
                    continue
                try:
                    res = api_dws_tax_in_out_deviation(conn, stat_year=str(y), entity_id=eid)
                    if res.get("ok"):
                        synced += 1
                    else:
                        errors += 1
                except Exception:
                    logger.exception("sync tax dev for %s %s", y, eid)
                    errors += 1
        except Exception:
            logger.exception("sync tax dev year %s", y)
            errors += 1
    return {"ok": True, "synced_entities": synced, "errors": errors, "stat_years": stat_years}


def api_dws_tax_in_out_deviation(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    """
    进销偏离分析：对比分析主体进项 vs 销项税率结构。

    需主体同时具备购方与销方角色（由前端 L1+require_both_roles 筛选保障）。
    """
    try:
        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "进销偏离分析需指定同时具备购销角色的分析主体",
                    "exception_type": "ValidationError",
                },
            }

        input_rows, input_total, input_lines = _tax_bucket_rows(
            conn, stat_year=y, entity_id=eid, role_type="进项"
        )
        output_rows, output_total, output_lines = _tax_bucket_rows(
            conn, stat_year=y, entity_id=eid, role_type="销项"
        )

        input_map = {r["tax_bucket"]: r for r in input_rows}
        output_map = {r["tax_bucket"]: r for r in output_rows}
        from src.local_api.settings_api import get_setting

        threshold_pct = float(get_setting("tax_in_out_deviation_threshold_pct", 10.0) or 10.0)
        compare_rows, exceeded_buckets, mix_deviation = build_tax_deviation_compare_rows(
            input_map, output_map, threshold_pct=threshold_pct
        )

        from src.audit.config_loader import group_id_for_year

        gid = group_id_for_year(y)

        _sync_tax_deviation_flags(
            conn,
            stat_year=y,
            entity_id=eid,
            entity_name=_entity_display_name(conn, eid),
            exceeded_buckets=exceeded_buckets,
            compare_rows=compare_rows,
            threshold_pct=threshold_pct,
        )

        amount_ratio = round(input_total / output_total, 6) if output_total > 0 else None
        tax_dev_flags = _tax_dev_flag_summary(conn, group_id=gid, entity_id=eid)

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "input_total_amount_je": input_total,
            "output_total_amount_je": output_total,
            "input_total_line_cnt": input_lines,
            "output_total_line_cnt": output_lines,
            "amount_ratio_input_over_output": amount_ratio,
            "mix_deviation_l1": mix_deviation,
            "deviation_threshold_pct": threshold_pct,
            "exceeded_bucket_count": len(exceeded_buckets),
            "tax_dev_flags": tax_dev_flags,
            "rows": compare_rows,
            "caliber_hint": (
                "税率档次按明细行 slv_num 分桶；金额为正常票明细 je 绝对值合计；"
                "mix_deviation_l1 为各档占比差绝对值之和（0~2，越大偏离越明显）。"
            ),
        }
    except Exception as exc:
        logger.exception("dws_tax_in_out_deviation")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _entity_display_name(conn: Any, entity_id: str) -> str | None:
    try:
        row = conn.execute(
            """
            SELECT any_value(entity_name)
            FROM dws_inv_trend
            WHERE entity_id = ?
            LIMIT 1
            """,
            [entity_id],
        ).fetchone()
        if row and row[0]:
            return str(row[0])
    except Exception:
        pass
    return None


def _sync_tax_deviation_flags(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str,
    entity_name: str | None,
    exceeded_buckets: list[str],
    compare_rows: list[dict[str, Any]],
    threshold_pct: float,
) -> None:
    """进销偏离超阈值时写入/清理合成疑点（RULE-TAX-DEV）。"""
    import json

    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(stat_year)
    flag_prefix = f"TAXDEV_{stat_year}_{entity_id}_"
    try:
        conn.execute(
            "DELETE FROM dm_audit_flag WHERE flag_id LIKE ? AND rule_id = 'RULE-TAX-DEV'",
            [f"{flag_prefix}%"],
        )
    except Exception:
        logger.exception("cleanup tax deviation flags")
    if not exceeded_buckets:
        return
    row_map = {r["tax_bucket"]: r for r in compare_rows}
    for bucket in exceeded_buckets:
        r = row_map.get(bucket, {})
        diff_pp = abs(float(r.get("ratio_diff") or 0)) * 100
        amt = max(float(r.get("input_amount_je") or 0), float(r.get("output_amount_je") or 0))
        fid = f"{flag_prefix}{bucket.replace('/', '_').replace('%', 'pct')}"
        desc = (
            f"进销偏离：{bucket} 档占比差 {diff_pp:.1f} 百分点，超过阈值 {threshold_pct:.1f} 百分点"
        )
        detail_json = json.dumps(
            {
                "stat_year": stat_year,
                "entity_id": entity_id,
                "tax_bucket": bucket,
                "ratio_diff": float(r.get("ratio_diff") or 0),
                "ratio_diff_pp": round(diff_pp, 2),
                "input_amount_ratio": float(r.get("input_amount_ratio") or 0),
                "output_amount_ratio": float(r.get("output_amount_ratio") or 0),
                "input_amount_je": float(r.get("input_amount_je") or 0),
                "output_amount_je": float(r.get("output_amount_je") or 0),
                "threshold_pct": threshold_pct,
                "rule_subtype": "tax_in_out_deviation",
            },
            ensure_ascii=False,
        )
        try:
            conn.execute(
                """
                INSERT INTO dm_audit_flag (
                    flag_id, rule_id, risk_level, flag_type, group_id,
                    entity_id, entity_name, amount, description, suggestion,
                    is_confirmed, analysis_batch, detail_json
                ) VALUES (?, 'RULE-TAX-DEV', '中风险', '进销偏离', ?, ?, ?, ?, ?, ?, FALSE, 'tax_deviation_sync', ?)
                ON CONFLICT (flag_id) DO UPDATE SET
                    amount = excluded.amount,
                    description = excluded.description,
                    risk_level = excluded.risk_level,
                    detail_json = excluded.detail_json
                """,
                [
                    fid,
                    gid,
                    entity_id,
                    entity_name,
                    amt,
                    desc,
                    "复核该税率档次的业务背景与进销匹配关系",
                    detail_json,
                ],
            )
        except Exception:
            logger.exception("insert tax deviation flag %s", fid)


def api_dws_tax_risk_exposure(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    """
    税风险敞口：偏离基准结构的明细税额 + 高风险税收分类编码金额 + RULE-05/08 疑点金额。
    """
    try:
        dev = api_dws_tax_in_out_deviation(conn, stat_year=stat_year, entity_id=entity_id)
        if not dev.get("ok"):
            return dev
        y = int(dev["stat_year"])
        eid = str(dev.get("entity_id") or "")
        from src.audit.config_loader import group_id_for_year

        gid = group_id_for_year(y)

        deviation_exposure = 0.0
        bucket_rows: list[dict[str, Any]] = []
        for r in dev.get("rows") or []:
            if not r.get("exceeded_threshold"):
                continue
            inp = float(r.get("input_amount_je") or 0)
            out = float(r.get("output_amount_je") or 0)
            exp_amt = abs(inp - out)
            deviation_exposure += exp_amt
            bucket_rows.append(
                {
                    "tax_bucket": r.get("tax_bucket"),
                    "deviation_amount": round(exp_amt, 2),
                    "ratio_diff_pp": round(abs(float(r.get("ratio_diff") or 0)) * 100, 2),
                    "source": "tax_in_out_deviation",
                }
            )

        high_risk_coding_amount = 0.0
        try:
            norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
            norm_gfs = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
            hr = conn.execute(
                f"""
                SELECT coalesce(sum(abs(d.se)), 0)
                FROM dwd_inv_detail d
                INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
                LEFT JOIN dim_tax_code tc ON trim(d.ssflbm) = trim(tc.tax_code)
                WHERE h.stat_year = ?
                  AND d.logic_line_no > 0
                  AND ({norm_xfs} = ? OR {norm_gfs} = ?)
                  AND upper(coalesce(tc.audit_risk_label, 'NORMAL')) = 'HIGH'
                """,
                [y, eid, eid],
            ).fetchone()
            high_risk_coding_amount = float(hr[0] or 0) if hr else 0.0
        except Exception:
            logger.exception("high risk coding amount")

        rule_flags = _tax_rule_flag_amounts(
            conn, group_id=gid, entity_id=eid, rule_ids=("RULE-05", "RULE-08", "RULE-TAX-DEV")
        )
        rule_05_amount = float(rule_flags.get("RULE-05", {}).get("amount") or 0)
        rule_08_amount = float(rule_flags.get("RULE-08", {}).get("amount") or 0)
        rule_tax_dev_amount = float(rule_flags.get("RULE-TAX-DEV", {}).get("amount") or 0)
        flag_amount = rule_05_amount + rule_08_amount

        total_exposure = round(
            deviation_exposure + high_risk_coding_amount + flag_amount + rule_tax_dev_amount, 2
        )
        base_total = float(dev.get("input_total_amount_je") or 0) + float(dev.get("output_total_amount_je") or 0)
        high_risk_ratio = (
            round((high_risk_coding_amount + flag_amount) / base_total, 6) if base_total > 0 else 0.0
        )

        if high_risk_coding_amount > 0:
            bucket_rows.append(
                {
                    "tax_bucket": "高风险编码",
                    "deviation_amount": round(high_risk_coding_amount, 2),
                    "ratio_diff_pp": None,
                    "source": "dim_tax_code",
                    "rule_id": None,
                }
            )
        if rule_05_amount > 0:
            bucket_rows.append(
                {
                    "tax_bucket": "RULE-05 税率品类",
                    "deviation_amount": round(rule_05_amount, 2),
                    "ratio_diff_pp": None,
                    "source": "dm_audit_flag",
                    "rule_id": "RULE-05",
                    "flag_count": int(rule_flags.get("RULE-05", {}).get("count") or 0),
                }
            )
        if rule_08_amount > 0:
            bucket_rows.append(
                {
                    "tax_bucket": "RULE-08 价格一致性",
                    "deviation_amount": round(rule_08_amount, 2),
                    "ratio_diff_pp": None,
                    "source": "dm_audit_flag",
                    "rule_id": "RULE-08",
                    "flag_count": int(rule_flags.get("RULE-08", {}).get("count") or 0),
                }
            )
        if rule_tax_dev_amount > 0:
            bucket_rows.append(
                {
                    "tax_bucket": "RULE-TAX-DEV 进销偏离",
                    "deviation_amount": round(rule_tax_dev_amount, 2),
                    "ratio_diff_pp": None,
                    "source": "dm_audit_flag",
                    "rule_id": "RULE-TAX-DEV",
                    "flag_count": int(rule_flags.get("RULE-TAX-DEV", {}).get("count") or 0),
                }
            )

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "total_exposure": total_exposure,
            "deviation_exposure": round(deviation_exposure, 2),
            "high_risk_coding_amount": round(high_risk_coding_amount, 2),
            "rule_05_amount": round(rule_05_amount, 2),
            "rule_08_amount": round(rule_08_amount, 2),
            "rule_tax_dev_amount": round(rule_tax_dev_amount, 2),
            "audit_flag_amount": round(flag_amount, 2),
            "high_risk_ratio": high_risk_ratio,
            "rule_flag_breakdown": rule_flags,
            "breakdown": bucket_rows,
            "deviation_threshold_pct": dev.get("deviation_threshold_pct"),
            "caliber_hint": (
                "敞口 = 超阈值进销偏离档位金额差 + 高风险税收分类编码税额 + RULE-05/08 疑点金额 + RULE-TAX-DEV。"
                "阈值来自系统设置 tax_in_out_deviation_threshold_pct。"
            ),
        }
    except Exception as exc:
        logger.exception("dws_tax_risk_exposure")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def export_tax_risk_delivery_csv_bytes(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None = None,
    limit: int = 500,
) -> tuple[bytes, int]:
    """交付包用税风险敞口 CSV：按主体汇总敞口分项。"""
    import csv
    import io

    entities: list[tuple[str, str]] = []
    if entity_id:
        entities = [(str(entity_id).strip(), "")]
    else:
        try:
            rows = conn.execute(
                """
                SELECT DISTINCT trim(COALESCE(entity_id, '')) AS eid,
                       max(trim(COALESCE(entity_name, ''))) AS ename
                FROM ads_scorecard
                WHERE stat_year = ? AND length(trim(COALESCE(entity_id, ''))) > 0
                GROUP BY 1
                ORDER BY 1
                LIMIT ?
                """,
                [stat_year, limit],
            ).fetchall()
            entities = [(str(r[0] or ""), str(r[1] or "")) for r in rows or [] if r and r[0]]
        except Exception:
            entities = []

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "entity_id",
            "entity_name",
            "total_exposure",
            "deviation_exposure",
            "high_risk_coding_amount",
            "rule_05_amount",
            "rule_08_amount",
            "rule_tax_dev_amount",
            "high_risk_ratio",
        ]
    )
    row_count = 0
    for eid, ename in entities:
        payload = api_dws_tax_risk_exposure(conn, stat_year=str(stat_year), entity_id=eid)
        if not payload.get("ok"):
            continue
        writer.writerow(
            [
                eid,
                ename,
                float(payload.get("total_exposure") or 0),
                float(payload.get("deviation_exposure") or 0),
                float(payload.get("high_risk_coding_amount") or 0),
                float(payload.get("rule_05_amount") or 0),
                float(payload.get("rule_08_amount") or 0),
                float(payload.get("rule_tax_dev_amount") or 0),
                float(payload.get("high_risk_ratio") or 0),
            ]
        )
        row_count += 1
    data = ("\ufeff" + buf.getvalue()).encode("utf-8")
    return data, row_count


def api_dws_trade_graph(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    min_amount: float | None = None,
    counterparty_id: str | None = None,
    party_a_tax: str | None = None,
    party_b_tax: str | None = None,
) -> dict[str, Any]:
    """关联交易图谱：中心主体 + 往来对手节点/边。"""
    try:
        from src.local_api.settings_api import get_setting

        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {"message": "请指定 L1 分析主体", "exception_type": "ValidationError"},
            }
        min_amt = float(min_amount if min_amount is not None else get_setting("min_graph_amount", 10000.0) or 10000.0)

        cp_focus = _norm_entity(counterparty_id)
        pa = _norm_entity(party_a_tax)
        pb = _norm_entity(party_b_tax)
        if not cp_focus and pa and pb:
            if eid == pa:
                cp_focus = pb
            elif eid == pb:
                cp_focus = pa
            else:
                cp_focus = pb

        rel = api_dws_trade_relationships(
            conn,
            stat_year=str(y),
            entity_id=eid,
            counterparty_id=cp_focus or None,
            party_a_tax=party_a_tax,
            party_b_tax=party_b_tax,
            limit=200,
            offset=0,
        )
        if not rel.get("ok"):
            return rel

        center_name = _entity_display_name(conn, eid) or eid
        from src.audit.config_loader import group_id_for_year

        gid = group_id_for_year(y)

        shell_taxes: set[str] = set()
        try:
            for r in conn.execute(
                "SELECT intermediary_tax FROM dm_shell_co WHERE group_id = ?", [gid]
            ).fetchall() or []:
                if r and r[0]:
                    shell_taxes.add(_norm_entity(str(r[0])))
        except Exception:
            pass

        circular_taxes: set[str] = set()
        try:
            for r in conn.execute(
                """
                SELECT party_a_tax, party_b_tax FROM dm_circ_inv WHERE group_id = ?
                """,
                [gid],
            ).fetchall() or []:
                if r:
                    circular_taxes.add(_norm_entity(str(r[0] or "")))
                    circular_taxes.add(_norm_entity(str(r[1] or "")))
        except Exception:
            pass

        confirmed_entities: set[str] = set()
        try:
            for r in conn.execute(
                """
                SELECT DISTINCT entity_id FROM dm_audit_flag
                WHERE group_id = ? AND COALESCE(is_confirmed, FALSE) = TRUE
                """,
                [gid],
            ).fetchall() or []:
                if r and r[0]:
                    confirmed_entities.add(_norm_entity(str(r[0])))
        except Exception:
            pass

        nodes: list[dict[str, Any]] = [
            {
                "id": eid,
                "label": center_name,
                "role": "subject",
                "is_center": True,
                "is_shell": False,
                "is_circular": False,
                "has_confirmed_flag": eid in confirmed_entities,
            }
        ]
        edges: list[dict[str, Any]] = []
        seen_nodes: set[str] = {eid}

        for row in rel.get("rows") or []:
            cp_id = _norm_entity(str(row.get("counterparty_id") or ""))
            if not cp_id or cp_id == eid:
                continue
            total_abs = float(row.get("total_amount_abs") or 0)
            if total_abs < min_amt and (not cp_focus or cp_id != cp_focus):
                continue
            if cp_id not in seen_nodes:
                seen_nodes.add(cp_id)
                nodes.append(
                    {
                        "id": cp_id,
                        "label": str(row.get("counterparty_name") or cp_id),
                        "role": str(row.get("counterparty_role") or "未知"),
                        "is_center": False,
                        "is_shell": cp_id in shell_taxes,
                        "is_circular": cp_id in circular_taxes,
                        "has_confirmed_flag": cp_id in confirmed_entities,
                    }
                )
            purchase = float(row.get("purchase_amount") or 0)
            sales = float(row.get("sales_amount") or 0)
            if abs(purchase) >= min_amt or (cp_focus and cp_id == cp_focus and abs(purchase) > 0):
                edges.append(
                    {
                        "source": cp_id,
                        "target": eid,
                        "role": "供应商",
                        "amount": abs(purchase),
                        "invoice_cnt": int(row.get("purchase_cnt") or 0),
                    }
                )
            if abs(sales) >= min_amt or (cp_focus and cp_id == cp_focus and abs(sales) > 0):
                edges.append(
                    {
                        "source": eid,
                        "target": cp_id,
                        "role": "客户",
                        "amount": abs(sales),
                        "invoice_cnt": int(row.get("sales_cnt") or 0),
                    }
                )

        max_nodes = int(get_setting("max_graph_nodes", 50) or 50)
        truncated = len(nodes) > max_nodes
        trunc_msg: str | None = None
        out_nodes = nodes
        out_edges = edges
        if truncated:
            trunc_msg = (
                f"节点数 {len(nodes)} 超过上限 {max_nodes}，已降级为摘要模式。"
                "请提高最小边金额或缩小分析主体范围后重试。"
            )
            center_node = next((n for n in nodes if n.get("is_center")), nodes[0] if nodes else None)
            flagged = [n for n in nodes if not n.get("is_center") and (n.get("is_shell") or n.get("is_circular") or n.get("has_confirmed_flag"))]
            flagged.sort(
                key=lambda n: (
                    0 if n.get("is_shell") else 1 if n.get("is_circular") else 2,
                    n.get("label") or n.get("id") or "",
                )
            )
            keep_ids: set[str] = set()
            if center_node:
                keep_ids.add(str(center_node["id"]))
            for n in flagged[: max(0, max_nodes - len(keep_ids))]:
                keep_ids.add(str(n["id"]))
            out_nodes = [n for n in nodes if str(n["id"]) in keep_ids]
            out_edges = [e for e in edges if str(e.get("source")) in keep_ids and str(e.get("target")) in keep_ids]

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "counterparty_id": cp_focus or None,
            "party_a_tax": pa or None,
            "party_b_tax": pb or None,
            "center_label": center_name,
            "min_graph_amount": min_amt,
            "max_graph_nodes": max_nodes,
            "nodes": out_nodes,
            "edges": out_edges,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "truncated": truncated,
            "truncated_message": trunc_msg,
        }
    except Exception as exc:
        logger.exception("dws_trade_graph")
        return {"ok": False, "nodes": [], "edges": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_rebuild(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    from src.etl.dws_build import refresh_dws_years

    raw = body.get("stat_years") or body.get("statYears")
    if raw is None and body.get("stat_year") is not None:
        raw = [body.get("stat_year")]
    years: list[int] = []
    if isinstance(raw, list):
        for item in raw:
            try:
                yi = int(str(item).strip())
            except (TypeError, ValueError):
                continue
            if 1990 <= yi <= 2100:
                years.append(yi)
    elif raw is not None:
        try:
            yi = int(str(raw).strip())
            if 1990 <= yi <= 2100:
                years = [yi]
        except (TypeError, ValueError):
            pass
    if not years:
        try:
            years = [int(y) for y in _distinct_dws_years(conn)[:5]]
        except Exception:
            years = []
        try:
            dwd_rows = conn.execute(
                "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL ORDER BY stat_year DESC LIMIT 5"
            ).fetchall()
            years = [int(r[0]) for r in dwd_rows if r and r[0] is not None]
        except Exception:
            pass
    if not years:
        return {
            "ok": False,
            "error": {"message": "无有效 stat_year 且 DWD 无可用年度", "exception_type": "ValidationError"},
        }
    run_id = str(body.get("run_id") or body.get("runId") or "").strip() or None
    result = refresh_dws_years(conn, stat_years=years, run_id=run_id)
    if result.get("ok"):
        try:
            tax_sync = sync_tax_deviation_flags_for_years(conn, stat_years=years)
            result["tax_deviation_sync"] = tax_sync
        except Exception:
            logger.exception("tax_deviation_sync after dws rebuild")
    return result
