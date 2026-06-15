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

### 4.0 重要：与「发票报送覆盖分析」已报送口径对齐

`vw_audit_invoice_coverage_group_member` 中「已报送」只看 **`dim_enterprise_year_rel`** 的 `has_seller_role` / `has_buyer_role`，**不直接扫 `dwd_inv_header`**。

**重算任务口径（与 Python `rebuild_dim_enterprise_year_rel` 一致）**：`dim_enterprise_year_rel` **仅写入**「当年 `dim_enterprise_year_roster` 花名册成员」且能映射到 org 主体的 `subject_id`；目标年度为 **DWD 发票统计年度 ∪ 花名册年度** 的并集。不在花名册中的 org 主体不会出现在本表（即使 DWD 中有其发票）。

> 花名册成员范围、台账同步与人工维护合并规则见 **`docs/dim_enterprise_year_roster_policy.md`**。手工增删改或复制花名册后，须对目标年度重算本表并与覆盖视图验收。

因此即使 DWD 里该企业同年既有销方行又有购方行，只要出现下面任一情况，页面仍不会进「已报送」：

- **`dim_enterprise_year_rel` 缺行或角色未更新**（未按年回填 / 回填脚本过旧）。
- **回填时主体关联与覆盖视图不一致**：旧版预检用 `m.subject_no = TRIM(发票税号)` 精确匹配；而主体库发票归集与覆盖视图使用 **规范化税号**（`upper` + 去空白与连字符，见 `vw_audit_invoice_coverage_group_member` 与 `ingest_dim_subject_master_from_dwd`）。发票侧为小写、带空格/短横线、与主表 `subject_no` 字面不一致时，**预检 JOIN 挂不上主体 → 年度关系表没有该行 → 页面永远不算已报送**。
- **同一规范化税号对应多条 `org` 主体行**：覆盖视图按 `norm_no` 去重只保留 `ROW_NUMBER(... ORDER BY subject_id)=1` 的那条；若 `dim_enterprise_year_rel` 写在**另一条** `subject_id` 上，则视图左连接 `r.subject_id = m.subject_id` 对不上，购销标志仍为假。

**以下 4.1 预检与加工中心重算 SQL 一致**：以 **当年花名册成员（dim_enterprise_year_roster）** 为行集合，规范化税号 + org 去重后 **LEFT JOIN** `dwd_inv_header`；若你曾用「全量 org × 发票」或旧版 `dim_group_enterprise_year` 预检灌过库，请对目标年度 **DELETE 后按新预检重新 Upsert**（见 §5）。

### 4.1 单年预检

```sql
-- 参数：将三处 2026 改为目标统计年度（如 2025）
CREATE OR REPLACE TABLE tmp_year_agg_preview AS
WITH group_member_norm AS (
    SELECT DISTINCT
        CAST(stat_year AS SMALLINT) AS stat_year,
        upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\s-]+', '', 'g')) AS norm_no
    FROM dim_enterprise_year_roster
    WHERE stat_year = 2026
      AND trim(COALESCE(enterprise_id, '')) <> ''
      AND length(upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\s-]+', '', 'g'))) > 0
),
org_subject_ranked AS (
    SELECT
        subject_id,
        subject_no,
        upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\s-]+', '', 'g')) AS norm_no,
        ROW_NUMBER() OVER (
            PARTITION BY upper(regexp_replace(trim(COALESCE(subject_no, '')), '[\s-]+', '', 'g'))
            ORDER BY subject_id
        ) AS rn
    FROM dim_subject_master
    WHERE subject_category = 'org'
      AND trim(COALESCE(subject_no, '')) <> ''
),
org_subject_dedup AS (
    SELECT subject_id, subject_no, norm_no
    FROM org_subject_ranked
    WHERE rn = 1
),
group_member_subjects AS (
    SELECT DISTINCT
        gm.stat_year,
        m.subject_id,
        m.norm_no
    FROM group_member_norm gm
    INNER JOIN org_subject_dedup m ON m.norm_no = gm.norm_no
),
dwd_subject_union AS (
    SELECT
        h.stat_year,
        TRIM(h.xfsbh) AS subject_no_raw,
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
        TRIM(h.gfsbh) AS subject_no_raw,
        'buyer' AS role_tag,
        h.import_batch_id,
        h.import_session_id,
        h.invoice_date,
        COALESCE(h.jshj, 0) AS amount_jshj
    FROM dwd_inv_header h
    WHERE h.stat_year = 2026
      AND TRIM(COALESCE(h.gfsbh, '')) <> ''
),
normed_union AS (
    SELECT
        *,
        upper(regexp_replace(trim(COALESCE(subject_no_raw, '')), '[\s-]+', '', 'g')) AS norm_no
    FROM dwd_subject_union
)
SELECT
    gms.subject_id,
    gms.stat_year,
    COALESCE(BOOL_OR(u.role_tag = 'seller'), FALSE) AS has_seller_role,
    COALESCE(BOOL_OR(u.role_tag = 'buyer'), FALSE) AS has_buyer_role,
    COALESCE(COUNT(u.role_tag), 0)::BIGINT AS invoice_count,
    COALESCE(SUM(u.amount_jshj), 0) AS amount_jshj_sum,
    MIN(u.invoice_date) AS year_first_seen_date,
    MAX(u.invoice_date) AS year_last_seen_date,
    MIN(u.import_batch_id) AS year_first_seen_batch_id,
    MAX(u.import_batch_id) AS year_last_seen_batch_id,
    MIN(u.import_session_id) AS year_first_seen_session_id,
    MAX(u.import_session_id) AS year_last_seen_session_id
FROM group_member_subjects gms
LEFT JOIN normed_union u
    ON CAST(u.stat_year AS INTEGER) = CAST(gms.stat_year AS INTEGER)
   AND u.norm_no = gms.norm_no
   AND length(u.norm_no) > 0
GROUP BY gms.subject_id, gms.stat_year;
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

---

## 9. 程序化重算（本地 API / CLI）

与 Runbook §4.1 口径一致，便于导入编排或运维脚本显式触发。

**任务码（编排配置可引用）：** `dim.enterprise_year_rel.rebuild`

| 方式 | 说明 |
|------|------|
| `GET /api/dim/enterprise-year-rel/meta` | 只读：DWD 中出现的 `stat_year` 列表、`dim_enterprise_year_rel` 按年行数 |
| `POST /api/dim/enterprise-year-rel/rebuild` | JSON：`stat_years` 可选（数组或 `"2024,2025"`；省略则对 DWD 全部年度）、`dry_run`（布尔）、`run_id` / `relation_snapshot_id` 可选 |
| `POST /api/dwd/build` | JSON 增加 `rebuild_enterprise_year_rel: true`：在 **本次 DWD 构建成功** 后，按返回的 `stat_years_built` 自动重算；结果在 `enterprise_year_rel_rebuild` |
| `python scripts/rebuild_enterprise_year_rel.py --years 2024,2025` | 直连 DuckDB 重算（`--all` = DWD∪台账年度；`--dry-run`、`--db` 见 `--help`） |

前端封装：`frontend/src/config/localApi.ts` 中 `postDimEnterpriseYearRelRebuild`、`fetchDimEnterpriseYearRelMeta`、`postDwdBuild({ ..., rebuild_enterprise_year_rel: true })`。
