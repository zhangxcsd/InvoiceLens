# 分析主体池（L1 Analysis Subject Pool）

## 口径概述

分析主体池用于 DWS 税务专题、健康度、关联交易等需「选定被审企业」的页面下拉筛选。与「发票报送覆盖分析 · 已报送」（购销双向、无张数门槛）口径不同。

## 三重门槛

主体进入分析主体池须同时满足：

1. **花名册成员**：`dim_enterprise_year_roster` 中 `is_member = TRUE` 且 `stat_year` 匹配；
2. **已映射主体库 org**：企业税号与 `dim_subject_master`（`subject_category = 'org'`）规范化税号匹配；
3. **当年有票**：`dim_enterprise_year_rel` 中该主体在当年至少具备购方或销方角色，且 `invoice_count > 0`。

实现见 `src/local_api/analysis_subject_pool.py` 中 `_analysis_subject_sql`。

## 参数 N（min_analysis_subject_invoice_count）

- 配置项：`min_analysis_subject_invoice_count`（系统设置 → 规则阈值，默认 10）；
- 含义：当年发票张数（`dim_enterprise_year_rel.invoice_count`）须 **≥ N** 才进入池；
- 比较符：大于等于（`>=`）。

## 可选筛选

| 参数 | 说明 |
|------|------|
| `require_buyer` | 仅保留 `has_buyer_role = TRUE` 的主体（购方视角专题） |
| `require_both_roles` | 须同时具备购方与销方角色（进销偏离、税风险敞口等） |

前端通过 `useDwsFilters({ entityPool: 'analysis', requireBothRoles: true })` 等与 API `GET /api/analysis/subject/options` 对齐。

## API

- `GET /api/analysis/subject/meta`：返回 N、口径说明、样例池规模；
- `GET /api/analysis/subject/options?stat_year=&require_buyer=&require_both_roles=&min_invoice_count=`：下拉选项。

## 与 DWS entity 下拉的区别

- `entityPool: 'dws_trend'`：来自 `dws_inv_trend` 有汇总数据的主体，不要求花名册/org 映射；
- `entityPool: 'analysis'`：严格三重门槛 + N，保证分析专题与被审范围一致。
