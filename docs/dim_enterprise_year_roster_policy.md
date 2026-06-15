# dim_enterprise_year_roster 花名册维护与来源口径

本文档约定 **集团年度成员花名册**（`dim_enterprise_year_roster`）在「台账自动同步 + 人工维护」混合模式下的产品规则、字段合并逻辑与核对方法，供后续开发、验收与运维检查使用。

> **状态说明（2026-06）**：规则已落地；同步为增量合并（不删仅人工行）；人工维护与复制 API 见 `src/local_api/enterprise_year_roster_manual.py`。

---

## 1. 表定位

| 项 | 约定 |
|---|---|
| 表名 | `dim_enterprise_year_roster` |
| 主键 | `(stat_year, enterprise_id)`，`enterprise_id` 为规范化统一社会信用代码 |
| 一行语义 | 某统计年度下，纳入集团成员分析范围的一个企业及其 **国家出资企业归属** |
| 不承载 | 管理/产权树结构（见 `dim_audited_enterprise_registry`、`dim_group_enterprise_year`） |
| 权威消费 | 发票报送覆盖分析、`dim_enterprise_year_rel` 重算、一级名单下属查询等 **均以本表现值为准** |

**一句话口径**：花名册 = 台账同步结果 + 人工补录/纠偏；同步 **只增改、不删人工**；冲突保留人工归类并标待核对，分析仍读花名册。

---

## 2. 两个正交维度：来源 vs 质量

实现与 UI 展示时 **不得混用** 下列两组字段。

### 2.1 来源（Provenance）—「这条成员怎么进花名册的」

| 存储（建议） | 含义 |
|---|---|
| `in_registry` | 台账同步曾写入/更新过该行 |
| `in_manual` | 人工新增、从上年度复制、或人工编辑后仍保留人工意图 |
| `data_source`（展示/冗余） | 由两位组合：`registry` / `manual` / `registry+manual` |

**UI 展示标签（中文）**：

| `data_source` | 展示 |
|---|---|
| `registry` | 台账同步 |
| `manual` | 人工维护 |
| `registry+manual` | 台账 + 人工 |

> 从上年度复制与单条手工新增同属 **人工维护**，不必单独枚举来源码。

### 2.2 质量（Quality）—「内容是否自洽、能否直接用于分析」

| 字段 | 含义 |
|---|---|
| `quality_status` | `ok`：正常；`conflict`：待核对 |
| `quality_issue` | 面向用户的核对说明（如国家出资企业税号未匹配、人工与台账归属不一致） |

**原则**：

- `quality_status=conflict` **不等于** 从成员范围剔除；默认仍计入 KPI 与覆盖分析分母（见 §4.2）。
- 来源为「台账 + 人工」且归属不一致时，必须 `quality_status=conflict`，并在 `quality_issue` 中写明双方归类。

---

## 3. 三条核心产品规则（已拍板）

### 3.1 同步：永不自动删除「仅人工」行

**同步任务**（从 `dim_audited_enterprise_registry` 刷新花名册，含加工中心任务、台账保存后链式同步、页面「从管理与产权层级信息同步花名册」）须遵守：

1. **禁止** 对目标年度执行 `DELETE FROM dim_enterprise_year_roster WHERE stat_year = ?` 整年清空（与当前实现不同，落地时须改造）。
2. 对台账扫到的成员：**UPSERT**，置 `in_registry = true`，按 §5 字段矩阵合并。
3. 对 **仅人工**（`in_manual=true` 且 `in_registry=false`）的行：**保留**，同步不得删除。
4. 删除成员 **仅允许**：用户在 UI 显式删除；或「从上年度复制」预览中勾选覆盖（见 §6）。

**同步后可提示（非阻断）**：台账中已不存在、花名册仍保留的「仅人工」成员数量，便于核对「台账已退出但审计仍要纳入」的场景。

### 3.2 冲突：分析读花名册现值；人工关键字段优先

