from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import yaml

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables

_RULES_PATH = Path("config/enterprise_profile_risk_rules.yaml")


def _make_run_id(prefix: str = "enterprise_profile") -> str:
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"


def _load_rules() -> dict[str, Any]:
    fallback = {
        "red_invoice_ratio": {"warn": 0.20, "high": 0.35, "score_warn": 15, "score_high": 30},
        "amount_mom_change_abs": {"warn": 0.50, "high": 1.00, "score_warn": 10, "score_high": 20},
        "count_mom_change_abs": {"warn": 0.50, "high": 1.00, "score_warn": 8, "score_high": 15},
        "counterparty_concentration": {"warn": 0.60, "high": 0.80, "score_warn": 12, "score_high": 25},
        "risk_level": {"low_max": 29, "medium_max": 59, "high_min": 60},
    }
    try:
        if not _RULES_PATH.exists():
            return fallback
        doc = yaml.safe_load(_RULES_PATH.read_text(encoding="utf-8")) or {}
        root = doc.get("enterprise_profile_risk_rules")
        if not isinstance(root, dict):
            return fallback
        out = dict(fallback)
        for k, v in root.items():
            if isinstance(v, dict) and k in out:
                out[k] = {**out[k], **v}
        return out
    except Exception:
        return fallback


