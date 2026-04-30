-- ============================================================================
-- 统一主体库导入示例 v2（含字段优先级策略）
-- 基于：docs/subject_master_etl_example.sql
-- 重点增强：
-- 1) 回写 dim_subject_master 时按字段级优先级覆盖；
-- 2) subject_no 冲突/subject_category 强冲突进入 conflict；
-- 3) 仍保持当前阶段最小关注字段：名称、机构类别、主体类别。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) 假设：外部文件先入临时表 stg_subject_import
-- ----------------------------------------------------------------------------
-- 字段示例：
-- file_id, row_no, subject_name, subject_no, subject_no_type,
-- subject_category, org_category, import_batch_id

-- ----------------------------------------------------------------------------
-- 1) 写入来源记录（先 pending）
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
    NULL,
    'external',
    import_batch_id,
    NULL AS import_session_id,
    file_id AS source_excel_file,
    NULL AS source_parquet_file,
    NULL AS source_sheet,
    NULL AS ods_file_seq,
    row_no,
    subject_name,
    subject_no,
    subject_no_type,
    subject_category,
    org_category,
    'pending',
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP
FROM stg_subject_import;

-- ----------------------------------------------------------------------------
-- 2) 第一优先级：标识号精确匹配
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record src
SET
    subject_id = m.subject_id,
    match_status = 'matched',
    match_rule = 'subject_no_exact',
    match_confidence = 1.0000
FROM (
    SELECT s.source_record_id, d.subject_id
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
-- 3) 第二优先级：规范名称精确匹配（仍 pending）
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record src
SET
    subject_id = m.subject_id,
    match_status = 'matched',
    match_rule = 'subject_name_std_exact',
    match_confidence = 0.9000
FROM (
    SELECT s.source_record_id, d.subject_id
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
-- 4) 多候选冲突识别（仍 pending）
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
-- 5) pending -> 新建主体
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
    'SUB_' || replace(replace(CAST(CURRENT_TIMESTAMP AS VARCHAR), '-', ''), ':', '') || '_' || CAST(row_number() OVER () AS VARCHAR),
    s.raw_subject_name,
    lower(trim(s.raw_subject_name)),
    COALESCE(s.raw_subject_category, 'org'),
    s.raw_org_category,
    s.raw_subject_no,
    s.raw_subject_no_type,
    'single',
    'external',
    s.import_batch_id,
    s.import_session_id,
    s.import_batch_id,
    s.import_session_id,
    'ok',
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM dim_subject_source_record s
WHERE s.source_system = 'external'
  AND s.match_status = 'pending';

-- ----------------------------------------------------------------------------
-- 6) 新建主体回填 pending -> matched
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
-- 7) 强冲突拦截（matched 但关键字段冲突）
-- ----------------------------------------------------------------------------
UPDATE dim_subject_source_record s
SET
    match_status = 'conflict',
    match_rule = 'strong_conflict_subject_no_or_category',
    match_confidence = 0.0000
FROM dim_subject_master d
WHERE s.match_status = 'matched'
  AND s.subject_id = d.subject_id
  AND (
      -- subject_no 强冲突：主表已有非空值，且与新值不一致
      (s.raw_subject_no IS NOT NULL AND trim(s.raw_subject_no) <> ''
       AND d.subject_no IS NOT NULL AND trim(d.subject_no) <> ''
       AND d.subject_no <> s.raw_subject_no)
      OR
      -- subject_category 强冲突：org/person 切换
      (s.raw_subject_category IS NOT NULL AND trim(s.raw_subject_category) <> ''
       AND d.subject_category IS NOT NULL AND trim(d.subject_category) <> ''
       AND d.subject_category <> s.raw_subject_category)
  );

-- 冲突同步到主表状态（可选）
UPDATE dim_subject_master d
SET
    source_status = 'conflict',
    quality_status = 'warning',
    quality_issue = '强冲突：subject_no 或 subject_category 不一致',
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
    SELECT 1
    FROM dim_subject_source_record s
    WHERE s.subject_id = d.subject_id
      AND s.match_status = 'conflict'
      AND s.match_rule = 'strong_conflict_subject_no_or_category'
);

-- ----------------------------------------------------------------------------
-- 8) 字段优先级回写（仅 matched 且非冲突）
-- 策略：
-- - subject_name: manual > external > invoice（本脚本当前仅 external）
-- - subject_category: external 仅补空，不改已有非空值
-- - org_category: manual > external，invoice 不覆盖（本脚本当前 external）
-- - subject_no: 只补空，不覆盖已有非空
-- ----------------------------------------------------------------------------
UPDATE dim_subject_master d
SET
    subject_name = CASE
        WHEN s.raw_subject_name IS NULL OR trim(s.raw_subject_name) = '' THEN d.subject_name
        -- 当前仅 external，等价于“可覆盖展示名”
        ELSE s.raw_subject_name
    END,
    subject_name_std = lower(trim(
        CASE
            WHEN s.raw_subject_name IS NULL OR trim(s.raw_subject_name) = '' THEN d.subject_name
            ELSE s.raw_subject_name
        END
    )),
    subject_category = CASE
        WHEN s.raw_subject_category IS NULL OR trim(s.raw_subject_category) = '' THEN d.subject_category
        WHEN d.subject_category IS NULL OR trim(d.subject_category) = '' THEN s.raw_subject_category
        ELSE d.subject_category
    END,
    org_category = CASE
        WHEN s.raw_org_category IS NULL OR trim(s.raw_org_category) = '' THEN d.org_category
        ELSE s.raw_org_category
    END,
    subject_no = CASE
        WHEN (d.subject_no IS NULL OR trim(d.subject_no) = '')
             AND s.raw_subject_no IS NOT NULL AND trim(s.raw_subject_no) <> ''
             THEN s.raw_subject_no
        ELSE d.subject_no
    END,
    subject_no_type = CASE
        WHEN (d.subject_no_type IS NULL OR trim(d.subject_no_type) = '')
             AND s.raw_subject_no_type IS NOT NULL AND trim(s.raw_subject_no_type) <> ''
             THEN s.raw_subject_no_type
        ELSE d.subject_no_type
    END,
    last_import_batch_id = COALESCE(s.import_batch_id, d.last_import_batch_id),
    last_import_session_id = COALESCE(s.import_session_id, d.last_import_session_id),
    source_status = CASE
        WHEN d.first_source_system IS NULL THEN 'single'
        WHEN d.first_source_system = s.source_system THEN d.source_status
        WHEN d.source_status = 'conflict' THEN 'conflict'
        ELSE 'merged'
    END,
    updated_at = CURRENT_TIMESTAMP
FROM dim_subject_source_record s
WHERE s.match_status = 'matched'
  AND s.source_system = 'external'
  AND s.subject_id = d.subject_id;

-- ----------------------------------------------------------------------------
-- 9) 收尾质检
-- ----------------------------------------------------------------------------
-- 9.1 批次匹配分布
SELECT import_batch_id, match_status, COUNT(*) AS cnt
FROM dim_subject_source_record
WHERE source_system = 'external'
GROUP BY import_batch_id, match_status
ORDER BY import_batch_id, match_status;

-- 9.2 冲突清单
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
