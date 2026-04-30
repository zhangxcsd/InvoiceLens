# 主体库字段优先级策略模板

适用对象：
- `dim_subject_master`
- 来源：`invoice` / `external` / `manual`

目标：
- 明确“同一字段多来源冲突”时如何覆盖；
- 保证主表更新稳定、可解释、可追溯。

---

## 1. 总体原则

- **主体身份优先稳定**：`subject_id` 一旦建立，不因来源变化重建。
- **字段级而非整行级覆盖**：每个字段单独定义优先级，避免“强来源把弱字段也覆盖掉”。
- **质量优先于来源**：同来源时优先选择质量更高、更新更晚的数据。
- **冲突可追溯**：冲突时保留 `dim_subject_source_record` 证据，不在主表静默覆盖。

---

## 2. 来源优先级（默认）

- `manual` > `external` > `invoice`

说明：
- `manual` 代表人工确认/主数据维护，可信度最高；
- `external` 通常是治理侧导入数据，结构化程度高于票面抽取；
- `invoice` 作为交易侧原始来源，覆盖广但字段噪声较大。

---

## 3. 字段级优先级矩阵（建议初版）

| 字段 | 覆盖策略 | 备注 |
|---|---|---|
| `subject_name` | `manual > external > invoice`，且仅在新值非空时覆盖 | 主展示名 |
| `subject_name_std` | 由 `subject_name` 规范化生成；不单独接收来源值 | 保持一致性 |
| `subject_category` | 仅 `manual` 可改；`external/invoice` 仅补空 | 防止 org/person 抖动 |
| `org_category` | `manual > external`；`invoice` 不覆盖 | 票面一般无可靠机构类别 |
| `subject_no` | 仅在当前为空时补值；冲突时进入 `conflict` | 标识号冲突风险高 |
| `subject_no_type` | 与 `subject_no` 同步更新 | 保持配对 |
| `last_import_batch_id` | 总是更新为最新导入批次 | 时间序更新 |
| `source_status` | 若出现第二来源则置为 `merged` | 反映来源融合 |
| `quality_status/issue` | 由质检流程更新，不在普通覆盖中改写 | 与业务覆盖解耦 |

> 说明：你当前阶段只关注名称、机构类别、主体类别，可先严格执行这三项策略。

---

## 4. 冲突判定规则（建议）

- **强冲突（必须人工）**
  - 同一 `subject_id` 出现不同 `subject_no`（且均非空）
  - `subject_category` 在 `org/person` 之间来回切换
- **弱冲突（可自动）**
  - 名称不同但标识号一致（可按来源优先级自动覆盖，原值留痕）
  - 机构类别不同（按来源优先级覆盖）

冲突落地建议：
- `dim_subject_source_record.match_status = 'conflict'`
- `dim_subject_master.source_status = 'conflict'`
- `quality_status = 'warning'`，`quality_issue` 写明冲突类型

---

## 5. SQL 覆盖模板（可直接改造）

```sql
-- 假设：s 为来源记录（已 matched），d 为主体主表
UPDATE dim_subject_master d
SET
    -- 1) subject_name：按来源优先级覆盖（仅新值非空）
    subject_name = CASE
        WHEN s.raw_subject_name IS NULL OR trim(s.raw_subject_name) = '' THEN d.subject_name
        WHEN s.source_system = 'manual' THEN s.raw_subject_name
        WHEN s.source_system = 'external' AND COALESCE(d.first_source_system, '') <> 'manual' THEN s.raw_subject_name
        WHEN s.source_system = 'invoice'
             AND COALESCE(d.first_source_system, '') NOT IN ('manual', 'external')
             THEN s.raw_subject_name
        ELSE d.subject_name
    END,

    -- 2) subject_name_std：始终由最终 subject_name 规范化得到
    subject_name_std = lower(trim(
        CASE
            WHEN s.raw_subject_name IS NULL OR trim(s.raw_subject_name) = '' THEN d.subject_name
            WHEN s.source_system = 'manual' THEN s.raw_subject_name
            WHEN s.source_system = 'external' AND COALESCE(d.first_source_system, '') <> 'manual' THEN s.raw_subject_name
            WHEN s.source_system = 'invoice'
                 AND COALESCE(d.first_source_system, '') NOT IN ('manual', 'external')
                 THEN s.raw_subject_name
            ELSE d.subject_name
        END
    )),

    -- 3) subject_category：仅 manual 可改，其他来源只补空
    subject_category = CASE
        WHEN s.raw_subject_category IS NULL OR trim(s.raw_subject_category) = '' THEN d.subject_category
        WHEN s.source_system = 'manual' THEN s.raw_subject_category
        WHEN d.subject_category IS NULL OR trim(d.subject_category) = '' THEN s.raw_subject_category
        ELSE d.subject_category
    END,

    -- 4) org_category：manual > external；invoice 不覆盖
    org_category = CASE
        WHEN s.raw_org_category IS NULL OR trim(s.raw_org_category) = '' THEN d.org_category
        WHEN s.source_system = 'manual' THEN s.raw_org_category
        WHEN s.source_system = 'external' AND COALESCE(d.first_source_system, '') <> 'manual' THEN s.raw_org_category
        ELSE d.org_category
    END,

    -- 5) subject_no：只补空，禁止自动改写非空旧值
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

    -- 6) 批次与状态
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
  AND s.subject_id = d.subject_id;
```

---

## 6. 最小落地建议（你当前阶段）

- 先启用 3 个字段的优先级：
  - `subject_name`
  - `subject_category`
  - `org_category`
- `subject_no` 采用“只补空不覆盖”
- 强冲突直接进 `conflict`，不自动修复

这样可以在不增加复杂度的前提下，把主表更新行为稳定下来。后续再扩展到更多字段即可。

