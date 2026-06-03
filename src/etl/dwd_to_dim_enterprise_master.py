from __future__ import annotations

from datetime import datetime
from typing import Any, Callable


def _make_run_id(prefix: str) -> str:
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"


def build_enterprise_master(
    conn: Any,
    *,
    import_batch_id: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
    on_progress: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """从 dwd_inv_header 归集 dim_enterprise（税号主体口径）。"""
    run_id = run_id or _make_run_id("enterprise_master")
    if on_progress:
        on_progress("scan", "正在扫描 dwd_inv_header 归集企业主体…")
    where_sql = "1=1"
    params: list[Any] = []
    if import_batch_id:
        where_sql += " AND COALESCE(import_batch_id, first_import_batch_id, '') = ?"
        params.append(import_batch_id)

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

    conn.execute(
        f"""
        WITH base AS (
          SELECT
            upper(trim(COALESCE(xfsbh, ''))) AS taxpayer_id,
            trim(COALESCE(xfmc, '')) AS party_name,
            1 AS is_seller,
            0 AS is_buyer,
            COALESCE(import_batch_id, first_import_batch_id, '') AS bid,
            CAST(invoice_date AS DATE) AS inv_date
          FROM dwd_inv_header
          WHERE {where_sql} {seller_scope_sql}

          UNION ALL

          SELECT
            upper(trim(COALESCE(gfsbh, ''))) AS taxpayer_id,
            trim(COALESCE(gfmc, '')) AS party_name,
            0 AS is_seller,
            1 AS is_buyer,
            COALESCE(import_batch_id, first_import_batch_id, '') AS bid,
            CAST(invoice_date AS DATE) AS inv_date
          FROM dwd_inv_header
          WHERE {where_sql} {buyer_scope_sql}
        ),
        valid AS (
          SELECT
            taxpayer_id,
            regexp_replace(trim(COALESCE(party_name, '')), '\\s+', '', 'g') AS name_std,
            trim(COALESCE(party_name, '')) AS name_raw,
            is_seller,
            is_buyer,
            bid,
            inv_date
          FROM base
          WHERE taxpayer_id <> ''
        ),
        agg AS (
          SELECT
            taxpayer_id,
            max_by(name_std, length(name_std)) AS enterprise_name_std,
            max_by(name_raw, length(name_raw)) AS enterprise_name_raw,
            max(is_seller) > 0 AS has_seller_role,
            max(is_buyer) > 0 AS has_buyer_role,
            min_by(bid, coalesce(inv_date, DATE '9999-12-31')) AS first_seen_batch_id,
            max_by(bid, coalesce(inv_date, DATE '1900-01-01')) AS last_seen_batch_id,
            min(inv_date) AS data_first_seen_date,
            max(inv_date) AS data_last_seen_date
          FROM valid
          GROUP BY taxpayer_id
        )
        INSERT OR REPLACE INTO dim_enterprise (
          enterprise_id,
          taxpayer_id,
          enterprise_name_std,
          enterprise_name_raw,
          has_seller_role,
          has_buyer_role,
          first_seen_batch_id,
          last_seen_batch_id,
          data_first_seen_date,
          data_last_seen_date,
          quality_status,
          quality_issue,
          updated_at
        )
        SELECT
          'ENT_' || substr(md5(taxpayer_id), 1, 24) AS enterprise_id,
          taxpayer_id,
          COALESCE(NULLIF(enterprise_name_std, ''), taxpayer_id) AS enterprise_name_std,
          NULLIF(enterprise_name_raw, '') AS enterprise_name_raw,
          has_seller_role,
          has_buyer_role,
          COALESCE(NULLIF(first_seen_batch_id, ''), '{run_id}') AS first_seen_batch_id,
          COALESCE(NULLIF(last_seen_batch_id, ''), '{run_id}') AS last_seen_batch_id,
          data_first_seen_date,
          data_last_seen_date,
          'ok' AS quality_status,
          NULL AS quality_issue,
          CURRENT_TIMESTAMP
        FROM agg
        """,
        [*params, *scope_params[:3], *params, *scope_params[3:]],
    )

    if on_progress:
        on_progress("count", "正在统计 dim_enterprise 写入结果…")
    rows = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dim_enterprise WHERE last_seen_batch_id = ?",
        [import_batch_id or run_id],
    ).fetchone()[0]
    return {
        "ok": True,
        "stage": "dwd_to_dim_enterprise_master",
        "run_id": run_id,
        "import_batch_id": import_batch_id,
        "subject_category_scope": subject_category_scope,
        "rows_affected": int(rows or 0),
    }


