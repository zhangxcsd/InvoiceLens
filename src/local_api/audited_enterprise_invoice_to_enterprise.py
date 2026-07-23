"""票→企业：从发票侧识别购销双向且张数达标的主体，核对是否在被审企业台账。"""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

_YEAR_RE_MIN = 1990
_YEAR_RE_MAX = 2100


def _norm_pid(value: str) -> str:
    return re.sub(r"[\s-]+", "", str(value or "").strip()).upper()


def _calendar_year() -> int:
    return date.today().year


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = _calendar_year() if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < _YEAR_RE_MIN or y > _YEAR_RE_MAX:
        return d
    return y


def _state_capital_status(state_investor: str, code: str) -> str:
    if state_investor.strip():
        return "国资"
    if code.strip():
        return "非国资"
    return "未维护"


def _distinct_stat_years_from_dwd(conn: Any) -> list[str]:
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT CAST(stat_year AS INTEGER) AS y
            FROM dwd_inv_header
            WHERE stat_year IS NOT NULL
            ORDER BY y DESC
            """
        ).fetchall()
        return [str(int(r[0])) for r in rows if r and r[0] is not None]
    except Exception as exc:
        logger.warning("invoice-to-enterprise: load stat years failed: %s", exc)
        return []


def _load_registry_by_pid(conn: Any, *, snapshot_year: int) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    try:
        rows = conn.execute(
            """
            SELECT
                COALESCE(unified_social_credit_code, ''),
                COALESCE(enterprise_name, ''),
                COALESCE(state_investor, '')
            FROM dim_audited_enterprise_registry
            WHERE snapshot_year = ?
            """,
            [snapshot_year],
        ).fetchall()
        for r in rows or []:
            code = str(r[0] or "")
            pid = _norm_pid(code)
            if not pid:
                continue
            out[pid] = {
                "code": code,
                "name": str(r[1] or ""),
                "stateInvestor": str(r[2] or ""),
            }
    except Exception as exc:
        logger.warning("invoice-to-enterprise: load registry failed: %s", exc)
    return out


def _invoice_target_pool_sql() -> str:
    return """
WITH dwd_subject_union AS (
    SELECT
        CAST(h.stat_year AS INTEGER) AS stat_year,
        TRIM(h.xfsbh) AS subject_no_raw,
        TRIM(COALESCE(h.xfmc, '')) AS party_name,
        'seller' AS role_tag
    FROM dwd_inv_header h
    WHERE h.stat_year IS NOT NULL
      AND TRIM(COALESCE(h.xfsbh, '')) <> ''

    UNION ALL

    SELECT
        CAST(h.stat_year AS INTEGER) AS stat_year,
        TRIM(h.gfsbh) AS subject_no_raw,
        TRIM(COALESCE(h.gfmc, '')) AS party_name,
        'buyer' AS role_tag
    FROM dwd_inv_header h
    WHERE h.stat_year IS NOT NULL
      AND TRIM(COALESCE(h.gfsbh, '')) <> ''
),
normed AS (
    SELECT
        stat_year,
        upper(regexp_replace(trim(COALESCE(subject_no_raw, '')), '[\\s-]+', '', 'g')) AS norm_no,
        party_name,
        role_tag
    FROM dwd_subject_union
    WHERE length(upper(regexp_replace(trim(COALESCE(subject_no_raw, '')), '[\\s-]+', '', 'g'))) > 0
),
year_agg AS (
    SELECT
        stat_year,
        norm_no,
        max_by(party_name, length(party_name)) AS enterprise_name,
        COALESCE(BOOL_OR(role_tag = 'seller'), FALSE) AS has_seller_role,
        COALESCE(BOOL_OR(role_tag = 'buyer'), FALSE) AS has_buyer_role,
        COUNT(*)::BIGINT AS invoice_count
    FROM normed
    GROUP BY stat_year, norm_no
)
SELECT
    norm_no,
    enterprise_name,
    has_seller_role,
    has_buyer_role,
    invoice_count
FROM year_agg
WHERE stat_year = ?
  AND COALESCE(has_seller_role, FALSE)
  AND COALESCE(has_buyer_role, FALSE)
  AND COALESCE(invoice_count, 0) >= ?
ORDER BY invoice_count DESC, norm_no
LIMIT 5000
"""


def api_audited_enterprise_invoice_to_enterprise(
    conn: Any,
    *,
    stat_year: str | None,
    min_invoice_count: int | None = None,
) -> dict[str, Any]:
    try:
        from src.local_api.analysis_subject_pool import get_min_invoice_count

        stat_years = _distinct_stat_years_from_dwd(conn)
        if not stat_years:
            cy = str(_calendar_year())
            stat_years = [cy]

        y = _safe_int_year(stat_year, _safe_int_year(stat_years[0] if stat_years else None))
        y_s = str(y)
        if y_s not in stat_years:
            stat_years = sorted(set(stat_years + [y_s]), key=lambda x: int(x), reverse=True)

        n = min_invoice_count if min_invoice_count is not None else get_min_invoice_count()
        n = max(1, min(int(n), 10000))

        registry_by_pid = _load_registry_by_pid(conn, snapshot_year=y)
        rows_raw = conn.execute(_invoice_target_pool_sql(), [y, n]).fetchall()

        rows_out: list[dict[str, Any]] = []
        in_registry = 0
        for r in rows_raw or []:
            try:
                pid = str(r[0] or "")
                reg = registry_by_pid.get(pid)
                in_reg = reg is not None
                if in_reg:
                    in_registry += 1
                code = reg["code"] if reg else pid
                name = reg["name"] if reg else str(r[1] or pid)
                state_investor = reg["stateInvestor"] if reg else ""
                rows_out.append(
                    {
                        "taxpayerId": code or pid,
                        "enterpriseName": str(r[1] or name or pid),
                        "hasSellerRole": bool(r[2]),
                        "hasBuyerRole": bool(r[3]),
                        "invoiceCount": int(r[4] or 0),
                        "inAuditedRegistry": in_reg,
                        "registryName": name if in_reg else "",
                        "registryCode": code if in_reg else "",
                        "stateCapitalStatus": _state_capital_status(state_investor, code),
                    }
                )
            except Exception as exc:
                logger.warning("invoice-to-enterprise row skipped: %s", exc)

        total = len(rows_out)
        return {
            "ok": True,
            "stat_years": stat_years,
            "selected_stat_year": y_s,
            "snapshot_year": y_s,
            "min_invoice_count": n,
            "caliber_hint": (
                f"分析目标群体：{y_s} 年度发票数据中，同一税号同时出现销方与购方角色，"
                f"且参与计数的发票行数 ≥ {n}。再与同年被审企业台账（dim_audited_enterprise_registry）"
                "按规范化税号核对是否在册。"
            ),
            "rows": rows_out,
            "summary": {
                "total": total,
                "in_registry": in_registry,
                "not_in_registry": max(0, total - in_registry),
            },
        }
    except Exception as exc:
        logger.exception("invoice-to-enterprise list failed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }
