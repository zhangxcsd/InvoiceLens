-- upsert_dim_enterprise_from_header.sql
-- 用途：基于 dwd_inv_header（发票主表）增量/全量更新 dim_enterprise
-- 规则：
-- 1) 仅从主表抽取销方/购方企业（xfsbh/xfmc, gfsbh/gfmc）
-- 2) taxpayer_id 为空的企业不入库
-- 3) 仅保留 first_seen_batch_id / last_seen_batch_id（不落 import_session_id）
--
-- 使用：
-- A. 单批次增量：将 target_batch 改为具体批次号
-- B. 全量重算式合并：将 target_batch 设为 NULL
--
-- 示例：
--   duckdb data/warehouse.duckdb -f scripts/upsert_dim_enterprise_from_header.sql

WITH params AS (
    SELECT CAST(NULL AS VARCHAR) AS target_batch
),
src_union AS (
    SELECT
        trim(xfsbh) AS taxpayer_id,
        trim(xfmc) AS enterprise_name,
        TRUE AS is_seller,
        FALSE AS is_buyer,
        invoice_date,
        import_batch_id
    FROM dwd_inv_header h
    CROSS JOIN params p
    WHERE (p.target_batch IS NULL OR h.import_batch_id = p.target_batch)
      AND trim(coalesce(h.xfsbh, '')) <> ''

    UNION ALL

    SELECT
        trim(gfsbh) AS taxpayer_id,
        trim(gfmc) AS enterprise_name,
        FALSE AS is_seller,
        TRUE AS is_buyer,
        invoice_date,
        import_batch_id
    FROM dwd_inv_header h
    CROSS JOIN params p
    WHERE (p.target_batch IS NULL OR h.import_batch_id = p.target_batch)
      AND trim(coalesce(h.gfsbh, '')) <> ''
),
src_agg AS (
    SELECT
        taxpayer_id,
        max(enterprise_name) FILTER (WHERE enterprise_name IS NOT NULL AND enterprise_name <> '') AS enterprise_name_std,
        arg_max(enterprise_name, invoice_date) AS enterprise_name_raw,
        max(CASE WHEN is_seller THEN 1 ELSE 0 END) = 1 AS has_seller_role,
        max(CASE WHEN is_buyer THEN 1 ELSE 0 END) = 1 AS has_buyer_role,
        min(invoice_date) AS data_first_seen_date,
        max(invoice_date) AS data_last_seen_date,
        arg_min(import_batch_id, invoice_date) AS first_seen_batch_id,
        arg_max(import_batch_id, invoice_date) AS last_seen_batch_id
    FROM src_union
    GROUP BY taxpayer_id
),
src_ready AS (
    SELECT
        md5('TAX|' || taxpayer_id) AS enterprise_id,
        taxpayer_id,
        coalesce(nullif(trim(enterprise_name_std), ''), taxpayer_id) AS enterprise_name_std,
        nullif(trim(enterprise_name_raw), '') AS enterprise_name_raw,
        has_seller_role,
        has_buyer_role,
        first_seen_batch_id,
        last_seen_batch_id,
        data_first_seen_date,
        data_last_seen_date
    FROM src_agg
)
MERGE INTO dim_enterprise AS t
USING src_ready AS s
ON t.taxpayer_id = s.taxpayer_id
WHEN MATCHED THEN UPDATE SET
    enterprise_name_std = coalesce(s.enterprise_name_std, t.enterprise_name_std),
    enterprise_name_raw = coalesce(s.enterprise_name_raw, t.enterprise_name_raw),
    has_seller_role = (t.has_seller_role OR s.has_seller_role),
    has_buyer_role = (t.has_buyer_role OR s.has_buyer_role),
    data_first_seen_date = CASE
        WHEN t.data_first_seen_date IS NULL THEN s.data_first_seen_date
        WHEN s.data_first_seen_date IS NULL THEN t.data_first_seen_date
        WHEN s.data_first_seen_date < t.data_first_seen_date THEN s.data_first_seen_date
        ELSE t.data_first_seen_date
    END,
    data_last_seen_date = CASE
        WHEN t.data_last_seen_date IS NULL THEN s.data_last_seen_date
        WHEN s.data_last_seen_date IS NULL THEN t.data_last_seen_date
        WHEN s.data_last_seen_date > t.data_last_seen_date THEN s.data_last_seen_date
        ELSE t.data_last_seen_date
    END,
    first_seen_batch_id = CASE
        WHEN t.data_first_seen_date IS NULL THEN s.first_seen_batch_id
        WHEN s.data_first_seen_date IS NULL THEN t.first_seen_batch_id
        WHEN s.data_first_seen_date < t.data_first_seen_date THEN s.first_seen_batch_id
        ELSE t.first_seen_batch_id
    END,
    last_seen_batch_id = CASE
        WHEN t.data_last_seen_date IS NULL THEN s.last_seen_batch_id
        WHEN s.data_last_seen_date IS NULL THEN t.last_seen_batch_id
        WHEN s.data_last_seen_date > t.data_last_seen_date THEN s.last_seen_batch_id
        ELSE t.last_seen_batch_id
    END,
    updated_at = CURRENT_TIMESTAMP
WHEN NOT MATCHED THEN INSERT (
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
) VALUES (
    s.enterprise_id,
    s.taxpayer_id,
    s.enterprise_name_std,
    s.enterprise_name_raw,
    s.has_seller_role,
    s.has_buyer_role,
    s.first_seen_batch_id,
    s.last_seen_batch_id,
    s.data_first_seen_date,
    s.data_last_seen_date,
    'ok',
    NULL,
    CURRENT_TIMESTAMP
);
