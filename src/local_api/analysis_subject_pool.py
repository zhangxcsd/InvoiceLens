"""L1 分析主体池：花名册成员 ∩ 已映射 org ∩ 有票 ∩ 发票张数 ≥ N。"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

_YEAR_RE_MIN = 1990
_YEAR_RE_MAX = 2100


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


def get_min_invoice_count() -> int:
    try:
        from src.local_api.settings_api import get_setting

        n = int(get_setting("min_analysis_subject_invoice_count", 10))
    except (TypeError, ValueError, ImportError):
        n = 10
    return max(0, n)


def _parse_min_invoice_count(raw: Any) -> int | None:
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if 1 <= n <= 10000:
        return n
    return None


def _resolve_min_invoice_count(min_invoice_count: int | None = None) -> int:
    if min_invoice_count is not None:
        return min_invoice_count
    return get_min_invoice_count()


def _analysis_subject_sql(*, require_buyer: bool, require_both_roles: bool = False) -> str:
    buyer_clause = " AND COALESCE(r.has_buyer_role, FALSE)" if require_buyer else ""
    both_roles_clause = (
        " AND COALESCE(r.has_buyer_role, FALSE) AND COALESCE(r.has_seller_role, FALSE)"
        if require_both_roles
        else ""
    )
    return f"""
WITH org_subject_ranked AS (
    SELECT
        subject_id,
        subject_name,
        subject_no,
        upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\\s-]+', '', 'g')) AS norm_no,
        ROW_NUMBER() OVER (
            PARTITION BY upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\\s-]+', '', 'g'))
            ORDER BY subject_id
        ) AS rn
    FROM dim_subject_master
    WHERE subject_category = 'org'
      AND trim(COALESCE(subject_no, '')) <> ''
),
org_subject_dedup AS (
    SELECT subject_id, subject_name, subject_no, norm_no
    FROM org_subject_ranked
    WHERE rn = 1
)
SELECT
    upper(regexp_replace(trim(COALESCE(ro.enterprise_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
    trim(COALESCE(m.subject_name, ro.enterprise_name, ro.enterprise_id, '')) AS entity_name,
    COALESCE(r.has_seller_role, FALSE) AS has_seller_role,
    COALESCE(r.has_buyer_role, FALSE) AS has_buyer_role,
    COALESCE(r.invoice_count, 0)::BIGINT AS invoice_count,
    COALESCE(r.amount_jshj_sum, 0) AS amount_jshj_sum
FROM dim_enterprise_year_roster ro
INNER JOIN org_subject_dedup m
    ON m.norm_no = upper(regexp_replace(trim(COALESCE(ro.enterprise_id, '')), '[\\s-]+', '', 'g'))
INNER JOIN dim_enterprise_year_rel r
    ON r.subject_id = m.subject_id
   AND r.stat_year = ro.stat_year
WHERE ro.stat_year = ?
  AND COALESCE(ro.is_member, TRUE)
  AND length(upper(regexp_replace(trim(COALESCE(ro.enterprise_id, '')), '[\\s-]+', '', 'g'))) > 0
  AND (COALESCE(r.has_seller_role, FALSE) OR COALESCE(r.has_buyer_role, FALSE))
  AND COALESCE(r.invoice_count, 0) >= ?{buyer_clause}{both_roles_clause}
ORDER BY invoice_count DESC, entity_id
LIMIT 2000
"""


def api_analysis_subject_meta(conn: Any, *, min_invoice_count: int | None = None) -> dict[str, Any]:
    """返回分析主体池阈值与口径说明。"""
    try:
        n = _resolve_min_invoice_count(min_invoice_count)
        roster_cnt = 0
        pool_cnt = 0
        try:
            roster_cnt = int(
                conn.execute(
                    """
                    SELECT COUNT(*)::BIGINT
                    FROM dim_enterprise_year_roster
                    WHERE COALESCE(is_member, TRUE)
                    """
                ).fetchone()[0]
                or 0
            )
        except Exception:
            pass
        try:
            pool_cnt = int(
                conn.execute(
                    f"SELECT COUNT(*)::BIGINT FROM ({_analysis_subject_sql(require_buyer=False)}) t",
                    [int(_calendar_year()), n],
                ).fetchone()[0]
                or 0
            )
        except Exception:
            pass
        return {
            "ok": True,
            "min_invoice_count": n,
            "comparison": ">=",
            "roster_row_count": roster_cnt,
            "pool_ready": roster_cnt > 0,
            "caliber_hint": (
                f"分析主体池：当年花名册成员、已映射主体库 org、当年有发票数据（购方或销方任一侧），"
                f"且当年发票张数 ≥ {n}。与「发票报送覆盖分析 · 已报送」（购销双向、无张数门槛）口径不同。"
            ),
            "sample_pool_count_current_year": pool_cnt,
        }
    except Exception as exc:
        logger.exception("analysis_subject_meta")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_analysis_subject_options(
    conn: Any,
    *,
    stat_year: str | None,
    require_buyer: bool = False,
    require_both_roles: bool = False,
    min_invoice_count: int | None = None,
) -> dict[str, Any]:
    """分析主体下拉选项（entity_id 为规范化税号，与 DWS 购方视角一致）。"""
    try:
        y = _safe_int_year(stat_year)
        n = _resolve_min_invoice_count(min_invoice_count)
        rows = conn.execute(
            _analysis_subject_sql(require_buyer=require_buyer, require_both_roles=require_both_roles),
            [y, n],
        ).fetchall()
        options = [
            {
                "entity_id": str(r[0] or ""),
                "entity_name": str(r[1] or r[0] or ""),
                "has_seller_role": bool(r[2]),
                "has_buyer_role": bool(r[3]),
                "invoice_count": int(r[4] or 0),
                "total_net_jshj": float(r[5] or 0),
            }
            for r in rows or []
            if r and r[0]
        ]
        hint = None
        if not options:
            hint = (
                f"{y} 年度暂无符合分析主体池条件的企业。"
                f"请维护花名册、重算企业年度购销标志，并确认当年发票张数 ≥ {n}。"
            )
        return {
            "ok": True,
            "stat_year": str(y),
            "min_invoice_count": n,
            "comparison": ">=",
            "require_buyer": bool(require_buyer),
            "require_both_roles": bool(require_both_roles),
            "options": options,
            "hint": hint,
        }
    except Exception as exc:
        logger.exception("analysis_subject_options")
        return {
            "ok": False,
            "options": [],
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
