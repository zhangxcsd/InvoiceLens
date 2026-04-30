# dim_enterprise_year_rel 回填运行手册（Runbook）

本文用于指导 `dim_enterprise_year_rel` 的生产/准生产回填执行，适用于：

- 单年回填（如仅重算 2026）
- 按批次区间回填（如补导一段历史批次）

> 说明：SQL 模板与表结构基于 `config/ddl/dim.sql` 中 `dim_enterprise_year_rel` 及相关视图。

---

## 1. 执行前准备

- 明确本次范围：
  - 单年：`target_year`
  - 区间：`batch_from`、`batch_to`
- 约定本次标识：
  - `relation_build_run_id`（例如 `RUN_YEAR_2026_20260430`）
  - `relation_snapshot_id`（例如 `SNAP_YEAR_2026_20260430`）
- 确认维护窗口（避免与大批量导入/重算任务冲突）。

---

## 2. 标准执行顺序（Checklist）

1. **备份目标表**
2. **预检聚合结果（不写入正式表）**
3. **执行回填 Upsert**
4. **执行验收 SQL**
5. **前端抽样验证**
6. **留痕归档（参数、行数、截图、耗时）**
7. **异常时按回滚预案处理**

---

## 3. 备份 SQL（必须）

```sql
-- 建议在执行前先做一次快照备份
CREATE TABLE IF NOT EXISTS bak_dim_enterprise_year_rel_20260430_1500 AS
SELECT * FROM dim_enterprise_year_rel;
```

> 备份表名建议带时间戳，便于快速回滚与审计追溯。

---

## 4. 预检 SQL（不写正式表）

### 4.1 单年预检

```sql
-- 参数示例：target_year = 2026
CREATE OR REPLACE TABLE tmp_year_agg_preview AS
WITH dwd_subject_union AS (
    SELECT
        h.stat_year,
        TRIM(h.xfsbh) AS subject_no,
        'seller' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE h.stat_year = 2026
      AND TRIM(COALESCE(h.xfsbh, '')) <> ''

    UNION ALL

    SELECT
        h.stat_year,
        TRIM(h.gfsbh) AS subject_no,
        'buyer' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE h.stat_year = 2026
      AND TRIM(COALESCE(h.gfsbh, '')) <> ''
)
SELECT
    m.subject_id,
    u.stat_year,
    BOOL_OR(u.role_tag = 'seller') AS has_seller_role,
    BOOL_OR(u.role_tag = 'buyer')  AS has_buyer_role,
    COUNT(*) AS invoice_count,
    SUM(u.amount_jshj) AS amount_jshj_sum,
    MIN(u.invoice_date) AS year_first_seen_date,
    MAX(u.invoice_date) AS year_last_seen_date,
    MIN(u.import_batch_id) AS year_first_seen_batch_id,
    MAX(u.import_batch_id) AS year_last_seen_batch_id,
    MIN(u.import_session_id) AS year_first_seen_session_id,
    MAX(u.import_session_id) AS year_last_seen_session_id
FROM dwd_subject_union u
JOIN dim_subject_master m
  ON m.subject_no = u.subject_no
 AND m.subject_category = 'org'
GROUP BY m.subject_id, u.stat_year;
```

### 4.2 预检检查项

```sql
-- 行数检查
SELECT COUNT(*) AS preview_rows FROM tmp_year_agg_preview;

-- 角色分布检查
SELECT
  CASE
    WHEN has_seller_role AND has_buyer_role THEN 'both'
    WHEN has_seller_role THEN 'seller'
    WHEN has_buyer_role THEN 'buyer'
    ELSE 'unknown'
  END AS role_tag,
  COUNT(*) AS cnt
FROM tmp_year_agg_preview
GROUP BY 1
ORDER BY cnt DESC;

-- 日期范围检查
SELECT MIN(year_first_seen_date), MAX(year_last_seen_date)
FROM tmp_year_agg_preview;
```

---

## 5. 回填 SQL（Upsert）

> 以下给单年示例。批次区间回填可直接使用 `config/ddl/dim.sql` 里的“变体模板 2”。

