-- check_group_enterprise_year.sql
-- 用途：对 dim_group_enterprise_year 做一次年度口径核对，输出各检查项违规行数。
-- 环境：DuckDB（与项目 config/ddl/dim.sql 一致）
-- 规则说明：docs/group_enterprise_year_rules.md
--
-- 使用：修改下方 WITH params 中的 stat_year，然后在仓库根目录执行例如：
--   duckdb data/warehouse.duckdb -f scripts/check_group_enterprise_year.sql
-- 期望：除 row_count 外，各 check_id 的 violation_cnt 均为 0。

WITH params AS (
    SELECT CAST(2024 AS SMALLINT) AS stat_year
),

p AS (
    SELECT stat_year FROM params
),

row_count AS (
    SELECT
        'row_count'::VARCHAR AS check_id,
        '当年 dim_group_enterprise_year 行数'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    WHERE t.stat_year = p.stat_year
),

mgmt_self_ref AS (
    SELECT
        'mgmt_self_ref'::VARCHAR AS check_id,
        '管理树：level=0/1 须自指 parent；level>=2 禁止自指'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    WHERE t.stat_year = p.stat_year
      AND (
          (t.mgmt_level IN (0, 1) AND t.mgmt_parent_enterprise_id <> t.enterprise_id)
          OR (t.mgmt_level >= 2 AND t.mgmt_parent_enterprise_id = t.enterprise_id)
      )
),

equity_self_ref AS (
    SELECT
        'equity_self_ref'::VARCHAR AS check_id,
        '产权树：level=0/1 须自指 parent；level>=2 禁止自指'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    WHERE t.stat_year = p.stat_year
      AND (
          (t.equity_level IN (0, 1) AND t.equity_parent_enterprise_id <> t.enterprise_id)
          OR (t.equity_level >= 2 AND t.equity_parent_enterprise_id = t.enterprise_id)
      )
),

level1_anchor AS (
    SELECT
        'level1_group_anchor'::VARCHAR AS check_id,
        'level1_group_id 须在当年存在且 mgmt_level=1'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    LEFT JOIN dim_group_enterprise_year g
           ON g.stat_year = t.stat_year
          AND g.enterprise_id = t.level1_group_id
    WHERE t.stat_year = p.stat_year
      AND (g.enterprise_id IS NULL OR g.mgmt_level <> 1)
),

mgmt_parent_exists AS (
    SELECT
        'mgmt_parent_exists'::VARCHAR AS check_id,
        '管理树：level>=2 时 mgmt_parent 须在同年表中存在'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    LEFT JOIN dim_group_enterprise_year pnode
           ON pnode.stat_year = t.stat_year
          AND pnode.enterprise_id = t.mgmt_parent_enterprise_id
    WHERE t.stat_year = p.stat_year
      AND t.mgmt_level >= 2
      AND pnode.enterprise_id IS NULL
),

equity_parent_exists AS (
    SELECT
        'equity_parent_exists'::VARCHAR AS check_id,
        '产权树：level>=2 时 equity_parent 须在同年表中存在'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    LEFT JOIN dim_group_enterprise_year pnode
           ON pnode.stat_year = t.stat_year
          AND pnode.enterprise_id = t.equity_parent_enterprise_id
    WHERE t.stat_year = p.stat_year
      AND t.equity_level >= 2
      AND pnode.enterprise_id IS NULL
),

conflict_rows AS (
    SELECT
        'quality_conflict'::VARCHAR AS check_id,
        'quality_status=conflict 待人工复核行数'::VARCHAR AS description,
        COUNT(*)::BIGINT AS violation_cnt
    FROM dim_group_enterprise_year t
    CROSS JOIN p
    WHERE t.stat_year = p.stat_year
      AND t.quality_status = 'conflict'
)

SELECT check_id, description, violation_cnt FROM row_count
UNION ALL SELECT check_id, description, violation_cnt FROM mgmt_self_ref
UNION ALL SELECT check_id, description, violation_cnt FROM equity_self_ref
UNION ALL SELECT check_id, description, violation_cnt FROM level1_anchor
UNION ALL SELECT check_id, description, violation_cnt FROM mgmt_parent_exists
UNION ALL SELECT check_id, description, violation_cnt FROM equity_parent_exists
UNION ALL SELECT check_id, description, violation_cnt FROM conflict_rows
ORDER BY
    CASE check_id
        WHEN 'row_count' THEN 0
        WHEN 'mgmt_self_ref' THEN 1
        WHEN 'equity_self_ref' THEN 2
        WHEN 'level1_group_anchor' THEN 3
        WHEN 'mgmt_parent_exists' THEN 4
        WHEN 'equity_parent_exists' THEN 5
        WHEN 'quality_conflict' THEN 6
        ELSE 99
    END;
