# DWD 映射总览

本文件由 `tools/generate_dwd_mapping_overview.py` 自动生成。

- 入口：`config/dwd_mapping.yaml`（includes 合并后展开）
- 行数：92

## 列级总览

| dwd_table | dwd_column | type | nullable | layer | rule_zh | from_table_types | sheet_labels_zh | ods_fields | expr/populate | comment |
|---|---|---|---|---|---|---|---|---|---|---|
| dwd_inv_detail | detail_uuid | varchar | False | C | 主键派生；票键+logic_line_no MD5，**不含** sheet；多 sheet 重复导出同键后写丢弃（见 docs/dwd_inv_detail_multi_sheet_dedup.md） | inv_detail | 信息汇总表,货物清单 | invoice_code,invoice_no,sdfphm,seq_no | md5_hex(norm_fpdm\|\|norm_fphm\|\|norm_sdfphm\|\|logic_line_no) | 主键；MD5(规范化 fpdm\|\|fphm\|\|sdfphm\|\|logic_line_no) |
| dwd_inv_detail | header_uuid | varchar | False | C | 关联键派生；与主表 header_uuid 同规则（不含行号） | inv_detail | 信息汇总表,货物清单 | invoice_code,invoice_no,sdfphm | md5_hex(norm_fpdm\|\|norm_fphm\|\|norm_sdfphm) | 外键，与主表 header_uuid 生成规则一致（不含行号） |
| dwd_inv_detail | stat_year | smallint | False | C | 由 ODS kprq 解析为日期后取年份（用于分区/过滤） | inv_detail | 信息汇总表,货物清单 | kprq | year(try_cast(kprq as date)) | 冗余年度，便于按年过滤 |
| dwd_inv_detail | stat_month | smallint | False | C | 由 ODS kprq 解析为日期后取月份 1-12（用于按月统计/索引） | inv_detail | 信息汇总表,货物清单 | kprq | month(try_cast(kprq as date)) | 与 stat_year 同源于本行开票日期 |
| dwd_inv_detail | logic_line_no | integer | False | C | 行号规则列（数电票/纸票分组编号等规则见 DDL） | inv_detail | 信息汇总表,货物清单 | seq_no | try_cast(seq_no as integer) | 行号；数电票等规则见 dwd.sql 注释 |
| dwd_inv_detail | fpdm | varchar |  | A | 行级冗余发票代码，trim（货物清单可能空） | inv_detail | 信息汇总表,货物清单 | invoice_code | trim(invoice_code) | 行级冗余发票代码（货物清单可能空） |
| dwd_inv_detail | fphm | varchar |  | A | 行级冗余发票号码，trim | inv_detail | 信息汇总表,货物清单 | invoice_no | trim(invoice_no) |  |
| dwd_inv_detail | sdfphm | varchar |  | A | 行级冗余数电票号码，trim | inv_detail | 信息汇总表,货物清单 | sdfphm | trim(sdfphm) |  |
| dwd_inv_detail | kprq | varchar |  | A | 行级冗余开票日期原串（ODS kprq），trim | inv_detail | 信息汇总表,货物清单 | kprq | trim(cast(kprq as varchar)) | 开票日期原始串；ODS 标准列 kprq |
| dwd_inv_detail | invoice_date | date |  | B | 将 ODS kprq 解析为 DATE（DWD 强类型日期） | inv_detail | 信息汇总表,货物清单 | kprq | try_cast(kprq as date) | 开票日期（解析后）；源于 ODS kprq |
| dwd_inv_detail | special_business_type | varchar |  | A | 直接映射特定业务类型，trim（信息汇总表常见） | inv_detail | 信息汇总表,货物清单 | special_business_type | trim(cast(special_business_type as varchar)) | 特定业务类型；信息汇总表常见，货物清单常空 |
| dwd_inv_detail | xfsbh | varchar |  | A | 行级冗余销方税号，trim | inv_detail | 信息汇总表,货物清单 | seller_tax_no | trim(seller_tax_no) |  |
| dwd_inv_detail | xfmc | varchar |  | A | 行级冗余销方名称，trim | inv_detail | 信息汇总表,货物清单 | seller_name | trim(seller_name) |  |
| dwd_inv_detail | gfsbh | varchar |  | A | 行级冗余购方税号，trim | inv_detail | 信息汇总表,货物清单 | buyer_tax_no | trim(buyer_tax_no) |  |
| dwd_inv_detail | gfmc | varchar |  | A | 行级冗余购方名称，trim | inv_detail | 信息汇总表,货物清单 | buyer_name | trim(buyer_name) |  |
| dwd_inv_detail | fply | varchar |  | A | 行级冗余发票来源，trim | inv_detail | 信息汇总表,货物清单 | invoice_source | trim(invoice_source) |  |
| dwd_inv_detail | fppz | varchar |  | A | 行级冗余发票票种/类型，trim | inv_detail | 信息汇总表,货物清单 | invoice_type | trim(invoice_type) |  |
| dwd_inv_detail | fpzt | varchar |  | A | 行级冗余发票状态，trim | inv_detail | 信息汇总表,货物清单 | invoice_status | trim(invoice_status) |  |
| dwd_inv_detail | sfzsfp | varchar |  | A | 行级冗余是否正数发票等标志，转字符串后 trim | inv_detail | 信息汇总表,货物清单 | is_positive_invoice | trim(cast(is_positive_invoice as varchar)) |  |
| dwd_inv_detail | fpfxdj | varchar |  | A | 行级冗余风险等级，trim | inv_detail | 信息汇总表,货物清单 | invoice_risk_level | trim(invoice_risk_level) |  |
| dwd_inv_detail | kpr | varchar |  | A | 行级冗余开票人，trim | inv_detail | 信息汇总表,货物清单 | drawer | trim(drawer) |  |
| dwd_inv_detail | bz | varchar |  | A | 行级冗余备注，trim | inv_detail | 信息汇总表,货物清单 | remark | trim(remark) |  |
| dwd_inv_detail | ssflbm | varchar |  | A | 直接映射税收分类编码，trim | inv_detail | 信息汇总表,货物清单 | tax_category_code | trim(tax_category_code) | 税收分类编码 |
| dwd_inv_detail | hwlwmc | varchar |  | A | 直接映射货物/劳务名称，trim | inv_detail | 信息汇总表,货物清单 | goods_name | trim(goods_name) | 货物或应税劳务名称 |
| dwd_inv_detail | ggxh | varchar |  | A | 直接映射规格型号，trim | inv_detail | 信息汇总表,货物清单 | spec_model | trim(spec_model) |  |
| dwd_inv_detail | dw | varchar |  | A | 直接映射单位，trim | inv_detail | 信息汇总表,货物清单 | unit | trim(unit) |  |
| dwd_inv_detail | sl | decimal |  | B | 数量清洗并转 DECIMAL(18,8) | inv_detail | 信息汇总表,货物清单 | quantity | try_cast(quantity as decimal(18,8)) | 数量 |
| dwd_inv_detail | dj | decimal |  | B | 单价清洗并转 DECIMAL(18,8) | inv_detail | 信息汇总表,货物清单 | unit_price | try_cast(unit_price as decimal(18,8)) | 单价 |
| dwd_inv_detail | je | decimal |  | B | 明细金额清洗并转 DECIMAL(18,2) | inv_detail | 信息汇总表,货物清单 | amount | try_cast(amount as decimal(18,2)) |  |
| dwd_inv_detail | slv | varchar |  | B | 税率原串规范化（trim） | inv_detail | 信息汇总表,货物清单 | tax_rate | trim(cast(tax_rate as varchar)) | 税率原始字符串 |
| dwd_inv_detail | slv_num | decimal |  | B | 税率解析为数值（如 13% -> 0.13；免税/零税率 -> 0） | inv_detail | 信息汇总表,货物清单 | tax_rate | parse_tax_rate_to_decimal(tax_rate) | 税率数值化 |
| dwd_inv_detail | se | decimal |  | B | 明细税额清洗并转 DECIMAL(18,2) | inv_detail | 信息汇总表,货物清单 | tax_amount | try_cast(tax_amount as decimal(18,2)) |  |
| dwd_inv_detail | jshj | decimal |  | B | 明细价税合计清洗并转 DECIMAL(18,2) | inv_detail | 信息汇总表,货物清单 | total_amount | try_cast(total_amount as decimal(18,2)) |  |
| dwd_inv_detail | import_batch_id | varchar |  | D | 血缘；来自 hive 分区列「批次」 | inv_detail | 信息汇总表,货物清单 | 批次 | cast(批次 as varchar) |  |
| dwd_inv_detail | import_session_id | varchar |  | D | 血缘；导入会话 ID（ODS 行内列） | inv_detail | 信息汇总表,货物清单 | import_session_id | trim(cast(import_session_id as varchar)) |  |
| dwd_inv_detail | ods_file_seq | integer |  | D | 血缘；来自 hive 分区 ods_file_seq | inv_detail | 信息汇总表,货物清单 | ods_file_seq | try_cast(ods_file_seq as integer) |  |
| dwd_inv_detail | source_excel_file | varchar |  | D | 血缘；来源 Excel 路径（ODS 行内列） | inv_detail | 信息汇总表,货物清单 | source_excel_file | trim(cast(source_excel_file as varchar)) |  |
| dwd_inv_detail | source_parquet_file | varchar |  | D | 血缘；来源 ODS Parquet 路径（ODS 行内列） | inv_detail | 信息汇总表,货物清单 | source_parquet_file | trim(cast(source_parquet_file as varchar)) |  |
| dwd_inv_detail | source_sheet | varchar |  | D | 血缘；来源工作表名（ODS 行内列） | inv_detail | 信息汇总表,货物清单 | source_sheet | trim(cast(source_sheet as varchar)) |  |
| dwd_inv_detail | ingest_ts | timestamp |  | D | 血缘；进入 ODS 链路的采集时间（ODS 行内列） | inv_detail | 信息汇总表,货物清单 | ingest_ts | try_cast(ingest_ts as timestamp) |  |
| dwd_inv_detail | dwd_build_ts |  |  | D | 血缘；本次写入 DWD 的构建时间（ETL 生成） | inv_detail | 信息汇总表,货物清单 |  | dwd_lineage |  |
| dwd_inv_detail | dwd_build_id |  |  | D | 血缘；本次写入 DWD 的构建任务 ID（ETL 生成） | inv_detail | 信息汇总表,货物清单 |  | dwd_lineage |  |
| dwd_inv_header | header_uuid | varchar | False | C | 主键派生；对发票代码/号码/数电票号做规范化后计算 MD5 | inv_header | 发票基础信息 | invoice_code,invoice_no,sdfphm | md5_hex(norm_fpdm\|\|norm_fphm\|\|norm_sdfphm) | 主键；MD5(规范化后的 fpdm\|\|fphm\|\|sdfphm)，与 dwd.sql 注释一致 |
| dwd_inv_header | stat_year | smallint | False | C | 由 ODS kprq 解析为日期后取年份（用于分区/过滤） | inv_header | 发票基础信息 | kprq | year(try_cast(kprq as date)) | 自开票日期解析的统计年度，核心分区过滤列 |
| dwd_inv_header | stat_month | smallint | False | C | 由 ODS kprq 解析为日期后取月份 1-12（用于按月统计/索引） | inv_header | 发票基础信息 | kprq | month(try_cast(kprq as date)) | 自开票日期解析的月份 1–12；与 stat_year 同派生，便于按月汇总与索引 |
| dwd_inv_header | fpdm | varchar |  | A | 直接映射发票代码，trim | inv_header | 发票基础信息 | invoice_code | trim(invoice_code) | 发票代码（数电票可能为空） |
| dwd_inv_header | fphm | varchar |  | A | 直接映射发票号码，trim | inv_header | 发票基础信息 | invoice_no | trim(invoice_no) | 发票号码 |
| dwd_inv_header | sdfphm | varchar |  | A | 直接映射数电票号码，trim | inv_header | 发票基础信息 | sdfphm | trim(sdfphm) | 数电票号码 |
| dwd_inv_header | xfsbh | varchar |  | A | 直接映射销方税号，trim | inv_header | 发票基础信息 | seller_tax_no | trim(seller_tax_no) | 销方纳税人识别号 |
| dwd_inv_header | xfmc | varchar |  | A | 直接映射销方名称，trim | inv_header | 发票基础信息 | seller_name | trim(seller_name) | 销方名称 |
| dwd_inv_header | gfsbh | varchar |  | A | 直接映射购方税号，trim | inv_header | 发票基础信息 | buyer_tax_no | trim(buyer_tax_no) | 购方纳税人识别号 |
| dwd_inv_header | gfmc | varchar |  | A | 直接映射购方名称，trim | inv_header | 发票基础信息 | buyer_name | trim(buyer_name) | 购方名称 |
| dwd_inv_header | kprq | varchar |  | A | 直接映射开票日期原始串（ODS 标准列 kprq），trim | inv_header | 发票基础信息 | kprq | trim(cast(kprq as varchar)) | 开票日期原始串；ODS 标准列 kprq |
| dwd_inv_header | invoice_date | date |  | B | 将 ODS kprq 解析为 DATE（DWD 强类型日期） | inv_header | 发票基础信息 | kprq | try_cast(kprq as date) | 开票日期（解析后，DWD）；源于 ODS kprq |
| dwd_inv_header | invoice_time | time |  | A | 当前无来源，置空（后续若接入时分秒再补） | inv_header | 发票基础信息 |  | null | 若 ODS 仅日期无时分秒，可为 NULL |
| dwd_inv_header | je | decimal |  | B | 金额字段清洗并转 DECIMAL(18,2) | inv_header | 发票基础信息 | amount | try_cast(amount as decimal(18,2)) | 金额 |
| dwd_inv_header | se | decimal |  | B | 税额字段清洗并转 DECIMAL(18,2) | inv_header | 发票基础信息 | tax_amount | try_cast(tax_amount as decimal(18,2)) | 税额 |
| dwd_inv_header | jshj | decimal |  | B | 价税合计字段清洗并转 DECIMAL(18,2) | inv_header | 发票基础信息 | total_amount | try_cast(total_amount as decimal(18,2)) | 价税合计 |
| dwd_inv_header | fply | varchar |  | A | 直接映射发票来源，trim | inv_header | 发票基础信息 | invoice_source | trim(invoice_source) | 发票来源等（与 DWD 列语义对齐时按需映射） |
| dwd_inv_header | fppz | varchar |  | A | 直接映射发票票种/类型，trim | inv_header | 发票基础信息 | invoice_type | trim(invoice_type) | 发票票种/类型 |
| dwd_inv_header | fpzt | varchar |  | A | 直接映射发票状态，trim；红冲 post_etl 中 NULL/空串在计算口径上视同「正常」（不改正文列，缺失仍可做异常统计） | inv_header | 发票基础信息 | invoice_status | trim(invoice_status) | 发票状态 |
| dwd_inv_header | sfzsfp | varchar |  | A | 直接映射是否正数发票等标志，转字符串后 trim | inv_header | 发票基础信息 | is_positive_invoice | trim(cast(is_positive_invoice as varchar)) | 是否正数发票等（以业务字典为准） |
| dwd_inv_header | fpfxdj | varchar |  | A | 直接映射风险等级，trim | inv_header | 发票基础信息 | invoice_risk_level | trim(invoice_risk_level) | 风险等级（若 ODS 有独立字段可再接） |
| dwd_inv_header | kpr | varchar |  | A | 直接映射开票人，trim | inv_header | 发票基础信息 | drawer | trim(drawer) | 开票人 |
| dwd_inv_header | bz | varchar |  | A | 直接映射备注，trim | inv_header | 发票基础信息 | remark | trim(remark) | 备注 |
| dwd_inv_header | import_batch_id | varchar |  | D | 血缘；来自 hive 分区列「批次」 | inv_header | 发票基础信息 | 批次 | cast(批次 as varchar) | 本行映射对应的导入批次（通常等同分区列「批次」） |
| dwd_inv_header | import_session_id | varchar |  | D | 血缘；导入会话 ID（ODS 行内列） | inv_header | 发票基础信息 | import_session_id | trim(cast(import_session_id as varchar)) | 导入会话 ID |
| dwd_inv_header | ods_file_seq | integer |  | D | 血缘；来自 hive 分区 ods_file_seq | inv_header | 发票基础信息 | ods_file_seq | try_cast(ods_file_seq as integer) | ODS 分片序号（hive 分区 ods_file_seq=） |
| dwd_inv_header | source_excel_file | varchar |  | D | 血缘；来源 Excel 路径（ODS 行内列） | inv_header | 发票基础信息 | source_excel_file | trim(cast(source_excel_file as varchar)) | 来源 Excel 路径 |
| dwd_inv_header | source_parquet_file | varchar |  | D | 血缘；来源 ODS Parquet 路径（ODS 行内列） | inv_header | 发票基础信息 | source_parquet_file | trim(cast(source_parquet_file as varchar)) | 落盘 ODS Parquet 路径 |
| dwd_inv_header | source_sheet | varchar |  | D | 血缘；来源工作表名（ODS 行内列） | inv_header | 发票基础信息 | source_sheet | trim(cast(source_sheet as varchar)) | 来源工作表名 |
| dwd_inv_header | ingest_ts | timestamp |  | D | 血缘；进入 ODS 链路的采集时间（ODS 行内列） | inv_header | 发票基础信息 | ingest_ts | try_cast(ingest_ts as timestamp) | 进入 ODS 链路的采集时间 |
| dwd_inv_header | dwd_build_ts |  |  | D | 血缘；本次写入 DWD 的构建时间（ETL 生成） | inv_header | 发票基础信息 |  | dwd_lineage | 写入 DWD 的时间（ETL 生成） |
| dwd_inv_header | dwd_build_id |  |  | D | 血缘；本次写入 DWD 的构建任务 ID（ETL 生成） | inv_header | 发票基础信息 |  | dwd_lineage | DWD 构建任务 ID（ETL 生成） |
| dwd_inv_header | first_import_batch_id | varchar | False | C | 首次占据该 header_uuid 的批次（先到先得去重语义） | inv_header | 发票基础信息 | 批次 | cast(批次 as varchar) | 首次写入该 header 的批次（去重策略：先到先得） |
| dwd_inv_header | first_import_file | varchar | False | C | 首次占据该 header_uuid 的来源文件（先到先得去重语义） | inv_header | 发票基础信息 | source_excel_file | coalesce(trim(source_excel_file), '') | 首次导入来源文件（可用 source_excel_file 或 manifest） |
| dwd_inv_header | detail_total_amount |  |  | C | 导入后回填；按 header_uuid 汇总明细 jshj（排除 logic_line_no=0） | inv_header | 发票基础信息 |  | post_aggregate | 由明细汇总回填 |
| dwd_inv_header | is_balanced |  |  | C | 导入后回填；按平账规则产出（未校验/平账/不平账等） | inv_header | 发票基础信息 |  | post_aggregate |  |
| dwd_inv_header | balance_diff |  |  | C | 导入后回填；主表 jshj 与明细汇总差异 | inv_header | 发票基础信息 |  | post_aggregate |  |
| dwd_inv_header | related_blue_invoice_uuid |  |  | C | 导入后回填；红票须「发票状态视为正常」（显式正常或 fpzt 空/NULL 按迁移口径视同正常）；bz 由 UDF 多模式解析，md5 反查 dwd_inv_header（header_uuid，可跨年）；仅本批次 dwd_build_id；库中无蓝票则不填 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | net_je |  |  | C | 导入后回填；仅蓝票；蓝票.je + 全库指向该蓝票的「fpzt 视为正常」红票 je 之和（多红对一蓝分项可加） | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | net_se |  |  | C | 导入后回填；仅蓝票；蓝票.se + 全库「fpzt 视为正常」红票 se 之和 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | net_jshj |  |  | C | 导入后回填；仅蓝票；蓝票.jshj + 全库「fpzt 视为正常」红票 jshj 之和 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | net_calc_status |  |  | C | 导入后回填；红票关联成功为「蓝票已计算」；可解析但未入库匹配为「孤立红票」（fpzt 视为正常者）；蓝票侧有红冲为「蓝票已计算」或「已全额红冲」；红票不写净额列；显式已作废等不参与红冲、蓝票侧已作废状态不覆盖 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | balance_tolerance |  |  | C | 导入后回填；平账容差（默认 0.10） | inv_header | 发票基础信息 |  | post_aggregate |  |
| dwd_inv_header | balance_check_time |  |  | C | 导入后回填；平账校验时间 | inv_header | 发票基础信息 |  | post_aggregate |  |
| dwd_inv_header | balance_notes |  |  | C | 导入后回填；平账备注/说明 | inv_header | 发票基础信息 |  | post_aggregate |  |
| dwd_inv_header | red_offset_jshj |  |  | C | 导入后回填；全库（可跨年）related_blue 指向该蓝票且「fpzt 视为正常」（含空/NULL）的红票 SUM(jshj)；本批次触发时对触及的蓝票重算 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | red_invoice_count |  |  | C | 导入后回填；全库 related_blue 指向该蓝票且「fpzt 视为正常」（含空/NULL）的红票行数 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | is_fully_reversed |  |  | C | 导入后回填；\|蓝票.jshj + red_offset_jshj\| ≤ balance_tolerance（默认 0.10）时为 true | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | is_orphan_red |  |  | C | 导入后回填；「fpzt 视为正常」（含空/NULL）且 bz 可解析目标蓝票 UUID 但库中无对应 header 时为 true；已关联则 false；显式非「正常」且非空（如已作废）不参与 | inv_header | 发票基础信息 |  | post_etl |  |
| dwd_inv_header | net_calc_time |  |  | C | 导入后回填；净额计算时间 | inv_header | 发票基础信息 |  | post_etl |  |

## 备注

- `layer` 当前若为空，表示该列尚未补充分层标注（后续建议强制 A/B/C/D）。
- `rule_zh` 为中文口径说明；用于快速查阅与排错。
- `expr/populate` 仅用于对齐语义；真正 SQL 以 ETL 实现为准。
