# DWD 分层与映射原则

本文档约定 **ODS → DWD** 的规则写法与字段分层，与 `config/ddl/dwd.sql`、`config/dwd_mapping.yaml` 配套使用。

**调度与运维（增量 / 全量 / 强制重洗、水位字段）**：见同目录 [`ODS到DWD增量构建与强制重洗.md`](./ODS到DWD增量构建与强制重洗.md)。

## 1. 核心原则：先冻结 ODS 语义，再定义 DWD 语义

- **ODS 层**（含 `config/field_mapping.yaml`）解决的是：**Excel 表头 → ODS 标准字段（蛇形英文名）** 的落盘语义。开票日期在 ODS 的标准列名为 **`kprq`**（原值字符串）；**`invoice_date`（DATE）仅在 DWD** 由 ETL 从 `kprq` 解析写入。
- **DWD 层**解决的是：**分析/报表/仓库语义**。不要求 DWD 列名与 ODS 列名一致；允许重命名、拆分、派生、聚合回填。
- 映射配置（`dwd_mapping.yaml`）应显式写出：**ODS 字段 → DWD 字段** 及 **变换规则**，避免“隐含同名即相等”。

## 2. 四个字段来源分层（每张 DWD 表均按此归类）

### A. 直接映射（ODS → DWD rename / cast）

从 ODS 行中**直接取值**，仅做类型对齐或等价重命名（如 `invoice_no` → DWD 业务列 `fphm`），不做业务规则变换。

典型：`trim` 以外的逻辑若已算“清洗”，可归入 B。

### B. 规则清洗（ODS → DWD transform）

在 A 的基础上增加确定性规则，例如：日期规范化、金额转 `DECIMAL`、税率解析、枚举映射、全角/半角、去空格等。

### C. 派生字段（Derived）

不单独来自某一 ODS 列，由 **ODS 多列 + 规则** 或 **跨行/跨表计算** 得到，例如：

- 键类派生：`header_uuid`、`detail_uuid`、`logic_line_no`、`stat_year`、`stat_month`（与 `invoice_date` 同源的月份物化列，便于按月过滤与复合索引；亦可查询时 `EXTRACT(month FROM invoice_date)`，二者择一或并存由性能需求决定）
- 业务派生：`amount_without_tax`、是否红票、行指纹等（以各表 DDL 为准）

### D. 运行与血缘（Lineage，**全库统一建议字段**）

每条 DWD 行应能回答：**来自哪次导入、哪个分片、哪份源文件、何时写入 DWD**。建议统一使用下列字段（列名与类型以 `dwd.sql` 为准）：

| 字段 | 含义 |
|------|------|
| `import_batch_id` | 导入批次 ID |
| `import_session_id` | 导入会话 ID |
| `ods_file_seq` | ODS 分片序号（与分区 `ods_file_seq=` 对齐） |
| `source_excel_file` | 来源 Excel 路径或标识 |
| `source_parquet_file` | 来源 ODS Parquet 路径 |
| `source_sheet` | 来源工作表名 |
| `ingest_ts` | 数据进入 ODS 链路的采集/写入时间（来自 ODS 行若存在） |
| `dwd_build_ts` | 本行写入 DWD 的时间 |
| `dwd_build_id` | 本次 DWD 构建任务 ID（便于重跑、对账） |

**说明**

- 主表“先到先得”去重场景下，可额外保留 **`first_import_batch_id` / `first_import_file`** 表示**首次**占据该主键行的导入来源；与 **D 层“本行映射来源”** 语义不同，二者可同时存在。
- 若某阶段尚未接入某列，可置 `NULL`，但字段建议在 DDL 中预留，便于后续对齐。

## 3. 与「导入后批量回填」的关系

平账、净额、红冲关联等字段，通常 **不是** ODS 行级一次性映射，而属于 **ODS→DWD 首次落表之后的批处理**。在 DDL 中单独成组注释（如“导入后回填”），在 `dwd_mapping.yaml` 中可用 `populate: post_aggregate` / `post_etl` 标注。

## 4. `dwd_inv_map` 与 `invoice_dir`

- **用途**：表达「**某被分析主体（entity）在某批次下与某张发票头 `header_uuid` 的归属关系**」，用于集团多法人、多来源导入时的溯源与报表展示字段（如 `entity_name`），**不是**票面购方/销方字段的替代品（购销方在 `dwd_inv_header` 的 `gfsbh`/`xfsbh` 等）。
- **`invoice_dir`（进项 / 销项）**：相对该 **entity** 的业务视角（取得发票 vs 对外开具）。若当前流水线**没有可靠判定依据**，应置 `NULL`，**禁止**在 DWD 无来源地猜测；待目录规则、上游元数据或明确业务字段接入后再写入。DDL 中该列为可空。

## 5. `dwd_inv_detail`

### 5.1 票面冗余列

- 明细行除行项目字段外，允许冗余与主表对齐的票面列（如 `fpdm`/`kprq`/购销方/发票状态等），减少分析时 `JOIN dwd_inv_header`。**信息汇总表**类 ODS 行通常较全；**货物清单**等 sheet 在 `field_mapping` 中列较少时，冗余列多为 `NULL`，属预期行为。

### 5.2 多工作表重复导出、`logic_line_no` 与 `detail_uuid`

- **约定全文**（含先到先得、主键不含 `source_sheet`、与 `UNIQUE(header_uuid, logic_line_no)` 的关系）：见 **[`dwd_inv_detail_multi_sheet_dedup.md`](./dwd_inv_detail_multi_sheet_dedup.md)**。
- **实现入口**：`src/etl/cleaner.py`（`_ods_dtl_logic` 与明细 `INSERT`）；**表结构**：`config/ddl/dwd.sql`。

## 6. 文档与代码索引

| 资源 | 作用 |
|------|------|
| `config/ddl/dwd.sql` | DWD 物理表结构；列顺序与注释按分层梳理 |
| `config/dwd_mapping.yaml` | DWD 映射入口（含 includes 索引）；各表的列级映射在 `config/dwd_mapping/*.yaml` |
| `tools/validate_dwd_mapping.py` | 映射文件结构校验（可扩展为对照 ODS 字段） |

## 7. 修订记录

- 初版：确立 A/B/C/D 分层与统一血缘字段，并同步梳理 `dwd.sql` 注释与血缘列。
- 补充：`stat_month`、`dwd_inv_detail` 票面冗余列约定；`dwd_inv_map` / `invoice_dir` 语义与可空说明。
- ODS 开票日期标准列名统一为 `kprq`；DWD 解析列为 `invoice_date`（DATE）。
- 补充：`dwd_inv_detail` 多 sheet 重复导出去重约定专文 [`dwd_inv_detail_multi_sheet_dedup.md`](./dwd_inv_detail_multi_sheet_dedup.md)，并在此文 §5.2 索引。
