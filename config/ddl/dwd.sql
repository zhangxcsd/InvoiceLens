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
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    logic_line_no INTEGER NOT NULL,

    fpdm                  VARCHAR,
    fphm                  VARCHAR,
    sdfphm                VARCHAR,
    kprq                  VARCHAR,
    invoice_date          DATE,
    fppz                  VARCHAR,
    invoice_status        VARCHAR,
    is_positive_invoice   VARCHAR,
    remark                VARCHAR,
    je                    DECIMAL(18,2),
    se                    DECIMAL(18,2),
    jshj                  DECIMAL(18,2),

    passenger_name        VARCHAR,
    traveler_id_no        VARCHAR,
    trip_date             DATE,
    trip_time             VARCHAR,
    departure_place       VARCHAR,
    arrival_place         VARCHAR,
    transport_tool_type   VARCHAR,
    service_class         VARCHAR,
    trip_no               VARCHAR,

    source_table_type     VARCHAR,
    source_scope_key      VARCHAR,
    is_business_in_scope  BOOLEAN,

    import_batch_id       VARCHAR,
    import_session_id     VARCHAR,
    ods_file_seq          INTEGER,
    source_excel_file     VARCHAR,
    source_parquet_file   VARCHAR,
    source_sheet          VARCHAR,
    ingest_ts             TIMESTAMP,
    dwd_build_ts          TIMESTAMP,
    dwd_build_id          VARCHAR,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, source_scope_key, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spcp_header    ON dwd_spc_transport_passenger (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spcp_ym        ON dwd_spc_transport_passenger (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spcp_trip_date ON dwd_spc_transport_passenger (trip_date);
CREATE INDEX IF NOT EXISTS idx_spcp_ibatch    ON dwd_spc_transport_passenger (import_batch_id);

-- -----------------------------------------------------------------------------
-- dwd_spc_transport_freight：专项运输-货运明细
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dwd_spc_transport_freight (
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    stat_month    SMALLINT NOT NULL,
    logic_line_no INTEGER NOT NULL,

    fpdm                  VARCHAR,
    fphm                  VARCHAR,
    sdfphm                VARCHAR,
    kprq                  VARCHAR,
    invoice_date          DATE,
    fppz                  VARCHAR,
    invoice_status        VARCHAR,
    is_positive_invoice   VARCHAR,
    remark                VARCHAR,
    je                    DECIMAL(18,2),
    se                    DECIMAL(18,2),
    jshj                  DECIMAL(18,2),

    shipper               VARCHAR,
    receiver              VARCHAR,
    cargo_name            VARCHAR,
    departure_place       VARCHAR,
    arrival_place         VARCHAR,
    transport_tool_type   VARCHAR,

    source_table_type     VARCHAR,
    source_scope_key      VARCHAR,
    is_business_in_scope  BOOLEAN,

    import_batch_id       VARCHAR,
    import_session_id     VARCHAR,
    ods_file_seq          INTEGER,
    source_excel_file     VARCHAR,
    source_parquet_file   VARCHAR,
    source_sheet          VARCHAR,
    ingest_ts             TIMESTAMP,
    dwd_build_ts          TIMESTAMP,
    dwd_build_id          VARCHAR,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, source_scope_key, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_spcf_header    ON dwd_spc_transport_freight (header_uuid);
CREATE INDEX IF NOT EXISTS idx_spcf_ym        ON dwd_spc_transport_freight (stat_year, stat_month);
CREATE INDEX IF NOT EXISTS idx_spcf_ibatch    ON dwd_spc_transport_freight (import_batch_id);
