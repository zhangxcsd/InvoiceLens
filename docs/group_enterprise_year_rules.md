# dim_group_enterprise_year 口径与校验规则

本文档用于约束 `dim_group_enterprise_year` 的年度组织关系口径，便于后续核对与迭代。

## 1. 表定位

- 表名：`dim_group_enterprise_year`
- 语义：按年度沉淀企业在管理树与产权树中的归属结果
- 主键：`(stat_year, enterprise_id)`
- 业务锚点：`level1_group_id / level1_group_name` 表示一级企业集团（level=1）

## 0. 企业维度前置规则（与 dim_enterprise 对齐）

- 企业全量维表：`dim_enterprise`（定义于 `config/ddl/dim.sql`）
- 企业来源：仅从发票主表销方/购方抽取，不从发票明细侧抽取
- 入库前置条件：`taxpayer_id` 非空；无税号企业不入库
- 批次追溯字段：仅保留 `first_seen_batch_id / last_seen_batch_id`
- 推荐脚本：`scripts/upsert_dim_enterprise_from_header.sql`（支持单批次或全量 MERGE）

## 2. 层级定义

- `mgmt_level` / `equity_level` 统一采用 0 基层级
- `level=0`：树根层（可用于“省属企业”等顶层规则）
- `level=1`：一级企业集团层（与 `level1_group_*` 对齐）
- `level>=2`：一级集团下的下属层级

## 3. Parent 自指策略（强约束）

为保证 `parent` 永不为空并兼容多规则，采用如下约束：

1. `level in (0, 1)`：`parent_id` 必须自指（`parent_id = enterprise_id`）
2. `level >= 2`：`parent_id` 必须指向上级且不可自指（`parent_id <> enterprise_id`）

对应字段：

- 管理树：`mgmt_parent_enterprise_id`
- 产权树：`equity_parent_enterprise_id`

## 4. 树根字段说明

- 管理树根：`mgmt_root_enterprise_id / mgmt_root_enterprise_name`
- 产权树根：`equity_root_enterprise_id / equity_root_enterprise_name`

说明：

- `*_root_*` 用于标识各口径拓扑根；与 `level1_group_*` 允许不完全相同
- 当集团治理口径存在托管、代管或多树并行时，此差异是允许的

## 5. 状态与治理字段

- 管理状态：`mgmt_status`
- 产权状态：`equity_status`
- 质量字段：`quality_status`, `quality_issue`
- 版本字段：`version_no`, `calc_version`, `etl_batch_id`, `as_of_date`

建议状态枚举：

- `active`：有效
- `inactive`：无效/退出
- `pending`：待确认
- `conflict`：存在冲突待处理

## 6. 核对建议

每次年度数据入库后建议执行以下核对：

1. `level in (0,1)` 是否全部满足 parent 自指
2. `level >= 2` 是否存在 parent 自指异常
3. `level1_group_*` 是否均对应 level=1 业务锚点
4. `quality_status='conflict'` 的记录是否已复核

## 7. 初始化与核对 SQL 模板（DuckDB）

以下 SQL 可按年度替换 `{{stat_year}}` 后执行。

一键汇总核对（推荐）：修改 `scripts/check_group_enterprise_year.sql` 顶部 `params.stat_year` 后执行该文件，可一次输出各检查项违规行数。

### 7.1 年度基础插入（模板）

> 说明：此模板用于演示最小落库字段，实际项目请替换为你的来源表与口径逻辑。

