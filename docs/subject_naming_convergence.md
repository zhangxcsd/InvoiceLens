# 主体库命名收敛清单

本文用于统一“主体库”相关术语与字段命名，避免多处实现歧义。

## 1) 术语统一（对外口径）

- 顶层名称：`主体库`
- 一级分类：
  - `组织机构主体`（`org`）
  - `自然人主体`（`person`，含临时纳税人）
- 说明：
  - “组织机构”定义依据 `GB 32100-2015`
  - “个人主体”属于历史用词；新文案统一为“自然人主体”

## 2) 模型统一（对内实现）

- 存量年度模型（保留）：
  - `dim_enterprise_subject`
  - `dim_person_subject`
  - `vw_dim_subject_union`
- 增量统一模型（推荐）：
  - `dim_subject_master`
  - `dim_subject_source_record`

## 3) 血缘字段命名统一（与 DWD 对齐）

主表摘要血缘（`dim_subject_master`）：
- `first_import_batch_id`
- `first_import_session_id`
- `last_import_batch_id`
- `last_import_session_id`

配置文件说明字段（`config/subject_codebook_rules.yaml`）：
- `remark`（用于记录本配置文件的编码口径与规则说明）

来源明细血缘（`dim_subject_source_record`）：
- `import_batch_id`
- `import_session_id`
- `ods_file_seq`
- `source_excel_file`
- `source_parquet_file`
- `source_sheet`
- `source_row_no`
- `ingest_ts`

## 4) 弃用命名（仅兼容，不再新增）

- `source_batch_id` -> `import_batch_id`
- `source_file` -> `source_excel_file`
- `imported_at` -> `ingest_ts`
- `first_seen_batch_id` / `last_seen_batch_id`（仅存量年度模型保留，不用于新增统一模型）

## 5) 实施约束

- 新增表、脚本、接口参数，优先使用第 3 节命名。
- 历史字段不做破坏性改名时，需在文档标注“兼容字段”并给出映射关系。
- 前端展示统一使用“主体库 / 组织机构主体 / 自然人主体”。

