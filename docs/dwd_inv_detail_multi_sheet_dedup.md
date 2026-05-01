# `dwd_inv_detail`：多工作表重复导出与明细去重约定

本文记录 **ODS→DWD** 中明细主键、`logic_line_no` 与 **信息汇总表 / 货物清单** 等 **inv_detail** 多 sheet 场景下的产品共识，与 `src/etl/cleaner.py`、`config/ddl/dwd.sql` 实现一致。修改规则时请同步更新本文件与 DDL 注释。

## 1. 业务前提（当前范围）

- **信息汇总表** 与 **货物清单** 映射到同一 ODS 类型 **`inv_detail`**，视为 **同一套发票明细的重复导出**，目标是 **去除信息重复**，而非保留多份镜像。
- **暂不扩展**到其他 sheet 类型；若未来存在「互补而非重复」的多 sheet，需单独约定，**不可**默认沿用本文规则。

## 2. `logic_line_no`（按来源作用域内编号）

- 在 ETL 临时视图 `_ods_dtl_logic` 中，窗口分区为 **`PARTITION BY _hdr_k, _scope_k`**：
  - **`_hdr_k`**：与 `header_uuid` 同源的票键（规范化 fpdm / fphm / sdfphm 的 MD5 输入逻辑在 SQL 中与主表一致）。
  - **`_scope_k`**：`MD5(import_session_id || normalized(source_excel_file) || source_sheet)`。
    - `normalized(source_excel_file)`：仅做路径字符串归一（`lower + trim + \ -> /`），用于稳定来源键。
    - `source_parquet_file` **不参与** `_scope_k`，仅作血缘追溯。
- **不在全票维度**把多个来源作用域连成一条连续序号；**每个 `_scope_k` 各自**得到 **1…n**（及汇总参考行 **`0`**，见 `config/dwd_goods_summary_phrases.yaml`）。
- ODS **序号**列仅作 **sheet 分区内**排序键，**不把原序号原样写入 DWD** 作为最终行号。

## 3. 同作用域重复落盘（同会话重复文件）的处理

- 在编号前先去重：对同一 `(_hdr_k, _scope_k, _ord_key)`，按 `ods_file_seq` 与 `source_parquet_file` 取最先一条。
- 目的：同一来源文件重复落盘（例如同会话下重复导入/多目录重复扫描）时，不把同一业务行编成 `1/2/...` 的“伪多行”。

## 4. `detail_uuid`（主键，不含 sheet）

- 公式：**`MD5( fw2hw(fpdm) || fw2hw(fphm) || fw2hw(sdfphm) || CAST(logic_line_no AS VARCHAR) )`**（与 DDL 注释一致）。
- **故意不包含** `source_sheet`：同一张发票在 **全库范围内**，**每个整数 `logic_line_no` 最多对应一条明细行**。
- 与 **`header_uuid`** 的关系：`header_uuid` 仅含票键；同一票下 **`detail_uuid` 在票键基础上再叠 `logic_line_no`**，用于区分明细行槽位。

## 5. 写入语义：先到先得（与主表一致）

- 明细写入使用 **`INSERT … ON CONFLICT DO NOTHING`**（主键为 `detail_uuid`）。
- **先成功插入**的行保留（含 **`source_sheet` 等血缘**）；**后插入**且算出 **相同 `detail_uuid`** 的行 **整行丢弃**。
- 典型情况：先导入的 sheet 已占满同票的 `logic_line_no = 1…n` 槽位后，后导入 sheet 中 **同键** 行可能 **全部冲突**，从而 **后一来源整批明细无法入库**——在「重复导出」假设下为 **预期行为**。

## 6. 顺序与「官方」行号

- **以先导入、先写入 DWD 的 sheet** 为准，确定该票下 **`logic_line_no` 与实物行的对应关系**；后导入的 sheet **不覆盖**已存在槽位。
- 若两 sheet **行序相反**（例如一为 1–5、一为 5–1），只要两侧在 **各自 sheet 内**仍得到 **1…5** 的 `logic_line_no`，后导入侧可能与 **1…5 全部主键冲突**而整批不落库；业务上依赖 **「两表整体明细集合等价」** 的假设，**只保留一份**即可。

## 7. 与 DDL 约束

