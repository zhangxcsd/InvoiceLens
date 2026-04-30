# DWD Mapping 变更检查清单

适用范围：新增或调整任意 `config/dwd_mapping/*.yaml`、`config/ddl/dwd.sql`、`src/etl/cleaner.py` 的变更。

## 1. 先锁定 ODS 字段契约

- 先确认目标 ODS 视图：例如 `ods_spc_freight`、`ods_spc_passenger_transport`。
- 字段来源以 ODS 标准列为准（通常英文字段）。
- 中文字段仅在以下场景保留：
  - 确认为分区列（如 `批次`、`表类型`）。
  - 已实证存在于目标 ODS 视图中（不是 Excel 原始列臆测）。

## 2. 映射文件编写规则

- 每个列都必须有 `layer`，取值仅 `A/B/C/D`。
- 非 `populate` 列必须有 `source.ods_fields`。
- `ods_fields` 顺序：主契约字段在前，兼容字段在后。
- 禁止写“当前 ODS 不存在”的候选列，避免噪音映射。

## 3. DDL / Mapping / Cleaner 三处一致性

- DDL 新增列后，mapping 必须同步新增。
- Cleaner 的 `INSERT INTO ... (...)` 列序必须与 `SELECT` 对齐。
- 多来源合并时：
  - 若源表列不一致，使用 `UNION ALL BY NAME`（不要直接 `UNION ALL SELECT *`）。

## 4. 必跑校验（提交前）

- 语法校验：
  - `python -m py_compile src/etl/cleaner.py`
- 映射校验：
  - `python tools/validate_dwd_mapping.py`
- 可选数据验收（建议）：
  - 指定批次执行 DWD 构建
  - 查询新表按 `import_batch_id` 的写入行数与关键字段抽样

## 5. 结果回报模板（给业务/评审）

- 本次变更覆盖文件列表
- 构建是否成功（成功/失败）
- 失败时给出阻塞点（SQL、字段契约、数据质量）
- 成功时给出行数：
  - `rows_written_spc_transport_passenger`
  - `rows_written_spc_transport_freight`

## 6. 最小回归验收 SQL（可直接复用）

以下 SQL 以批次 `20260414` 为例，执行时替换为目标 `import_batch_id`。

- 行数验收（是否落盘）：
  - `select count(*) from dwd_spc_transport_passenger where import_batch_id = '20260414';`
  - `select count(*) from dwd_spc_transport_freight where import_batch_id = '20260414';`

- 分年验收（stat_year 口径）：
  - `select stat_year, count(*) from dwd_spc_transport_passenger where import_batch_id = '20260414' group by 1 order by 1;`
  - `select stat_year, count(*) from dwd_spc_transport_freight where import_batch_id = '20260414' group by 1 order by 1;`

- 关键字段抽样（passenger）：
  - `select source_table_type, transport_means_type, trip_date, trip_time, trip_no from dwd_spc_transport_passenger where import_batch_id = '20260414' order by stat_year, logic_line_no limit 20;`

- 关键字段抽样（freight）：
  - `select transport_means_type, transport_means_plate_no, cargo_name, departure_place, arrival_place from dwd_spc_transport_freight where import_batch_id = '20260414' limit 20;`

- 业务范围标记核验（两表）：
  - `select is_business_in_scope, count(*) from dwd_spc_transport_passenger where import_batch_id = '20260414' group by 1 order by 1;`
  - `select is_business_in_scope, count(*) from dwd_spc_transport_freight where import_batch_id = '20260414' group by 1 order by 1;`

- 时间标准化核验（passenger）：
  - `select trip_time, count(*) from dwd_spc_transport_passenger where import_batch_id = '20260414' group by 1 order by 1;`
  - 期望：`NULL` 保留为空；非空应为 `HH:MM`；解析失败兜底为 `00:00`。
