"""
DWD → DWS 年度聚合刷新（决策九：单表 + stat_year）。

刷新策略：对目标 stat_year 在五张主题表上 DELETE 后 INSERT。
核心金额字段：COALESCE(net_jshj, jshj, 0)（净额优先，宽表内嵌口径）。
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Callable

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, str], None] | None

_NORM_TAX = "upper(regexp_replace(trim(COALESCE({col}, '')), '[\\s-]+', '', 'g'))"
_NET_AMT = "COALESCE(h.net_jshj, h.jshj, 0)"
_FPZT_NORMAL = "coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') = '正常'"
_IS_RED = f"({ _NET_AMT } < 0 OR COALESCE(h.is_orphan_red, FALSE))"
_IS_CANCEL = "(coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') <> '正常' OR COALESCE(h.net_calc_status, '') = '已作废')"


def _make_run_id(prefix: str = "dws_refresh") -> str:
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def _delete_year(conn: Any, table: str, stat_year: int) -> None:
    conn.execute(f"DELETE FROM {table} WHERE stat_year = ?", [stat_year])


def _refresh_trade_sum(conn: Any, stat_year: int) -> int:
    norm_xfs = _NORM_TAX.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX.format(col="h.gfsbh")
    conn.execute(
        f"""
        INSERT INTO dws_trade_sum (
            trade_sum_uuid, stat_year, entity_id, entity_name, role_type,
            counterparty_id, counterparty_name, counterparty_role,
            total_amount, invoice_cnt, max_invoice_amt, latest_invoice_date, update_time
        )
        WITH seller_side AS (
            SELECT
                {norm_xfs} AS entity_id,
                max(trim(COALESCE(h.xfmc, ''))) AS entity_name,
                '销方' AS role_type,
                {norm_gfs} AS counterparty_id,
                max(trim(COALESCE(h.gfmc, ''))) AS counterparty_name,
                '客户' AS counterparty_role,
                sum({_NET_AMT}) AS total_amount,
                count(*)::INT AS invoice_cnt,
                max(abs({_NET_AMT})) AS max_invoice_amt,
                max(h.invoice_date) AS latest_invoice_date
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND length({norm_xfs}) > 0
              AND length({norm_gfs}) > 0
            GROUP BY 1, 3, 4, 6
        ),
        buyer_side AS (
            SELECT
                {norm_gfs} AS entity_id,
                max(trim(COALESCE(h.gfmc, ''))) AS entity_name,
                '购方' AS role_type,
                {norm_xfs} AS counterparty_id,
                max(trim(COALESCE(h.xfmc, ''))) AS counterparty_name,
                '供应商' AS counterparty_role,
                sum({_NET_AMT}) AS total_amount,
                count(*)::INT AS invoice_cnt,
                max(abs({_NET_AMT})) AS max_invoice_amt,
                max(h.invoice_date) AS latest_invoice_date
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND length({norm_gfs}) > 0
              AND length({norm_xfs}) > 0
            GROUP BY 1, 3, 4, 6
        ),
        u AS (
            SELECT * FROM seller_side
            UNION ALL
            SELECT * FROM buyer_side
        )
        SELECT
            'TRD_' || substr(md5(entity_id || '|' || cast(? AS VARCHAR) || '|' || role_type || '|' || counterparty_id), 1, 24),
            ?,
            entity_id,
            nullif(entity_name, ''),
            role_type,
            counterparty_id,
            coalesce(nullif(counterparty_name, ''), counterparty_id),
            counterparty_role,
            total_amount,
            invoice_cnt,
            max_invoice_amt,
            coalesce(latest_invoice_date, DATE '1900-01-01'),
            CURRENT_TIMESTAMP
        FROM u
        WHERE length(entity_id) > 0 AND length(counterparty_id) > 0
        """,
        [stat_year, stat_year, stat_year, stat_year],
    )
    row = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dws_trade_sum WHERE stat_year = ?", [stat_year]
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _refresh_inv_trend(conn: Any, stat_year: int) -> int:
    norm_xfs = _NORM_TAX.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX.format(col="h.gfsbh")
    conn.execute(
        f"""
        INSERT INTO dws_inv_trend (
            trend_uuid, entity_id, entity_name, stat_year, stat_month, role_type,
            normal_cnt, normal_je, normal_jshj, red_cnt, red_jshj, cancel_cnt, net_jshj,
            holiday_cnt, weekend_large_cnt, update_time
        )
        WITH seller AS (
            SELECT
                {norm_xfs} AS entity_id,
                max(trim(COALESCE(h.xfmc, ''))) AS entity_name,
                h.stat_month,
                '销项' AS role_type,
                count(*) FILTER (WHERE NOT ({_IS_RED}) AND NOT ({_IS_CANCEL}))::INT AS normal_cnt,
                coalesce(sum(h.je) FILTER (WHERE NOT ({_IS_RED}) AND NOT ({_IS_CANCEL})), 0) AS normal_je,
                coalesce(sum(h.jshj) FILTER (WHERE NOT ({_IS_RED}) AND NOT ({_IS_CANCEL})), 0) AS normal_jshj,
                count(*) FILTER (WHERE {_IS_RED} AND NOT ({_IS_CANCEL}))::INT AS red_cnt,
                coalesce(sum({_NET_AMT}) FILTER (WHERE {_IS_RED} AND NOT ({_IS_CANCEL})), 0) AS red_jshj,
                count(*) FILTER (WHERE {_IS_CANCEL})::INT AS cancel_cnt,
                coalesce(sum({_NET_AMT}), 0) AS net_jshj,
                0::INT AS holiday_cnt,
                count(*) FILTER (
                    WHERE extract(dow FROM h.invoice_date) IN (0, 6)
                      AND abs({_NET_AMT}) >= 100000
                )::INT AS weekend_large_cnt
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND length({norm_xfs}) > 0
            GROUP BY 1, 3, 4
        ),
        buyer AS (
            SELECT
                {norm_gfs} AS entity_id,
                max(trim(COALESCE(h.gfmc, ''))) AS entity_name,
                h.stat_month,
                '进项' AS role_type,
                count(*) FILTER (WHERE NOT ({_IS_RED}) AND NOT ({_IS_CANCEL}))::INT AS normal_cnt,
                coalesce(sum(h.je) FILTER (WHERE NOT ({_IS_RED}) AND NOT ({_IS_CANCEL})), 0) AS normal_je,
                coalesce(sum(h.jshj) FILTER (WHERE NOT ({_IS_RED}) AND NOT ({_IS_CANCEL})), 0) AS normal_jshj,
                count(*) FILTER (WHERE {_IS_RED} AND NOT ({_IS_CANCEL}))::INT AS red_cnt,
                coalesce(sum({_NET_AMT}) FILTER (WHERE {_IS_RED} AND NOT ({_IS_CANCEL})), 0) AS red_jshj,
                count(*) FILTER (WHERE {_IS_CANCEL})::INT AS cancel_cnt,
                coalesce(sum({_NET_AMT}), 0) AS net_jshj,
                0::INT AS holiday_cnt,
                count(*) FILTER (
                    WHERE extract(dow FROM h.invoice_date) IN (0, 6)
                      AND abs({_NET_AMT}) >= 100000
                )::INT AS weekend_large_cnt
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND length({norm_gfs}) > 0
            GROUP BY 1, 3, 4
        ),
        u AS (
            SELECT * FROM seller
            UNION ALL
            SELECT * FROM buyer
        )
        SELECT
            'TRD_' || substr(md5(entity_id || '|' || cast(? AS VARCHAR) || '|' || cast(stat_month AS VARCHAR) || '|' || role_type), 1, 24),
            entity_id,
            nullif(entity_name, ''),
            ?,
            stat_month,
            role_type,
            normal_cnt,
            normal_je,
            normal_jshj,
            red_cnt,
            red_jshj,
            cancel_cnt,
            net_jshj,
            holiday_cnt,
            weekend_large_cnt,
            CURRENT_TIMESTAMP
        FROM u
        WHERE length(entity_id) > 0
        """,
        [stat_year, stat_year, stat_year, stat_year],
    )
    row = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dws_inv_trend WHERE stat_year = ?", [stat_year]
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _refresh_sup_conc(conn: Any, stat_year: int) -> int:
    norm_xfs = _NORM_TAX.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX.format(col="h.gfsbh")
    conn.execute(
        f"""
        INSERT INTO dws_sup_conc (
            conc_uuid, entity_id, entity_name, stat_year, supplier_id, supplier_name,
            is_new_supplier, first_invoice_date, last_invoice_date,
            net_jshj, invoice_cnt, max_single_amt,
            goods_categories, tax_codes, tax_rates,
            amount_rank, amount_ratio, cumulative_ratio, update_time
        )
        WITH base AS (
            SELECT
                {norm_gfs} AS entity_id,
                max(trim(COALESCE(h.gfmc, ''))) AS entity_name,
                {norm_xfs} AS supplier_id,
                max(trim(COALESCE(h.xfmc, ''))) AS supplier_name,
                min(h.invoice_date) AS first_invoice_date,
                max(h.invoice_date) AS last_invoice_date,
                sum({_NET_AMT}) AS net_jshj,
                count(*)::INT AS invoice_cnt,
                max(abs({_NET_AMT})) AS max_single_amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND length({norm_gfs}) > 0
              AND length({norm_xfs}) > 0
            GROUP BY 1, 3
        ),
        prior AS (
            SELECT DISTINCT
                {norm_gfs} AS entity_id,
                {norm_xfs} AS supplier_id
            FROM dwd_inv_header h
            WHERE h.stat_year < ?
              AND length({norm_gfs}) > 0
              AND length({norm_xfs}) > 0
        ),
        ranked AS (
            SELECT
                b.*,
                NOT EXISTS (
                    SELECT 1 FROM prior p
                    WHERE p.entity_id = b.entity_id AND p.supplier_id = b.supplier_id
                ) AS is_new_supplier,
                sum(b.net_jshj) OVER (PARTITION BY b.entity_id) AS entity_total,
                row_number() OVER (
                    PARTITION BY b.entity_id ORDER BY b.net_jshj DESC, b.supplier_id
                ) AS amount_rank,
                sum(b.net_jshj) OVER (
                    PARTITION BY b.entity_id ORDER BY b.net_jshj DESC, b.supplier_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cum_amt
            FROM base b
        )
        SELECT
            'SUP_' || substr(md5(entity_id || '|' || cast(? AS VARCHAR) || '|' || supplier_id), 1, 24),
            entity_id,
            nullif(entity_name, ''),
            ?,
            supplier_id,
            coalesce(nullif(supplier_name, ''), supplier_id),
            is_new_supplier,
            first_invoice_date,
            last_invoice_date,
            net_jshj,
            invoice_cnt,
            max_single_amt,
            CAST(NULL AS VARCHAR),
            CAST(NULL AS VARCHAR),
            CAST(NULL AS VARCHAR),
            amount_rank::INT,
            CASE WHEN entity_total = 0 THEN 0 ELSE net_jshj / entity_total END,
            CASE WHEN entity_total = 0 THEN 0 ELSE cum_amt / entity_total END,
            CURRENT_TIMESTAMP
        FROM ranked
        """,
        [stat_year, stat_year, stat_year, stat_year],
    )
    row = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dws_sup_conc WHERE stat_year = ?", [stat_year]
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _refresh_goods_cat(conn: Any, stat_year: int) -> int:
    norm_gfs = _NORM_TAX.format(col="d.gfsbh")
    conn.execute(
        f"""
        INSERT INTO dws_goods_cat (
            category_uuid, entity_id, stat_year, stat_quarter, tax_code_short, tax_code_level2,
            net_jshj, invoice_cnt, supplier_cnt, avg_single_amt, max_single_amt,
            distinct_tax_rates, update_time
        )
        WITH line AS (
            SELECT
                {norm_gfs} AS entity_id,
                ((d.stat_month - 1) / 3 + 1)::TINYINT AS stat_quarter,
                nullif(trim(COALESCE(d.ssflbm, '')), '') AS tax_code,
                left(nullif(trim(COALESCE(d.ssflbm, '')), ''), 1) AS tax_code_short,
                left(nullif(trim(COALESCE(d.ssflbm, '')), ''), 2) AS tax_code_level2,
                coalesce(d.jshj, d.je, 0) AS line_amt,
                { _NORM_TAX.format(col="d.xfsbh") } AS supplier_id,
                d.slv_num
            FROM dwd_inv_detail d
            WHERE d.stat_year = ?
              AND d.logic_line_no > 0
              AND length({norm_gfs}) > 0
        )
        SELECT
            'CAT_' || substr(md5(entity_id || '|' || cast(? AS VARCHAR) || '|' || cast(stat_quarter AS VARCHAR) || '|' || coalesce(tax_code_short, '')), 1, 24),
            entity_id,
            ?,
            stat_quarter,
            tax_code_short,
            max(tax_code_level2),
            sum(line_amt),
            count(*)::INT,
            count(DISTINCT supplier_id)::INT,
            avg(line_amt),
            max(line_amt),
            count(DISTINCT slv_num)::INT,
            CURRENT_TIMESTAMP
        FROM line
        WHERE length(entity_id) > 0
        GROUP BY entity_id, stat_quarter, tax_code_short
        """,
        [stat_year, stat_year, stat_year],
    )
    row = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dws_goods_cat WHERE stat_year = ?", [stat_year]
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _refresh_quality(conn: Any, stat_year: int) -> int:
    norm_xfs = _NORM_TAX.format(col="h.xfsbh")
    norm_gfs = _NORM_TAX.format(col="h.gfsbh")
    conn.execute(
        f"""
        INSERT INTO dws_quality (
            quality_uuid, entity_id, entity_name, stat_year,
            header_total, header_unbalanced, header_missing_detail, header_invalid_tax_no,
            detail_total, detail_orphan, detail_null_ssflbm,
            unmatched_red_cnt, fully_reversed_cnt, quality_score, update_time
        )
        WITH seller_hdr AS (
            SELECT
                {norm_xfs} AS entity_id,
                trim(COALESCE(h.xfmc, '')) AS entity_name,
                h.header_uuid,
                h.is_balanced,
                COALESCE(h.is_orphan_red, FALSE) AS is_orphan_red,
                COALESCE(h.is_fully_reversed, FALSE) AS is_fully_reversed,
                h.xfsbh AS raw_tax
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND length({norm_xfs}) > 0
        ),
        buyer_hdr AS (
            SELECT
                {norm_gfs} AS entity_id,
                trim(COALESCE(h.gfmc, '')) AS entity_name,
                h.header_uuid,
                h.is_balanced,
                COALESCE(h.is_orphan_red, FALSE) AS is_orphan_red,
                COALESCE(h.is_fully_reversed, FALSE) AS is_fully_reversed,
                h.gfsbh AS raw_tax
            FROM dwd_inv_header h
            WHERE h.stat_year = ? AND length({norm_gfs}) > 0
        ),
        hdr AS (
            SELECT * FROM seller_hdr
            UNION ALL
            SELECT * FROM buyer_hdr
        ),
        dtl AS (
            SELECT header_uuid, count(*)::BIGINT AS cnt,
                   sum(CASE WHEN nullif(trim(COALESCE(ssflbm, '')), '') IS NULL THEN 1 ELSE 0 END)::BIGINT AS null_ssfl
            FROM dwd_inv_detail
            WHERE stat_year = ?
            GROUP BY header_uuid
        ),
        ent AS (
            SELECT
                h.entity_id,
                max(h.entity_name) AS entity_name,
                count(*)::INT AS header_total,
                sum(CASE WHEN coalesce(h.is_balanced, '未校验') NOT IN ('平账', '差异可接受', '强制通过') THEN 1 ELSE 0 END)::INT AS header_unbalanced,
                sum(CASE WHEN coalesce(d.cnt, 0) = 0 THEN 1 ELSE 0 END)::INT AS header_missing_detail,
                sum(CASE WHEN length(trim(COALESCE(h.raw_tax, ''))) < 15 THEN 1 ELSE 0 END)::INT AS header_invalid_tax_no,
                coalesce(sum(d.cnt), 0)::INT AS detail_total,
                sum(CASE WHEN h.is_orphan_red THEN 1 ELSE 0 END)::INT AS unmatched_red_cnt,
                sum(CASE WHEN h.is_fully_reversed THEN 1 ELSE 0 END)::INT AS fully_reversed_cnt,
                coalesce(sum(d.null_ssfl), 0)::INT AS detail_null_ssflbm
            FROM hdr h
            LEFT JOIN dtl d ON d.header_uuid = h.header_uuid
            GROUP BY h.entity_id
        )
        SELECT
            'Q_' || substr(md5(entity_id || '|' || cast(? AS VARCHAR)), 1, 24),
            entity_id,
            nullif(entity_name, ''),
            ?,
            header_total,
            header_unbalanced,
            header_missing_detail,
            header_invalid_tax_no,
            detail_total,
            0,
            detail_null_ssflbm,
            unmatched_red_cnt,
            fully_reversed_cnt,
            greatest(
                0,
                100
                - least(40, header_unbalanced * 2)
                - least(30, unmatched_red_cnt * 3)
                - least(20, header_missing_detail)
            ),
            CURRENT_TIMESTAMP
        FROM ent
        WHERE length(entity_id) > 0
        """,
        [stat_year, stat_year, stat_year, stat_year, stat_year],
    )
    row = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dws_quality WHERE stat_year = ?", [stat_year]
    ).fetchone()
    return int(row[0] or 0) if row else 0


def refresh_dws(
    conn: Any,
    *,
    stat_year: int,
    run_id: str | None = None,
    on_progress: ProgressFn = None,
) -> dict[str, Any]:
    """
    刷新指定年度的五张 DWS 主题表（DELETE + INSERT）。

    数据源：dwd_inv_header / dwd_inv_detail（WHERE stat_year=?）。
    """
    if stat_year < 1990 or stat_year > 2100:
        return {
            "ok": False,
            "error": {"message": f"非法 stat_year: {stat_year}", "exception_type": "ValidationError"},
        }
    build_run_id = (run_id or "").strip() or _make_run_id()
    counts: dict[str, int] = {}
    try:
        if on_progress:
            on_progress("delete", f"清理 {stat_year} 年度 DWS 旧数据…")
        for tbl in (
            "dws_trade_sum",
            "dws_inv_trend",
            "dws_sup_conc",
            "dws_goods_cat",
            "dws_quality",
        ):
            _delete_year(conn, tbl, stat_year)

        steps = [
            ("dws_trade_sum", _refresh_trade_sum),
            ("dws_inv_trend", _refresh_inv_trend),
            ("dws_sup_conc", _refresh_sup_conc),
            ("dws_goods_cat", _refresh_goods_cat),
            ("dws_quality", _refresh_quality),
        ]
        for name, fn in steps:
            if on_progress:
                on_progress("aggregate", f"写入 {name}（{stat_year}）…")
            counts[name] = fn(conn, stat_year)

        return {
            "ok": True,
            "run_id": build_run_id,
            "stat_year": stat_year,
            "rows_written": counts,
            "total_rows": sum(counts.values()),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("refresh_dws failed stat_year=%s", stat_year)
        return {
            "ok": False,
            "run_id": build_run_id,
            "stat_year": stat_year,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
            "rows_written": counts,
        }


def refresh_dws_years(
    conn: Any,
    *,
    stat_years: list[int],
    run_id: str | None = None,
    on_progress: ProgressFn = None,
) -> dict[str, Any]:
    """按年度串行刷新 DWS（多年份去重升序）。"""
    years = sorted({int(y) for y in stat_years if 1990 <= int(y) <= 2100})
    if not years:
        return {"ok": True, "skipped": True, "message": "无有效 stat_year，跳过 DWS 刷新"}
    build_run_id = (run_id or "").strip() or _make_run_id()
    year_results: list[dict[str, Any]] = []
    total_rows = 0
    for y in years:
        one = refresh_dws(conn, stat_year=y, run_id=build_run_id, on_progress=on_progress)
        year_results.append(one)
        if one.get("ok"):
            total_rows += int(one.get("total_rows") or 0)
        else:
            return {
                "ok": False,
                "run_id": build_run_id,
                "stat_years": years,
                "year_results": year_results,
                "error": one.get("error"),
            }
    return {
        "ok": True,
        "run_id": build_run_id,
        "stat_years": years,
        "year_results": year_results,
        "total_rows": total_rows,
    }
