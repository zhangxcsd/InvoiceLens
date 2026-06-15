"""DWD 发票明细导出（CSV / XLSX）。"""

from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

_EXPORT_COLUMNS = [
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
    ("je", "金额"),
    ("se", "税额"),
    ("jshj", "价税合计"),
    ("slv", "税率"),
    ("stat_year", "统计年度"),
    ("stat_month", "统计月份"),
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


def _build_export_sql(
    *,
    stat_year: int | None,
    entity_id: str | None,
    seller_tax_no: str | None,
    date_from: str | None,
    date_to: str | None,
    fpzt: str | None,
) -> tuple[str, list[Any]]:
    clauses = ["d.logic_line_no > 0"]
    params: list[Any] = []
    if stat_year is not None:
        clauses.append("h.stat_year = ?")
        params.append(stat_year)
    eid = _norm_entity(entity_id)
    if eid:
        norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
        norm_gfs = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
        clauses.append(f"({norm_xfs} = ? OR {norm_gfs} = ?)")
        params.extend([eid, eid])
    seller = _norm_entity(seller_tax_no)
    if seller:
        norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
        clauses.append(f"{norm_xfs} = ?")
        params.append(seller)
    if date_from:
        clauses.append("h.invoice_date >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("h.invoice_date <= ?")
        params.append(date_to)
    status = (fpzt or "").strip()
    if status and status.lower() not in ("all", "全部"):
        clauses.append("coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') = ?")
        params.append(status)
    where = " AND ".join(clauses)
    sql = f"""
        SELECT
            h.sdfphm, h.fpdm, h.fphm, h.kprq, h.fpzt,
            h.xfmc, h.xfsbh, h.gfmc, h.gfsbh,
            d.hwlwmc, d.je, d.se, d.jshj, d.slv,
            h.stat_year, h.stat_month
        FROM dwd_inv_detail d
        INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
        WHERE {where}
        ORDER BY h.invoice_date DESC NULLS LAST, h.sdfphm, d.logic_line_no
        LIMIT {_EXPORT_MAX_ROWS}
    """
    return sql, params


_EXPORT_MAX_ROWS = 50000


def _build_count_sql(
    *,
    stat_year: int | None,
    entity_id: str | None,
    seller_tax_no: str | None,
    date_from: str | None,
    date_to: str | None,
    fpzt: str | None,
) -> tuple[str, list[Any]]:
    sql, params = _build_export_sql(
        stat_year=stat_year,
        entity_id=entity_id,
        seller_tax_no=seller_tax_no,
        date_from=date_from,
        date_to=date_to,
        fpzt=fpzt,
    )
    count_sql = f"SELECT COUNT(*)::BIGINT FROM ({sql.rsplit('LIMIT', 1)[0].strip()}) sub"
    return count_sql, params


def api_export_invoices_count(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    seller_tax_no: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    fpzt: str | None = None,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year) if stat_year else None
        count_sql, params = _build_count_sql(
            stat_year=y,
            entity_id=entity_id,
            seller_tax_no=seller_tax_no,
            date_from=date_from,
            date_to=date_to,
            fpzt=fpzt,
        )
        total = int(conn.execute(count_sql, params).fetchone()[0] or 0)
        capped = total > _EXPORT_MAX_ROWS
        return {
            "ok": True,
            "row_count": total,
            "max_export_rows": _EXPORT_MAX_ROWS,
            "capped": capped,
            "message": (
                f"匹配 {total:,} 行，超过导出上限 {_EXPORT_MAX_ROWS:,}，导出时将仅包含前 {_EXPORT_MAX_ROWS:,} 行。"
                if capped
                else None
            ),
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_export_invoices_meta(conn: Any) -> dict[str, Any]:
    try:
        years: set[int] = set()
        for (yv,) in conn.execute(
            "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL ORDER BY stat_year DESC"
        ).fetchall() or []:
            if yv is not None:
                yi = int(yv)
                if 1990 <= yi <= 2100:
                    years.add(yi)
        year_list = [str(y) for y in sorted(years, reverse=True)] or [str(date.today().year)]
        statuses = ["全部", "正常", "作废", "红冲"]
        cnt = int(conn.execute("SELECT COUNT(*)::BIGINT FROM dwd_inv_header").fetchone()[0] or 0)
        return {
            "ok": True,
            "stat_years": year_list,
            "default_stat_year": year_list[0],
            "invoice_status_options": statuses,
            "total_headers": cnt,
            "max_export_rows": _EXPORT_MAX_ROWS,
            "formats": ["csv", "xlsx"],
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def export_invoices_csv_bytes(
    conn: Any,
    *,
    stat_year: int | None,
    entity_id: str | None = None,
    seller_tax_no: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    fpzt: str | None = None,
    max_rows: int = 5000,
) -> tuple[bytes | None, int, int]:
    """
    导出发票明细 CSV（用于交付包等场景）。
    返回 (csv_bytes_or_none, exported_rows, total_matched_rows)。
    超过 max_rows 时截断并仍返回 CSV。
    """
    try:
        count_sql, count_params = _build_count_sql(
            stat_year=stat_year,
            entity_id=entity_id,
            seller_tax_no=seller_tax_no,
            date_from=date_from,
            date_to=date_to,
            fpzt=fpzt,
        )
        total = int(conn.execute(count_sql, count_params).fetchone()[0] or 0)
        if total <= 0:
            return None, 0, 0
        lim = max(1, min(int(max_rows or 5000), _EXPORT_MAX_ROWS))
        sql, params = _build_export_sql(
            stat_year=stat_year,
            entity_id=entity_id,
            seller_tax_no=seller_tax_no,
            date_from=date_from,
            date_to=date_to,
            fpzt=fpzt,
        )
        sql = sql.rsplit("LIMIT", 1)[0].strip() + f"\n        LIMIT {lim}\n    "
        rows = conn.execute(sql, params).fetchall()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([label for _, label in _EXPORT_COLUMNS])
        for r in rows or []:
            writer.writerow([r[i] for i in range(len(_EXPORT_COLUMNS))])
        return buf.getvalue().encode("utf-8-sig"), len(rows or []), total
    except Exception as exc:
        logger.warning("export_invoices_csv_bytes: %s", exc)
        return None, 0, 0


def api_export_invoices(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    seller_tax_no: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    fpzt: str | None = None,
    fmt: str = "csv",
) -> tuple[int, bytes | dict[str, Any], str, str]:
    """返回 (status, body, content_type, filename)。"""
    try:
        from src.local_api.license_gate import check_export_allowed

        denied = check_export_allowed()
        if denied:
            return 403, denied, "", ""

        y = _safe_int_year(stat_year) if stat_year else None
        count_sql, count_params = _build_count_sql(
            stat_year=y,
            entity_id=entity_id,
            seller_tax_no=seller_tax_no,
            date_from=date_from,
            date_to=date_to,
            fpzt=fpzt,
        )
        total = int(conn.execute(count_sql, count_params).fetchone()[0] or 0)
        if total > _EXPORT_MAX_ROWS:
            return (
                400,
                {
                    "ok": False,
                    "error": {
                        "code": "export_row_cap_exceeded",
                        "message": (
                            f"匹配 {total:,} 行明细，超过单次导出上限 {_EXPORT_MAX_ROWS:,}。"
                            "请缩小筛选范围（年度/主体/日期）后重试。"
                        ),
                        "row_count": total,
                        "max_export_rows": _EXPORT_MAX_ROWS,
                    },
                },
                "",
                "",
            )
        sql, params = _build_export_sql(
            stat_year=y,
            entity_id=entity_id,
            seller_tax_no=seller_tax_no,
            date_from=date_from,
            date_to=date_to,
            fpzt=fpzt,
        )
        rows = conn.execute(sql, params).fetchall()
        export_fmt = (fmt or "csv").strip().lower()
        year_tag = str(y) if y else "all"
        if export_fmt == "xlsx":
            try:
                from openpyxl import Workbook
            except ImportError as exc:
                return 400, {"ok": False, "error": {"message": "缺少 openpyxl 依赖"}}, "", ""
            wb = Workbook()
            ws = wb.active
            ws.title = "发票明细"
            ws.append([label for _, label in _EXPORT_COLUMNS])
            for r in rows or []:
                ws.append([r[i] for i in range(len(_EXPORT_COLUMNS))])
            buf = io.BytesIO()
            wb.save(buf)
            data = buf.getvalue()
            fname = f"invoice_export_{year_tag}.xlsx"
            return (
                200,
                data,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                fname,
            )
        # CSV default
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([label for _, label in _EXPORT_COLUMNS])
        for r in rows or []:
            writer.writerow([r[i] for i in range(len(_EXPORT_COLUMNS))])
        data = buf.getvalue().encode("utf-8-sig")
        fname = f"invoice_export_{year_tag}.csv"
        return 200, data, "text/csv; charset=utf-8", fname
    except Exception as exc:
        logger.exception("export_invoices")
        return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""
