# 税风险暴露 ↔ 关联图谱 操作说明

## 用途

将 **税务分析 · 风险暴露** 与 **关联交易 · 图谱**、疑点清单、报告配置串联，便于从敞口指标下钻到往来网络与审计交付。

## 推荐路径

1. **DWS 看板 → 风险暴露分析**：选择同时具备购销角色的 L1 分析主体与年度。
2. 查看 KPI（敞口总额、RULE-05/08 金额等）后：
   - **查看相关疑点清单** → `flags_list`（带 `stat_year` / `entity_id` / `rule_id`）
   - **查看关联交易图谱** → `related_graph`（深链参数 `source=tax_risk`）
   - **生成税风险报告** → `report_config`（章节：`tax_in_out_deviation`、`audit_flags`、`related`）
3. **关联图谱页**：
   - 滚轮缩放、拖拽平移 SVG；节点过多时显示截断提示，并链向对开/通道列表。
   - 系统设置 **max_graph_nodes**（阈值页）控制最大节点数；可调高 **最小边金额** 缩小网络。
4. 从图谱返回税风险：**返回税风险暴露**（清除 `source` 以外的筛选上下文）。

## 数据依赖

| 能力 | 主要表/任务 |
|------|-------------|
| 税风险敞口 | `dws_tax_deviation`、DWD 明细 + `dim_tax_code`、`dm_audit_flag` |
| 关联图谱 | `dws_trade_sum`、`dm_audit_flag` / `dm_shell_co` / `dm_circ_inv` |
| 报告章节 | `estimate_delivery_package` / Word 模板 |

日常刷新建议：加工中心 **一键关键路径任务链**（花名册 → 年度购销标志 → DWS 重建 → 审计扫描 → 评分卡）。

## 深链参数（URL query）

| 参数 | 说明 |
|------|------|
| `nav=tax_risk_exposure` / `related_graph` | 目标页 |
| `stat_year` | 统计年度 |
| `entity_id` | 分析主体税号 |
| `source=tax_risk` | 图谱页展示税风险上下文条 |
| `party_a_tax` / `party_b_tax` | 疑点/对开上下文（可选） |

## 冒烟

```bash
python scripts/test_e2e_delivery_chain_smoke.py
python scripts/test_compare_ads_smoke.py
```

前端深链：`frontend/tests/deep-link-audit-flag.spec.ts`（含 `source=tax_risk` 图谱上下文）。
