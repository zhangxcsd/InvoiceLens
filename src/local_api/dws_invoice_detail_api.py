"""DWS 聚合下钻：发票明细行只读列表与 CSV 导出。"""

from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

_LIST_MAX_PAGE_SIZE = 200
_EXPORT_MAX_ROWS = 50000

_NORM_XFS = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
_NORM_GFS = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"

_LIST_COLUMNS = [
    ("sdfphm", "数电票号码"),
    ("fpdm", "发票代码"),
    ("fphm", "发票号码"),
    ("kprq", "开票日期"),
    ("fpzt", "发票状态"),
    ("xfmc", "销方名称"),
    ("xfsbh", "销方税号"),
    ("gfmc", "购方名称"),
    ("gfsbh", "购方税号"),
    ("hwlwmc", "货物名称"),
    ("ssflbm", "税收分类编码"),
    ("je", "金额"),
    ("se", "税额"),
    ("jshj", "价税合计"),
    ("slv", "税率"),
    ("slv_num", "税率数值"),
    ("stat_year", "统计年度"),
    ("stat_month", "统计月份"),
    ("logic_line_no", "逻辑行号"),
]


def _norm_entity(v: str | None) -> str:
    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = date.today().year if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _parse_page(raw: Any, default: int = 1) -> int:
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return default


def _parse_page_size(raw: Any, default: int = 50) -> int:
    try:
        return max(1, min(_LIST_MAX_PAGE_SIZE, int(raw)))
    except (TypeError, ValueError):
        return default


def _parse_stat_month(v: str | None, stat_year: int) -> int | None:
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
        except (ValueError, TypeError):
            return None
        return None
    try:
        m = int(s)
        return m if 1 <= m <= 12 else None
    except (TypeError, ValueError):
        return None


def _parse_slv_num(raw: str | float | None) -> float | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _invoice_detail_filters(
    *,
    stat_year: int | None,
    entity_id: str | None,
    stat_month: str | None,
    date_from: str | None,
    date_to: str | None,
    seller_tax_no: str | None,
    goods_name: str | None,
    slv_num: str | float | None,
) -> tuple[str, list[Any], dict[str, Any]]:
    clauses = ["d.logic_line_no > 0"]
    params: list[Any] = []
    meta: dict[str, Any] = {}

    if stat_year is not None:
        # 审计含义：限定统计年度，与 DWS 聚合口径一致
        clauses.append("h.stat_year = ?")
        params.append(stat_year)
        meta["stat_year"] = stat_year

    eid = _norm_entity(entity_id)
    if eid:
        # 审计含义：主体下钻，购销任一侧税号命中
        clauses.append(f"({_NORM_XFS} = ? OR {_NORM_GFS} = ?)")
        params.extend([eid, eid])
        meta["entity_id"] = eid

    seller = _norm_entity(seller_tax_no)
    if seller:
        clauses.append(f"{_NORM_XFS} = ?")
        params.append(seller)
        meta["seller_tax_no"] = seller

    m = _parse_stat_month(stat_month, stat_year) if stat_year is not None else None
    if m is not None:
        # 审计含义：按 stat_month 与月度 DWS 下钻对齐
        clauses.append("coalesce(h.stat_month, d.stat_month) = ?")
        params.append(m)
        meta["stat_month"] = m

    if date_from and str(date_from).strip():
        clauses.append("h.invoice_date >= ?")
        params.append(str(date_from).strip()[:10])
        meta["date_from"] = str(date_from).strip()[:10]
    if date_to and str(date_to).strip():
        clauses.append("h.invoice_date <= ?")
        params.append(str(date_to).strip()[:10])
        meta["date_to"] = str(date_to).strip()[:10]

    gn = str(goods_name or "").strip()
    if gn:
        clauses.append(
            "(trim(coalesce(d.hwlwmc, '')) ILIKE ? OR lower(trim(coalesce(d.hwlwmc, ''))) LIKE lower(?))"
        )
        params.extend([gn, f"%{gn}%"])
        meta["goods_name"] = gn

    rate = _parse_slv_num(slv_num)
    if rate is not None:
        clauses.append("abs(coalesce(d.slv_num, 0) - ?) <= 0.005")
        params.append(rate)
        meta["slv_num"] = rate

    return " AND ".join(clauses), params, meta


def _list_select_sql(where: str) -> str:
    return f"""
        SELECT
            h.sdfphm, h.fpdm, h.fphm, h.kprq, h.fpzt,
            h.xfmc, h.xfsbh, h.gfmc, h.gfsbh,
            d.hwlwmc, d.ssflbm, d.je, d.se, d.jshj, d.slv, d.slv_num,
            h.stat_year, coalesce(h.stat_month, d.stat_month) AS stat_month,
            d.logic_line_no
        FROM dwd_inv_detail d
        INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
        WHERE {where}
        ORDER BY h.invoice_date DESC NULLS LAST, h.sdfphm, d.logic_line_no
    """


