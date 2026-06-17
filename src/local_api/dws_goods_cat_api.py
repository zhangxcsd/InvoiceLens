"""DWS 商品品类结构只读 API（dws_goods_cat）。"""

from __future__ import annotations

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


def _parse_quarter(v: str | None) -> int | None:
    if not v or not str(v).strip():
        return None
    try:
        q = int(str(v).strip())
        if 1 <= q <= 4:
            return q
    except ValueError:
        pass
    return None


def _row_dict(r: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "tax_code_short": str(r[0] or ""),
        "tax_code_level2": str(r[1] or ""),
        "stat_quarter": int(r[2] or 0),
        "net_jshj": round(float(r[3] or 0), 2),
        "invoice_cnt": int(r[4] or 0),
        "supplier_cnt": int(r[5] or 0),
        "avg_single_amt": round(float(r[6] or 0), 2) if r[6] is not None else None,
        "max_single_amt": round(float(r[7] or 0), 2) if r[7] is not None else None,
        "distinct_tax_rates": int(r[8] or 0),
    }


def api_dws_goods_cat_overview(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_quarter: str | None = None,
) -> dict[str, Any]:
    """品类结构概览：季度汇总 + Top 品类。"""
    try:
        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "品类结构分析需指定购方主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        q = _parse_quarter(stat_quarter)
        q_clause = " AND stat_quarter = ?" if q is not None else ""
        q_params: list[Any] = [q] if q is not None else []

        quarter_rows = conn.execute(
            f"""
            -- 审计含义：按季度汇总品类金额与行数，观察采购结构季节性
            SELECT
                stat_quarter,
                sum(net_jshj) AS net_jshj,
                sum(invoice_cnt)::BIGINT AS invoice_cnt,
                count(DISTINCT tax_code_short)::BIGINT AS category_cnt
            FROM dws_goods_cat
            WHERE stat_year = ? AND entity_id = ?{q_clause}
            GROUP BY stat_quarter
            ORDER BY stat_quarter
            """,
            [y, eid, *q_params],
        ).fetchall()

        total_amt = sum(float(r[1] or 0) for r in quarter_rows or [])
        total_lines = sum(int(r[2] or 0) for r in quarter_rows or [])

        top_rows = conn.execute(
            f"""
            -- 审计含义：年度/季度内金额最高的税码短前缀品类
            SELECT
                tax_code_short, tax_code_level2, stat_quarter,
                net_jshj, invoice_cnt, supplier_cnt,
                avg_single_amt, max_single_amt, distinct_tax_rates
            FROM dws_goods_cat
            WHERE stat_year = ? AND entity_id = ?{q_clause}
            ORDER BY net_jshj DESC NULLS LAST, tax_code_short
            LIMIT 10
            """,
            [y, eid, *q_params],
        ).fetchall()

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "stat_quarter": str(q) if q is not None else None,
            "total_net_jshj": round(total_amt, 2),
            "total_invoice_cnt": total_lines,
            "quarterly": [
                {
                    "stat_quarter": int(r[0] or 0),
                    "net_jshj": round(float(r[1] or 0), 2),
                    "invoice_cnt": int(r[2] or 0),
                    "category_cnt": int(r[3] or 0),
                }
                for r in quarter_rows or []
            ],
            "top_categories": [_row_dict(r) for r in top_rows or []],
            "hint": None if quarter_rows else f"{y} 年度该主体暂无品类汇总数据（请先执行 DWS 刷新）。",
        }
    except Exception as exc:
        logger.exception("dws_goods_cat_overview")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dws_goods_cat_list(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_quarter: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """品类明细列表（可按季度筛选）。"""
    try:
        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "品类明细需指定购方主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        q = _parse_quarter(stat_quarter)
        q_clause = " AND stat_quarter = ?" if q is not None else ""
        q_params: list[Any] = [q] if q is not None else []
        lim = max(1, min(int(limit or 50), 500))
        off = max(0, int(offset or 0))

        total = int(
            conn.execute(
                f"""
                SELECT count(*)::BIGINT FROM dws_goods_cat
                WHERE stat_year = ? AND entity_id = ?{q_clause}
                """,
                [y, eid, *q_params],
            ).fetchone()[0]
            or 0
        )

        rows = conn.execute(
            f"""
            SELECT
                tax_code_short, tax_code_level2, stat_quarter,
                net_jshj, invoice_cnt, supplier_cnt,
                avg_single_amt, max_single_amt, distinct_tax_rates
            FROM dws_goods_cat
            WHERE stat_year = ? AND entity_id = ?{q_clause}
            ORDER BY stat_quarter, net_jshj DESC NULLS LAST, tax_code_short
            LIMIT ? OFFSET ?
            """,
            [y, eid, *q_params, lim, off],
        ).fetchall()

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "stat_quarter": str(q) if q is not None else None,
            "rows": [_row_dict(r) for r in rows or []],
            "total": total,
            "limit": lim,
            "offset": off,
        }
    except Exception as exc:
        logger.exception("dws_goods_cat_list")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}