```sql
INSERT INTO dim_enterprise_year_rel (
    subject_id,
    stat_year,
    year_role_tag,
    has_seller_role,
    has_buyer_role,
    year_first_seen_batch_id,
    year_last_seen_batch_id,
    year_first_seen_session_id,
    year_last_seen_session_id,
    year_first_seen_date,
    year_last_seen_date,
    invoice_count,
    amount_jshj_sum,
    relation_build_run_id,
    relation_snapshot_id,
    quality_status,
    quality_issue,
    updated_at
)
SELECT
    subject_id,
    stat_year,
    CASE
        WHEN has_seller_role AND has_buyer_role THEN 'both'
        WHEN has_seller_role THEN 'seller'
        WHEN has_buyer_role THEN 'buyer'
        ELSE 'unknown'
    END AS year_role_tag,
    has_seller_role,
    has_buyer_role,
    year_first_seen_batch_id,
    year_last_seen_batch_id,
    year_first_seen_session_id,
    year_last_seen_session_id,
    year_first_seen_date,
    year_last_seen_date,
    invoice_count,
    amount_jshj_sum,
    'RUN_YEAR_2026_20260430' AS relation_build_run_id,
    'SNAP_YEAR_2026_20260430' AS relation_snapshot_id,
    'ok' AS quality_status,
    NULL AS quality_issue,
    CURRENT_TIMESTAMP AS updated_at
FROM tmp_year_agg_preview
ON CONFLICT (subject_id, stat_year) DO UPDATE SET
    year_role_tag = EXCLUDED.year_role_tag,
    has_seller_role = EXCLUDED.has_seller_role,
    has_buyer_role = EXCLUDED.has_buyer_role,
    year_first_seen_batch_id = EXCLUDED.year_first_seen_batch_id,
    year_last_seen_batch_id = EXCLUDED.year_last_seen_batch_id,
    year_first_seen_session_id = EXCLUDED.year_first_seen_session_id,
    year_last_seen_session_id = EXCLUDED.year_last_seen_session_id,
    year_first_seen_date = EXCLUDED.year_first_seen_date,
    year_last_seen_date = EXCLUDED.year_last_seen_date,
    invoice_count = EXCLUDED.invoice_count,
    amount_jshj_sum = EXCLUDED.amount_jshj_sum,
    relation_build_run_id = EXCLUDED.relation_build_run_id,
    relation_snapshot_id = EXCLUDED.relation_snapshot_id,
    quality_status = EXCLUDED.quality_status,
    quality_issue = EXCLUDED.quality_issue,
    updated_at = CURRENT_TIMESTAMP;
```

---

## 6. 验收 SQL（必须执行）

```sql
-- 1) 年度覆盖检查
SELECT stat_year, COUNT(*) AS enterprise_count
FROM dim_enterprise_year_rel
GROUP BY stat_year
ORDER BY stat_year DESC;

-- 2) 角色分布检查
SELECT stat_year, year_role_tag, COUNT(*) AS cnt
FROM dim_enterprise_year_rel
GROUP BY stat_year, year_role_tag
ORDER BY stat_year DESC, year_role_tag;

-- 3) 汇总视图一致性
SELECT * FROM v_enterprise_year_summary ORDER BY stat_year DESC;

-- 4) 随机抽样核对（示例）
SELECT *
FROM dim_enterprise_year_rel
WHERE stat_year = 2026
ORDER BY RANDOM()
LIMIT 20;
```

---

## 7. 回滚预案（失败时）

```sql
-- 方案 A：整表回滚（最快）
DELETE FROM dim_enterprise_year_rel;
INSERT INTO dim_enterprise_year_rel
SELECT * FROM bak_dim_enterprise_year_rel_20260430_1500;

-- 方案 B：按年度回滚（若只改了单年）
DELETE FROM dim_enterprise_year_rel WHERE stat_year = 2026;
INSERT INTO dim_enterprise_year_rel
SELECT *
FROM bak_dim_enterprise_year_rel_20260430_1500
WHERE stat_year = 2026;
```

---

## 8. 执行留痕模板（建议）

- 执行人：
- 执行时间：
- 目标范围（年度/批次）：
- `relation_build_run_id`：
- `relation_snapshot_id`：
- 预检行数：
- Upsert 影响行数：
- 验收结论：
- 是否回滚：
- 备注：