def api_dws_invoice_detail_list(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    seller_tax_no: str | None = None,
    goods_name: str | None = None,
    slv_num: str | float | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year) if stat_year else None
        where, params, meta = _invoice_detail_filters(
            stat_year=y,
            entity_id=entity_id,
            stat_month=stat_month,
            date_from=date_from,
            date_to=date_to,
            seller_tax_no=seller_tax_no,
            goods_name=goods_name,
            slv_num=slv_num,
        )
        lim = max(1, min(int(limit or 50), _LIST_MAX_PAGE_SIZE))
        off = max(0, int(offset or 0))
        base = _list_select_sql(where)
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM ({base}) sub", params).fetchone()[0] or 0
        )
        rows_raw = conn.execute(f"{base} LIMIT ? OFFSET ?", [*params, lim, off]).fetchall()
        rows = [
            {
                "sdfphm": str(r[0] or ""),
                "fpdm": str(r[1] or ""),
                "fphm": str(r[2] or ""),
                "kprq": str(r[3] or "") if r[3] is not None else "",
                "fpzt": str(r[4] or ""),
                "xfmc": str(r[5] or ""),
                "xfsbh": str(r[6] or ""),
                "gfmc": str(r[7] or ""),
                "gfsbh": str(r[8] or ""),
                "hwlwmc": str(r[9] or ""),
                "ssflbm": str(r[10] or ""),
                "je": float(r[11] or 0),
                "se": float(r[12] or 0),
                "jshj": float(r[13] or 0),
                "slv": str(r[14] or ""),
                "slv_num": float(r[15]) if r[15] is not None else None,
                "stat_year": int(r[16]) if r[16] is not None else None,
                "stat_month": int(r[17]) if r[17] is not None else None,
                "logic_line_no": int(r[18] or 0),
            }
            for r in rows_raw or []
        ]
        return {
            "ok": True,
            "total": total,
            "limit": lim,
            "offset": off,
            "rows": rows,
            **meta,
        }
    except Exception as exc:
        logger.exception("dws_invoice_detail_list")
        return {"ok": False, "rows": [], "total": 0, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def export_dws_invoice_detail_csv_bytes(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    seller_tax_no: str | None = None,
    goods_name: str | None = None,
    slv_num: str | float | None = None,
    max_rows: int = _EXPORT_MAX_ROWS,
) -> tuple[bytes | None, int, int]:
    try:
        y = _safe_int_year(stat_year) if stat_year else None
        where, params, _meta = _invoice_detail_filters(
            stat_year=y,
            entity_id=entity_id,
            stat_month=stat_month,
            date_from=date_from,
            date_to=date_to,
            seller_tax_no=seller_tax_no,
            goods_name=goods_name,
            slv_num=slv_num,
        )
        base = _list_select_sql(where)
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM ({base}) sub", params).fetchone()[0] or 0
        )
        if total <= 0:
            return None, 0, 0
        lim = max(1, min(int(max_rows or _EXPORT_MAX_ROWS), _EXPORT_MAX_ROWS))
        rows = conn.execute(f"{base} LIMIT {lim}", params).fetchall()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([label for _, label in _LIST_COLUMNS])
        for r in rows or []:
            writer.writerow([r[i] for i in range(len(_LIST_COLUMNS))])
        return buf.getvalue().encode("utf-8-sig"), len(rows or []), total
    except Exception as exc:
        logger.warning("export_dws_invoice_detail_csv_bytes: %s", exc)
        return None, 0, 0


def api_dws_invoice_detail_export(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    stat_month: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    seller_tax_no: str | None = None,
    goods_name: str | None = None,
    slv_num: str | float | None = None,
) -> tuple[int, bytes | dict[str, Any], str, str]:
    """返回 (status, body, content_type, filename)。"""
    try:
        from src.local_api.license_gate import check_export_allowed

        denied = check_export_allowed()
        if denied:
            return 403, denied, "", ""

        y = _safe_int_year(stat_year) if stat_year else None
        data, exported, total = export_dws_invoice_detail_csv_bytes(
            conn,
            stat_year=str(y) if y else None,
            entity_id=entity_id,
            stat_month=stat_month,
            date_from=date_from,
            date_to=date_to,
            seller_tax_no=seller_tax_no,
            goods_name=goods_name,
            slv_num=slv_num,
        )
        if total <= 0:
            return 404, {"ok": False, "error": {"message": "无匹配明细可导出"}}, "", ""
        if total > _EXPORT_MAX_ROWS:
            return (
                400,
                {
                    "ok": False,
                    "error": {
                        "code": "export_row_cap_exceeded",
                        "message": (
                            f"匹配 {total:,} 行明细，超过单次导出上限 {_EXPORT_MAX_ROWS:,}。"
                            "请缩小筛选范围后重试。"
                        ),
                        "row_count": total,
                        "max_export_rows": _EXPORT_MAX_ROWS,
                    },
                },
                "",
                "",
            )
        year_tag = str(y) if y else "all"
        fname = f"invoice_detail_drill_{year_tag}.csv"
        return 200, data or b"", "text/csv; charset=utf-8", fname
    except Exception as exc:
        logger.exception("dws_invoice_detail_export")
        return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""