- 表上保留 **`UNIQUE (header_uuid, logic_line_no)`**，与「同票同逻辑行号最多一行」一致（在票键与 `header_uuid` 一一对应的前提下，与 `detail_uuid` 唯一性同向）。
- **新建库**：`CREATE TABLE` 即带上述主键与 UNIQUE。
- **已有库**：若历史上曾按「含 sheet 的 `detail_uuid`」落库，可能出现 **同一 `(header_uuid, logic_line_no)` 多行**；此时 **不能直接** `ADD CONSTRAINT`，需 **清理重复或重建表** 后再加约束。初始化时若检测到有重复，迁移逻辑会 **跳过** 加约束并打日志（见 `db/schema_sqlfiles.py`）。

## 8. 并发（极限情况）

- **多进程 / 多会话并行**对 **同一票、同一 `logic_line_no`** 插入时，存在 **竞态导致短暂重复** 的理论风险；单机单连接顺序执行时风险极低。若生产并行写同一 DuckDB，应对导入 **串行化** 或使用事务策略另行设计。

## 9. 专项运输（客运 / 货运）对齐

- `dwd_spc_transport_passenger` / `dwd_spc_transport_freight` 的 **`logic_line_no` 生成与 `dwd_inv_detail` 共用** `src/etl/dwd_shared_logic_line.py` 中 `build_create_ods_logic_line_view_sql`（分区 `_hdr_k` + `_scope_k`、汇总参考行 `0`、同键去重等语义一致）。
- **`detail_uuid`** 与明细表相同：`MD5(fw2hw(fpdm)||fw2hw(fphm)||fw2hw(sdfphm)||logic_line_no)`，**不含** `source_sheet`；同逻辑行在专项表与明细表中主键一致（计算正确时可直接 JOIN）。
- 多 sheet 时仍按 **来源作用域**（`_scope_k` / 落盘列 `source_scope_key`）各自编号；表级约束为 **`UNIQUE(header_uuid, logic_line_no)`**（与明细「同票同槽位」一致）。
- 行数数据质量：`run_cleaner` 返回 `dq_spc_transport_passenger_linecount_mismatch` / `dq_spc_transport_freight_linecount_mismatch` / `dq_spc_vehicle_sales_linecount_mismatch` / `dq_spc_construction_linecount_mismatch` / `dq_spc_estate_lease_linecount_mismatch`，比较同 `(header_uuid, source_scope_key)` 下 **`logic_line_no > 0`** 行数在专项与 `dwd_inv_detail` 是否一致。
- 金额校验（仅报告）：`dq_spc_transport_passenger_amount_vs_inv_detail` / `dq_spc_transport_freight_amount_vs_inv_detail` / `dq_spc_vehicle_sales_amount_vs_inv_detail` / `dq_spc_construction_service_amount_vs_inv_detail` / `dq_spc_estate_lease_amount_vs_inv_detail`。仅 **`logic_line_no > 0`** 的专项行；按 **`detail_uuid` LEFT JOIN `dwd_inv_detail`**；`dq_issue` 为 `no_inv_detail_row`（无同 UUID 明细）或 `amount_mismatch`（`je`/`se`/`jshj` 与明细差绝对值 > 默认 **0.01**）。不落库、不阻断清洗；规则见 `src/etl/dwd_shared_logic_line.py` 中 `sql_amount_dq_vs_inv_detail`。

## 10. 修订记录

- 2026-04：确立「sheet 内 `logic_line_no` + 全库 `detail_uuid` 不含 sheet + ON CONFLICT 先到先得」；恢复 `UNIQUE(header_uuid, logic_line_no)`；本文初版。
- 2026-04-13：`logic_line_no` 分区升级为 `source_scope_key`（`import_session_id + source_excel_file + source_sheet` 哈希）；新增同作用域重复落盘的编号前去重规则。
- 2026-04-18：专项运输与明细共用 `logic_line_no` / `detail_uuid` 规则；补充第 9 节。
- 2026-04-18：`dwd_spc_vehicle_sales`（新车+二手合并）、`dwd_spc_construction_service`、`dwd_spc_estate_lease` 落盘与同源 DQ 字段。
- 2026-04-18：专项金额按 `detail_uuid` 与 `dwd_inv_detail` 对照的 DQ 报告字段（`dq_*_amount_vs_inv_detail`）。
