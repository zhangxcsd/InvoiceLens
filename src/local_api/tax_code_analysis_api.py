"""税收分类编码结构分析 API（dwd_inv_detail × dim_tax_code）。"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_YEAR_RE_MIN = 1990
_YEAR_RE_MAX = 2100

_NORM_XFS = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
_NORM_GFS = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
_SSFLBM_NORM = "nullif(trim(COALESCE(d.ssflbm, '')), '')"
_LINE_AMOUNT = "coalesce(abs(d.jshj), abs(d.je), 0)"
_TAX_AMOUNT = "abs(coalesce(d.se, 0))"
_VALID_CODE = f"length({_SSFLBM_NORM}) = 19 AND regexp_matches({_SSFLBM_NORM}, '^[0-9]+$')"


def _calendar_year() -> int:
    from datetime import date

    return date.today().year


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = _calendar_year() if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < _YEAR_RE_MIN or y > _YEAR_RE_MAX:
        return d
    return y


def _norm_entity(v: str | None) -> str:
    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _parse_page(raw: Any, default: int = 1) -> int:
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return default


def _parse_page_size(raw: Any, default: int = 50) -> int:
    try:
        return max(1, min(200, int(raw)))
    except (TypeError, ValueError):
        return default


def _distinct_stat_years(conn: Any) -> list[str]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM dwd_inv_detail WHERE stat_year IS NOT NULL",
    ):
        try:
            for (yv,) in conn.execute(sql).fetchall() or []:
                if yv is not None:
                    yi = int(yv)
                    if _YEAR_RE_MIN <= yi <= _YEAR_RE_MAX:
                        years.add(yi)
        except Exception:
            continue
    if not years:
        return [str(_calendar_year())]
    return [str(y) for y in sorted(years, reverse=True)]


def _dim_tax_code_count(conn: Any) -> int:
    try:
        return int(conn.execute("SELECT COUNT(*)::BIGINT FROM dim_tax_code").fetchone()[0] or 0)
    except Exception:
        return 0


def _scope_filters(
    *,
    entity_id: str | None,
    import_batch_id: str | None,
) -> tuple[str, list[Any]]:
    """返回 scoped_lines 外层 WHERE 追加片段（审计：限定统计年度后的主体/批次范围）。"""
    clauses: list[str] = []
    params: list[Any] = []
    eid = _norm_entity(entity_id)
    if eid:
        # 审计含义：可选单户下钻，购销任一侧税号命中即纳入
        clauses.append(f"AND ({_NORM_XFS} = ? OR {_NORM_GFS} = ?)")
        params.extend([eid, eid])
    batch = str(import_batch_id or "").strip()
    if batch:
        # 审计含义：按导入批次追溯问题来源文件
        clauses.append("AND coalesce(d.import_batch_id, h.import_batch_id) = ?")
        params.append(batch)
    return " ".join(clauses), params


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


def _detail_line_filters(
    *,
    goods_name: str | None,
    slv_num: str | float | None,
) -> tuple[str, list[Any], dict[str, Any]]:
    """明细行深链过滤（RULE-05 等疑点 goods_name / slv_num）。"""
    clauses: list[str] = []
    params: list[Any] = []
    meta: dict[str, Any] = {}
    gn = str(goods_name or "").strip()
    if gn:
        # 审计含义：按货物/劳务名称收窄（大小写不敏感，支持精确或包含匹配）
        clauses.append(
            "AND (trim(coalesce(d.hwlwmc, '')) ILIKE ? OR lower(trim(coalesce(d.hwlwmc, ''))) LIKE lower(?))"
        )
        params.extend([gn, f"%{gn}%"])
        meta["goods_name"] = gn
    rate = _parse_slv_num(slv_num)
    if rate is not None:
        # 审计含义：按明细 slv_num 过滤，容差 0.005 与 RULE-05 一致
        clauses.append("AND abs(coalesce(d.slv_num, 0) - ?) <= 0.005")
        params.append(rate)
        meta["slv_num"] = rate
    return " ".join(clauses), params, meta


def _dim_empty_hint(dim_cnt: int) -> str | None:
    if dim_cnt > 0:
        return None
    return "税收分类编码库（dim_tax_code）为空，请先在「税收分类层级树」导入编码表后再查看命中率。"


def api_tax_code_analysis_overview(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    import_batch_id: str | None = None,
    keyword: str | None = None,
    goods_name: str | None = None,
    slv_num: str | float | None = None,
) -> dict[str, Any]:
    """税码覆盖率概览：命中率、未匹配规模、HIGH 类目税额占比、Top1 二级类目占比。"""
    try:
        y = _safe_int_year(stat_year)
        dim_cnt = _dim_tax_code_count(conn)
        scope_sql, scope_params = _scope_filters(
            entity_id=entity_id, import_batch_id=import_batch_id
        )
        detail_sql, detail_params, detail_meta = _detail_line_filters(
            goods_name=goods_name, slv_num=slv_num
        )
        kw = str(keyword or "").strip().lower()

        base_from = f"""
            FROM dwd_inv_detail d
            INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
            LEFT JOIN dim_tax_code tc ON trim(d.ssflbm) = trim(tc.tax_code)
            WHERE h.stat_year = ?
              AND d.logic_line_no > 0
              {scope_sql}
              {detail_sql}
        """
        params: list[Any] = [y, *scope_params, *detail_params]

        agg = conn.execute(
            f"""
            SELECT
                -- 审计：分母为票面 ssflbm 非空的明细行
                count(*) FILTER (WHERE {_SSFLBM_NORM} IS NOT NULL)::BIGINT AS lines_with_code,
                -- 审计：维表命中且编码格式符合 19 位数字口径
                count(*) FILTER (
                    WHERE {_SSFLBM_NORM} IS NOT NULL
                      AND tc.tax_code IS NOT NULL
                      AND {_VALID_CODE}
                )::BIGINT AS matched_lines,
                count(*) FILTER (
                    WHERE {_SSFLBM_NORM} IS NOT NULL
                      AND (tc.tax_code IS NULL OR NOT ({_VALID_CODE}))
                )::BIGINT AS unmatched_lines,
                coalesce(sum({_LINE_AMOUNT}) FILTER (
                    WHERE {_SSFLBM_NORM} IS NOT NULL
                      AND (tc.tax_code IS NULL OR NOT ({_VALID_CODE}))
                ), 0) AS unmatched_amount,
                coalesce(sum({_TAX_AMOUNT}) FILTER (
                    WHERE {_SSFLBM_NORM} IS NOT NULL
                      AND upper(coalesce(tc.audit_risk_label, 'NORMAL')) = 'HIGH'
                ), 0) AS high_risk_tax_amount,
                coalesce(sum({_TAX_AMOUNT}) FILTER (
                    WHERE {_SSFLBM_NORM} IS NOT NULL
                ), 0) AS total_tax_amount
            {base_from}
            """,
            params,
        ).fetchone()

        lines_with_code = int(agg[0] or 0) if agg else 0
        matched_lines = int(agg[1] or 0) if agg else 0
        unmatched_lines = int(agg[2] or 0) if agg else 0
        unmatched_amount = float(agg[3] or 0) if agg else 0.0
        high_risk_tax_amount = float(agg[4] or 0) if agg else 0.0
        total_tax_amount = float(agg[5] or 0) if agg else 0.0

        match_rate = round(matched_lines / lines_with_code, 6) if lines_with_code > 0 else 0.0
        high_risk_amount_share = (
            round(high_risk_tax_amount / total_tax_amount, 6) if total_tax_amount > 0 else 0.0
        )

        top_category_share = 0.0
        top_category_name: str | None = None
        try:
            top_row = conn.execute(
                f"""
                WITH coded AS (
                    SELECT
                        left({_SSFLBM_NORM}, 2) AS level2_prefix,
                        sum({_LINE_AMOUNT}) AS cat_amount
                    {base_from}
                      AND {_SSFLBM_NORM} IS NOT NULL
                      AND length({_SSFLBM_NORM}) >= 2
                    GROUP BY 1
                ),
                ranked AS (
                    SELECT
                        level2_prefix,
                        cat_amount,
                        sum(cat_amount) OVER () AS total_amount,
                        row_number() OVER (ORDER BY cat_amount DESC NULLS LAST) AS rn
                    FROM coded
                )
                SELECT
                    r.level2_prefix,
                    r.cat_amount,
                    r.total_amount,
                    coalesce(dim.goods_name, dim.goods_short_name, dim.full_path) AS cat_name
                FROM ranked r
                LEFT JOIN dim_tax_code dim
                  ON dim.level_depth = 2
                 AND left(trim(dim.tax_code), 2) = r.level2_prefix
                WHERE r.rn = 1
                LIMIT 1
                """,
                params,
            ).fetchone()
            if top_row and float(top_row[2] or 0) > 0:
                top_category_share = round(float(top_row[1] or 0) / float(top_row[2]), 6)
                top_category_name = str(top_row[3] or top_row[0] or "") or None
        except Exception:
            logger.exception("tax_code top_category_share")

        stat_years = _distinct_stat_years(conn)
        hints: list[str] = []
        dim_hint = _dim_empty_hint(dim_cnt)
        if dim_hint:
            hints.append(dim_hint)
        if lines_with_code == 0:
            hints.append(f"{y} 年度当前筛选条件下无有效明细行（logic_line_no>0）。")

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": _norm_entity(entity_id) or None,
            "import_batch_id": str(import_batch_id or "").strip() or None,
            "keyword": kw or None,
            **detail_meta,
            "dim_tax_code_count": dim_cnt,
            "lines_with_code": lines_with_code,
            "matched_line_count": matched_lines,
            "match_rate": match_rate,
            "unmatched_line_count": unmatched_lines,
            "unmatched_amount": round(unmatched_amount, 2),
            "high_risk_amount_share": high_risk_amount_share,
            "high_risk_tax_amount": round(high_risk_tax_amount, 2),
            "total_tax_amount": round(total_tax_amount, 2),
            "top_category_share": top_category_share,
            "top_category_name": top_category_name,
            "stat_years": stat_years,
            "hint": " ".join(hints) if hints else None,
            "caliber_hint": (
                "命中率 = 维表命中且 19 位数字编码的明细行 / ssflbm 非空明细行；"
                "HIGH 占比 = audit_risk_label=HIGH 的税额 / 非空编码行税额合计；"
                "Top1 二级类目占比 = 金额最高的前 2 位编码前缀 / 全部编码行金额。"
            ),
        }
    except Exception as exc:
        logger.exception("tax_code_analysis_overview")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_tax_code_analysis_unmatched(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    import_batch_id: str | None = None,
    keyword: str | None = None,
    goods_name: str | None = None,
    slv_num: str | float | None = None,
    page: int = 1,
    page_size: int = 50,
) -> dict[str, Any]:
    """未匹配 ssflbm 分页清单。"""
    try:
        y = _safe_int_year(stat_year)
        pg = _parse_page(page)
        ps = _parse_page_size(page_size)
        offset = (pg - 1) * ps
        dim_cnt = _dim_tax_code_count(conn)
        scope_sql, scope_params = _scope_filters(
            entity_id=entity_id, import_batch_id=import_batch_id
        )
        detail_sql, detail_params, detail_meta = _detail_line_filters(
            goods_name=goods_name, slv_num=slv_num
        )
        kw = str(keyword or "").strip()
        kw_clause = ""
        kw_params: list[Any] = []
        if kw:
            kw_clause = f"AND lower(coalesce(ssflbm_key, '')) LIKE ?"
            kw_params.append(f"%{kw.lower()}%")

        base_cte = f"""
        WITH raw_lines AS (
            SELECT
                d.header_uuid,
                CASE
                    WHEN {_SSFLBM_NORM} IS NULL THEN '（空）'
                    ELSE {_SSFLBM_NORM}
                END AS ssflbm_key,
                {_LINE_AMOUNT} AS line_amount,
                tc.tax_code AS matched_code
            FROM dwd_inv_detail d
            INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid
            LEFT JOIN dim_tax_code tc ON trim(d.ssflbm) = trim(tc.tax_code)
            WHERE h.stat_year = ?
              AND d.logic_line_no > 0
              {scope_sql}
              {detail_sql}
        ),
        unmatched AS (
            SELECT *
            FROM raw_lines
            WHERE ssflbm_key = '（空）'
               OR matched_code IS NULL
               OR NOT (length(ssflbm_key) = 19 AND regexp_matches(ssflbm_key, '^[0-9]+$'))
        ),
        grouped AS (
            SELECT
                ssflbm_key,
                count(*)::BIGINT AS line_count,
                coalesce(sum(line_amount), 0) AS amount_sum,
                count(DISTINCT header_uuid)::BIGINT AS sample_invoice_count
            FROM unmatched
            WHERE 1=1 {kw_clause}
            GROUP BY ssflbm_key
        )
        """
        count_params: list[Any] = [y, *scope_params, *detail_params, *kw_params]
        total = int(
            conn.execute(
                f"{base_cte} SELECT count(*)::BIGINT FROM grouped",
                count_params,
            ).fetchone()[0]
            or 0
        )

        rows_raw = conn.execute(
            f"""
            {base_cte}
            SELECT ssflbm_key, line_count, amount_sum, sample_invoice_count
            FROM grouped
            ORDER BY line_count DESC, amount_sum DESC, ssflbm_key
            LIMIT ? OFFSET ?
            """,
            [*count_params, ps, offset],
        ).fetchall()

        rows = [
            {
                "ssflbm": str(r[0] or ""),
                "line_count": int(r[1] or 0),
                "amount_sum": round(float(r[2] or 0), 2),
                "sample_invoice_count": int(r[3] or 0),
            }
            for r in rows_raw or []
        ]

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": _norm_entity(entity_id) or None,
            "import_batch_id": str(import_batch_id or "").strip() or None,
            "keyword": kw or None,
            **detail_meta,
            "page": pg,
            "page_size": ps,
            "total": total,
            "rows": rows,
            "dim_tax_code_count": dim_cnt,
            "hint": _dim_empty_hint(dim_cnt),
        }
    except Exception as exc:
        logger.exception("tax_code_analysis_unmatched")
        return {"ok": False, "rows": [], "total": 0, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_tax_code_analysis_enterprise_summary(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    keyword: str | None = None,
    top_category: str | None = None,
    goods_name: str | None = None,
    slv_num: str | float | None = None,
    page: int = 1,
    page_size: int = 50,
    min_invoice_count: int | None = None,
) -> dict[str, Any]:
    """分析主体池内企业税码结构画像（Top 二级类目、HIGH 占比）。"""
    try:
        from src.local_api.analysis_subject_pool import _resolve_min_invoice_count, _analysis_subject_sql

        y = _safe_int_year(stat_year)
        pg = _parse_page(page)
        ps = _parse_page_size(page_size)
        offset = (pg - 1) * ps
        n = _resolve_min_invoice_count(min_invoice_count)
        dim_cnt = _dim_tax_code_count(conn)
        kw = str(keyword or "").strip().lower()
        cat_filter = str(top_category or "").strip()
        detail_sql, detail_params, detail_meta = _detail_line_filters(
            goods_name=goods_name, slv_num=slv_num
        )
        eid = _norm_entity(entity_id)
        entity_clause = ""
        entity_params: list[Any] = []
        if eid:
            entity_clause = " AND entity_id = ?"
            entity_params = [eid]

        pool_sql = _analysis_subject_sql(require_buyer=False)
        kw_clause = ""
        kw_params: list[Any] = []
        if kw:
            kw_clause += " AND (lower(coalesce(entity_name, '')) LIKE ? OR lower(coalesce(entity_id, '')) LIKE ?)"
            kw_params.extend([f"%{kw}%", f"%{kw}%"])
        if cat_filter and cat_filter.lower() != "all":
            kw_clause += " AND coalesce(top_category, '') = ?"
            kw_params.append(cat_filter)

        metrics_cte = f"""
        WITH pool AS (
            {pool_sql}
        ),
        entity_lines AS (
            SELECT
                p.entity_id,
                p.entity_name,
                left(nullif(trim(COALESCE(d.ssflbm, '')), ''), 2) AS level2_prefix,
                {_LINE_AMOUNT} AS line_amount,
                {_TAX_AMOUNT} AS tax_amount,
                upper(coalesce(tc.audit_risk_label, 'NORMAL')) AS risk_label
            FROM pool p
            INNER JOIN dwd_inv_detail d ON d.stat_year = ?
              AND d.logic_line_no > 0
              AND nullif(trim(COALESCE(d.ssflbm, '')), '') IS NOT NULL
            INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid AND h.stat_year = ?
            LEFT JOIN dim_tax_code tc ON trim(d.ssflbm) = trim(tc.tax_code)
            WHERE ({_NORM_XFS} = p.entity_id OR {_NORM_GFS} = p.entity_id)
              {detail_sql}
        ),
        entity_totals AS (
            SELECT
                entity_id,
                any_value(entity_name) AS entity_name,
                coalesce(sum(line_amount), 0) AS total_amount,
                coalesce(sum(tax_amount) FILTER (WHERE risk_label = 'HIGH'), 0) AS high_risk_tax_amount
            FROM entity_lines
            GROUP BY entity_id
        ),
        cat_rank AS (
            SELECT
                entity_id,
                level2_prefix,
                sum(line_amount) AS cat_amount,
                row_number() OVER (
                    PARTITION BY entity_id
                    ORDER BY sum(line_amount) DESC NULLS LAST
                ) AS rn
            FROM entity_lines
            WHERE level2_prefix IS NOT NULL AND length(level2_prefix) = 2
            GROUP BY entity_id, level2_prefix
        ),
        top_cat AS (
            SELECT
                cr.entity_id,
                cr.level2_prefix,
                cr.cat_amount,
                (
                    SELECT any_value(coalesce(tc.goods_name, tc.goods_short_name, tc.full_path))
                    FROM dim_tax_code tc
                    WHERE tc.level_depth = 2
                      AND left(trim(tc.tax_code), 2) = cr.level2_prefix
                    LIMIT 1
                ) AS top_category
            FROM cat_rank cr
            WHERE cr.rn = 1
        ),
        enterprise_metrics AS (
            SELECT
                p.entity_id,
                p.entity_name,
                p.entity_id AS taxpayer_id,
                coalesce(tc.top_category, tc.level2_prefix, '—') AS top_category,
                CASE
                    WHEN et.total_amount > 0 THEN round(coalesce(tc.cat_amount, 0) / et.total_amount, 6)
                    ELSE 0.0
                END AS top_category_ratio,
                CASE
                    WHEN et.total_amount > 0 THEN round(et.high_risk_tax_amount / et.total_amount, 6)
                    ELSE 0.0
                END AS high_risk_ratio,
                et.total_amount,
                et.high_risk_tax_amount,
                p.invoice_count
            FROM pool p
            LEFT JOIN entity_totals et ON et.entity_id = p.entity_id
            LEFT JOIN top_cat tc ON tc.entity_id = p.entity_id
        )
        """

        count_params: list[Any] = [y, n, y, y, *detail_params, *entity_params, *kw_params]
        total = int(
            conn.execute(
                f"{metrics_cte} SELECT count(*)::BIGINT FROM enterprise_metrics WHERE 1=1 {entity_clause}{kw_clause}",
                count_params,
            ).fetchone()[0]
            or 0
        )

        rows_raw = conn.execute(
            f"""
            {metrics_cte}
            SELECT
                entity_id,
                entity_name,
                taxpayer_id,
                top_category,
                top_category_ratio,
                high_risk_ratio,
                total_amount,
                invoice_count
            FROM enterprise_metrics
            WHERE 1=1 {entity_clause}{kw_clause}
            ORDER BY high_risk_ratio DESC NULLS LAST, total_amount DESC NULLS LAST, entity_id
            LIMIT ? OFFSET ?
            """,
            [*count_params, ps, offset],
        ).fetchall()

        rows = [
            {
                "entity_id": str(r[0] or ""),
                "entity_name": str(r[1] or r[0] or ""),
                "taxpayer_id": str(r[2] or r[0] or ""),
                "top_category": str(r[3] or "—"),
                "top_category_ratio": float(r[4] or 0),
                "high_risk_ratio": float(r[5] or 0),
                "fluctuation_index": None,
                "total_amount": round(float(r[6] or 0), 2),
                "invoice_count": int(r[7] or 0),
            }
            for r in rows_raw or []
        ]

        kpi_row = conn.execute(
            f"""
            {metrics_cte}
            SELECT
                count(*)::BIGINT AS pool_count,
                count(*) FILTER (WHERE total_amount > 0)::BIGINT AS covered_count,
                count(*) FILTER (WHERE high_risk_ratio >= 0.05)::BIGINT AS high_risk_count,
                avg(top_category_ratio) AS avg_top_concentration
            FROM enterprise_metrics
            WHERE 1=1 {entity_clause}{kw_clause}
            """,
            count_params,
        ).fetchone()

        pool_count = int(kpi_row[0] or 0) if kpi_row else 0
        covered_count = int(kpi_row[1] or 0) if kpi_row else 0
        high_risk_count = int(kpi_row[2] or 0) if kpi_row else 0
        avg_top_concentration = float(kpi_row[3] or 0) if kpi_row else 0.0

        enterprise_coverage = round(covered_count / pool_count, 6) if pool_count > 0 else 0.0

        category_options: list[str] = []
        try:
            cat_rows = conn.execute(
                f"""
                {metrics_cte}
                SELECT DISTINCT top_category
                FROM enterprise_metrics
                WHERE top_category IS NOT NULL AND trim(top_category) <> '' AND top_category <> '—'
                ORDER BY top_category
                LIMIT 200
                """,
                [y, n, y, y, *detail_params],
            ).fetchall()
            category_options = [str(r[0]) for r in cat_rows or [] if r and r[0]]
        except Exception:
            pass

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid or None,
            **detail_meta,
            "min_invoice_count": n,
            "page": pg,
            "page_size": ps,
            "total": total,
            "rows": rows,
            "category_options": category_options,
            "kpis": {
                "enterprise_coverage": enterprise_coverage,
                "high_risk_enterprise_count": high_risk_count,
                "top_category_concentration": round(avg_top_concentration, 6),
                "monthly_mutation_rate": None,
            },
            "dim_tax_code_count": dim_cnt,
            "stat_years": _distinct_stat_years(conn),
            "hint": _dim_empty_hint(dim_cnt),
            "fluctuation_hint": "波动指数需跨月历史结构数据，当前版本暂未计算。",
            "caliber_hint": (
                f"企业范围：{y} 年分析主体池（发票张数 ≥ {n}）。"
                "Top 类目取二级编码（前 2 位）金额占比最高者；HIGH 占比为 HIGH 标签税额 / 企业编码行金额。"
            ),
        }
    except Exception as exc:
        logger.exception("tax_code_analysis_enterprise_summary")
        return {
            "ok": False,
            "rows": [],
            "total": 0,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


_TAX_SYNC_RULE_IDS = ("RULE-TAX-UNMATCH", "RULE-TAX-HIGH-CODE")


def _tax_table_exists(conn: Any, name: str) -> bool:
    try:
        conn.execute(f"SELECT 1 FROM {name} LIMIT 1")
        return True
    except Exception:
        return False


def _tax_flag_detail_json(cand: dict[str, Any]) -> str:
    import json

    rule_id = str(cand.get("rule_id") or "")
    payload: dict[str, Any] = {
        "stat_year": int(cand.get("stat_year") or 0),
        "entity_id": str(cand.get("entity_id") or ""),
        "rule_subtype": "tax_code_unmatch" if rule_id == "RULE-TAX-UNMATCH" else "tax_code_high",
    }
    if rule_id == "RULE-TAX-UNMATCH":
        payload["line_count"] = int(cand.get("line_count") or 0)
        payload["amount_sum"] = float(cand.get("amount_sum") or 0)
    elif rule_id == "RULE-TAX-HIGH-CODE":
        payload["high_risk_tax_amount"] = float(cand.get("high_risk_tax_amount") or 0)
    return json.dumps(payload, ensure_ascii=False)


def sync_tax_code_flags(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None = None,
    min_line_count: int | None = None,
    min_high_risk_amount: float | None = None,
) -> dict[str, Any]:
    """
    将税码分析结论同步至 dm_audit_flag（RULE-TAX-*）。

    重同步时仅删除未确认疑点，已确认记录保留。
    """
    from src.audit.config_loader import group_id_for_year, load_audit_rules_config

    y = int(stat_year)
    eid_filter = _norm_entity(entity_id)
    analysis_batch = f"tax_code_analysis_{y}"

    if not _tax_table_exists(conn, "dm_audit_flag"):
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": "dm_audit_flag 表不存在", "exception_type": "SchemaError"},
        }

    cfg = load_audit_rules_config()
    rules_cfg = cfg.get("rules") if isinstance(cfg, dict) else {}
    rc_unmatch = rules_cfg.get("RULE-TAX-UNMATCH", {}) if isinstance(rules_cfg, dict) else {}
    rc_high = rules_cfg.get("RULE-TAX-HIGH-CODE", {}) if isinstance(rules_cfg, dict) else {}
    min_lines = (
        max(1, int(min_line_count))
        if min_line_count is not None
        else max(1, int(rc_unmatch.get("min_line_count") or 5))
    )
    min_high_amt = (
        max(0.0, float(min_high_risk_amount))
        if min_high_risk_amount is not None
        else max(0.0, float(rc_high.get("min_high_risk_amount") or 10000))
    )

    candidates: list[dict[str, Any]] = []
    scope_sql, scope_params = _scope_filters(entity_id=eid_filter or None, import_batch_id=None)

    try:
        from src.local_api.analysis_subject_pool import _analysis_subject_sql, _resolve_min_invoice_count

        pool_sql = _analysis_subject_sql(require_buyer=False)
        n = _resolve_min_invoice_count(None)
        unmatched_rows = conn.execute(
            f"""
            -- 审计含义：分析主体池内按企业聚合未匹配 ssflbm 明细行规模
            WITH pool AS (
                {pool_sql}
            ),
            entity_lines AS (
                SELECT
                    p.entity_id,
                    p.entity_name,
                    {_LINE_AMOUNT} AS line_amount,
                    CASE
                        WHEN {_SSFLBM_NORM} IS NULL THEN TRUE
                        WHEN tc.tax_code IS NULL THEN TRUE
                        WHEN NOT ({_VALID_CODE}) THEN TRUE
                        ELSE FALSE
                    END AS is_unmatched
                FROM pool p
                INNER JOIN dwd_inv_detail d ON d.stat_year = ?
                  AND d.logic_line_no > 0
                INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid AND h.stat_year = ?
                LEFT JOIN dim_tax_code tc ON trim(d.ssflbm) = trim(tc.tax_code)
                WHERE ({_NORM_XFS} = p.entity_id OR {_NORM_GFS} = p.entity_id)
                  {scope_sql}
            )
            SELECT
                entity_id,
                any_value(entity_name) AS entity_name,
                count(*)::BIGINT AS line_count,
                coalesce(sum(line_amount), 0) AS amount_sum
            FROM entity_lines
            WHERE is_unmatched
            GROUP BY entity_id
            HAVING count(*) >= ?
            """,
            [y, n, y, y, *scope_params, min_lines],
        ).fetchall() or []
    except Exception as exc:
        logger.exception("tax_code sync unmatched aggregation")
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }

    for r in unmatched_rows:
        ent = str(r[0] or "")
        if eid_filter and ent != eid_filter:
            continue
        line_count = int(r[2] or 0)
        amount_sum = float(r[3] or line_count)
        fid = f"TAXCODE_{y}_{ent}_UNMATCH"
        candidates.append(
            {
                "flag_id": fid,
                "rule_id": "RULE-TAX-UNMATCH",
                "entity_id": ent,
                "entity_name": str(r[1] or ent),
                "amount": amount_sum,
                "description": f"税收分类编码未匹配维表：{line_count} 条明细 ssflbm 为空/格式异常/维表未命中",
                "suggestion": "补全 dim_tax_code 维表或修正清洗映射规则后重新导入",
                "flag_type": "税收分类编码",
                "stat_year": y,
                "line_count": line_count,
                "amount_sum": amount_sum,
            }
        )

    try:
        from src.local_api.analysis_subject_pool import _analysis_subject_sql, _resolve_min_invoice_count

        pool_sql = _analysis_subject_sql(require_buyer=False)
        n = _resolve_min_invoice_count(None)
        high_rows = conn.execute(
            f"""
            -- 审计含义：分析主体 HIGH 标签税额合计超过阈值的企业
            WITH pool AS (
                {pool_sql}
            ),
            entity_tax AS (
                SELECT
                    p.entity_id,
                    any_value(p.entity_name) AS entity_name,
                    coalesce(sum({_TAX_AMOUNT}) FILTER (
                        WHERE upper(coalesce(tc.audit_risk_label, 'NORMAL')) = 'HIGH'
                    ), 0) AS high_risk_tax_amount
                FROM pool p
                INNER JOIN dwd_inv_detail d ON d.stat_year = ?
                  AND d.logic_line_no > 0
                  AND nullif(trim(COALESCE(d.ssflbm, '')), '') IS NOT NULL
                INNER JOIN dwd_inv_header h ON d.header_uuid = h.header_uuid AND h.stat_year = ?
                LEFT JOIN dim_tax_code tc ON trim(d.ssflbm) = trim(tc.tax_code)
                WHERE ({_NORM_XFS} = p.entity_id OR {_NORM_GFS} = p.entity_id)
                  {scope_sql}
                GROUP BY p.entity_id
            )
            SELECT entity_id, entity_name, high_risk_tax_amount
            FROM entity_tax
            WHERE high_risk_tax_amount >= ?
            """,
            [y, n, y, y, *scope_params, min_high_amt],
        ).fetchall() or []
    except Exception as exc:
        logger.exception("tax_code sync high-risk aggregation")
        high_rows = []

    for r in high_rows:
        ent = str(r[0] or "")
        if eid_filter and ent != eid_filter:
            continue
        amt = float(r[2] or 0)
        fid = f"TAXCODE_{y}_{ent}_HIGH"
        candidates.append(
            {
                "flag_id": fid,
                "rule_id": "RULE-TAX-HIGH-CODE",
                "entity_id": ent,
                "entity_name": str(r[1] or ent),
                "amount": amt,
                "description": f"高风险税收分类编码税额集中：HIGH 标签税额合计 {amt:,.2f} 元",
                "suggestion": "抽样复核 HIGH 类目明细业务实质与编码选用是否匹配",
                "flag_type": "税收分类编码",
                "stat_year": y,
                "high_risk_tax_amount": amt,
            }
        )

    current_ids = {str(c["flag_id"]) for c in candidates}
    try:
        placeholders = ", ".join("?" for _ in _TAX_SYNC_RULE_IDS)
        if current_ids:
            id_ph = ", ".join("?" for _ in current_ids)
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE analysis_batch = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                  AND flag_id NOT IN ({id_ph})
                """,
                [analysis_batch, *_TAX_SYNC_RULE_IDS, *current_ids],
            )
        else:
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE analysis_batch = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                """,
                [analysis_batch, *_TAX_SYNC_RULE_IDS],
            )
    except Exception as exc:
        logger.exception("cleanup tax code flags")
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }

    gid = group_id_for_year(y)
    inserted = 0
    updated = 0
    skipped_confirmed = 0
    by_rule: dict[str, int] = {rid: 0 for rid in _TAX_SYNC_RULE_IDS}

    for cand in candidates:
        flag_id = str(cand["flag_id"])
        rule_id = str(cand["rule_id"])
        try:
            existing = conn.execute(
                "SELECT COALESCE(is_confirmed, FALSE) FROM dm_audit_flag WHERE flag_id = ?",
                [flag_id],
            ).fetchone()
            if existing and bool(existing[0]):
                skipped_confirmed += 1
                continue
            existed = existing is not None
        except Exception:
            logger.exception("check confirmed tax code flag %s", flag_id)
            existed = False

        rc = rules_cfg.get(rule_id, {}) if isinstance(rules_cfg, dict) else {}
        risk_level = str(rc.get("risk_level") or "中风险")
        detail_json = _tax_flag_detail_json(cand)
        try:
            conn.execute(
                """
                INSERT INTO dm_audit_flag (
                    flag_id, rule_id, risk_level, flag_type, group_id,
                    entity_id, entity_name, amount, description, suggestion,
                    is_confirmed, analysis_batch, detail_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)
                ON CONFLICT (flag_id) DO UPDATE SET
                    rule_id = excluded.rule_id,
                    risk_level = excluded.risk_level,
                    flag_type = excluded.flag_type,
                    entity_name = excluded.entity_name,
                    amount = excluded.amount,
                    description = excluded.description,
                    suggestion = excluded.suggestion,
                    analysis_batch = excluded.analysis_batch,
                    detail_json = excluded.detail_json
                """,
                [
                    flag_id,
                    rule_id,
                    risk_level,
                    str(cand.get("flag_type") or "税收分类编码"),
                    gid,
                    str(cand.get("entity_id") or ""),
                    str(cand.get("entity_name") or ""),
                    float(cand.get("amount") or 0),
                    str(cand.get("description") or ""),
                    str(cand.get("suggestion") or ""),
                    analysis_batch,
                    detail_json,
                ],
            )
            if existed:
                updated += 1
            else:
                inserted += 1
            by_rule[rule_id] = by_rule.get(rule_id, 0) + 1
        except Exception:
            logger.exception("insert tax code flag %s", flag_id)

    return {
        "ok": True,
        "stat_year": y,
        "entity_id": eid_filter or None,
        "analysis_batch": analysis_batch,
        "finding_count": len(candidates),
        "inserted": inserted,
        "updated": updated,
        "skipped_confirmed": skipped_confirmed,
        "by_rule": by_rule,
        "min_line_count": min_lines,
        "min_high_risk_amount": min_high_amt,
    }


def api_tax_code_sync_flags(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None = None,
    min_line_count: int | None = None,
    min_high_risk_amount: float | None = None,
) -> dict[str, Any]:
    try:
        return sync_tax_code_flags(
            conn,
            stat_year=stat_year,
            entity_id=entity_id,
            min_line_count=min_line_count,
            min_high_risk_amount=min_high_risk_amount,
        )
    except Exception as exc:
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def export_tax_code_delivery_csv_bytes(conn: Any, *, stat_year: int) -> tuple[bytes, int]:
    """交付包用税码分析 CSV：未匹配税码汇总 + 企业结构摘要。"""
    import csv
    import io

    unmatched = api_tax_code_analysis_unmatched(
        conn, stat_year=str(stat_year), page=1, page_size=2000
    )
    summary = api_tax_code_analysis_enterprise_summary(
        conn, stat_year=str(stat_year), page=1, page_size=2000
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["section", "ssflbm_key", "line_count", "amount_sum", "sample_invoice_count"])
    row_count = 0
    for r in unmatched.get("rows") or []:
        writer.writerow(
            [
                "unmatched",
                str(r.get("ssflbm_key") or ""),
                int(r.get("line_count") or 0),
                float(r.get("amount_sum") or 0),
                int(r.get("sample_invoice_count") or 0),
            ]
        )
        row_count += 1
    writer.writerow([])
    writer.writerow(
        [
            "section",
            "entity_id",
            "entity_name",
            "total_amount",
            "high_risk_tax_amount",
            "top_category",
            "invoice_count",
        ]
    )
    for r in summary.get("rows") or []:
        writer.writerow(
            [
                "enterprise_summary",
                str(r.get("entity_id") or ""),
                str(r.get("entity_name") or ""),
                float(r.get("total_amount") or 0),
                float(r.get("high_risk_tax_amount") or 0),
                str(r.get("top_category") or ""),
                int(r.get("invoice_count") or 0),
            ]
        )
        row_count += 1
    data = ("\ufeff" + buf.getvalue()).encode("utf-8")
    return data, row_count