| 层级 | 规则 |
|---|---|
| 写入/合并 | 台账同步 **不覆盖** 人工已维护过的关键字段（§5）；台账侧补空、写 `registry_row_id`、置 `in_registry=true` |
| 分析消费 | 报送覆盖、`dim_enterprise_year_rel` 等 **一律读花名册现值**，不并行维护「台账口径分母」 |
| 质量标识 | 人工与台账归属不一致 → `quality_status=conflict`，`quality_issue` 记录「台账：… / 人工：…」；`data_source=registry+manual` |

**列表/KPI 默认**：待核对行 **仍计入** 成员总数与覆盖分母，避免结果随同步来回跳动。

**可选高级模式（默认关闭）**：「待核对成员不参与覆盖分母」— 仅在有明确治理需求时启用。

### 3.3 从上年度复制：默认跳过已存在行

复制是批量初始化操作，**默认保守**：

| 目标年度已有行 | 默认行为 | 预览中可选项 |
|---|---|---|
| 不存在 | 插入；`in_manual=true` | — |
| 仅人工 | **跳过** | 可勾选「用去年数据覆盖该人工行」（需二次确认） |
| 仅台账 | **跳过** | 可勾选「仅补空字段」（不改国家出资企业归类） |
| 台账 + 人工 | **强制跳过** | 不允许批量覆盖；须单条编辑 |

预览须展示：**将新增 N / 将跳过 M / 冲突提示 K**，用户确认后执行。

---

## 4. 人工维护能力（产品范围）

### 4.1 入口

- **单条手工添加**：税号、企业名称、国家出资企业及税号、`is_member` 等。
- **从上年度复制**：见 §6。
- **单条编辑 / 删除**：仅影响 `in_manual` 侧意图；删除仅人工行不同步回台账。

### 4.2 页面定位（相对现行 UI）

现行页面文案为「只读查询」；落地后调整为：

> 花名册 = 台账同步 + 人工补录/纠偏；同步不删除人工行；冲突进入待核对。

建议增加列：**来源**（与 **核对状态** 并列），筛选：仅人工 / 仅台账 / 台账+人工 / 待核对。

---

## 5. 字段级合并矩阵

键：`R`=台账同步写入，`M`=人工维护，`∅`=空/未维护。

### 5.1 台账同步（UPSERT 已存在行）

| 字段 | 仅台账行 (`in_manual=false`) | 含人工 (`in_manual=true`) |
|---|---|---|
| `enterprise_name` | R 覆盖 | R 可更新名称；若 M 非空且与 R 不同，不强制覆盖（可记 conflict 说明） |
| `state_investor` | R 覆盖 | **M 优先**，R 不覆盖 |
| `state_investor_unified_credit_code` | R 覆盖 | **M 优先**，R 不覆盖 |
| `is_member` | R 覆盖 | **M 优先** |
| `registry_row_id` | R 写入 | R 写入（仅台账侧标识） |
| `in_registry` | 置 true | 置 true |
| `in_manual` | 不变 | 保持 true |
| `data_source` | 重算 | 重算（通常为 `registry+manual`） |
| `quality_status` / `quality_issue` | 按台账内匹配规则计算 | 若 R 与 M 归属不一致 → `conflict` + 双方说明；否则按台账规则 |

### 5.2 单条人工新增

| 字段 | 规则 |
|---|---|
| 主键 | 新建 `(stat_year, enterprise_id)` |
| `in_manual` | true |
| `in_registry` | false（除非同税号已被同步过） |
| `data_source` | `manual` 或 `registry+manual` |
| `registry_row_id` | NULL（无台账行时） |
| `quality_status` | 缺国家出资企业或税号匹配失败 → `conflict` |

### 5.3 单条人工编辑

- 用户改动的字段视为 **人工意图**：置 `in_manual=true`，重算 `data_source`。
- 若该行已有 `in_registry=true` 且改动与台账快照不一致 → `quality_status=conflict`。

### 5.4 单条人工删除

| 行类型 | 行为 |
|---|---|
| 仅人工 | 物理删除 |
| 台账 + 人工 | **不建议提供「删行」**；应提供「撤销人工覆盖」或改 `is_member=false`（产品二选一，默认后者更安全） |
| 仅台账 | 不提供删除；成员退出须改台账或 `is_member=false`（若产品允许台账行标记非成员） |

