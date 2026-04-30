# DWD 专项明细字段对齐清单

本文用于统一专项 DWD 明细表（`dwd_spc_*`）与通用明细表（`dwd_inv_detail`）的字段口径，作为开发、联调、评审依据。

## 1. 对齐范围

适用专项表：

- `dwd_spc_transport_passenger`
- `dwd_spc_transport_freight`
- `dwd_spc_vehicle_sales`
- `dwd_spc_construction_service`
- `dwd_spc_estate_lease`

对齐原则：

- 粒度以 `detail` 为准（非 `header` 粒度）。
- 通用字段优先复用 `dwd_inv_detail` 既有命名。
- 票头属性字段可按明细冗余落地（便于明细侧直接查询）。
- 专项特有业务字段允许保留专项命名，不强制与通用明细同名。

## 2. 字段对齐矩阵（专项 -> 通用明细）

### 2.1 主键与粒度字段

- [x] `detail_uuid` -> `dwd_inv_detail.detail_uuid`
- [x] `header_uuid` -> `dwd_inv_detail.header_uuid`
- [x] `stat_year` -> `dwd_inv_detail.stat_year`
- [x] `stat_month` -> `dwd_inv_detail.stat_month`
- [x] `logic_line_no` -> `dwd_inv_detail.logic_line_no`

### 2.2 发票基础字段（明细冗余票面）

- [x] `fpdm` -> `dwd_inv_detail.fpdm`（发票代码）
- [x] `fphm` -> `dwd_inv_detail.fphm`（发票号码）
- [x] `sdfphm` -> `dwd_inv_detail.sdfphm`（数电发票号码）
- [x] `kprq` -> `dwd_inv_detail.kprq`（开票日期原串）
- [x] `invoice_date` -> `dwd_inv_detail.invoice_date`（解析日期）
- [x] `fppz` -> `dwd_inv_detail.fppz`（发票票种）
- [x] `invoice_status`（语义）-> `dwd_inv_detail.fpzt`（发票状态）
- [x] `is_positive_invoice`（语义）-> `dwd_inv_detail.sfzsfp`（是否正数发票）
- [x] `remark`（语义）-> `dwd_inv_detail.bz`（备注）

### 2.3 购销方字段（重点）

- [x] `xfsbh` -> `dwd_inv_detail.xfsbh`（销方纳税人识别号）
- [x] `xfmc` -> `dwd_inv_detail.xfmc`（销方名称）
- [x] `gfsbh` -> `dwd_inv_detail.gfsbh`（购买方纳税人识别号）
- [x] `gfmc` -> `dwd_inv_detail.gfmc`（购买方名称）

Excel/ODS 候选列（用于字段归一）：

- [x] `xfsbh`: `xfsbh` / `seller_tax_no` / `销方识别号` / `销方税号`
- [x] `xfmc`: `xfmc` / `seller_name` / `销方名称`
- [x] `gfsbh`: `gfsbh` / `buyer_tax_no` / `购买方识别号` / `购买方税号` / `购方税号`
- [x] `gfmc`: `gfmc` / `buyer_name` / `购买方名称` / `购方名称`

### 2.4 金额字段

- [x] `je` -> `dwd_inv_detail.je`（金额）
- [x] `se` -> `dwd_inv_detail.se`（税额）
- [x] `jshj` -> `dwd_inv_detail.jshj`（价税合计）

### 2.5 血缘字段

- [x] `import_batch_id` -> `dwd_inv_detail.import_batch_id`
- [x] `import_session_id` -> `dwd_inv_detail.import_session_id`
- [x] `ods_file_seq` -> `dwd_inv_detail.ods_file_seq`
- [x] `source_excel_file` -> `dwd_inv_detail.source_excel_file`
- [x] `source_parquet_file` -> `dwd_inv_detail.source_parquet_file`
- [x] `source_sheet` -> `dwd_inv_detail.source_sheet`
- [x] `ingest_ts` -> `dwd_inv_detail.ingest_ts`
- [x] `dwd_build_ts` -> `dwd_inv_detail.dwd_build_ts`
- [x] `dwd_build_id` -> `dwd_inv_detail.dwd_build_id`

## 3. 专项特有字段（不强制通用同名）

### 3.1 客运专项

- [x] `passenger_name`
- [x] `traveler_id_no`
- [x] `trip_date`
- [x] `trip_time`
- [x] `departure_place`
- [x] `arrival_place`
- [x] `transport_means_type`
- [x] `service_class`
- [x] `trip_no`

### 3.2 货运专项

- [x] `cargo_name`
- [x] `departure_place`
- [x] `arrival_place`
- [x] `transport_means_plate_no`
- [x] `transport_means_type`

### 3.3 机动车销售专项

- [x] `source_table_type`
- [x] `trade_org_name`
- [x] `trade_org_tax_no`
- [x] `vin_chassis`
- [x] `engine_no`
- [x] `vehicle_certificate_no`
- [x] `commodity_inspection_no`
- [x] `place_of_origin`
- [x] `vehicle_plate_no`
- [x] `registration_cert_no`
- [x] `transfer_dmv_office`
- [x] `buyer_address`
- [x] `buyer_phone`

### 3.4 建筑服务专项

- [x] `construction_project_name`
- [x] `construction_service_location`
- [x] `cross_region_tax_mgmt_no`

### 3.5 不动产经营租赁专项

- [x] `license_plate_no`
- [x] `property_title_cert_no`

## 4. 覆盖状态（本轮改动）

- [x] 5 张专项表 DDL 补齐 `xfsbh/xfmc/gfsbh/gfmc`
- [x] 5 张专项表 DDL 补齐通用字段中文注释（含血缘字段）
- [x] `src/etl/cleaner.py` 对应 5 段 `INSERT INTO dwd_spc_*` 已接入 4 个购销方字段写入
- [x] 5 份专项映射 `config/dwd_mapping/dwd_spc_*.yaml` 已补齐 4 个购销方字段映射
- [x] 旧库兼容迁移：已在 `db/schema_sqlfiles.py` 增加专项表缺失列幂等补列逻辑

## 5. 待确认项（评审可选）

- [ ] 是否需要把 `invoice_status/is_positive_invoice/remark` 在专项层重命名为 `fpzt/sfzsfp/bz`（当前保持专项历史命名，仅做语义对齐）
- [ ] 是否新增一层统一视图（如 `vw_dwd_spc_detail_unified`）对外暴露完全统一命名
- [ ] 是否补充专项字段级数据质量规则（如税号长度、身份证号格式、车架号长度等）

