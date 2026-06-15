"""审计规则 SQL 片段（与 dws_build 口径对齐）。"""

from __future__ import annotations

import calendar
import json
from typing import Any


def norm_tax(col: str) -> str:
    return f"upper(regexp_replace(trim(COALESCE({col}, '')), '[\\s-]+', '', 'g'))"


NET_AMT = "COALESCE(h.net_jshj, h.jshj, 0)"
ABS_NET = f"abs({NET_AMT})"
FPZT_NORMAL = "coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') = '正常'"
IS_POSITIVE = f"({NET_AMT} > 0)"
IS_RED = f"({NET_AMT} < 0 OR COALESCE(h.is_orphan_red, FALSE))"
IS_CANCEL = (
    "(coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') <> '正常' "
    "OR COALESCE(h.net_calc_status, '') = '已作废')"
)


def entity_filter(entity_id: str | None, *, xfs_col: str = "h.xfsbh", gfs_col: str = "h.gfsbh") -> tuple[str, list[Any]]:
    import re

    raw = re.sub(r"[\s-]+", "", str(entity_id or "").strip()).upper()
    if not raw:
        return "", []
    nx = norm_tax(xfs_col)
    ng = norm_tax(gfs_col)
    return f" AND ({nx} = ? OR {ng} = ?)", [raw, raw]


def year_params(stat_year: int, entity_id: str | None) -> tuple[list[Any], str]:
    ef, ep = entity_filter(entity_id)
    return [stat_year] + ep, ef


def month_date_bounds(stat_year: int, stat_month: int) -> tuple[str, str]:
    """stat_month 为 1–12，返回该月起止 ISO 日期。"""
    y = int(stat_year)
    m = int(stat_month)
    if m < 1 or m > 12:
        return f"{y}-01-01", f"{y}-12-31"
    last = calendar.monthrange(y, m)[1]
    return f"{y}-{m:02d}-01", f"{y}-{m:02d}-{last:02d}"


def flag_detail_json(**fields: Any) -> str:
    """疑点 detail_json（供前端深链，跳过 None）。"""
    payload = {k: v for k, v in fields.items() if v is not None}
    return json.dumps(payload, ensure_ascii=False)