### 5.5 从上年度复制（插入新行）

| 字段 | 规则 |
|---|---|
| 复制 | `enterprise_id`、`enterprise_name`、`state_investor`、`state_investor_unified_credit_code`、`is_member` |
| 不复制 | 去年的 `in_registry`、`registry_row_id`、`quality_*` |
| 标记 | `in_manual=true`；`data_source=manual` |
| 默认源行筛选 | 去年 `is_member=true` 且 `quality_status='ok'`（预览可放宽） |

---

## 6. 从上年度复制 — 详细规则

### 6.1 参数

- `source_year` / `target_year`（通常 `target = source + 1`）
- 可选：按国家出资企业子集复制
- 预览模式 / 执行模式

### 6.2 冲突定义（预览「冲突提示 K」）

同一 `enterprise_id` 在目标年 **已存在** 且满足以下任一：

- 仅台账行，且去年复制来的 `state_investor` 与台账现值不同；
- 台账 + 人工，且去年模板与现值任一关键字段不同。

此类 **不自动写入**，仅在预览列出，供用户决定单条维护或等台账更新。

### 6.3 执行后

- 链式触发 `dim_enterprise_year_rel` 重算（目标年度），与台账同步成功后的链式行为一致（见 §7）。

---

## 7. 下游链式影响

花名册变更后，须保证与下列对象一致：

| 下游 | 关系 |
|---|---|
| `dim_enterprise_year_rel` | 仅 **当年花名册成员** 且映射到 org 主体；花名册增删改后须重算目标年度 |
| `vw_audit_invoice_coverage_*` | 分母来自花名册成员；已报送看 `dim_enterprise_year_rel` |
| 加工中心任务 | `enterprise_year_roster_build` 语义由「全量替换」改为「台账增量合并」（§3.1） |

**触发时机**：台账同步成功、人工保存/复制成功、用户显式「重算年度关系」— 至少覆盖目标 `stat_year`。

---

## 8. 核对 Checklist

### 8.1 功能验收（实现落地后）

- [ ] 同步后 **仅人工** 行仍存在，且 `in_manual=true`、`in_registry=false`
- [ ] 同步后 **台账+人工** 冲突行：`quality_status=conflict`，人工 `state_investor` 未被覆盖
- [ ] 复制预览默认 **跳过** 已存在行；统计 N/M/K 与执行结果一致
- [ ] **双来源行** 无法被复制任务批量覆盖
- [ ] 花名册变更后，目标年度 `dim_enterprise_year_rel` 与覆盖视图抽样一致
- [ ] UI 来源列与 `data_source` 一致；筛选有效

### 8.2 SQL 核对（现有 + 扩展）

**现有脚本**（不依赖新字段）：

```bash
duckdb data/database/warehouse.duckdb -f scripts/check_enterprise_year_roster_consistency.sql
```

修改脚本内 `params.stat_year` 后执行。期望：`roster_member_missing_rel`、`rel_outside_roster`、`coverage_denominator_mismatch` 的 `violation_cnt` 为 0；`roster_quality_conflict` 为信息项。

**扩展核对（`in_registry` / `in_manual` 落地后启用）**：