def build_enterprise_mapping_status(
    conn: Any,
    *,
    import_batch_id: str | None = None,
    subject_category_scope: str | None = None,
    run_id: str | None = None,
    on_progress: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """构建企业↔票主体映射状态表（票面主体是否已映射到 dim_enterprise）。"""
    run_id = run_id or _make_run_id("enterprise_mapping")
    if on_progress:
        on_progress("prepare", "正在准备映射检查表…")
    where_sql = "1=1"
    params: list[Any] = []
    if import_batch_id:
        where_sql += " AND COALESCE(import_batch_id, first_import_batch_id, '') = ?"
        params.append(import_batch_id)

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dwd_enterprise_mapping_status (
          mapping_uuid         VARCHAR NOT NULL PRIMARY KEY,
          taxpayer_id          VARCHAR,
          enterprise_name_raw  VARCHAR,
          enterprise_name_std  VARCHAR,
          linked_enterprise_id VARCHAR,
          linked_taxpayer_id   VARCHAR,
          match_key            VARCHAR,
          match_status         VARCHAR,
          pending_reason       VARCHAR,
          import_batch_id      VARCHAR,
          calc_run_id          VARCHAR,
          calc_time            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    if import_batch_id:
        conn.execute(
            "DELETE FROM dwd_enterprise_mapping_status WHERE import_batch_id = ?",
            [import_batch_id],
        )
    else:
        conn.execute("DELETE FROM dwd_enterprise_mapping_status WHERE calc_run_id = ?", [run_id])

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

    if on_progress:
        on_progress("match", "正在匹配票面主体与 dim_enterprise…")
    conn.execute(
        f"""
        WITH src AS (
          SELECT
            upper(trim(COALESCE(xfsbh, ''))) AS taxpayer_id,
            trim(COALESCE(xfmc, '')) AS enterprise_name_raw,
            regexp_replace(trim(COALESCE(xfmc, '')), '\\s+', '', 'g') AS enterprise_name_std,
            COALESCE(import_batch_id, first_import_batch_id, '') AS import_batch_id
          FROM dwd_inv_header
          WHERE {where_sql} {seller_scope_sql}
          UNION ALL
          SELECT
            upper(trim(COALESCE(gfsbh, ''))) AS taxpayer_id,
            trim(COALESCE(gfmc, '')) AS enterprise_name_raw,
            regexp_replace(trim(COALESCE(gfmc, '')), '\\s+', '', 'g') AS enterprise_name_std,
            COALESCE(import_batch_id, first_import_batch_id, '') AS import_batch_id
          FROM dwd_inv_header
          WHERE {where_sql} {buyer_scope_sql}
        ),
        dedup AS (
          SELECT DISTINCT taxpayer_id, enterprise_name_raw, enterprise_name_std, import_batch_id
          FROM src
          WHERE taxpayer_id <> '' OR enterprise_name_std <> ''
        ),
        m AS (
          SELECT
            d.*,
            e.enterprise_id AS linked_enterprise_id,
            e.taxpayer_id AS linked_taxpayer_id,
            CASE
              WHEN d.taxpayer_id <> '' AND e.enterprise_id IS NOT NULL THEN 'taxpayer_id'
              WHEN d.taxpayer_id = '' AND e2.enterprise_id IS NOT NULL THEN 'enterprise_name_std'
              ELSE 'none'
            END AS match_key,
            CASE
              WHEN d.taxpayer_id <> '' AND e.enterprise_id IS NOT NULL THEN 'matched'
              WHEN d.taxpayer_id = '' AND e2.enterprise_id IS NOT NULL THEN 'name_fallback'
              ELSE 'pending'
            END AS match_status,
            CASE
              WHEN d.taxpayer_id = '' THEN 'missing_taxpayer_id'
              WHEN d.taxpayer_id <> '' AND e.enterprise_id IS NULL THEN 'taxpayer_not_in_dim_enterprise'
              ELSE NULL
            END AS pending_reason
          FROM dedup d
          LEFT JOIN dim_enterprise e
            ON e.taxpayer_id = d.taxpayer_id
          LEFT JOIN dim_enterprise e2
            ON d.taxpayer_id = '' AND e2.enterprise_name_std = d.enterprise_name_std
        )
        INSERT INTO dwd_enterprise_mapping_status (
          mapping_uuid, taxpayer_id, enterprise_name_raw, enterprise_name_std,
          linked_enterprise_id, linked_taxpayer_id, match_key, match_status, pending_reason,
          import_batch_id, calc_run_id, calc_time
        )
        SELECT
          'MAP_' || substr(md5(coalesce(taxpayer_id,'') || '|' || coalesce(enterprise_name_std,'') || '|' || coalesce(import_batch_id,'')), 1, 24),
          taxpayer_id,
          enterprise_name_raw,
          enterprise_name_std,
          linked_enterprise_id,
          linked_taxpayer_id,
          match_key,
          match_status,
          pending_reason,
          import_batch_id,
          ? AS calc_run_id,
          CURRENT_TIMESTAMP
        FROM m
        """,
        [*params, *scope_params[:3], *params, *scope_params[3:], run_id],
    )

    rows = conn.execute(
        "SELECT COUNT(*)::BIGINT FROM dwd_enterprise_mapping_status WHERE calc_run_id = ?",
        [run_id],
    ).fetchone()[0]
    return {
        "ok": True,
        "stage": "dwd_to_dim_enterprise_mapping",
        "run_id": run_id,
        "import_batch_id": import_batch_id,
        "subject_category_scope": subject_category_scope,
        "rows_affected": int(rows or 0),
    }

