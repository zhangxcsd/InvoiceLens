# ODS→DWD：增量构建与强制重洗规则

本文档描述 **正常增量构建**、**全量构建** 与 **强制重洗** 的边界、数据水位与 API 约定，供实现对照、评审与后续迭代时更新。

---

## 1. 术语与水位

| 概念 | 说明 |
|------|------|
| **import_batch_id** | 导入批次，与磁盘 `data/ods/批次=<id>/` 及 `ods_load_log` 一致。 |
| **import_session_id** | 单次导入会话；同一批次可有多个会话。 |
| **DWD 处理水位** | 列 `ods_load_log.dwd_session_processed_at`（`TIMESTAMP`，可空）。某会话完成 **按年清洗并成功落盘** 后写入；`NULL` 表示该会话尚未被「正常增量」标记为已处理。 |

新建库见 `config/ddl/ods.sql`；旧库由 `db/schema_sqlfiles.py` 中 `migrate_ods_load_log_dwd_watermark` 自动 `ADD COLUMN`。

---

## 2. 正常增量构建（默认）

**目标**：只处理尚未写入水位的会话，避免重复全表扫描与重复写入尝试，且 **绝不** 因 ODS 缺失、文件删改等原因自动删除或回滚已落盘 DWD。

**行为要点**：

1. 查询 `ods_load_log` 中 `import_batch_id = ?` 且 `dwd_session_processed_at IS NULL` 的 `import_session_id`。
2. 若无待处理会话：返回成功（业务上「无事可做」），**不写 DWD、不更新水位**（实现中可带 `stat_year_source: skipped_incremental_empty` 等标识）。
3. 若有待处理会话：在 `run_cleaner` 中通过会话筛选限制 ODS 临时视图范围；按 **可解析开票日期的 distinct 年度** 循环调用清洗。
   - 年度推断先看 `ods_inv_header`，若头表为空/不可解析，再用 `ods_inv_detail` 兜底，避免“头表缺失导致无法确定 stat_year”。
4. **全部计划年度均成功执行** 后，将本次涉及的会话批量更新 `dwd_session_processed_at = CURRENT_TIMESTAMP`。
5. 若中间某年度抛错：**不更新** 这些会话的水位；响应中宜包含 `failed_stat_year`、`stat_years_succeeded`（或等价字段）便于重试与对账。

**API**：`POST /api/dwd/build`  
**默认请求体**：`incremental` 缺省为 `true`（与「默认增量」一致）。  
可选 **`import_session_ids`**（字符串数组）：在 incremental 为 true 时，仅在该批次的**待处理会话**中与列表取交集；不传则处理该批次全部待处理会话。空数组等价于「无待处理」的跳过语义（与未传不同业务时需以后端实现为准；当前实现中空列表会使待处理集合为空）。

---

## 3. 全量构建（不按水位跳过）

**目标**：对批次内 **全部** ODS 会话跑清洗（不按 `dwd_session_processed_at` 过滤），仍 **不** 主动删除历史 DWD 行；重复主键依赖既有 `ON CONFLICT DO NOTHING` 等语义。

**行为要点**：

1. `run_cleaner` 的 `import_session_ids` 为 `None`（整批 `batch_id`）。
2. 成功后为本批次 **`ods_load_log` 中全部会话** 写入 `dwd_session_processed_at`（与增量「只标本次处理的会话」不同）。

**API**：`POST /api/dwd/build`，请求体 `incremental: false` **或** `full_batch: true`（`full_batch: true` 时实现上应等价于关闭增量）。

---

## 4. 强制重洗（运维显式操作）

**目标**：在修正映射、补数据等运维场景下，**允许** 删除 **指定会话** 曾写入的 DWD 行并重新清洗，同时重置该会话的水位。

**必须与正常增量 / 全量路径隔离**：仅通过 **专用接口** 触发，**不得** 在增量或全量逻辑中自动调用。

**行为要点**（顺序固定）：

1. 校验 `ods_load_log` 存在 `(import_batch_id, import_session_id)`。
2. `DELETE FROM dwd_inv_header` / `dwd_inv_detail`：按会话删除。
   - **主路径**：`WHERE import_batch_id = ? AND import_session_id = ?`。
   - **兼容旧库兜底**：若历史行 `import_session_id` 为 `NULL/空串`，则用 `source_parquet_file` 匹配 ODS 分区路径中的 `会话=<import_session_id>` 一并删除（否则会出现“强制重洗后行数不变/删不干净”的现象）。
   - **执行策略**：删除实现采用“按主键分批小批次删除”（而非一次性条件删），以降低 DuckDB 旧版本在大批量删除时触发 `Failed to delete all rows from index` 的概率。
3. `UPDATE ods_load_log SET dwd_session_processed_at = NULL` 对应行。
4. 仅对该 `import_session_id` 调用按年清洗（`import_session_ids = [该 id]`）。
5. 全部年度成功后，为该会话重新写入水位。

**会话筛选兼容规则（重要）**：

- 强制重洗/按会话增量在 **ODS 取数** 与 **stat_year 推断** 两处都使用同一筛选口径：
  - 主路径：`import_session_id IN (...)`
  - 旧库兜底：当 `import_session_id` 为空时，按 `source_parquet_file` 中 `会话=<sid>` 匹配血缘
- 目的：避免旧数据因会话字段缺失被筛空，进而误报“无可解析开票日期 / 无法确定 stat_year”。

**说明**：当前管道若未写入 `dwd_inv_map` 等其它表，则删除范围以实际 ETL 为准；若未来扩展映射表且按会话可追溯，应在此同步补充删除规则并更新本文档。

**API**：`POST /api/dwd/force-rebuild`  
**请求体**：`import_batch_id`、`import_session_id`（兼容别名 `session_id`）、可选 `stat_year`。

---

## 5. 禁止与审计要点

| 禁止项 | 说明 |
|--------|------|
| 自动删 DWD | 正常增量、全量构建 **不得** 因 ODS Parquet 缺失、目录被删等 **自动** `DELETE` 已落盘 DWD。 |
| 隐式强制重洗 | **不得** 在后台任务中静默调用「强制重洗」语义。 |
| 与水位混用 | 强制重洗前后水位重置与重跑只应出现在该专用路径。 |

**代码审计**：全仓检索 `DELETE FROM dwd_inv_`，仅 `force_rebuild` 相关模块应出现按会话删除（若新增删除逻辑须同步更新本节）。

---

## 6. 前端与运维入口

- **加工中心 → ODS→DWD**：提供「开始构建（增量）」与「强制重洗」（需选择 `import_session_id` 并确认对话框）。
- 会话级 **DWD 水位展示** 依赖列表接口返回的 `dwd_session_processed_at`（见 ODS 预览批次 API）。

---

## 7. 变更记录

| 日期 | 变更摘要 |
|------|----------|
| 2026-04-10 | 初版：水位列、增量/全量/强制重洗边界与 API 对照；与 `src/local_api/dwd_build.py`、`src/etl/cleaner.py` 行为一致。 |
