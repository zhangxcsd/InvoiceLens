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
    conn: Any, *, stat_year: str | None, entity_id: str | None = None
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
        row = conn.execute(
            f"""
            SELECT
                coalesce(sum(t.net_jshj), 0) AS total_net_jshj,
                coalesce(sum(t.normal_cnt + t.red_cnt + t.cancel_cnt), 0)::BIGINT AS invoice_cnt,
                coalesce(sum(t.red_cnt), 0)::BIGINT AS red_cnt,
                coalesce(sum(t.cancel_cnt), 0)::BIGINT AS cancel_cnt
            FROM dws_inv_trend t
            WHERE t.stat_year = ?{ef}
            """,
            [y, *ep],
        ).fetchone()
        sup_sql = f"""
            SELECT count(DISTINCT supplier_id)::BIGINT
            FROM dws_sup_conc
            WHERE stat_year = ?{ef}
        """
        sup_cnt = int(conn.execute(sup_sql, [y, *ep]).fetchone()[0] or 0)
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
        out_cnt = 0.0
        in_cnt = 0.0
        role_rows = conn.execute(
            f"""
            SELECT role_type, coalesce(sum(net_jshj), 0)
            FROM dws_inv_trend
            WHERE stat_year = ?{ef}
            GROUP BY role_type
            """,
            [y, *ep],
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
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_filter_clause(entity_id)
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
            WHERE stat_year = ?{ef}{rt_clause}
            GROUP BY stat_month, role_type
            ORDER BY stat_month, role_type
            """,
            [y, *ep, *rt_params],
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
    conn: Any, *, stat_year: str | None, entity_id: str | None = None
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
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": ep[0],
            "supplier_cnt": supplier_cnt,
            **cr,
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_supplier_top(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    limit: int = 20,
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
        total = int(
            conn.execute(
                f"SELECT COUNT(*)::BIGINT FROM dws_sup_conc WHERE stat_year = ?{ef}",
                [y, *ep],
            ).fetchone()[0]
            or 0
        )
        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": ep[0],
            "rows": out,
            "total": total,
            "limit": lim,
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
            [y, *entity_params],
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
            GROUP BY 1, 2
            ORDER BY 1, amount_je DESC
            """,
            [y, *entity_params],
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
        WHERE 1=1{role_filter_clause}{kw_clause}
        """
        total = int(
            conn.execute(
                count_sql,
                [y, *ep, *role_filter_params, *kw_params],
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
        WHERE 1=1{role_filter_clause}{kw_clause}
        ORDER BY total_amount_abs DESC NULLS LAST, counterparty_id
        LIMIT ? OFFSET ?
        """
        rows = conn.execute(
            list_sql,
            [y, *ep, *role_filter_params, *kw_params, lim, off],
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
        buckets = ["13%", "9%", "6%", "3%", "免税/零税率", "其他"]

        compare_rows: list[dict[str, Any]] = []
        mix_deviation_sum = 0.0
        for b in buckets:
            inp = input_map.get(b, {"amount_je": 0.0, "amount_ratio": 0.0, "line_cnt": 0})
            out = output_map.get(b, {"amount_je": 0.0, "amount_ratio": 0.0, "line_cnt": 0})
            in_ratio = float(inp.get("amount_ratio") or 0)
            out_ratio = float(out.get("amount_ratio") or 0)
            ratio_diff = round(in_ratio - out_ratio, 6)
            mix_deviation_sum += abs(ratio_diff)
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
                }
            )

        amount_ratio = round(input_total / output_total, 6) if output_total > 0 else None
        mix_deviation = round(mix_deviation_sum, 6)

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
            "rows": compare_rows,
            "caliber_hint": (
                "税率档次按明细行 slv_num 分桶；金额为正常票明细 je 绝对值合计；"
                "mix_deviation_l1 为各档占比差绝对值之和（0~2，越大偏离越明显）。"
            ),
        }
    except Exception as exc:
        logger.exception("dws_tax_in_out_deviation")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


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
    return refresh_dws_years(conn, stat_years=years, run_id=run_id)
