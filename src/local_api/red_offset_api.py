"""红冲/作废专题看板 API（dwd_inv_header 净额与红冲字段）。"""

from __future__ import annotations

import csv
import io
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    from datetime import date

    d = date.today().year if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _norm_entity(v: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _entity_clause(entity_id: str | None, col_buyer: str = "gfsbh", col_seller: str = "xfsbh") -> tuple[str, list[Any]]:
    eid = _norm_entity(entity_id)
    if not eid:
        return "", []
    norm_gfs = f"upper(regexp_replace(trim(coalesce(h.{col_buyer}, '')), '[\\\\s-]+', '', 'g'))"
    norm_xfs = f"upper(regexp_replace(trim(coalesce(h.{col_seller}, '')), '[\\\\s-]+', '', 'g'))"
    return f" AND ({norm_gfs} = ? OR {norm_xfs} = ?)", [eid, eid]


def api_dws_red_offset_overview(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_clause(entity_id)

        kpi = conn.execute(
            f"""
            -- 审计含义：统计红冲占比、孤立红票与全额红冲规模
            SELECT
                count(*)::BIGINT AS header_cnt,
                sum(CASE WHEN coalesce(h.fpzt, '') LIKE '%红%' OR coalesce(h.is_orphan_red, FALSE) THEN 1 ELSE 0 END)::BIGINT AS red_cnt,
                sum(CASE WHEN coalesce(h.is_orphan_red, FALSE) THEN 1 ELSE 0 END)::BIGINT AS orphan_cnt,
                sum(CASE WHEN coalesce(h.net_calc_status, '') IN ('fully_reversed', '全额红冲') THEN 1 ELSE 0 END)::BIGINT AS fully_reversed_cnt,
                sum(abs(coalesce(h.net_jshj, h.jshj, 0))) FILTER (WHERE coalesce(h.fpzt, '') LIKE '%红%' OR coalesce(h.is_orphan_red, FALSE)) AS red_offset_amt,
                sum(abs(coalesce(h.net_jshj, h.jshj, 0))) AS net_amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?{ef}
            """,
            [y, *ep],
        ).fetchone()

        header_cnt = int(kpi[0] or 0) if kpi else 0
        red_cnt = int(kpi[1] or 0) if kpi else 0
        orphan_cnt = int(kpi[2] or 0) if kpi else 0
        fully_cnt = int(kpi[3] or 0) if kpi else 0
        red_amt = float(kpi[4] or 0) if kpi else 0.0
        net_amt = float(kpi[5] or 0) if kpi else 0.0
        red_ratio = round(red_cnt / header_cnt, 6) if header_cnt > 0 else None

        monthly = conn.execute(
            f"""
            -- 审计含义：按月观察红票与孤立红票趋势
            SELECT
                h.stat_month,
                count(*)::BIGINT AS header_cnt,
                sum(CASE WHEN coalesce(h.fpzt, '') LIKE '%红%' OR coalesce(h.is_orphan_red, FALSE) THEN 1 ELSE 0 END)::BIGINT AS red_cnt,
                sum(CASE WHEN coalesce(h.is_orphan_red, FALSE) THEN 1 ELSE 0 END)::BIGINT AS orphan_cnt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?{ef}
            GROUP BY h.stat_month
            ORDER BY h.stat_month
            """,
            [y, *ep],
        ).fetchall()

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": _norm_entity(entity_id) or None,
            "kpis": {
                "header_cnt": header_cnt,
                "red_cnt": red_cnt,
                "red_ratio": red_ratio,
                "orphan_cnt": orphan_cnt,
                "fully_reversed_cnt": fully_cnt,
                "red_offset_amt": round(red_amt, 2),
                "net_amt": round(net_amt, 2),
            },
            "monthly_trend": [
                {
                    "stat_month": int(r[0] or 0),
                    "header_cnt": int(r[1] or 0),
                    "red_cnt": int(r[2] or 0),
                    "orphan_cnt": int(r[3] or 0),
                }
                for r in monthly or []
            ],
            "hint": None if header_cnt > 0 else f"{y} 年度暂无发票头数据。",
        }
    except Exception as exc:
        logger.exception("dws_red_offset_overview")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_red_offset_list(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    kind: str = "all",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        ef, ep = _entity_clause(entity_id)
        k = (kind or "all").strip().lower()
        kind_clause = ""
        if k == "orphan":
            kind_clause = " AND coalesce(h.is_orphan_red, FALSE) = TRUE"
        elif k == "fully_reversed":
            kind_clause = " AND coalesce(h.net_calc_status, '') IN ('fully_reversed', '全额红冲')"
        elif k == "red":
            kind_clause = " AND (coalesce(h.fpzt, '') LIKE '%红%' OR coalesce(h.is_orphan_red, FALSE))"
        lim = max(1, min(int(limit or 50), 500))
        off = max(0, int(offset or 0))

        total = int(
            conn.execute(
                f"""
                SELECT count(*)::BIGINT FROM dwd_inv_header h
                WHERE h.stat_year = ?{ef}{kind_clause}
                """,
                [y, *ep],
            ).fetchone()[0]
            or 0
        )

        rows = conn.execute(
            f"""
            SELECT
                h.fphm, h.sdfphm, h.invoice_date, h.xfsbh, h.xfmc, h.gfsbh, h.gfmc,
                h.fpzt, h.net_calc_status,
                coalesce(h.net_calc_status, '') IN ('fully_reversed', '全额红冲') AS is_fully_reversed,
                coalesce(h.is_orphan_red, FALSE) AS is_orphan_red,
                CASE WHEN coalesce(h.fpzt, '') LIKE '%红%' OR coalesce(h.is_orphan_red, FALSE)
                     THEN abs(coalesce(h.net_jshj, h.jshj, 0)) ELSE 0 END AS red_offset_jshj,
                coalesce(h.net_jshj, h.jshj, 0),
                CASE WHEN coalesce(h.fpzt, '') LIKE '%红%' THEN 1 ELSE 0 END AS red_invoice_count
            FROM dwd_inv_header h
            WHERE h.stat_year = ?{ef}{kind_clause}
            ORDER BY abs(coalesce(h.net_jshj, h.jshj, 0)) DESC NULLS LAST, h.invoice_date DESC NULLS LAST
            LIMIT ? OFFSET ?
            """,
            [y, *ep, lim, off],
        ).fetchall()

        out = [
            {
                "invoice_no": str(r[1] or r[0] or ""),
                "invoice_date": str(r[2] or "") if r[2] else "",
                "seller_tax_no": str(r[3] or ""),
                "seller_name": str(r[4] or ""),
                "buyer_tax_no": str(r[5] or ""),
                "buyer_name": str(r[6] or ""),
                "fpzt": str(r[7] or ""),
                "net_calc_status": str(r[8] or ""),
                "is_fully_reversed": bool(r[9]),
                "is_orphan_red": bool(r[10]),
                "red_offset_jshj": round(float(r[11] or 0), 2),
                "net_jshj": round(float(r[12] or 0), 2),
                "red_invoice_count": int(r[13] or 0),
            }
            for r in rows or []
        ]

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": _norm_entity(entity_id) or None,
            "kind": k,
            "rows": out,
            "total": total,
            "limit": lim,
            "offset": off,
        }
    except Exception as exc:
        logger.exception("dws_red_offset_list")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def export_red_offset_csv_bytes(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    kind: str = "all",
) -> tuple[bytes, int, int]:
    payload = api_dws_red_offset_list(
        conn, stat_year=stat_year, entity_id=entity_id, kind=kind, limit=5000, offset=0
    )
    rows = payload.get("rows") or []
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "invoice_no",
            "invoice_date",
            "seller_tax_no",
            "seller_name",
            "buyer_tax_no",
            "buyer_name",
            "fpzt",
            "net_calc_status",
            "is_fully_reversed",
            "is_orphan_red",
            "red_offset_jshj",
            "net_jshj",
            "red_invoice_count",
        ]
    )
    for r in rows:
        w.writerow(
            [
                r.get("invoice_no"),
                r.get("invoice_date"),
                r.get("seller_tax_no"),
                r.get("seller_name"),
                r.get("buyer_tax_no"),
                r.get("buyer_name"),
                r.get("fpzt"),
                r.get("net_calc_status"),
                r.get("is_fully_reversed"),
                r.get("is_orphan_red"),
                r.get("red_offset_jshj"),
                r.get("net_jshj"),
                r.get("red_invoice_count"),
            ]
        )
    return buf.getvalue().encode("utf-8-sig"), len(rows), int(payload.get("total") or 0)
