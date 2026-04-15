-- =============================================================================
-- ODS 层 DuckDB 定义：导入元数据表 + 基于 Parquet 的业务视图
--
-- 配套文件（修改本 SQL 前建议先对照）：
--   config/sheet_mapping.yaml   Excel 工作表名（包含匹配）→ 分区表类型 table_type
--   config/field_mapping.yaml     各 sheet 表头 → ODS 标准列名（Parquet 列）
--   src/ingestion/excel_to_ods.py  写出 Parquet、分区目录、溯源列、ods_* 表写入
--
-- 初始化行为（见 db/schema_sqlfiles.py）：
--   若某 glob 下尚无 Parquet，会创建占位视图避免 DuckDB 启动失败；有数据后会 OR REPLACE 为真实 read_parquet。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ods_batch_state：导入批次状态机（简化三态）
-- 写入：load_excel_batch_to_ods 在批次开始置 running，结束置 success/failed
-- 主键 import_batch_id：必须与目录 data/ods/批次=<import_batch_id>/ 一致，便于与磁盘、日志对账
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ods_batch_state (
    import_batch_id TEXT NOT NULL PRIMARY KEY,
    status           VARCHAR NOT NULL,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message          VARCHAR
);

-- -----------------------------------------------------------------------------
-- ods_file_fingerprint：源文件内容哈希（file_hash）维度的导入履历
-- 用途：重复文件软拦截；记录首次成功导入的 batch/session，供审计判断「是否同文件多次入湖」
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ods_file_fingerprint (
    file_hash                    VARCHAR NOT NULL PRIMARY KEY,
    first_success_import_batch_id    TEXT,
    first_success_import_session_id  TEXT,
    last_status                 VARCHAR,
    last_seen_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- ods_load_log：单次「批次 × 导入会话」的汇总日志
-- 主键 (import_batch_id, import_session_id)：同一批次可有多会话（并发或重跑）
-- parquet_paths：本次涉及的 ODS Parquet 路径摘要；detail_json：扩展明细（实现自定）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ods_load_log (
    import_batch_id     TEXT NOT NULL,
    import_session_id   TEXT NOT NULL,
    load_time            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    file_count           INTEGER,
    total_rows           INTEGER,
    success_count        INTEGER,
    fail_count           INTEGER,
    warn_count           INTEGER,

    parquet_paths        VARCHAR,
    detail_json          TEXT,

    -- DWD 增量水位：某 import_session 在 ODS→DWD 全年度成功落盘后写入；NULL 表示尚未完成增量处理
    dwd_session_processed_at TIMESTAMP,

    PRIMARY KEY (import_batch_id, import_session_id)
);

-- ============================================================
-- ODS 业务数据：read_parquet 视图（真源在磁盘 Parquet）
--
-- 目录布局（与 excel_to_ods 一致）：
--   data/ods/批次=<batch_id>/表类型=<table_type>/ods_file_seq=<n>/*.parquet
--
-- 分区列（hive_partitioning=1 从路径解析）：
--   批次、表类型、ods_file_seq — 勿改用「序号=」作分区目录名（与业务列「序号」冲突，见 excel_to_ods 内注释）
--
-- 视图内别名：
--   批次 AS batch_id、表类型 AS table_type — 便于应用层/SQL 用英文列名过滤；与分区中文键并存
--
-- union_by_name=true：
--   同一 table_type 下多文件列略有不齐时，按列名并集对齐，减少读失败
--
-- 视图命名：ods_<table_type>，其中 <table_type> 须与 sheet_mapping 的 value 及磁盘 表类型= 完全一致
--
-- 关于「sheet_mapping 键」：
--   仅指 config/sheet_mapping.yaml 里映射对象左侧、引号内的字面名（导入时对工作表名做「包含匹配」的候选键）。
--   该行 `#` 之后为「YAML 行内说明」，不是键；注释里二者分开展示，避免把说明误当成键名。
-- ============================================================

-- -----------------------------------------------------------------------------
-- ods_inv_header
-- 分区 table_type：inv_header
-- sheet_mapping 键：发票基础信息
-- YAML 行内说明：兼容旧模板/工作簿表名；与「发票基础数据」同一 ODS 类型
-- 业务：增值税发票主表信息行
-- 列定义：field_mapping.yaml 中与本键同名的 sheet 块
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS ods_inv_header AS
SELECT
    *,
    批次   AS batch_id,
    表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=inv_header/**/*.parquet',
    hive_partitioning=1,
    union_by_name=true
);