```sql
-- 参数：目标统计年度
WITH p AS (SELECT CAST(2026 AS SMALLINT) AS stat_year)

-- E1：不应存在「无来源」行
SELECT 'orphan_no_source' AS check_id, COUNT(*) AS violation_cnt
FROM dim_enterprise_year_roster ro, p
WHERE ro.stat_year = p.stat_year
  AND NOT COALESCE(ro.in_registry, FALSE)
  AND NOT COALESCE(ro.in_manual, FALSE);

-- E2：data_source 与双位一致
SELECT 'data_source_mismatch' AS check_id, COUNT(*) AS violation_cnt
FROM dim_enterprise_year_roster ro, p
WHERE ro.stat_year = p.stat_year
  AND ro.data_source IS DISTINCT FROM (
      CASE
          WHEN COALESCE(ro.in_registry, FALSE) AND COALESCE(ro.in_manual, FALSE) THEN 'registry+manual'
          WHEN COALESCE(ro.in_registry, FALSE) THEN 'registry'
          WHEN COALESCE(ro.in_manual, FALSE) THEN 'manual'
          ELSE NULL
      END
  );

-- E3：仅人工行不应有 registry_row_id（除非业务允许预关联，默认应为 NULL）
SELECT 'manual_only_with_registry_id' AS check_id, COUNT(*) AS violation_cnt
FROM dim_enterprise_year_roster ro, p
WHERE ro.stat_year = p.stat_year
  AND COALESCE(ro.in_manual, FALSE)
  AND NOT COALESCE(ro.in_registry, FALSE)
  AND trim(COALESCE(ro.registry_row_id, '')) <> '';

-- E4：冲突行应同时有双来源（归属不一致场景）
SELECT 'conflict_without_dual_source' AS check_id, COUNT(*) AS violation_cnt
FROM dim_enterprise_year_roster ro, p
WHERE ro.stat_year = p.stat_year
  AND ro.quality_status = 'conflict'
  AND ro.quality_issue LIKE '%台账%'
  AND ro.quality_issue LIKE '%人工%'
  AND NOT (COALESCE(ro.in_registry, FALSE) AND COALESCE(ro.in_manual, FALSE));
```

> 落地时将 E1–E4 合并进 `scripts/check_enterprise_year_roster_consistency.sql` 或同级脚本，并在 CI/发布检查清单中引用。

### 8.3 与台账差异抽查

对 `data_source IN ('manual', 'registry+manual')` 的样本：

1. 在「管理与产权层级信息」查同年度同税号是否存在；
2. 对比 `state_investor` 与台账 `state_investor` 是否一致；
3. 不一致且 `quality_status=conflict` → 符合 §3.2；若 status 仍为 `ok` → 缺陷。

---

## 9. 建议 schema 演进（实现参考）

在 `config/ddl/dim.sql` / patch 中增加（名称可微调，语义须一致）：

```sql
-- 建议新增列（布尔默认 false）
-- in_registry BOOLEAN DEFAULT FALSE,
-- in_manual   BOOLEAN DEFAULT FALSE,
-- manual_updated_at TIMESTAMP,  -- 可选：最后一次人工操作时间
-- manual_note VARCHAR,           -- 可选：人工说明
```

现有 `data_source` 保留，由 `in_registry` / `in_manual` **派生**，便于查询与 UI。

**当前实现（待改造）**：同步时 `data_source='audited_enterprise_registry'`，整年 DELETE 后 INSERT；见 `src/local_api/enterprise_year_roster_build.py`。

---

## 10. 相关文档与代码索引

| 资源 | 说明 |
|---|---|
| `config/ddl/dim.sql` | 表定义 |
| `src/local_api/enterprise_year_roster_build.py` | 台账 → 花名册增量同步 |
| `src/local_api/enterprise_year_roster_manual.py` | 人工增删、从上年度复制 |
| `src/local_api/enterprise_year_roster_merge.py` | 字段合并与来源派生 |
| `src/local_api/enterprise_year_roster_store.py` | 花名册读写 UPSERT |
| `src/local_api/enterprise_year_roster_api.py` | 花名册查询 API |
| `frontend/src/dim/EnterpriseYearRosterPage.tsx` | 花名册页 |
| `docs/dim_enterprise_year_rel_runbook.md` | 年度关系回填；分母依赖花名册 |
| `docs/group_enterprise_year_rules.md` | 集团双树表口径（与花名册解耦） |
| `scripts/check_enterprise_year_roster_consistency.sql` | 一致性核对 |
| `docs/subject_field_priority_policy.md` | 主体库多来源优先级（设计参照） |

---

## 11. 修订记录

| 日期 | 说明 |
|---|---|
| 2026-06-08 | 初版：拍板混合维护规则、字段合并矩阵、复制与核对清单 |
| 2026-06-08 | 代码落地：增量同步、人工 API、前端维护入口、扩展一致性 SQL |
