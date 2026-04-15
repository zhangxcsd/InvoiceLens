"""
开票日期：与 DWD cleaner._sql_invoice_date_try_expr（DuckDB）语义对齐的 Python 单值解析。

修改解析规则时请同时更新：
- 本模块 parse_invoice_date_raw
- src/etl/cleaner._sql_invoice_date_try_expr
"""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any

import pandas as pd

# ODS 开票日期原串列名候选（须与 config/dwd_mapping 中 dwd_inv_header.kprq / dwd_inv_detail.kprq 的 source.ods_fields 顺序与集合一致）
ODS_INVOICE_DATE_CANDIDATES: tuple[str, ...] = (
    "kprq",
    "开票日期",
    "发票日期",
    "invoice_date",
    "日期",
)

_EXCEL_SERIAL_MIN = 1000
_EXCEL_SERIAL_MAX = 100_000


def parse_invoice_date_raw(raw: Any) -> date | None:
    """
    将单元格原始值解析为 date，失败返回 None。
    顺序与 cleaner._sql_invoice_date_try_expr 中 COALESCE 分支一致（尽量同源）。
    """
    if raw is None:
        return None
    try:
        if raw is pd.NA or bool(pd.isna(raw)):
            return None
    except (TypeError, ValueError):
        pass

    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if isinstance(raw, pd.Timestamp):
        if pd.isna(raw):
            return None
        return raw.date()

    s = str(raw).strip()
    if not s:
        return None
    if s.lower() in {"nan", "none", "null"}:
        return None
    if s in {"--", "—", "-", "N/A", "n/a"}:
        return None

    date_norm = s.replace("/", "-")

    for fmt, src in (
        ("%Y-%m-%d", date_norm),
        ("%Y%m%d", s),
        ("%Y-%m-%d %H:%M:%S", s),
        ("%Y/%m/%d %H:%M:%S", s),
    ):
        try:
            return datetime.strptime(src, fmt).date()
        except ValueError:
            pass

    # 对应 TRY_CAST(col AS DATE) / TIMESTAMP（宽松 ISO）
    try:
        ts = pd.to_datetime(s, errors="coerce")
        if ts is not pd.NaT:
            return ts.date()
    except Exception:
        pass

    # Excel 序列号（与 DuckDB：FLOOR + 1899-12-30 + INTERVAL day 一致）
    try:
        v = float(s)
        if math.isnan(v):
            return None
        n = int(math.floor(v + 1e-9))
        if _EXCEL_SERIAL_MIN <= n <= _EXCEL_SERIAL_MAX:
            dt2 = pd.to_datetime(n, unit="D", origin="1899-12-30", errors="coerce")
            if dt2 is not pd.NaT:
                return dt2.date()
    except (ValueError, TypeError, OverflowError):
        pass

    return None
