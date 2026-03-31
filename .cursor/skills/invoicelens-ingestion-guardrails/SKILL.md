---
name: invoicelens-ingestion-guardrails
description: Enforces robust Excel-to-ODS ingestion guardrails for InvoiceLens-style projects: resilient Excel parsing (file-blocking vs row-reject), auditable rejects/logs, externalized table types and DDL in .sql files (preserve SQL comments), offline-only frontend assets, and safe Parquet writing with schema-compatibility retries. Use when implementing Excel imports, ODS landing, manifests, DuckDB schema/DDL, or config externalization.
---

# InvoiceLens Ingestion Guardrails

## 目标

- **Excel 读取必须可跳过、可追踪、不中断**：任何异常不允许把程序整体打崩。
- **ODS / DDL / 配置必须外置**：表类型映射、建表 SQL、规则 SQL 等不写死在 `.py`。
- **离线可运行**：前端静态资源不依赖外网 CDN。
- **Parquet 写入要自动兼容**：遇到类型漂移/推断差异要可自愈，降级但不中断。

## 触发场景（什么时候用）

- 用户提到：`Excel`、`.xlsx/.xls`、**小批量导入**、**ODS 落盘**、`batch_id`、`manifest`、`DuckDB DDL`、`schema`、`建表语句抽离`、`sheet mapping`、`ComputeError`、`parquet`、`离线`、`CDN`。

## Excel 导入稳定性（必须遵守）

- **异常分级**：
  - **文件级阻断（file_blocking=true）**：文件损坏/无法打开/引擎错误/关键元数据缺失 → **跳过该文件**，但继续后续文件。
  - **行级拒收（file_blocking=false）**：单行解析失败（金额/日期/税号/编码等）→ **跳过该行**，其余行继续。
- **行级拒收最少字段**（用于 UI 回溯与定位）：
  - `source_excel_file`, `sheet`, `seq_no`（优先使用 Excel 的 `序号` 列）
  - `field`（若可定位到字段）
  - `reason`（面向用户）
  - `exception_type`（便于排查）
- **拒收清单推荐形状**（便于 UI 展示与摘要）：
  - `reject_row_ranges: [{seq_no_start, seq_no_end, reason}]`
  - `reject_row_samples: [{seq_no, sheet, field, reason}]`

## 表类型与配置外置（不硬编码）

- **sheet → data_type（表类型）映射**放在 `config/sheet_mapping.yaml`（或等价外部文件），加载失败要有默认回退。
- 允许自动补全缺失映射，但必须：
  - **原子写入**（避免中途写坏）
  - **不覆盖已有键**
  - **可追踪**（日志/提示用户新增了哪些映射）

## ODS 与 manifest（可追溯）

- ODS 落盘目录由 UI 传入的 `import_batch_id` 决定；同一 `batch_id` 允许**续跑**但不建议并发。
- 需要 `manifest` 来把相对序号与实际来源绑定：
  - 按 `batch_id + table_type` 聚合成少量 manifest
  - 写在独立目录（例如 `data/ods/manifests/`）
  - 多进程/多次 flush 下写入要避免互相覆盖：使用 **session_id** 分文件或原子追加策略

## Parquet 写入自动兼容（防 ComputeError）

- 默认写入失败（如 Polars `ComputeError`/schema mismatch）时，采用**逐级降级重试**：
  - 提高 `infer_schema_length`
  - 必要时将**非核心字段**统一转为 `Utf8`
- 兼容模式触发时，将本次导入状态从“成功”降为“警告”，但仍应写入 ODS 与日志（除非文件级阻断）。

## 性能与口径（A/B/C：推荐实现，适配超大 Excel）

- **A｜逐 Sheet 读取**
  - 避免 `read_excel(sheet_name=None)` 一次性读取整本工作簿；使用 `pd.ExcelFile` 逐 sheet 读取，降低峰值内存与无效 IO。
- **B｜向量化拒收判定**
  - 大表禁止逐行构造海量 dict 做校验；应在 DataFrame 上向量化判定拒收 mask，并仅保留：
    - `reject_row_ranges`（连续序号区间摘要）
    - `reject_row_samples`（前 N 条样本用于 UI）
- **C｜ODS 原始字符串，强类型在 DWD**
  - ODS 层只做“缺失值归一化”（把 `"nan"/"null"/"none"/"--"/"N/A"` 等占位符还原为真正 `NULL`）与最小可用的行级有效性判定（序号可定位、识别键不全空）。
  - 金额/日期的解析、精度控制、业务清洗与可解析性拒收，统一在 DWD 阶段完成并记录。
  - DWD 的拒收日志建议复用 ODS 形状（ranges+samples），便于 UI 统一展示与回溯。

## DDL / SQL 外置与可解释性

- **DuckDB 建表 DDL**必须放在 `config/ddl/*.sql`，`db/schema_duckdb.py` 只负责加载文件内容并执行。
- **禁止剥离 SQL 注释**（`--` / `/* */`），用于审计解释与报告导出。

## 离线能力（禁止外网 CDN）

- 前端/报告 HTML/可视化资源必须本地加载（如 Plotly：`include_plotlyjs="inline"` 或本地目录引用）。
- 打包时必须包含静态资源目录（如 `assets/`）。

