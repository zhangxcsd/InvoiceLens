-- check_enterprise_year_roster_consistency.sql
-- 用途：核对花名册、年度关系表与报送覆盖视图口径是否一致（DuckDB）。
-- 环境：config/ddl/dim.sql 中 dim_enterprise_year_roster / dim_enterprise_year_rel / vw_audit_invoice_coverage_*
-- 维护规则：docs/dim_enterprise_year_roster_policy.md（来源 in_registry/in_manual 落地后见该文档 §8.2 扩展 SQL）
--
-- 使用：修改 params.stat_year，在仓库根目录执行例如：
--   duckdb data/database/warehouse.duckdb -f scripts/check_enterprise_year_roster_consistency.sql
-- 期望：除 row_count 外，各 check_id 的 violation_cnt 均为 0（或仅预期内的 quality 差异）。

WITH params AS (
    SELECT CAST(2024 AS SMALLINT) AS stat_year
),

p AS (
    SELECT stat_year FROM params
),

-- 花名册行数
roster_row_count AS (
    SELECT
        'roster_row_count'::VARCHAR AS check_id,
        '当年 dim_enterprise_year_roster 行数'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_enterprise_year_roster ro
    CROSS JOIN p
    WHERE ro.stat_year = p.stat_year
),

-- 年度关系：花名册成员税号应对应有 rel 行（映射到 org 主体后）
roster_member_missing_rel AS (
    SELECT
        'roster_member_missing_rel'::VARCHAR AS check_id,
        '花名册成员已映射 org 但 dim_enterprise_year_rel 缺行'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM vw_audit_invoice_coverage_group_member v
    CROSS JOIN p
    WHERE v.stat_year = p.stat_year
      AND v.in_coverage_denominator
      AND v.subject_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM dim_enterprise_year_rel r
          WHERE r.subject_id = v.subject_id
            AND r.stat_year = v.stat_year
      )
),

-- 年度关系：rel 行不应出现在花名册成员集合之外（同 subject_id + stat_year）
rel_outside_roster AS (
    SELECT
        'rel_outside_roster'::VARCHAR AS check_id,
        'dim_enterprise_year_rel 存在但不在当年花名册成员集合'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_enterprise_year_rel r
    CROSS JOIN p
    WHERE r.stat_year = p.stat_year
      AND NOT EXISTS (
          SELECT 1
          FROM dim_enterprise_year_roster ro
          INNER JOIN dim_subject_master m
              ON m.subject_category = 'org'
             AND upper(regexp_replace(trim(COALESCE(m.subject_no, '')), '[\s-]+', '', 'g'))
               = upper(regexp_replace(trim(COALESCE(ro.enterprise_id, '')), '[\s-]+', '', 'g'))
          WHERE ro.stat_year = p.stat_year
            AND m.subject_id = r.subject_id
      )
),

-- 覆盖视图：分母成员数应等于 in_coverage_denominator 计数
coverage_denominator_mismatch AS (
    SELECT
        'coverage_denominator_mismatch'::VARCHAR AS check_id,
        'vw_audit_invoice_coverage_soe_year 分母与明细 in_coverage_denominator 不一致'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM (
        SELECT
            s.stat_year,
            s.soe_anchor_enterprise_id,
            s.denominator_mapped_members AS agg_cnt,
            (
                SELECT COUNT(*)::BIGINT
                FROM vw_audit_invoice_coverage_group_member d
                WHERE d.stat_year = s.stat_year
                  AND d.soe_anchor_enterprise_id IS NOT DISTINCT FROM s.soe_anchor_enterprise_id
                  AND d.in_coverage_denominator
            ) AS detail_cnt
        FROM vw_audit_invoice_coverage_soe_year s
        CROSS JOIN p
        WHERE s.stat_year = p.stat_year
    ) x
    WHERE x.agg_cnt IS DISTINCT FROM x.detail_cnt
),

-- 花名册 quality conflict 计数（信息项，非硬违规）
roster_conflict_count AS (
    SELECT
        'roster_quality_conflict'::VARCHAR AS check_id,
        '花名册 quality_status=conflict 行数（需人工维护国家出资企业）'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_enterprise_year_roster ro
    CROSS JOIN p
    WHERE ro.stat_year = p.stat_year
      AND ro.quality_status = 'conflict'
),

orphan_no_source AS (
    SELECT
        'orphan_no_source'::VARCHAR AS check_id,
        '无 in_registry/in_manual 来源标识'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_enterprise_year_roster ro
    CROSS JOIN p
    WHERE ro.stat_year = p.stat_year
      AND NOT COALESCE(ro.in_registry, FALSE)
      AND NOT COALESCE(ro.in_manual, FALSE)
),

data_source_mismatch AS (
    SELECT
        'data_source_mismatch'::VARCHAR AS check_id,
        'data_source 与 in_registry/in_manual 不一致'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_enterprise_year_roster ro
    CROSS JOIN p
    WHERE ro.stat_year = p.stat_year
      AND ro.data_source IS DISTINCT FROM (
          CASE
              WHEN COALESCE(ro.in_registry, FALSE) AND COALESCE(ro.in_manual, FALSE) THEN 'registry+manual'
              WHEN COALESCE(ro.in_registry, FALSE) THEN 'registry'
              WHEN COALESCE(ro.in_manual, FALSE) THEN 'manual'
              ELSE NULL
          END
      )
),

manual_only_with_registry_id AS (
    SELECT
        'manual_only_with_registry_id'::VARCHAR AS check_id,
        '仅人工行不应带 registry_row_id'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_enterprise_year_roster ro
    CROSS JOIN p
    WHERE ro.stat_year = p.stat_year
      AND COALESCE(ro.in_manual, FALSE)
      AND NOT COALESCE(ro.in_registry, FALSE)
      AND trim(COALESCE(ro.registry_row_id, '')) <> ''
)

SELECT * FROM roster_row_count
UNION ALL SELECT * FROM roster_member_missing_rel
UNION ALL SELECT * FROM rel_outside_roster
UNION ALL SELECT * FROM coverage_denominator_mismatch
UNION ALL SELECT * FROM roster_conflict_count
UNION ALL SELECT * FROM orphan_no_source
UNION ALL SELECT * FROM data_source_mismatch
UNION ALL SELECT * FROM manual_only_with_registry_id
ORDER BY check_id;
