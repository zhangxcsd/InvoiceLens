-- dwd_inv_header：全局发票主表（无 group_id，先到先得去重）
-- 净额字段内嵌（宽表设计），无单独净额表
CREATE TABLE IF NOT EXISTS dwd_inv_header (
    header_uuid      VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(全角转半角后的 fpdm || fphm || sdfphm)
    stat_year        SMALLINT NOT NULL,
    -- 从 invoice_date 解析，是本表的核心分区过滤列

    -- 原始字段
    fpdm     VARCHAR,  fphm     VARCHAR,  sdfphm   VARCHAR,
    xfsbh    VARCHAR,  xfmc     VARCHAR,
    gfsbh    VARCHAR,  gfmc     VARCHAR,
    kprq     VARCHAR,
    invoice_date  DATE,
    invoice_time  TIME,
    je       DECIMAL(18,2),
    se       DECIMAL(18,2),
    jshj     DECIMAL(18,2),
    fply     VARCHAR,  fppz     VARCHAR,  fpzt     VARCHAR,
    sfzsfp   VARCHAR,
    fpfxdj   VARCHAR,
    kpr      VARCHAR,
    bz       VARCHAR,

    -- 平账字段（导入后批量回填）
    detail_total_amount DECIMAL(18,2),
    is_balanced         VARCHAR DEFAULT '未校验',
    -- 枚举：未校验 / 平账 / 不平账 / 差异可接受 / 强制通过
    balance_diff        DECIMAL(18,2),
    balance_tolerance   DECIMAL(18,2) DEFAULT 0.10,
    balance_check_time  TIMESTAMP,
    balance_notes       VARCHAR,

    -- 红蓝关联（ETL 从 bz 备注解析）
    related_blue_invoice_uuid VARCHAR,

    -- 净额字段（红蓝对冲后批量回填，宽表内嵌，无单独净额表）
    net_je            DECIMAL(18,2),
    net_se            DECIMAL(18,2),
    net_jshj          DECIMAL(18,2),
    red_offset_je     DECIMAL(18,2) DEFAULT 0,
    red_offset_se     DECIMAL(18,2) DEFAULT 0,
    red_offset_jshj   DECIMAL(18,2) DEFAULT 0,
    red_invoice_count INT          DEFAULT 0,
    net_calc_status   VARCHAR      DEFAULT '未计算',
    -- 枚举：未计算 / 蓝票已计算 / 已全额红冲 / 孤立红票 / 已作废
    is_fully_reversed BOOLEAN DEFAULT FALSE,
    is_orphan_red     BOOLEAN DEFAULT FALSE,
    -- 孤立红票（未关联蓝票）保留负值参与 SUM 聚合（宽口径，决策三）
    net_calc_time     TIMESTAMP,

    -- 元数据
    first_import_batch_id VARCHAR NOT NULL,
    first_import_file     VARCHAR NOT NULL,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hdr_year    ON dwd_inv_header (stat_year);
CREATE INDEX IF NOT EXISTS idx_hdr_xfsbh   ON dwd_inv_header (xfsbh);
CREATE INDEX IF NOT EXISTS idx_hdr_gfsbh   ON dwd_inv_header (gfsbh);
CREATE INDEX IF NOT EXISTS idx_hdr_date    ON dwd_inv_header (invoice_date);
CREATE INDEX IF NOT EXISTS idx_hdr_bal     ON dwd_inv_header (is_balanced);
CREATE INDEX IF NOT EXISTS idx_hdr_blue    ON dwd_inv_header (related_blue_invoice_uuid);
CREATE INDEX IF NOT EXISTS idx_hdr_sfzsfp  ON dwd_inv_header (sfzsfp);
CREATE INDEX IF NOT EXISTS idx_hdr_net     ON dwd_inv_header (net_calc_status);

-- dwd_inv_detail：全局发票明细表（无 group_id，与主表成对）
CREATE TABLE IF NOT EXISTS dwd_inv_detail (
    detail_uuid   VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(全角转半角后的 fpdm || fphm || sdfphm || logic_line_no)
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    -- 冗余，避免 JOIN 主表，加速按年过滤
    logic_line_no INT NOT NULL,
    -- 规则：数电票按 sdfphm 分组编号，纸票按 fpdm+fphm 分组编号，从 1 起
    -- 特殊：hwlwmc 含"详见"且同票明细≥2条的汇总参考行赋值 0
    -- 下游聚合必须 WHERE logic_line_no > 0 排除汇总行

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

    invoice_date DATE,   -- 冗余，避免 JOIN 主表
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (header_uuid, logic_line_no)
);

CREATE INDEX IF NOT EXISTS idx_dtl_header  ON dwd_inv_detail (header_uuid);
CREATE INDEX IF NOT EXISTS idx_dtl_year    ON dwd_inv_detail (stat_year);
CREATE INDEX IF NOT EXISTS idx_dtl_ssflbm  ON dwd_inv_detail (ssflbm);
CREATE INDEX IF NOT EXISTS idx_dtl_date    ON dwd_inv_detail (invoice_date);

-- dwd_inv_map：实体发票映射/溯源表（不含 group_id；仅做实体与票据关联）
-- 同一张发票在多次导入/多来源下可产生多行溯源记录
CREATE TABLE IF NOT EXISTS dwd_inv_map (
    map_uuid      VARCHAR NOT NULL PRIMARY KEY,
    -- MD5(entity_id || header_uuid || invoice_dir || import_batch_id)
    header_uuid   VARCHAR NOT NULL,
    stat_year     SMALLINT NOT NULL,
    -- 冗余，加速按年过滤
    entity_id     VARCHAR,
    -- 进项：从 gfsbh 反查 dim_org_node；销项：从 xfsbh 反查
    -- 匹配失败置 NULL，clean_status 标记"企业识别号匹配失败"
    entity_name   VARCHAR,
    -- 冗余全称（entity_fullname 冗余策略）
    invoice_dir   VARCHAR NOT NULL,  -- 进项 / 销项
    import_batch_id VARCHAR NOT NULL,
    source_file     VARCHAR NOT NULL,
    clean_status    VARCHAR,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (stat_year, header_uuid, invoice_dir, entity_id, import_batch_id)
);

CREATE INDEX IF NOT EXISTS idx_map_header    ON dwd_inv_map (header_uuid);
CREATE INDEX IF NOT EXISTS idx_map_year      ON dwd_inv_map (stat_year);
CREATE INDEX IF NOT EXISTS idx_map_entity_ent ON dwd_inv_map (entity_id, import_batch_id);

