-- ============================================================================
-- 统一主体库导入示例（最小可落地版）
-- 目标：
-- 1) 外部数据先落 dim_subject_source_record；
-- 2) 按规则分流 matched / pending / conflict；
-- 3) matched 记录回写 dim_subject_master（upsert）。
--
-- 说明：
-- - 本示例偏 DuckDB/PostgreSQL 通用写法，实际可按你们 ETL 框架改造。
-- - 仅示意核心链路，字段可按业务继续扩展。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) 假设：外部文件先入临时表 stg_subject_import
-- ----------------------------------------------------------------------------
-- 建议临时表字段（示例）：
-- file_id, row_no, subject_name, subject_no, subject_no_type,
-- subject_category, org_category, import_batch_id

-- ----------------------------------------------------------------------------
-- 1) 原样写入来源记录（默认先置 pending，后续再批量判定）
-- ----------------------------------------------------------------------------
INSERT INTO dim_subject_source_record (
    source_record_id,
    subject_id,
    source_system,
    import_batch_id,
    import_session_id,
    source_excel_file,
    source_parquet_file,
    source_sheet,
    ods_file_seq,
    source_row_no,
    raw_subject_name,
    raw_subject_no,
    raw_subject_no_type,
    raw_subject_category,
    raw_org_category,
    match_status,
    match_rule,
    match_confidence,
    payload_json,
    ingest_ts
)
SELECT
    'SRC_' || file_id || '_' || CAST(row_no AS VARCHAR) AS source_record_id,
    NULL AS subject_id,
    'external' AS source_system,
    import_batch_id,
    NULL AS import_session_id,
    file_id AS source_excel_file,
    NULL AS source_parquet_file,
    NULL AS source_sheet,
    NULL AS ods_file_seq,
    row_no AS source_row_no,
    subject_name AS raw_subject_name,
    subject_no AS raw_subject_no,
    subject_no_type AS raw_subject_no_type,
    subject_category AS raw_subject_category,
    org_category AS raw_org_category,
    'pending' AS match_status,
    NULL AS match_rule,
    NULL AS match_confidence,
    NULL AS payload_json,
    CURRENT_TIMESTAMP AS ingest_ts
FROM stg_subject_import;

-- ----------------------------------------------------------------------------
-- 2) 第一优先级：按标识号精确匹配（subject_no + subject_category）
--    命中唯一主体 => matched
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record src
SET
    subject_id = m.subject_id,
    match_status = 'matched',
    match_rule = 'subject_no_exact',
    match_confidence = 1.0000
FROM (
    SELECT
        s.source_record_id,
        d.subject_id
    FROM dim_subject_source_record s
    JOIN dim_subject_master d
      ON d.subject_no = s.raw_subject_no
     AND d.subject_category = COALESCE(s.raw_subject_category, d.subject_category)
    WHERE s.source_system = 'external'
      AND s.match_status = 'pending'
      AND s.raw_subject_no IS NOT NULL
) m
WHERE src.source_record_id = m.source_record_id;

-- ----------------------------------------------------------------------------
-- 3) 第二优先级：按规范名称匹配（仅对仍 pending 的记录）
--    这里用 lower(trim(name)) 作为示例规范化方式
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record src
SET
    subject_id = m.subject_id,
    match_status = 'matched',
    match_rule = 'subject_name_std_exact',
    match_confidence = 0.9000
FROM (
    SELECT
        s.source_record_id,
        d.subject_id
    FROM dim_subject_source_record s
    JOIN dim_subject_master d
      ON lower(trim(d.subject_name_std)) = lower(trim(s.raw_subject_name))
     AND d.subject_category = COALESCE(s.raw_subject_category, d.subject_category)
    WHERE s.source_system = 'external'
      AND s.match_status = 'pending'
      AND s.raw_subject_name IS NOT NULL
) m
WHERE src.source_record_id = m.source_record_id;

-- ----------------------------------------------------------------------------
-- 4) 冲突识别：同一来源记录命中多主体（示意）
--    简化处理：将仍 pending 且存在多候选的记录标记 conflict。
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record s
SET
    match_status = 'conflict',
    match_rule = 'multi_candidate',
    match_confidence = 0.0000
WHERE s.source_system = 'external'
  AND s.match_status = 'pending'
  AND EXISTS (
      SELECT 1
      FROM dim_subject_master d
      WHERE d.subject_category = COALESCE(s.raw_subject_category, d.subject_category)
        AND (
            (s.raw_subject_no IS NOT NULL AND d.subject_no = s.raw_subject_no)
            OR
            (s.raw_subject_name IS NOT NULL AND lower(trim(d.subject_name_std)) = lower(trim(s.raw_subject_name)))
        )
      GROUP BY d.subject_category
      HAVING COUNT(*) > 1
  );