-- -----------------------------------------------------------------------------
-- ods_inv_detail
-- 分区 table_type：inv_detail
-- sheet_mapping 键：信息汇总表、货物清单
-- YAML 行内说明（逐字摘抄自 config/sheet_mapping.yaml 各键所在行的 `#` 后；改 YAML 时须同步本段）：
--   「信息汇总表」：货物或服务的详细清单，提供更全面的发票数据概览，可能包含红字发票统计
--   「货物清单」：货物或服务的详细清单，提供更全面的发票数据概览。老版本金税系统中会使用，与信息汇总表不会同时出现
-- 行级追溯：Parquet 列 source_sheet 保留原始工作表名
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS ods_inv_detail AS
SELECT
    *,
    批次   AS batch_id,
    表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=inv_detail/**/*.parquet',
    hive_partitioning=1,
    union_by_name=true
);

-- ---------------------------------------------------------------------------
-- 以下为特殊票种 / 行业模板（table_type = spc_*）
-- 每视图前两行：视图名与分区 | sheet_mapping 键（仅 YAML 左侧字面名）
-- 次行：YAML 行内说明（摘抄自该行 `#` 后；无则写「无」）
-- ---------------------------------------------------------------------------

-- ods_spc_estate | 表类型=spc_estate | sheet_mapping 键：不动产销售
-- YAML 行内说明：房地产销售类
CREATE VIEW IF NOT EXISTS ods_spc_estate AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_estate/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_vehicle | 表类型=spc_vehicle | sheet_mapping 键：机动车销售
-- YAML 行内说明：机动车销售
CREATE VIEW IF NOT EXISTS ods_spc_vehicle AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_vehicle/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_used_vehicle | 表类型=spc_used_vehicle | sheet_mapping 键：二手车销售
-- YAML 行内说明：二手车
CREATE VIEW IF NOT EXISTS ods_spc_used_vehicle AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_used_vehicle/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_agri_machinery | 表类型=spc_agri_machinery | sheet_mapping 键：拖拉机
-- YAML 行内说明：拖拉机和联合收割机，农机购置补贴相关
CREATE VIEW IF NOT EXISTS ods_spc_agri_machinery AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_agri_machinery/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_oil | 表类型=spc_oil | sheet_mapping 键：成品油
-- YAML 行内说明：成品油采购与销售
CREATE VIEW IF NOT EXISTS ods_spc_oil AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_oil/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_rare_earth | 表类型=spc_rare_earth | sheet_mapping 键：稀土
-- YAML 行内说明：无
CREATE VIEW IF NOT EXISTS ods_spc_rare_earth AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_rare_earth/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_agri_acquisition | 表类型=spc_agri_acquisition | sheet_mapping 键：农产品收购
-- YAML 行内说明：农产品收购
CREATE VIEW IF NOT EXISTS ods_spc_agri_acquisition AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_agri_acquisition/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_agri_self_produced | 表类型=spc_agri_self_produced | sheet_mapping 键：自产农产品
-- YAML 行内说明：自产农产品销售
CREATE VIEW IF NOT EXISTS ods_spc_agri_self_produced AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_agri_self_produced/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_pv_acquisition | 表类型=spc_pv_acquisition | sheet_mapping 键：光伏
-- YAML 行内说明：光伏收购
CREATE VIEW IF NOT EXISTS ods_spc_pv_acquisition AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_pv_acquisition/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_scrap_acquisition | 表类型=spc_scrap_acquisition | sheet_mapping 键：报废产品收购
-- YAML 行内说明：资源回收行业
CREATE VIEW IF NOT EXISTS ods_spc_scrap_acquisition AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_scrap_acquisition/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_intangible | 表类型=spc_intangible | sheet_mapping 键：无形资产
-- YAML 行内说明：专利、商标、著作权等
CREATE VIEW IF NOT EXISTS ods_spc_intangible AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_intangible/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_construction | 表类型=spc_construction | sheet_mapping 键：建筑服务
-- YAML 行内说明：建筑安装工程类
CREATE VIEW IF NOT EXISTS ods_spc_construction AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_construction/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_finance | 表类型=spc_finance | sheet_mapping 键：金融服务
-- YAML 行内说明：金融保险类
CREATE VIEW IF NOT EXISTS ods_spc_finance AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_finance/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_modern_service | 表类型=spc_modern_service | sheet_mapping 键：现代服务
-- YAML 行内说明：研发、信息技术、文化创意等
CREATE VIEW IF NOT EXISTS ods_spc_modern_service AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_modern_service/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_life_service | 表类型=spc_life_service | sheet_mapping 键：生活服务
-- YAML 行内说明：餐饮、住宿、旅游等服务
CREATE VIEW IF NOT EXISTS ods_spc_life_service AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_life_service/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_medical | 表类型=spc_medical | sheet_mapping 键：医疗服务
-- YAML 行内说明：医疗机构开票专用
CREATE VIEW IF NOT EXISTS ods_spc_medical AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_medical/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_toll | 表类型=spc_toll | sheet_mapping 键：通行费
-- YAML 行内说明：高速公路等通行费
CREATE VIEW IF NOT EXISTS ods_spc_toll AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_toll/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_estate_lease | 表类型=spc_estate_lease | sheet_mapping 键：不动产经营租赁
-- YAML 行内说明：房屋租赁类
CREATE VIEW IF NOT EXISTS ods_spc_estate_lease AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_estate_lease/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_tangible_lease | 表类型=spc_tangible_lease | sheet_mapping 键：有形动产租赁
-- YAML 行内说明：设备租赁等
CREATE VIEW IF NOT EXISTS ods_spc_tangible_lease AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_tangible_lease/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_freight | 表类型=spc_freight | sheet_mapping 键：货物运输服务
-- YAML 行内说明：货物运输服务类
CREATE VIEW IF NOT EXISTS ods_spc_freight AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_freight/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_passenger_transport | 表类型=spc_passenger_transport | sheet_mapping 键：旅客运输服务
-- YAML 行内说明：出租车、网约车服务
CREATE VIEW IF NOT EXISTS ods_spc_passenger_transport AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_passenger_transport/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_rail_eticket | 表类型=spc_rail_eticket | sheet_mapping 键：铁路电子客票
-- YAML 行内说明：2024年11月1日前为“铁路客票”（纸质报销凭证）
CREATE VIEW IF NOT EXISTS ods_spc_rail_eticket AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_rail_eticket/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_rail_ticket | 表类型=spc_rail_ticket | sheet_mapping 键：铁路客票
-- YAML 行内说明：无（历史纸质口径见「铁路电子客票」键的 YAML 行内说明）
CREATE VIEW IF NOT EXISTS ods_spc_rail_ticket AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_rail_ticket/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_air_transport | 表类型=spc_air_transport | sheet_mapping 键：航空运输
-- YAML 行内说明：航空运输电子客票、航空运输行程单
CREATE VIEW IF NOT EXISTS ods_spc_air_transport AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_air_transport/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_vehicle_vessel_tax | 表类型=spc_vehicle_vessel_tax | sheet_mapping 键：车船税
-- YAML 行内说明：代收车船税
CREATE VIEW IF NOT EXISTS ods_spc_vehicle_vessel_tax AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_vehicle_vessel_tax/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_diff_taxation | 表类型=spc_diff_taxation | sheet_mapping 键：差额征税
-- YAML 行内说明：无
CREATE VIEW IF NOT EXISTS ods_spc_diff_taxation AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_diff_taxation/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);

-- ods_spc_agency_invoice | 表类型=spc_agency_invoice | sheet_mapping 键：代开发票
-- YAML 行内说明：税务机关代开场景
CREATE VIEW IF NOT EXISTS ods_spc_agency_invoice AS
SELECT *, 批次 AS batch_id, 表类型 AS table_type
FROM read_parquet(
    'data/ods/批次=*/表类型=spc_agency_invoice/**/*.parquet',
    hive_partitioning=1, union_by_name=true
);
