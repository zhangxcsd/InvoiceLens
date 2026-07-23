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


def _norm_entity_id(v: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _parse_org_tree(tree: str | None) -> str:
    return "eq" if str(tree or "").lower().startswith("eq") else "mg"


def _org_tree_columns(tree_mode: str) -> tuple[str, str, str]:
    if tree_mode == "eq":
        return "eq_path_ids", "eq_level", "eq_path"
    return "mg_path_ids", "mg_level", "mg_path"


_ORG_SCOPE_NOT_FOUND_MSG = (
    "{year} 年度组织层级中未找到该节点。"
    "请确认台账已导入并在「组织层级树」维护上级关系；"
    "若台账已有数据可刷新页面重试，或在加工中心运行「组织层级双树物化」。"
)


def _maybe_materialize_org_hier_for_year(conn: Any, year: int) -> bool:
    """dim_org_hier 缺少年份数据但台账有时，触发一次台账物化。"""
    try:
        hier_cnt = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM dim_org_hier WHERE stat_year = ?",
                [year],
            ).fetchone()[0]
            or 0
        )
        if hier_cnt > 0:
            return False
        reg_cnt = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM dim_audited_enterprise_registry WHERE snapshot_year = ?",
                [year],
            ).fetchone()[0]
            or 0
        )
        if reg_cnt <= 0:
            return False
        from src.local_api.dim_org_hier_build import materialize_org_hier_from_registry

        result = materialize_org_hier_from_registry(
            conn,
            stat_years=[year],
            replace_years=True,
            updated_by="ORG_SCOPE_LOOKUP",
        )
        return bool(result.get("ok"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("maybe_materialize_org_hier_for_year failed: %s", exc)
        return False


def _fetch_org_hier_scope_row(
    conn: Any,
    *,
    year: int,
    scope_id: str,
    path_col: str,
    level_col: str,
) -> tuple[Any, ...] | None:
    sql = f"""
        SELECT
            upper(regexp_replace(trim(COALESCE(entity_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
            trim(COALESCE(entity_shortname, entity_fullname, entity_id, '')) AS entity_name,
            {level_col},
            {path_col}
        FROM dim_org_hier
        WHERE stat_year = ?
          AND upper(regexp_replace(trim(COALESCE(entity_id, '')), '[\\s-]+', '', 'g')) = ?
    """
    row = conn.execute(sql, [year, scope_id]).fetchone()
    if row and row[3]:
        return row
    if _maybe_materialize_org_hier_for_year(conn, year):
        row = conn.execute(sql, [year, scope_id]).fetchone()
        if row and row[3]:
            return row
    return None


def _org_subject_dedup_cte() -> str:
    return """
org_subject_ranked AS (
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
)"""


def _parse_member_source(raw: str | None) -> str:
    return "org_subtree" if str(raw or "").strip().lower() in ("org_subtree", "subtree", "org") else "pool"


def _parse_excluded_entity_ids(raw: str | None) -> set[str]:
    out: set[str] = set()
    if not raw:
        return out
    for part in str(raw).split(","):
        eid = _norm_entity_id(part)
        if eid:
            out.add(eid)
    return out


def resolve_org_subtree_scope_members(
    conn: Any,
    *,
    stat_year: str | None,
    tree: str | None,
    scope_entity_id: str | None,
) -> dict[str, Any]:
    """组织节点及其下级子树全部成员（LEFT JOIN 当年票据统计；不含 L1 池 / 张数 / 角色门槛）。"""
    try:
        y = _safe_int_year(stat_year)
        tree_mode = _parse_org_tree(tree)
        path_col, level_col, _path_name_col = _org_tree_columns(tree_mode)
        scope_id = _norm_entity_id(scope_entity_id)
        if not scope_id:
            return {
                "ok": False,
                "members": [],
                "error": {"message": "需指定组织节点 scope_entity_id", "exception_type": "ValidationError"},
            }
        scope_row = _fetch_org_hier_scope_row(
            conn,
            year=y,
            scope_id=scope_id,
            path_col=path_col,
            level_col=level_col,
        )
        if not scope_row:
            return {
                "ok": False,
                "members": [],
                "error": {
                    "message": _ORG_SCOPE_NOT_FOUND_MSG.format(year=y),
                    "exception_type": "NotFoundError",
                },
            }
        path_ids = str(scope_row[3] or "")
        subtree_total = int(
            conn.execute(
                f"""
                SELECT COUNT(*)::BIGINT
                FROM dim_org_hier
                WHERE stat_year = ?
                  AND length(upper(regexp_replace(trim(COALESCE(entity_id, '')), '[\\s-]+', '', 'g'))) > 0
                  AND ({path_col} = ? OR {path_col} LIKE ? || '/%')
                """,
                [y, path_ids, path_ids],
            ).fetchone()[0]
            or 0
        )
        member_rows = conn.execute(
            f"""
            WITH {_org_subject_dedup_cte()},
            subtree AS (
                SELECT
                    upper(regexp_replace(trim(COALESCE(h.entity_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
                    trim(COALESCE(h.entity_shortname, h.entity_fullname, h.entity_id, '')) AS org_name,
                    h.{level_col} AS org_level
                FROM dim_org_hier h
                WHERE h.stat_year = ?
                  AND length(upper(regexp_replace(trim(COALESCE(h.entity_id, '')), '[\\s-]+', '', 'g'))) > 0
                  AND (h.{path_col} = ? OR h.{path_col} LIKE ? || '/%')
            )
            SELECT
                s.entity_id,
                trim(COALESCE(
                    NULLIF(trim(COALESCE(m.subject_name, '')), ''),
                    NULLIF(trim(COALESCE(ro.enterprise_name, '')), ''),
                    s.org_name,
                    s.entity_id
                )) AS entity_name,
                s.org_level,
                COALESCE(r.has_seller_role, FALSE) AS has_seller_role,
                COALESCE(r.has_buyer_role, FALSE) AS has_buyer_role,
                COALESCE(r.invoice_count, 0)::BIGINT AS invoice_count,
                COALESCE(r.amount_jshj_sum, 0) AS amount_jshj_sum,
                (ro.enterprise_id IS NOT NULL) AS in_roster
            FROM subtree s
            LEFT JOIN dim_enterprise_year_roster ro
                ON ro.stat_year = ?
               AND upper(regexp_replace(trim(COALESCE(ro.enterprise_id, '')), '[\\s-]+', '', 'g')) = s.entity_id
               AND COALESCE(ro.is_member, TRUE)
            LEFT JOIN org_subject_dedup m ON m.norm_no = s.entity_id
            LEFT JOIN dim_enterprise_year_rel r
                ON r.subject_id = m.subject_id
               AND CAST(r.stat_year AS INTEGER) = ?
            ORDER BY s.org_level, invoice_count DESC, s.entity_id
            LIMIT 2000
            """,
            [y, path_ids, path_ids, y, y],
        ).fetchall()
        members = [
            {
                "entity_id": str(r[0] or ""),
                "entity_name": str(r[1] or r[0] or ""),
                "org_level": int(r[2] or 0),
                "has_seller_role": bool(r[3]),
                "has_buyer_role": bool(r[4]),
                "invoice_count": int(r[5] or 0),
                "total_net_jshj": float(r[6] or 0),
                "in_roster": bool(r[7]),
            }
            for r in member_rows or []
            if r and r[0]
        ]
        hint = None
        if not members and subtree_total > 0:
            hint = f"节点「{scope_row[1] or scope_id}」及其下级共 {subtree_total} 家组织成员，但未解析到有效企业税号。"
        return {
            "ok": True,
            "stat_year": str(y),
            "tree": tree_mode,
            "scope_entity_id": scope_id,
            "scope_entity_name": str(scope_row[1] or scope_id),
            "scope_org_level": int(scope_row[2] or 0),
            "subtree_org_count": subtree_total,
            "member_count": len(members),
            "members": members,
            "hint": hint,
            "member_source": "org_subtree",
        }
    except Exception as exc:
        logger.exception("resolve_org_subtree_scope_members")
        return {
            "ok": False,
            "members": [],
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def api_analysis_scope_entity_options(
    conn: Any,
    *,
    stat_year: str | None,
) -> dict[str, Any]:
    """单主体模式：花名册成员 ∪ 当年组织树节点（按 entity_id 去重）。"""
    try:
        y = _safe_int_year(stat_year)
        rows = conn.execute(
            """
            WITH roster AS (
                SELECT
                    upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
                    trim(COALESCE(enterprise_name, enterprise_id, '')) AS entity_name
                FROM dim_enterprise_year_roster
                WHERE stat_year = ?
                  AND COALESCE(is_member, TRUE)
                  AND length(upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g'))) > 0
            ),
            org_nodes AS (
                SELECT
                    upper(regexp_replace(trim(COALESCE(entity_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
                    trim(COALESCE(entity_shortname, entity_fullname, entity_id, '')) AS entity_name
                FROM dim_org_hier
                WHERE stat_year = ?
                  AND length(upper(regexp_replace(trim(COALESCE(entity_id, '')), '[\\s-]+', '', 'g'))) > 0
            ),
            unioned AS (
                SELECT entity_id, entity_name, 1 AS src_order FROM roster
                UNION ALL
                SELECT entity_id, entity_name, 2 AS src_order FROM org_nodes
            ),
            ranked AS (
                SELECT
                    entity_id,
                    entity_name,
                    ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY src_order, entity_name) AS rn
                FROM unioned
            )
            SELECT entity_id, entity_name
            FROM ranked
            WHERE rn = 1
            ORDER BY entity_name, entity_id
            LIMIT 5000
            """,
            [y, y],
        ).fetchall()
        options = [
            {
                "entity_id": str(r[0] or ""),
                "entity_name": str(r[1] or r[0] or ""),
            }
            for r in rows or []
            if r and r[0]
        ]
        hint = None
        if not options:
            hint = f"{y} 年度暂无花名册成员或组织树节点，请先维护组织维度与花名册。"
        return {
            "ok": True,
            "stat_year": str(y),
            "options": options,
            "hint": hint,
            "source": "org_union",
        }
    except Exception as exc:
        logger.exception("analysis_scope_entity_options")
        return {
            "ok": False,
            "options": [],
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def resolve_analysis_org_scope_members(
    conn: Any,
    *,
    stat_year: str | None,
    tree: str | None,
    scope_entity_id: str | None,
    require_buyer: bool = False,
    require_both_roles: bool = False,
    min_invoice_count: int | None = None,
) -> dict[str, Any]:
    """组织节点及其下级子树 ∩ 分析主体池：返回可分析的主体清单（含所选节点自身）。"""
    try:
        y = _safe_int_year(stat_year)
        tree_mode = _parse_org_tree(tree)
        path_col, level_col, _path_name_col = _org_tree_columns(tree_mode)
        scope_id = _norm_entity_id(scope_entity_id)
        if not scope_id:
            return {
                "ok": False,
                "members": [],
                "error": {"message": "需指定组织节点 scope_entity_id", "exception_type": "ValidationError"},
            }
        n = _resolve_min_invoice_count(min_invoice_count)
        scope_row = _fetch_org_hier_scope_row(
            conn,
            year=y,
            scope_id=scope_id,
            path_col=path_col,
            level_col=level_col,
        )
        if not scope_row:
            return {
                "ok": False,
                "members": [],
                "error": {
                    "message": _ORG_SCOPE_NOT_FOUND_MSG.format(year=y),
                    "exception_type": "NotFoundError",
                },
            }
        path_ids = str(scope_row[3] or "")
        subtree_total = int(
            conn.execute(
                f"""
                SELECT COUNT(*)::BIGINT
                FROM dim_org_hier
                WHERE stat_year = ?
                  AND ({path_col} = ? OR {path_col} LIKE ? || '/%')
                """,
                [y, path_ids, path_ids],
            ).fetchone()[0]
            or 0
        )
        pool_sql = _analysis_subject_sql(require_buyer=require_buyer, require_both_roles=require_both_roles)
        member_rows = conn.execute(
            f"""
            WITH pool AS (
                {pool_sql}
            ),
            subtree AS (
                SELECT
                    upper(regexp_replace(trim(COALESCE(h.entity_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
                    h.{level_col} AS org_level
                FROM dim_org_hier h
                WHERE h.stat_year = ?
                  AND (h.{path_col} = ? OR h.{path_col} LIKE ? || '/%')
            )
            SELECT
                p.entity_id,
                p.entity_name,
                s.org_level,
                p.has_seller_role,
                p.has_buyer_role,
                p.invoice_count,
                p.amount_jshj_sum
            FROM pool p
            INNER JOIN subtree s ON p.entity_id = s.entity_id
            ORDER BY s.org_level, p.invoice_count DESC, p.entity_id
            LIMIT 2000
            """,
            [y, n, y, path_ids, path_ids],
        ).fetchall()
        members = [
            {
                "entity_id": str(r[0] or ""),
                "entity_name": str(r[1] or r[0] or ""),
                "org_level": int(r[2] or 0),
                "has_seller_role": bool(r[3]),
                "has_buyer_role": bool(r[4]),
                "invoice_count": int(r[5] or 0),
                "total_net_jshj": float(r[6] or 0),
            }
            for r in member_rows or []
            if r and r[0]
        ]
        hint = None
        if not members:
            hint = (
                f"节点「{scope_row[1] or scope_id}」及其下级共 {subtree_total} 家组织成员，"
                f"但无企业同时满足分析主体池条件（花名册 + org 映射 + 当年有票且张数 ≥ {n}）。"
            )
        return {
            "ok": True,
            "stat_year": str(y),
            "tree": tree_mode,
            "scope_entity_id": scope_id,
            "scope_entity_name": str(scope_row[1] or scope_id),
            "scope_org_level": int(scope_row[2] or 0),
            "subtree_org_count": subtree_total,
            "member_count": len(members),
            "members": members,
            "hint": hint,
        }
    except Exception as exc:
        logger.exception("resolve_analysis_org_scope_members")
        return {
            "ok": False,
            "members": [],
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def api_analysis_org_scope_members(
    conn: Any,
    *,
    stat_year: str | None,
    tree: str | None,
    scope_entity_id: str | None,
    require_buyer: bool = False,
    require_both_roles: bool = False,
    min_invoice_count: int | None = None,
    member_source: str | None = None,
) -> dict[str, Any]:
    if _parse_member_source(member_source) == "org_subtree":
        return resolve_org_subtree_scope_members(
            conn,
            stat_year=stat_year,
            tree=tree,
            scope_entity_id=scope_entity_id,
        )
    return resolve_analysis_org_scope_members(
        conn,
        stat_year=stat_year,
        tree=tree,
        scope_entity_id=scope_entity_id,
        require_buyer=require_buyer,
        require_both_roles=require_both_roles,
        min_invoice_count=min_invoice_count,
    )
