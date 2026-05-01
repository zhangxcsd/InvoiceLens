-- =============================================================================
-- DWD 层表结构（按「A/B/C/D 分层」梳理，详见 docs/DWD分层与映射原则.md）
--
-- A 直接映射：ODS 标准字段 → DWD 列（rename/cast）
-- B 规则清洗：在 ETL 中完成 transform 后写入（常与 A 共用目标列，见各列注释）
-- C 派生：键、年度、行号、批处理回填结果等
-- D 血缘：import_batch_id / import_session_id / ods_file_seq / source_* / ingest_ts /
--         dwd_build_ts / dwd_build_id（全库统一命名）
--
-- 注意：已存在的 DuckDB 库不会自动新增列；结构变更需配套迁移脚本或重建表。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dwd_inv_header：全局发票主表（无 group_id，先到先得去重）
-- 净额字段内嵌（宽表设计），无单独净额表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_inv_header (
    -- =========================
    -- 【C】主键与分区键（派生）
    -- =========================
    header_uuid      VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(全角转半角后的 fpdm || fphm || sdfphm)
    stat_year        SMALLINT NOT NULL,
    -- 从 invoice_date 解析，核心年度过滤列
    stat_month       SMALLINT NOT NULL,
    -- 从 invoice_date 解析的月份 1–12；与 stat_year 同属【C】派生，便于按月汇总与分区裁剪（亦可 SELECT 时用 EXTRACT(month FROM invoice_date)，但物化列对索引/物化视图更友好）

    -- =========================
    -- 【A】直接映射（ODS 蛇形字段 → DWD 票面列；类型在 ETL cast）
    -- 【B】规则清洗：与 A 同名列时在 ETL 内完成 trim/全半角/日期解析等
    -- =========================
    fpdm     VARCHAR,  fphm     VARCHAR,  sdfphm   VARCHAR,
    xfsbh    VARCHAR,  xfmc     VARCHAR,
    gfsbh    VARCHAR,  gfmc     VARCHAR,
    kprq     VARCHAR,
    -- 解析后的 DATE / TIME；均由 ETL 从 ODS kprq 解析（非 ODS 落盘列名）；仅日期无时分秒时 invoice_time 为 NULL
    invoice_date  DATE,
    invoice_time  TIME,
    je       DECIMAL(18,2),
    se       DECIMAL(18,2),
    jshj     DECIMAL(18,2),
    fply     VARCHAR,
    fppz     VARCHAR,
    fpzt     VARCHAR,
    sfzsfp   VARCHAR,
    fpfxdj   VARCHAR,
    kpr      VARCHAR,
    bz       VARCHAR,

    -- =========================
    -- 【C】导入后回填：平账（非 ODS 行级一次性映射）
    -- =========================
    detail_total_amount DECIMAL(18,2),
    is_balanced         VARCHAR DEFAULT '未校验',
    -- 枚举：未校验 / 平账 / 不平账 / 差异可接受 / 强制通过
    balance_diff        DECIMAL(18,2),
    balance_tolerance   DECIMAL(18,2) DEFAULT 0.10,
    balance_check_time  TIMESTAMP,
    balance_notes       VARCHAR,

    -- =========================
    -- 【C】导入后回填：红蓝关联（ETL 从 bz 等解析）
    -- =========================
    related_blue_invoice_uuid VARCHAR,

    -- =========================
    -- 【C】导入后回填：净额 / 红冲（宽表内嵌）
    -- =========================
    net_je            DECIMAL(18,2),
    net_se            DECIMAL(18,2),
    net_jshj          DECIMAL(18,2),
    red_offset_jshj   DECIMAL(18,2) DEFAULT 0,
    red_invoice_count INT          DEFAULT 0,
    net_calc_status   VARCHAR      DEFAULT '未计算',
    -- 枚举：未计算 / 蓝票已计算 / 已全额红冲 / 孤立红票 / 已作废
    is_fully_reversed BOOLEAN DEFAULT FALSE,
    is_orphan_red     BOOLEAN DEFAULT FALSE,
    -- 孤立红票（未关联蓝票）保留负值参与 SUM 聚合（宽口径，决策三）
    net_calc_time     TIMESTAMP,

    -- =========================
    -- 【D】统一血缘（行级来源；与「首次占据」语义不同，见文档）
    -- =========================
    import_batch_id     VARCHAR,
    import_session_id   VARCHAR,
    ods_file_seq        INTEGER,
    source_excel_file   VARCHAR,
    source_parquet_file VARCHAR,
    source_sheet        VARCHAR,
    ingest_ts           TIMESTAMP,
    dwd_build_ts        TIMESTAMP,
    dwd_build_id        VARCHAR,

    -- =========================
    -- 首次占据主键（先到先得去重）：首次写入该 header 的批次与文件
    -- =========================
    first_import_batch_id VARCHAR NOT NULL,
    first_import_file     VARCHAR NOT NULL,

    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hdr_year    ON dwd_inv_header (stat_year);
CREATE INDEX IF NOT EXISTS idx_hdr_ym      ON dwd_inv_header (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_hdr_xfsbh   ON dwd_inv_header (xfsbh);
CREATE INDEX IF NOT EXISTS idx_hdr_gfsbh   ON dwd_inv_header (gfsbh);
CREATE INDEX IF NOT EXISTS idx_hdr_date    ON dwd_inv_header (invoice_date);
CREATE INDEX IF NOT EXISTS idx_hdr_bal     ON dwd_inv_header (is_balanced);
CREATE INDEX IF NOT EXISTS idx_hdr_blue    ON dwd_inv_header (related_blue_invoice_uuid);
CREATE INDEX IF NOT EXISTS idx_hdr_sfzsfp  ON dwd_inv_header (sfzsfp);
CREATE INDEX IF NOT EXISTS idx_hdr_net     ON dwd_inv_header (net_calc_status);
CREATE INDEX IF NOT EXISTS idx_hdr_ibatch  ON dwd_inv_header (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_inv_detail：全局发票明细表（无 group_id，与主表成对）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_inv_detail (
    -- =========================
    -- 【C】主键与关联键（派生/规则）
    -- =========================
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(全角转半角后的 fpdm || fphm || sdfphm || logic_line_no)；**不含** source_sheet（跨 sheet 重复导出同键丢弃，见 docs/dwd_inv_detail_multi_sheet_dedup.md）
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    -- 与 stat_year 同源于本行 invoice_date；货物清单等稀疏行若缺日期则 ETL 应拒收或整行不写入 DWD
    logic_line_no INT NOT NULL,
    -- 规则：在「同一发票键 + 同一 source_scope_key」分区内按 ODS 序号排序编号，从 1 起（不跨来源作用域）
    -- source_scope_key（ETL 内部键）= MD5(import_session_id || normalized(source_excel_file) || source_sheet)
    -- 特殊：hwlwmc 命中 config/dwd_goods_summary_phrases.yaml 短语且同票同 source_scope_key 明细≥2 条的汇总参考行赋值 0
    -- 下游聚合必须 WHERE logic_line_no > 0 排除汇总行

    -- =========================
    -- 【A】票面级冗余（与主表列名对齐；信息汇总表行上通常齐全，货物清单可能大量 NULL，免 JOIN header）
    -- 【B】清洗在 ETL
    -- =========================
    fpdm     VARCHAR,
    fphm     VARCHAR,
    sdfphm   VARCHAR,
    kprq     VARCHAR,
    -- 与主表一致：开票日期原串；ODS 标准列名为 kprq
    invoice_date  DATE,
    special_business_type VARCHAR,
    -- ODS special_business_type；特定业务类型（信息汇总表有，货物清单常空）
    xfsbh    VARCHAR,
    xfmc     VARCHAR,
    gfsbh    VARCHAR,
    gfmc     VARCHAR,
    fply     VARCHAR,
    fppz     VARCHAR,
    fpzt     VARCHAR,
    sfzsfp   VARCHAR,
    fpfxdj   VARCHAR,
    kpr      VARCHAR,
    bz       VARCHAR,

    -- =========================
    -- 【A】明细行字段 / 【B】清洗在 ETL
    -- =========================
    ssflbm    VARCHAR,   -- 税收分类编码（作废票/代开票可能为 NULL）
    hwlwmc    VARCHAR,   -- 货物或应税劳务名称
    ggxh      VARCHAR,   -- 规格型号
    dw        VARCHAR,   -- 单位
    sl        DECIMAL(18,8),
    dj        DECIMAL(18,8),
    je        DECIMAL(18,2),
    slv       VARCHAR,   -- 税率原始字符串（如"13%"/"免税"）
    slv_num   DECIMAL(10,6),  -- 税率数值化；不可转换时存 0（决策十一相关）
    se        DECIMAL(18,2),
    jshj      DECIMAL(18,2),

    -- =========================
    -- 【D】统一血缘
    -- =========================
    import_batch_id     VARCHAR,
    import_session_id   VARCHAR,
    ods_file_seq        INTEGER,
    source_excel_file   VARCHAR,
    source_parquet_file VARCHAR,
    source_sheet        VARCHAR,
    ingest_ts           TIMESTAMP,
    dwd_build_ts        TIMESTAMP,
    dwd_build_id        VARCHAR,

    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- 与 detail_uuid（票键+logic_line_no）语义一致：同票同逻辑行号最多一行；先写入者保留
    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_dtl_header  ON dwd_inv_detail (header_uuid);
CREATE INDEX IF NOT EXISTS idx_dtl_year    ON dwd_inv_detail (stat_year);
CREATE INDEX IF NOT EXISTS idx_dtl_ym      ON dwd_inv_detail (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_dtl_ssflbm  ON dwd_inv_detail (ssflbm);
CREATE INDEX IF NOT EXISTS idx_dtl_date    ON dwd_inv_detail (invoice_date);
CREATE INDEX IF NOT EXISTS idx_dtl_ibatch  ON dwd_inv_detail (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_inv_map：主体（被审计单位/法人）与发票头的关联表 —— 「这张票在本次分析里归哪个 entity」
--
-- 典型用途：集团多法人、多批次导入、同一 header_uuid 重复出现时，记录「某 entity 在某批次下认领该票」；
-- 供 DM/报表 JOIN 展示 entity_name，不等同于票面购方销方（那是 header 上的 gfsbh/xfsbh）。
--
-- invoice_dir（进项 / 销项）：业务视角标签（相对该主体是取得发票还是对外开具）。当前管道若尚无可靠判定规则，
-- 可全程置 NULL；勿在 DWD 硬编码猜测。有明确来源时（如目录约定、久其导入元数据、上游系统字段）再写入。
-- 同一张票可对不同主体、不同批次各有一行；唯一键见表末 UNIQUE。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_inv_map (
    -- =========================
    -- 【C】主键与业务键
    -- =========================
    map_uuid      VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(entity_id || header_uuid || coalesce(invoice_dir,'') || import_batch_id) 等，由 ETL 约定
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    entity_id     VARCHAR,
    entity_name   VARCHAR,
    invoice_dir   VARCHAR,
    -- 可选：进项 / 销项；无来源时 NULL
    clean_status  VARCHAR,

    -- =========================
    -- 【D】统一血缘（与其它 DWD 表一致，仅用 source_excel_file）
    -- =========================
    import_batch_id     VARCHAR NOT NULL,
    import_session_id   VARCHAR,
    ods_file_seq        INTEGER,
    source_excel_file   VARCHAR NOT NULL,
    source_parquet_file VARCHAR,
    source_sheet        VARCHAR,
    ingest_ts           TIMESTAMP,
    dwd_build_ts        TIMESTAMP,
    dwd_build_id        VARCHAR,

    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (stat_year, header_uuid, invoice_dir, entity_id, import_batch_id)
);

CREATE INDEX IF NOT EXISTS idx_map_header    ON dwd_inv_map (header_uuid);
CREATE INDEX IF NOT EXISTS idx_map_year      ON dwd_inv_map (stat_year);
CREATE INDEX IF NOT EXISTS idx_map_entity_ent ON dwd_inv_map (entity_id, import_batch_id);
CREATE INDEX IF NOT EXISTS idx_map_ibatch    ON dwd_inv_map (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_spc_transport_passenger：专项运输-客运明细
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_spc_transport_passenger (
    -- detail_uuid：与 dwd_inv_detail 相同公式 MD5(fw2hw(fpdm||fphm||sdfphm)||logic_line_no)，便于同逻辑行与明细对齐
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    -- 与 dwd_inv_detail 同源：_hdr_k+_scope_k 分区内编号，详见销货清单类汇总参考行为 0（见 src/etl/dwd_shared_logic_line.py）
    logic_line_no INTEGER NOT NULL,

    fpdm                  VARCHAR, -- 发票代码（Excel：发票代码）
    fphm                  VARCHAR, -- 发票号码（Excel：发票号码）
    sdfphm                VARCHAR, -- 数电发票号码
    kprq                  VARCHAR, -- 开票日期原串（Excel：开票日期/发票日期）
    invoice_date          DATE,    -- 开票日期（由 kprq 解析）
    fppz                  VARCHAR, -- 发票票种（Excel：发票票种）
    invoice_status        VARCHAR, -- 发票状态（Excel：发票状态）
    is_positive_invoice   VARCHAR, -- 是否正数发票（Excel：是否正数发票）
    remark                VARCHAR, -- 备注（Excel：备注）
    je                    DECIMAL(18,2), -- 金额
    se                    DECIMAL(18,2), -- 税额
    jshj                  DECIMAL(18,2), -- 价税合计
    xfsbh                 VARCHAR, -- 销方纳税人识别号（Excel：销方识别号/销方税号）
    xfmc                  VARCHAR, -- 销方名称（Excel：销方名称）
    gfsbh                 VARCHAR, -- 购买方纳税人识别号（Excel：购买方识别号/购买方税号）
    gfmc                  VARCHAR, -- 购买方名称（Excel：购买方名称/购方名称）

    passenger_name        VARCHAR, -- 旅客姓名
    traveler_id_no        VARCHAR, -- 有效身份证号
    trip_date             DATE,    -- 出行日期
    trip_time             VARCHAR, -- 出行时间（HH:MM）
    departure_place       VARCHAR, -- 出发地
    arrival_place         VARCHAR, -- 到达地
    transport_means_type  VARCHAR, -- 交通工具类型（铁路/航空/其他）
    service_class         VARCHAR, -- 舱位/席别等级
    trip_no               VARCHAR, -- 车次/航班号

    source_table_type     VARCHAR, -- 来源专项表类型（如 spc_passenger_transport/spc_rail_eticket/spc_air_transport）
    source_scope_key      VARCHAR, -- 来源作用域键（import_session_id+source_excel_file+source_sheet 组合哈希）
    is_business_in_scope  BOOLEAN, -- 是否纳入业务口径（发票状态=正常 且 是否正数发票=是）

    import_batch_id       VARCHAR, -- 导入批次 ID（批次）
    import_session_id     VARCHAR, -- 导入会话 ID
    ods_file_seq          INTEGER, -- ODS 分片序号（ods_file_seq）
    source_excel_file     VARCHAR, -- 来源 Excel 文件路径
    source_parquet_file   VARCHAR, -- 来源 ODS Parquet 文件路径
    source_sheet          VARCHAR, -- 来源工作表名
    ingest_ts             TIMESTAMP, -- 进入 ODS 链路时间
    dwd_build_ts          TIMESTAMP, -- DWD 构建写入时间
    dwd_build_id          VARCHAR, -- DWD 构建任务 ID
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spcp_header    ON dwd_spc_transport_passenger (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spcp_ym        ON dwd_spc_transport_passenger (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spcp_trip_date ON dwd_spc_transport_passenger (trip_date);
CREATE INDEX IF NOT EXISTS idx_spcp_ibatch    ON dwd_spc_transport_passenger (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_spc_transport_freight：专项运输-货运明细
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_spc_transport_freight (
    -- detail_uuid：与 dwd_inv_detail 相同公式（同票同 logic_line_no 与明细主键一致）
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    -- 与 dwd_inv_detail 同源编号规则（见 src/etl/dwd_shared_logic_line.py）
    logic_line_no INTEGER NOT NULL,

    fpdm                  VARCHAR, -- 发票代码（Excel：发票代码）
    fphm                  VARCHAR, -- 发票号码（Excel：发票号码）
    sdfphm                VARCHAR, -- 数电发票号码
    kprq                  VARCHAR, -- 开票日期原串（Excel：开票日期/发票日期）
    invoice_date          DATE,    -- 开票日期（由 kprq 解析）
    fppz                  VARCHAR, -- 发票票种（Excel：发票票种）
    invoice_status        VARCHAR, -- 发票状态（Excel：发票状态）
    is_positive_invoice   VARCHAR, -- 是否正数发票（Excel：是否正数发票）
    remark                VARCHAR, -- 备注（Excel：备注）
    je                    DECIMAL(18,2), -- 金额
    se                    DECIMAL(18,2), -- 税额
    jshj                  DECIMAL(18,2), -- 价税合计
    xfsbh                 VARCHAR, -- 销方纳税人识别号（Excel：销方识别号/销方税号）
    xfmc                  VARCHAR, -- 销方名称（Excel：销方名称）
    gfsbh                 VARCHAR, -- 购买方纳税人识别号（Excel：购买方识别号/购买方税号）
    gfmc                  VARCHAR, -- 购买方名称（Excel：购买方名称/购方名称）

    cargo_name            VARCHAR, -- 货物名称
    departure_place       VARCHAR, -- 起运地
    arrival_place         VARCHAR, -- 到达地
    transport_means_plate_no VARCHAR, -- 运输工具牌号/车牌号
    transport_means_type  VARCHAR, -- 运输工具种类

    source_table_type     VARCHAR, -- 来源专项表类型（spc_freight）
    source_scope_key      VARCHAR, -- 来源作用域键（import_session_id+source_excel_file+source_sheet 组合哈希）
    is_business_in_scope  BOOLEAN, -- 是否纳入业务口径（发票状态=正常 且 是否正数发票=是）

    import_batch_id       VARCHAR, -- 导入批次 ID（批次）
    import_session_id     VARCHAR, -- 导入会话 ID
    ods_file_seq          INTEGER, -- ODS 分片序号（ods_file_seq）
    source_excel_file     VARCHAR, -- 来源 Excel 文件路径
    source_parquet_file   VARCHAR, -- 来源 ODS Parquet 文件路径
    source_sheet          VARCHAR, -- 来源工作表名
    ingest_ts             TIMESTAMP, -- 进入 ODS 链路时间
    dwd_build_ts          TIMESTAMP, -- DWD 构建写入时间
    dwd_build_id          VARCHAR, -- DWD 构建任务 ID
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spcf_header    ON dwd_spc_transport_freight (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spcf_ym        ON dwd_spc_transport_freight (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spcf_ibatch    ON dwd_spc_transport_freight (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_spc_vehicle_sales：专项-机动车销售（含新车 spc_vehicle + 二手车 spc_used_vehicle）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_spc_vehicle_sales (
    -- detail_uuid：与 dwd_inv_detail 同公式；新车/二手车合并写入本表，source_table_type 区分来源
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    -- 与 dwd_inv_detail 同源编号规则（见 src/etl/dwd_shared_logic_line.py）
    logic_line_no INTEGER NOT NULL,

    fpdm                  VARCHAR, -- 发票代码（Excel：发票代码）
    fphm                  VARCHAR, -- 发票号码（Excel：发票号码）
    sdfphm                VARCHAR, -- 数电发票号码
    kprq                  VARCHAR, -- 开票日期原串（Excel：开票日期/发票日期）
    invoice_date          DATE,    -- 开票日期（由 kprq 解析）
    fppz                  VARCHAR, -- 发票票种（Excel：发票票种）
    invoice_status        VARCHAR, -- 发票状态（Excel：发票状态）
    is_positive_invoice   VARCHAR, -- 是否正数发票（Excel：是否正数发票）
    remark                VARCHAR, -- 备注（Excel：备注）
    je                    DECIMAL(18,2), -- 金额
    se                    DECIMAL(18,2), -- 税额
    jshj                  DECIMAL(18,2), -- 价税合计
    xfsbh                 VARCHAR, -- 销方纳税人识别号（Excel：销方识别号/销方税号）
    xfmc                  VARCHAR, -- 销方名称（Excel：销方名称）
    gfsbh                 VARCHAR, -- 购买方纳税人识别号（Excel：购买方识别号/购买方税号）
    gfmc                  VARCHAR, -- 购买方名称（Excel：购买方名称/购方名称）

    source_table_type     VARCHAR, -- 来源专项表类型（spc_vehicle/spc_used_vehicle）
    trade_org_name        VARCHAR, -- 经营/拍卖单位或二手车市场名称（合并字段）
    trade_org_tax_no      VARCHAR, -- 经营/拍卖单位或二手车市场纳税人识别号（合并字段）
    vin_chassis           VARCHAR, -- 车辆识别代号/车架号
    engine_no             VARCHAR, -- 发动机号码
    vehicle_certificate_no VARCHAR, -- 合格证号
    commodity_inspection_no VARCHAR, -- 商检号码/商检单号
    place_of_origin       VARCHAR, -- 产地
    vehicle_plate_no      VARCHAR, -- 车牌照号/车牌号
    registration_cert_no  VARCHAR, -- 登记证号
    transfer_dmv_office   VARCHAR, -- 转入地车辆管理所名称
    buyer_address         VARCHAR, -- 购买方地址
    buyer_phone           VARCHAR, -- 购买方联系电话

    source_scope_key      VARCHAR, -- 来源作用域键（import_session_id+source_excel_file+source_sheet 组合哈希）
    is_business_in_scope  BOOLEAN, -- 是否纳入业务口径（发票状态=正常 且 是否正数发票=是）

    import_batch_id       VARCHAR, -- 导入批次 ID（批次）
    import_session_id     VARCHAR, -- 导入会话 ID
    ods_file_seq          INTEGER, -- ODS 分片序号（ods_file_seq）
    source_excel_file     VARCHAR, -- 来源 Excel 文件路径
    source_parquet_file   VARCHAR, -- 来源 ODS Parquet 文件路径
    source_sheet          VARCHAR, -- 来源工作表名
    ingest_ts             TIMESTAMP, -- 进入 ODS 链路时间
    dwd_build_ts          TIMESTAMP, -- DWD 构建写入时间
    dwd_build_id          VARCHAR, -- DWD 构建任务 ID
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spcvs_header ON dwd_spc_vehicle_sales (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spcvs_ym     ON dwd_spc_vehicle_sales (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spcvs_ibatch ON dwd_spc_vehicle_sales (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_spc_construction_service：专项-建筑服务（spc_construction）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_spc_construction_service (
    -- detail_uuid：与 dwd_inv_detail 同公式
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    -- 与 dwd_inv_detail 同源编号规则（见 src/etl/dwd_shared_logic_line.py）
    logic_line_no INTEGER NOT NULL,

    fpdm                      VARCHAR, -- 发票代码（Excel：发票代码）
    fphm                      VARCHAR, -- 发票号码（Excel：发票号码）
    sdfphm                    VARCHAR, -- 数电发票号码
    kprq                      VARCHAR, -- 开票日期原串（Excel：开票日期/发票日期）
    invoice_date              DATE,    -- 开票日期（由 kprq 解析）
    fppz                      VARCHAR, -- 发票票种（Excel：发票票种）
    invoice_status            VARCHAR, -- 发票状态（Excel：发票状态）
    is_positive_invoice       VARCHAR, -- 是否正数发票（Excel：是否正数发票）
    remark                    VARCHAR, -- 备注（Excel：备注）
    je                        DECIMAL(18,2), -- 金额
    se                        DECIMAL(18,2), -- 税额
    jshj                      DECIMAL(18,2), -- 价税合计
    xfsbh                     VARCHAR, -- 销方纳税人识别号（Excel：销方识别号/销方税号）
    xfmc                      VARCHAR, -- 销方名称（Excel：销方名称）
    gfsbh                     VARCHAR, -- 购买方纳税人识别号（Excel：购买方识别号/购买方税号）
    gfmc                      VARCHAR, -- 购买方名称（Excel：购买方名称/购方名称）

    construction_project_name     VARCHAR, -- 建筑项目名称
    construction_service_location VARCHAR, -- 建筑服务发生地
    cross_region_tax_mgmt_no      VARCHAR, -- 跨区域涉税事项报验管理编号

    source_table_type         VARCHAR, -- 来源专项表类型（spc_construction）
    source_scope_key          VARCHAR, -- 来源作用域键（import_session_id+source_excel_file+source_sheet 组合哈希）
    is_business_in_scope      BOOLEAN, -- 是否纳入业务口径（发票状态=正常 且 是否正数发票=是）

    import_batch_id           VARCHAR, -- 导入批次 ID（批次）
    import_session_id         VARCHAR, -- 导入会话 ID
    ods_file_seq              INTEGER, -- ODS 分片序号（ods_file_seq）
    source_excel_file         VARCHAR, -- 来源 Excel 文件路径
    source_parquet_file       VARCHAR, -- 来源 ODS Parquet 文件路径
    source_sheet              VARCHAR, -- 来源工作表名
    ingest_ts                 TIMESTAMP, -- 进入 ODS 链路时间
    dwd_build_ts              TIMESTAMP, -- DWD 构建写入时间
    dwd_build_id              VARCHAR, -- DWD 构建任务 ID
    created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spc_cs_header ON dwd_spc_construction_service (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spc_cs_ym     ON dwd_spc_construction_service (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spc_cs_ibatch ON dwd_spc_construction_service (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_spc_estate_lease：专项-不动产经营租赁（spc_estate_lease）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_spc_estate_lease (
    -- detail_uuid：与 dwd_inv_detail 同公式
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    -- 与 dwd_inv_detail 同源编号规则（见 src/etl/dwd_shared_logic_line.py）
    logic_line_no INTEGER NOT NULL,

    fpdm                  VARCHAR, -- 发票代码（Excel：发票代码）
    fphm                  VARCHAR, -- 发票号码（Excel：发票号码）
    sdfphm                VARCHAR, -- 数电发票号码
    kprq                  VARCHAR, -- 开票日期原串（Excel：开票日期/发票日期）
    invoice_date          DATE,    -- 开票日期（由 kprq 解析）
    fppz                  VARCHAR, -- 发票票种（Excel：发票票种）
    invoice_status        VARCHAR, -- 发票状态（Excel：发票状态）
    is_positive_invoice   VARCHAR, -- 是否正数发票（Excel：是否正数发票）
    remark                VARCHAR, -- 备注（Excel：备注）
    je                    DECIMAL(18,2), -- 金额
    se                    DECIMAL(18,2), -- 税额
    jshj                  DECIMAL(18,2), -- 价税合计
    xfsbh                 VARCHAR, -- 销方纳税人识别号（Excel：销方识别号/销方税号）
    xfmc                  VARCHAR, -- 销方名称（Excel：销方名称）
    gfsbh                 VARCHAR, -- 购买方纳税人识别号（Excel：购买方识别号/购买方税号）
    gfmc                  VARCHAR, -- 购买方名称（Excel：购买方名称/购方名称）

    license_plate_no      VARCHAR, -- 车牌号
    property_title_cert_no VARCHAR, -- 产权证书/不动产权证号

    source_table_type     VARCHAR, -- 来源专项表类型（spc_estate_lease）
    source_scope_key      VARCHAR, -- 来源作用域键（import_session_id+source_excel_file+source_sheet 组合哈希）
    is_business_in_scope  BOOLEAN, -- 是否纳入业务口径（发票状态=正常 且 是否正数发票=是）

    import_batch_id       VARCHAR, -- 导入批次 ID（批次）
    import_session_id     VARCHAR, -- 导入会话 ID
    ods_file_seq          INTEGER, -- ODS 分片序号（ods_file_seq）
    source_excel_file     VARCHAR, -- 来源 Excel 文件路径
    source_parquet_file   VARCHAR, -- 来源 ODS Parquet 文件路径
    source_sheet          VARCHAR, -- 来源工作表名
    ingest_ts             TIMESTAMP, -- 进入 ODS 链路时间
    dwd_build_ts          TIMESTAMP, -- DWD 构建写入时间
    dwd_build_id          VARCHAR, -- DWD 构建任务 ID
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spc_el_header ON dwd_spc_estate_lease (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spc_el_ym     ON dwd_spc_estate_lease (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spc_el_ibatch ON dwd_spc_estate_lease (import_batch_id);