```sql
INSERT INTO dim_group_enterprise_year (
    stat_year,
    enterprise_id,
    enterprise_name,
    is_member,
    level1_group_id,
    level1_group_name,
    mgmt_root_enterprise_id,
    mgmt_root_enterprise_name,
    mgmt_status,
    mgmt_parent_enterprise_id,
    mgmt_parent_enterprise_name,
    mgmt_level,
    equity_root_enterprise_id,
    equity_root_enterprise_name,
    equity_status,
    equity_parent_enterprise_id,
    equity_parent_enterprise_name,
    equity_level,
    as_of_date,
    version_no,
    calc_version,
    etl_batch_id,
    data_source,
    source_record_id,
    quality_status,
    quality_issue
)
SELECT
    {{stat_year}} AS stat_year,
    s.enterprise_id,
    s.enterprise_name,
    TRUE AS is_member,
    s.level1_group_id,
    s.level1_group_name,
    s.mgmt_root_enterprise_id,
    s.mgmt_root_enterprise_name,
    s.mgmt_status,
    s.mgmt_parent_enterprise_id,
    s.mgmt_parent_enterprise_name,
    s.mgmt_level,
    s.equity_root_enterprise_id,
    s.equity_root_enterprise_name,
    s.equity_status,
    s.equity_parent_enterprise_id,
    s.equity_parent_enterprise_name,
    s.equity_level,
    CURRENT_DATE AS as_of_date,
    1 AS version_no,
    'v1' AS calc_version,
    'manual_init' AS etl_batch_id,
    'import_template' AS data_source,
    s.source_record_id,
    'active' AS quality_status,
    NULL AS quality_issue
FROM your_source_table s
WHERE s.stat_year = {{stat_year}};
```

### 7.2 自指规则核对（应返回 0 行）

```sql
-- 管理树：level=0/1 必须自指；level>=2 禁止自指
SELECT *
FROM dim_group_enterprise_year t
WHERE t.stat_year = {{stat_year}}
  AND (
      (t.mgmt_level IN (0, 1) AND t.mgmt_parent_enterprise_id <> t.enterprise_id)
      OR (t.mgmt_level >= 2 AND t.mgmt_parent_enterprise_id = t.enterprise_id)
  );
```

```sql
-- 产权树：level=0/1 必须自指；level>=2 禁止自指
SELECT *
FROM dim_group_enterprise_year t
WHERE t.stat_year = {{stat_year}}
  AND (
      (t.equity_level IN (0, 1) AND t.equity_parent_enterprise_id <> t.enterprise_id)
      OR (t.equity_level >= 2 AND t.equity_parent_enterprise_id = t.enterprise_id)
  );
```

### 7.3 一级集团锚点核对（应返回 0 行）

```sql
-- 要求：level1_group_id 对应的企业在当年必须存在，且 mgmt_level=1
SELECT t.*
FROM dim_group_enterprise_year t
LEFT JOIN dim_group_enterprise_year g
       ON g.stat_year = t.stat_year
      AND g.enterprise_id = t.level1_group_id
WHERE t.stat_year = {{stat_year}}
  AND (g.enterprise_id IS NULL OR g.mgmt_level <> 1);
```

### 7.4 上级节点存在性核对（应返回 0 行）

```sql
-- 管理树：level>=2 的 parent 必须存在于同年度
SELECT t.*
FROM dim_group_enterprise_year t
LEFT JOIN dim_group_enterprise_year p
       ON p.stat_year = t.stat_year
      AND p.enterprise_id = t.mgmt_parent_enterprise_id
WHERE t.stat_year = {{stat_year}}
  AND t.mgmt_level >= 2
  AND p.enterprise_id IS NULL;
```

```sql
-- 产权树：level>=2 的 parent 必须存在于同年度
SELECT t.*
FROM dim_group_enterprise_year t
LEFT JOIN dim_group_enterprise_year p
       ON p.stat_year = t.stat_year
      AND p.enterprise_id = t.equity_parent_enterprise_id
WHERE t.stat_year = {{stat_year}}
  AND t.equity_level >= 2
  AND p.enterprise_id IS NULL;
```

### 7.5 冲突记录清单（人工复核）

```sql
SELECT *
FROM dim_group_enterprise_year
WHERE stat_year = {{stat_year}}
  AND quality_status = 'conflict'
ORDER BY enterprise_id;
```