-- ----------------------------------------------------------------------------
-- 5) 仍未命中的 pending：新建主体主档（仅对 pending）
--    你们可替换为更稳定的 ID 生成策略（如 UUID/序列）。
-- ----------------------------------------------------------------------------
INSERT INTO dim_subject_master (
    subject_id,
    subject_name,
    subject_name_std,
    subject_category,
    org_category,
    subject_no,
    subject_no_type,
    source_status,
    first_source_system,
    first_import_batch_id,
    first_import_session_id,
    last_import_batch_id,
    last_import_session_id,
    quality_status,
    quality_issue,
    created_at,
    updated_at
)
SELECT
    'SUB_' || replace(replace(CAST(CURRENT_TIMESTAMP AS VARCHAR), '-', ''), ':', '') || '_' || CAST(row_number() OVER () AS VARCHAR) AS subject_id,
    s.raw_subject_name AS subject_name,
    lower(trim(s.raw_subject_name)) AS subject_name_std,
    COALESCE(s.raw_subject_category, 'org') AS subject_category,
    s.raw_org_category AS org_category,
    s.raw_subject_no AS subject_no,
    s.raw_subject_no_type AS subject_no_type,
    'single' AS source_status,
    'external' AS first_source_system,
    s.import_batch_id AS first_import_batch_id,
    s.import_session_id AS first_import_session_id,
    s.import_batch_id AS last_import_batch_id,
    s.import_session_id AS last_import_session_id,
    'ok' AS quality_status,
    NULL AS quality_issue,
    CURRENT_TIMESTAMP AS created_at,
    CURRENT_TIMESTAMP AS updated_at
FROM dim_subject_source_record s
WHERE s.source_system = 'external'
  AND s.match_status = 'pending';

-- ----------------------------------------------------------------------------
-- 6) 回填新建主体的关联（pending -> matched）
--    规则：用同批次 + 名称 + 标识号回关联。
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record s
SET
    subject_id = d.subject_id,
    match_status = 'matched',
    match_rule = COALESCE(s.match_rule, 'new_subject_created'),
    match_confidence = COALESCE(s.match_confidence, 0.8000)
FROM dim_subject_master d
WHERE s.source_system = 'external'
  AND s.match_status = 'pending'
  AND d.first_source_system = 'external'
  AND d.first_import_batch_id = s.import_batch_id
  AND COALESCE(d.subject_no, '') = COALESCE(s.raw_subject_no, '')
  AND COALESCE(lower(trim(d.subject_name_std)), '') = COALESCE(lower(trim(s.raw_subject_name)), '');

-- ----------------------------------------------------------------------------
-- 7) 用 matched 记录回写主表（补齐最近批次/名称/机构类别）
--    注意：这里是示例策略，真实项目可加入字段优先级（external vs invoice）。
-- ----------------------------------------------------------------------------
UPDATE dim_subject_master d
SET
    subject_name = COALESCE(s.raw_subject_name, d.subject_name),
    subject_name_std = COALESCE(lower(trim(s.raw_subject_name)), d.subject_name_std),
    org_category = COALESCE(s.raw_org_category, d.org_category),
    subject_no = COALESCE(s.raw_subject_no, d.subject_no),
    subject_no_type = COALESCE(s.raw_subject_no_type, d.subject_no_type),
    last_import_batch_id = COALESCE(s.import_batch_id, d.last_import_batch_id),
    last_import_session_id = COALESCE(s.import_session_id, d.last_import_session_id),
    source_status = CASE
        WHEN d.first_source_system IS NULL OR d.first_source_system = s.source_system THEN d.source_status
        ELSE 'merged'
    END,
    updated_at = CURRENT_TIMESTAMP
FROM dim_subject_source_record s
WHERE s.match_status = 'matched'
  AND s.subject_id = d.subject_id
  AND s.source_system = 'external';

-- ----------------------------------------------------------------------------
-- 8) 质检视图（建议作为每批次收尾核对）
-- ----------------------------------------------------------------------------
-- 8.1 本批次匹配结果分布
SELECT
    import_batch_id,
    match_status,
    COUNT(*) AS cnt
FROM dim_subject_source_record
WHERE source_system = 'external'
GROUP BY import_batch_id, match_status
ORDER BY import_batch_id, match_status;

-- 8.2 冲突清单
SELECT
    source_record_id,
    import_batch_id,
    raw_subject_name,
    raw_subject_no,
    raw_subject_category,
    match_rule
FROM dim_subject_source_record
WHERE source_system = 'external'
  AND match_status = 'conflict'
ORDER BY ingest_ts DESC;
