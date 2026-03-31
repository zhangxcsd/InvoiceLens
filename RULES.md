## InvoiceLens 默认规则（实现时必须遵守）

这份文件用于让**人类**与**AI**在实现过程中遵守同一套硬性约束（对应 Cursor 规则 `.cursor/rules/core-guardrails.mdc`）。

### 稳定性（Excel 读取）

- **必须**为所有 Excel 读取/解析增加 `try/except`，任何异常**不能导致程序崩溃**。
- **行级错误必须跳过**：单行解析失败（金额/日期/税号/编码等）只拒收该行，其余行继续处理。
- **必须记录可追溯日志**（至少包含）：
  - `source_excel_file`、`sheet`、`seq_no`（优先使用 Excel 列 `序号` 定位）
  - `field`（可选）、`reason`、`exception_type`
  - 汇总：`reject_row_ranges`、`reject_row_samples`

### 可解释性（审计规则 SQL）

- 审计规则 SQL **必须保留注释**，不得在加载/执行前删注释或压缩导致注释丢失。
- **每个关键筛选条件都要写“审计含义”注释**（尤其是 `WHERE` / `JOIN` 的过滤条件）。
- 建议每条规则都包含：规则头注释（目的/风险/适用范围/输出字段含义）+ 条件逐条注释。

### 离线能力（Plotly/前端资源）

- 禁止任何外网 CDN 资源引用（`cdnjs/jsdelivr/unpkg/cdn.*` 等）。
- Plotly 必须离线：
  - 优先 `include_plotlyjs="inline"`（最稳）。
  - 或使用 `include_plotlyjs="directory"` 并把 `plotly.min.js` 等资源放到 `assets/` 本地目录。
- 打包分发时必须把 `assets/` 等静态资源一并带上，保证断网可运行。