def build_enterprise_invoice_profile(
    conn: Any | None = None,
    *,
    stat_month: str | None = None,
    import_batch_id: str | None = None,
    calc_batch_id: str | None = None,
    source_scope: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
    on_progress: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """从 dwd_inv_header 构建 dws_enterprise_invoice_profile（月粒度企业画像）。"""
    own_conn = False
    if conn is None:
        conn = get_conn()
        own_conn = True
    init_all_tables(conn)
    if on_progress:
        on_progress("validate", "正在校验 dwd_inv_header…")
    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
    except Exception:
        return {"ok": False, "error": "dwd_inv_header 不可读或不存在，请先完成 ODS→DWD 构建。"}

    run_id = run_id or _make_run_id()
    calc_batch_id = (calc_batch_id or run_id).strip() or run_id
    if source_scope is None:
        source_scope = f"month:{stat_month}" if stat_month else (f"batch:{import_batch_id}" if import_batch_id else "all")

    where_parts = ["invoice_date IS NOT NULL"]
    params: list[Any] = []
    if stat_month:
        where_parts.append("strftime(invoice_date, '%Y-%m') = ?")
        params.append(stat_month)
    if import_batch_id:
        where_parts.append("COALESCE(import_batch_id, first_import_batch_id, '') = ?")
        params.append(import_batch_id)
    where_sql = " AND ".join(where_parts)
    seller_scope_sql = ""
    buyer_scope_sql = ""
    scope_params: list[Any] = []
    scope = (subject_category_scope or "").strip().upper()
    if scope and scope != "ALL":
        seller_scope_sql = (
            " AND EXISTS ("
            " SELECT 1 FROM dim_subject_master sm"
            " WHERE upper(trim(COALESCE(sm.subject_no, ''))) = upper(trim(COALESCE(xfsbh, '')))"
            "   AND ("
            "     ( ? = 'SC-TEMP' AND COALESCE(sm.subject_category, '') = 'person')"
            "     OR"
            "     ( ? <> 'SC-TEMP' AND COALESCE(sm.subject_category, '') = 'org' AND COALESCE(sm.org_category, '') = ?)"
            "   )"
            " )"
        )
        buyer_scope_sql = (
            " AND EXISTS ("
            " SELECT 1 FROM dim_subject_master sm"
            " WHERE upper(trim(COALESCE(sm.subject_no, ''))) = upper(trim(COALESCE(gfsbh, '')))"
            "   AND ("
            "     ( ? = 'SC-TEMP' AND COALESCE(sm.subject_category, '') = 'person')"
            "     OR"
            "     ( ? <> 'SC-TEMP' AND COALESCE(sm.subject_category, '') = 'org' AND COALESCE(sm.org_category, '') = ?)"
            "   )"
            " )"
        )
        scope_params = [scope, scope, scope, scope, scope, scope]

    r = _load_rules()
    if on_progress:
        on_progress("aggregate", "正在聚合企业月度画像与风险评分…")
    red = r["red_invoice_ratio"]
    amt = r["amount_mom_change_abs"]
    cnt = r["count_mom_change_abs"]
    conc = r["counterparty_concentration"]
    lvl = r["risk_level"]

    def n(v: Any) -> str:
        return str(float(v))

    score_sql = f"""
      (
        CASE WHEN COALESCE(a.red_inv_ratio, 0) >= {n(red["high"])} THEN {n(red["score_high"])}
             WHEN COALESCE(a.red_inv_ratio, 0) >= {n(red["warn"])} THEN {n(red["score_warn"])}
             ELSE 0 END
        +
        CASE WHEN ABS(COALESCE(a.amt_mom_change, 0)) >= {n(amt["high"])} THEN {n(amt["score_high"])}
             WHEN ABS(COALESCE(a.amt_mom_change, 0)) >= {n(amt["warn"])} THEN {n(amt["score_warn"])}
             ELSE 0 END
        +
        CASE WHEN ABS(COALESCE(a.cnt_mom_change, 0)) >= {n(cnt["high"])} THEN {n(cnt["score_high"])}
             WHEN ABS(COALESCE(a.cnt_mom_change, 0)) >= {n(cnt["warn"])} THEN {n(cnt["score_warn"])}
             ELSE 0 END
        +
        CASE WHEN COALESCE(a.top_counterparty_ratio, 0) >= {n(conc["high"])} THEN {n(conc["score_high"])}
             WHEN COALESCE(a.top_counterparty_ratio, 0) >= {n(conc["warn"])} THEN {n(conc["score_warn"])}
             ELSE 0 END
      )
    """

    sql = f"""
    WITH hdr_scope AS (
      SELECT *
      FROM dwd_inv_header
      WHERE {where_sql}
    ),
    side_flat AS (
      SELECT
        upper(trim(COALESCE(xfsbh, ''))) AS taxpayer_id,
        trim(COALESCE(xfmc, '')) AS taxpayer_name,
        upper(trim(COALESCE(gfsbh, ''))) AS counterparty_id,
        'output'::VARCHAR AS invoice_side,
        CAST(invoice_date AS DATE) AS inv_date,
        strftime(invoice_date, '%Y-%m') AS stat_month,
        CAST(EXTRACT(year FROM invoice_date) AS SMALLINT) AS stat_year,
        CAST(EXTRACT(month FROM invoice_date) AS SMALLINT) AS stat_month_no,
        COALESCE(jshj, 0) AS amt_jshj,
        CASE WHEN COALESCE(jshj, 0) < 0 OR COALESCE(related_blue_invoice_uuid, '') <> '' THEN 1 ELSE 0 END AS is_red
      FROM hdr_scope
      WHERE trim(COALESCE(xfsbh, '')) <> '' {seller_scope_sql}
      UNION ALL
      SELECT
        upper(trim(COALESCE(gfsbh, ''))) AS taxpayer_id,
        trim(COALESCE(gfmc, '')) AS taxpayer_name,
        upper(trim(COALESCE(xfsbh, ''))) AS counterparty_id,
        'input'::VARCHAR AS invoice_side,
        CAST(invoice_date AS DATE) AS inv_date,
        strftime(invoice_date, '%Y-%m') AS stat_month,
        CAST(EXTRACT(year FROM invoice_date) AS SMALLINT) AS stat_year,
        CAST(EXTRACT(month FROM invoice_date) AS SMALLINT) AS stat_month_no,
        COALESCE(jshj, 0) AS amt_jshj,
        CASE WHEN COALESCE(jshj, 0) < 0 OR COALESCE(related_blue_invoice_uuid, '') <> '' THEN 1 ELSE 0 END AS is_red
      FROM hdr_scope
      WHERE trim(COALESCE(gfsbh, '')) <> '' {buyer_scope_sql}
    ),
    base AS (
      SELECT * FROM side_flat WHERE taxpayer_id <> ''
    ),
    monthly AS (
      SELECT
        taxpayer_id,
        max_by(taxpayer_name, length(taxpayer_name)) AS taxpayer_name,
        stat_month,
        max(stat_year) AS stat_year,
        max(stat_month_no) AS stat_month_no,
        COUNT(*)::BIGINT AS inv_cnt_total,
        SUM(COALESCE(amt_jshj, 0))::DECIMAL(18,2) AS inv_amt_total,
        SUM(CASE WHEN invoice_side='output' THEN 1 ELSE 0 END)::BIGINT AS inv_cnt_output,
        SUM(CASE WHEN invoice_side='output' THEN COALESCE(amt_jshj,0) ELSE 0 END)::DECIMAL(18,2) AS inv_amt_output,
        SUM(CASE WHEN invoice_side='input' THEN 1 ELSE 0 END)::BIGINT AS inv_cnt_input,
        SUM(CASE WHEN invoice_side='input' THEN COALESCE(amt_jshj,0) ELSE 0 END)::DECIMAL(18,2) AS inv_amt_input,
        COUNT(DISTINCT CASE WHEN invoice_side='output' THEN NULLIF(counterparty_id,'') END)::BIGINT AS counterparty_cnt_output,
        COUNT(DISTINCT CASE WHEN invoice_side='input' THEN NULLIF(counterparty_id,'') END)::BIGINT AS counterparty_cnt_input,
        SUM(CASE WHEN is_red=0 THEN 1 ELSE 0 END)::BIGINT AS blue_inv_cnt,
        SUM(CASE WHEN is_red=1 THEN 1 ELSE 0 END)::BIGINT AS red_inv_cnt,
        COUNT(DISTINCT inv_date)::BIGINT AS active_days
      FROM base
      GROUP BY taxpayer_id, stat_month
    ),
    daily_agg AS (
      SELECT
        taxpayer_id,
        stat_month,
        AVG(day_cnt)::DECIMAL(18,6) AS avg_daily_inv_cnt,
        MAX(day_cnt)::BIGINT AS max_daily_inv_cnt
      FROM (
        SELECT taxpayer_id, stat_month, inv_date, COUNT(*)::BIGINT AS day_cnt
        FROM base
        GROUP BY taxpayer_id, stat_month, inv_date
      ) d
      GROUP BY taxpayer_id, stat_month
    ),
    cp_top AS (
      SELECT
        taxpayer_id,
        stat_month,
        MAX(cp_amt) AS top_amt,
        SUM(cp_amt) AS total_amt
      FROM (
        SELECT taxpayer_id, stat_month, counterparty_id, SUM(COALESCE(amt_jshj,0))::DECIMAL(18,2) AS cp_amt
        FROM base
        WHERE counterparty_id <> ''
        GROUP BY taxpayer_id, stat_month, counterparty_id
      ) c
      GROUP BY taxpayer_id, stat_month
    ),
    assembled AS (
      SELECT
        'ENT_' || substr(md5(m.taxpayer_id), 1, 24) AS enterprise_id,
        m.stat_month,
        m.stat_year,
        m.stat_month_no,
        m.inv_cnt_total,
        m.inv_amt_total,
        m.inv_cnt_output,
        m.inv_amt_output,
        m.inv_cnt_input,
        m.inv_amt_input,
        m.counterparty_cnt_output,
        m.counterparty_cnt_input,
        CASE WHEN m.inv_amt_input = 0 THEN NULL ELSE (m.inv_amt_output * 1.0 / m.inv_amt_input) END AS output_input_amt_ratio,
        m.blue_inv_cnt,
        m.red_inv_cnt,
        CASE WHEN m.inv_cnt_total = 0 THEN NULL ELSE (m.red_inv_cnt * 1.0 / m.inv_cnt_total) END AS red_inv_ratio,
        CASE WHEN COALESCE(ct.total_amt,0)=0 THEN NULL ELSE (ct.top_amt * 1.0 / ct.total_amt) END AS top_counterparty_ratio,
        m.active_days,
        d.avg_daily_inv_cnt,
        d.max_daily_inv_cnt,
        p.inv_amt_total AS prev_inv_amt_total,
        p.inv_cnt_total AS prev_inv_cnt_total
      FROM monthly m
      LEFT JOIN daily_agg d
        ON d.taxpayer_id=m.taxpayer_id AND d.stat_month=m.stat_month
      LEFT JOIN cp_top ct
        ON ct.taxpayer_id=m.taxpayer_id AND ct.stat_month=m.stat_month
      LEFT JOIN dws_enterprise_invoice_profile p
        ON p.enterprise_id = 'ENT_' || substr(md5(m.taxpayer_id), 1, 24)
       AND p.stat_month = strftime(date(m.stat_month || '-01', '-1 month'), '%Y-%m')
    ),
    scored AS (
      SELECT
        a.*,
        CASE WHEN a.prev_inv_amt_total IS NULL OR a.prev_inv_amt_total = 0 THEN NULL
             ELSE (a.inv_amt_total - a.prev_inv_amt_total) * 1.0 / a.prev_inv_amt_total END AS amt_mom_change,
        CASE WHEN a.prev_inv_cnt_total IS NULL OR a.prev_inv_cnt_total = 0 THEN NULL
             ELSE (a.inv_cnt_total - a.prev_inv_cnt_total) * 1.0 / a.prev_inv_cnt_total END AS cnt_mom_change
      FROM assembled a
    )
    INSERT OR REPLACE INTO dws_enterprise_invoice_profile (
      enterprise_id, stat_month, stat_year, stat_month_no,
      calc_batch_id, calc_run_id, calc_time, source_scope,
      inv_cnt_total, inv_amt_total, inv_cnt_output, inv_amt_output, inv_cnt_input, inv_amt_input,
      counterparty_cnt_output, counterparty_cnt_input, output_input_amt_ratio,
      blue_inv_cnt, red_inv_cnt, red_inv_ratio, top_counterparty_ratio,
      active_days, avg_daily_inv_cnt, max_daily_inv_cnt, amt_mom_change, cnt_mom_change,
      abnormal_red_flag, abnormal_spike_flag, abnormal_counterparty_concentration_flag,
      risk_score_base, risk_level
    )
    SELECT
      s.enterprise_id, s.stat_month, s.stat_year, s.stat_month_no,
      ?, ?, CURRENT_TIMESTAMP, ?,
      s.inv_cnt_total, s.inv_amt_total, s.inv_cnt_output, s.inv_amt_output, s.inv_cnt_input, s.inv_amt_input,
      s.counterparty_cnt_output, s.counterparty_cnt_input, s.output_input_amt_ratio,
      s.blue_inv_cnt, s.red_inv_cnt, s.red_inv_ratio, s.top_counterparty_ratio,
      s.active_days, s.avg_daily_inv_cnt, s.max_daily_inv_cnt, s.amt_mom_change, s.cnt_mom_change,
      (COALESCE(s.red_inv_ratio, 0) >= {n(red["high"])}),
      (ABS(COALESCE(s.amt_mom_change,0)) >= {n(amt["high"])} OR ABS(COALESCE(s.cnt_mom_change,0)) >= {n(cnt["high"])}),
      (COALESCE(s.top_counterparty_ratio,0) >= {n(conc["high"])}),
      {score_sql}::DECIMAL(8,2) AS risk_score_base,
      CASE
        WHEN {score_sql} >= {n(lvl["high_min"])} THEN 'high'
        WHEN {score_sql} > {n(lvl["low_max"])} THEN 'medium'
        ELSE 'low'
      END AS risk_level
    FROM scored s
    """

    conn.execute(sql, [*params, *scope_params[:3], *scope_params[3:], calc_batch_id, run_id, source_scope])
    if on_progress:
        on_progress("count", "正在统计画像写入行数…")
    written = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dws_enterprise_invoice_profile WHERE calc_run_id = ?",
        [run_id],
    ).fetchone()[0]
    enterprise_n = conn.execute(
        "SELECT COUNT(DISTINCT enterprise_id)::BIGINT FROM dws_enterprise_invoice_profile WHERE calc_run_id = ?",
        [run_id],
    ).fetchone()[0]

    out = {
        "ok": True,
        "stage": "dwd_to_dim_enterprise_profile",
        "run_id": run_id,
        "calc_batch_id": calc_batch_id,
        "source_scope": source_scope,
        "subject_category_scope": subject_category_scope,
        "stat_month": stat_month,
        "import_batch_id": import_batch_id,
        "enterprise_upserted": int(enterprise_n or 0),
        "profile_rows_written": int(written or 0),
    }
    if own_conn:
        try:
            conn.close()
        except Exception:
            pass
    return out

