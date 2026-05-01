CREATE TABLE IF NOT EXISTS dim_org_sys (
    sys_id       VARCHAR NOT NULL PRIMARY KEY,
    sys_name     VARCHAR NOT NULL,
    admin_level  VARCHAR NOT NULL,
    gov_owner    VARCHAR,
    sort_no      INTEGER,
    is_active    BOOLEAN DEFAULT TRUE
);

INSERT OR IGNORE INTO dim_org_sys VALUES (
    'PROV_SD', '山东省属企业', '省', '山东省国有资产监督管理委员会', 1, TRUE
);

CREATE TABLE IF NOT EXISTS dim_org_node (
    entity_id        VARCHAR NOT NULL PRIMARY KEY,
    sys_id           VARCHAR NOT NULL,
    entity_fullname  VARCHAR NOT NULL,
    entity_shortname VARCHAR,
    entity_type      VARCHAR,
    main_business    VARCHAR,
    industry_id      VARCHAR,
    industry_name    VARCHAR,
    is_stat_inc      BOOLEAN DEFAULT TRUE,
    reg_capital      DECIMAL(18,2),
    established_date DATE,
    is_active        BOOLEAN DEFAULT TRUE,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_node_sys      ON dim_org_node (sys_id);
CREATE INDEX IF NOT EXISTS idx_node_industry ON dim_org_node (sys_id, industry_id);

INSERT OR IGNORE INTO dim_org_node
    (entity_id, sys_id, entity_fullname, entity_shortname, entity_type, is_stat_inc)
VALUES
    ('ROOT_PROV_SD', 'PROV_SD', '山东省国有资产监督管理委员会', '省国资委', '根节点', FALSE);

CREATE TABLE IF NOT EXISTS dim_org_hier (
    hier_id              VARCHAR NOT NULL PRIMARY KEY,
    entity_id            VARCHAR NOT NULL,
    entity_shortname     VARCHAR,
    entity_fullname      VARCHAR,
    sys_id               VARCHAR NOT NULL,
    stat_year            SMALLINT NOT NULL,
    mg_parent_id         VARCHAR,
    mg_parent_shortname  VARCHAR,
    mg_parent_fullname   VARCHAR,
    mg_sort_no           INTEGER,
    mg_level             TINYINT,
    mg_path              VARCHAR,
    mg_path_ids          VARCHAR,
    mg_root_group_id     VARCHAR,
    mg_is_leaf           BOOLEAN DEFAULT TRUE,
    eq_parent_id         VARCHAR,
    eq_parent_shortname  VARCHAR,
    eq_parent_fullname   VARCHAR,
    eq_sort_no           INTEGER,
    eq_shareholding_ratio DECIMAL(7,4),
    eq_level             TINYINT,
    eq_path              VARCHAR,
    eq_path_ids          VARCHAR,
    eq_root_group_id     VARCHAR,
    eq_is_leaf           BOOLEAN DEFAULT TRUE,
    is_hier_diff         BOOLEAN DEFAULT FALSE,
    hier_diff_note       VARCHAR,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by           VARCHAR DEFAULT 'SYSTEM',
    UNIQUE (entity_id, stat_year)
);

CREATE INDEX IF NOT EXISTS idx_hier_sys_year  ON dim_org_hier (sys_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_entity    ON dim_org_hier (entity_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_mg_parent ON dim_org_hier (mg_parent_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_eq_parent ON dim_org_hier (eq_parent_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_mg_root   ON dim_org_hier (mg_root_group_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_eq_root   ON dim_org_hier (eq_root_group_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_hier_diff      ON dim_org_hier (is_hier_diff, stat_year);

-- 集团年度成员与双树关系（管理/产权）权威口径
-- 规则：
-- 1) level=0 与 level=1 节点 parent 必须自指（parent_id = enterprise_id）
-- 2) level>=2 节点 parent 不可自指（parent_id <> enterprise_id）
-- 3) level1_group_* 代表一级企业集团（level=1 的业务锚点）
CREATE TABLE IF NOT EXISTS dim_group_enterprise_year (
    stat_year                     SMALLINT NOT NULL,
    enterprise_id                 VARCHAR NOT NULL,
    enterprise_name               VARCHAR,
    is_member                     BOOLEAN DEFAULT TRUE,
    level1_group_id               VARCHAR NOT NULL,
    level1_group_name             VARCHAR,

    mgmt_root_enterprise_id       VARCHAR,
    mgmt_root_enterprise_name     VARCHAR,
    mgmt_status                   VARCHAR,
    mgmt_parent_enterprise_id     VARCHAR NOT NULL,
    mgmt_parent_enterprise_name   VARCHAR,
    mgmt_level                    TINYINT NOT NULL,

    equity_root_enterprise_id     VARCHAR,
    equity_root_enterprise_name   VARCHAR,
    equity_status                 VARCHAR,
    equity_parent_enterprise_id   VARCHAR NOT NULL,
    equity_parent_enterprise_name VARCHAR,
    equity_level                  TINYINT NOT NULL,

    as_of_date                    DATE,
    version_no                    INTEGER DEFAULT 1,
    calc_version                  VARCHAR,
    etl_batch_id                  VARCHAR,
    data_source                   VARCHAR,
    source_record_id              VARCHAR,
    quality_status                VARCHAR,
    quality_issue                 VARCHAR,
    updated_at                    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stat_year, enterprise_id),
    CHECK (mgmt_level >= 0),
    CHECK (equity_level >= 0),
    CHECK (
        (mgmt_level IN (0, 1) AND mgmt_parent_enterprise_id = enterprise_id)
        OR (mgmt_level >= 2 AND mgmt_parent_enterprise_id <> enterprise_id)
    ),
    CHECK (
        (equity_level IN (0, 1) AND equity_parent_enterprise_id = enterprise_id)
        OR (equity_level >= 2 AND equity_parent_enterprise_id <> enterprise_id)
    )
);

CREATE INDEX IF NOT EXISTS idx_group_year_l1_group   ON dim_group_enterprise_year (stat_year, level1_group_id);
CREATE INDEX IF NOT EXISTS idx_group_year_mgmt_root  ON dim_group_enterprise_year (stat_year, mgmt_root_enterprise_id);
CREATE INDEX IF NOT EXISTS idx_group_year_equity_root ON dim_group_enterprise_year (stat_year, equity_root_enterprise_id);
CREATE INDEX IF NOT EXISTS idx_group_year_mgmt_parent ON dim_group_enterprise_year (stat_year, mgmt_parent_enterprise_id);
CREATE INDEX IF NOT EXISTS idx_group_year_eq_parent   ON dim_group_enterprise_year (stat_year, equity_parent_enterprise_id);
CREATE INDEX IF NOT EXISTS idx_group_year_status      ON dim_group_enterprise_year (stat_year, mgmt_status, equity_status);

CREATE SEQUENCE IF NOT EXISTS seq_hier_log_id START 1;
CREATE TABLE IF NOT EXISTS dim_org_hier_log (
    log_id           BIGINT NOT NULL DEFAULT nextval('seq_hier_log_id') PRIMARY KEY,
    entity_id        VARCHAR NOT NULL,
    stat_year        SMALLINT NOT NULL,
    change_type      VARCHAR,
    old_eq_parent_id VARCHAR,  new_eq_parent_id VARCHAR,
    old_mg_parent_id VARCHAR,  new_mg_parent_id VARCHAR,
    change_note      VARCHAR,
    changed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    changed_by       VARCHAR DEFAULT 'SYSTEM'
);

CREATE TABLE IF NOT EXISTS dim_tax_code (
    tax_code         VARCHAR NOT NULL PRIMARY KEY, -- 合并编码（Excel 第12列），按字符串保留，目标口径为19位分类编码
    -- 原始业务字段（来自编码表正文区域）
    goods_name       VARCHAR, -- 货物和劳务名称（Excel 第13列）
    goods_short_name VARCHAR, -- 商品和服务分类简称（Excel 第14列）
    description      VARCHAR, -- 说明（Excel 第15列）
    -- 分层编码展开字段（来自 Excel 的“篇/类/章/节/条/款/项/目/子目/细目”列）
    level_pian       VARCHAR,  -- 篇（第2列，1位）
    level_lei        VARCHAR,  -- 类（第3列，2位）
    level_zhang      VARCHAR,  -- 章（第4列，2位）
    level_jie        VARCHAR,  -- 节（第5列，2位）
    level_tiao       VARCHAR,  -- 条（第6列，2位）
    level_kuan       VARCHAR,  -- 款（第7列，2位）
    level_xiang      VARCHAR,  -- 项（第8列，2位）
    level_mu         VARCHAR,  -- 目（第9列，2位）
    level_zimu       VARCHAR,  -- 子目（第10列，2位）
    level_ximu       VARCHAR,  -- 细目（第11列，2位）
    -- 新版治理字段（对齐税收分类导入能力）
    level_depth      TINYINT,  -- 层级深度：按合并编码最后一个非零层级推导（1-10）
    is_leaf          BOOLEAN,  -- 是否叶子：未被任何其它编码作为 parent_code 时为 TRUE
    parent_code      VARCHAR,  -- 父级合并编码（同为19位编码口径）
    full_path        TEXT,     -- 中文全路径（按层级名称拼接，使用 " > " 连接）
    data_version     VARCHAR DEFAULT '税务总局20171218', -- 编码表版本（默认税务总局20171218）
    clean_status     VARCHAR,  -- 清洗标记：分类编码有误 / 分类编码重复 / NULL(正常)
    audit_risk_label VARCHAR DEFAULT 'NORMAL', -- 风险标签：NORMAL/HIGH（咨询、会议、餐饮等可预置HIGH）
    -- 数据血缘字段（与当前项目批次/会话体系一致，便于追溯到 ODS 源）
    import_batch_id   VARCHAR,   -- 导入批次 ID（对应 data/ods/批次=...）
    import_session_id VARCHAR,   -- 导入会话 ID（同一批次可多会话）
    ods_file_seq      INTEGER,   -- ODS 分片序号（分区 ods_file_seq=...）
    source_excel_file VARCHAR,   -- 来源 Excel 文件路径
    source_parquet_file VARCHAR, -- 来源 ODS Parquet 文件路径
    source_sheet      VARCHAR,   -- 来源工作表名
    ingest_ts         TIMESTAMP, -- 进入 ODS 链路时间戳
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 首次写入时间
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP  -- 最近更新时间
);

CREATE INDEX IF NOT EXISTS idx_tax_short  ON dim_tax_code (goods_short_name);
CREATE INDEX IF NOT EXISTS idx_tax_parent ON dim_tax_code (parent_code);
CREATE INDEX IF NOT EXISTS idx_tax_depth  ON dim_tax_code (level_depth);
CREATE INDEX IF NOT EXISTS idx_tax_leaf   ON dim_tax_code (is_leaf);
CREATE INDEX IF NOT EXISTS idx_tax_path   ON dim_tax_code (full_path);
CREATE INDEX IF NOT EXISTS idx_tax_clean  ON dim_tax_code (clean_status);
CREATE INDEX IF NOT EXISTS idx_tax_risk   ON dim_tax_code (audit_risk_label);
CREATE INDEX IF NOT EXISTS idx_tax_lineage_batch ON dim_tax_code (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_tax_lineage_session ON dim_tax_code (import_session_id);
CREATE INDEX IF NOT EXISTS idx_tax_lineage_ods_seq ON dim_tax_code (ods_file_seq);

-- 发票企业全量维表（来源：发票主表销方/购方；无税号企业不入库）
CREATE TABLE IF NOT EXISTS dim_enterprise (
    enterprise_id         VARCHAR NOT NULL PRIMARY KEY,
    taxpayer_id           VARCHAR NOT NULL UNIQUE,
    enterprise_name_std   VARCHAR NOT NULL,
    enterprise_name_raw   VARCHAR,
    has_seller_role       BOOLEAN DEFAULT FALSE,
    has_buyer_role        BOOLEAN DEFAULT FALSE,
    first_seen_batch_id   VARCHAR NOT NULL,
    last_seen_batch_id    VARCHAR NOT NULL,
    data_first_seen_date  DATE,
    data_last_seen_date   DATE,
    quality_status        VARCHAR DEFAULT 'ok',
    quality_issue         VARCHAR,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (length(trim(taxpayer_id)) > 0),
    CHECK (quality_status IN ('ok', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_ent_name_std      ON dim_enterprise (enterprise_name_std);
CREATE INDEX IF NOT EXISTS idx_ent_last_batch    ON dim_enterprise (last_seen_batch_id);
CREATE INDEX IF NOT EXISTS idx_ent_seen_date_rng ON dim_enterprise (data_first_seen_date, data_last_seen_date);

-- =============================================================================
-- 主体维度拆分（企业主体 / 个人主体）
-- 背景：
-- 1) 在真实业务中，发票对手方既有企业主体，也可能出现个人身份证号主体（如对私采购、物业/医疗高频个人开票等）。
-- 2) 若全部并入企业维表，会导致企业口径 KPI 与清单被个人主体“放大”，不利于企业主题分析。
-- 3) 因此采用“企业主体表 + 个人主体表”拆分建模：存储分开、口径清晰、可追溯保留。
--
-- 设计原则：
-- 1) 企业主题页面默认仅消费企业主体表（dim_enterprise_subject）。
-- 2) 个人主体单独入表（dim_person_subject），用于对私交易与风险专题，不默认计入企业 KPI。
-- 3) 字段命名尽量复用 dwd_inv_header 票面语义（xfsbh/xfmc/gfsbh/gfmc），降低映射与维护成本。
-- 4) 两表均按年度快照（stat_year）管理，支持“同主体跨年度”的连续追踪。
--
-- -----------------------------------------------------------------------------
-- 建议抽取流程（伪代码，仅口径说明，不直接执行）
-- -----------------------------------------------------------------------------
-- Step A) 从 dwd_inv_header 拉平主体候选（销方 + 购方）
--   A1. 销方候选：subject_no = xfsbh, subject_name = xfmc, role = seller
--   A2. 购方候选：subject_no = gfsbh, subject_name = gfmc, role = buyer
--   A3. 合并为同一候选流（UNION ALL），并带上：
--       stat_year, import_batch_id, invoice_date, source_excel_file 等血缘字段
--
-- Step B) 主体类型判定（企业 / 个人 / unknown）
--   B1. subject_no 命中企业税号规则 -> subject_type = 'enterprise'
--   B2. subject_no 命中身份证号规则 -> subject_type = 'person'
--   B3. 其余 -> subject_type = 'unknown'（不入两张主体维表，进入异常清单）
--
-- Step C) 年度快照聚合（按 stat_year + 主体识别号）
--   C1. 同年度同主体去重
--   C2. 聚合角色标记：
--       has_seller_role = BOOL_OR(role='seller')
--       has_buyer_role  = BOOL_OR(role='buyer')
--   C3. 聚合首末出现信息：
--       first_seen_batch_id = MIN(import_batch_id)  -- 口径可替换为最早 invoice_date 对应批次
--       last_seen_batch_id  = MAX(import_batch_id)  -- 口径可替换为最晚 invoice_date 对应批次
--       data_first_seen_date = MIN(invoice_date)
--       data_last_seen_date  = MAX(invoice_date)
--   C4. 名称处理：
--       *_name_std = 规范化名称（建议 trim/全半角统一/大小写统一）
--       *_name_raw = 原始名称代表值（可取最近一条或最长非空）
--
-- Step D) 分表入库（UPSERT）
--   D1. subject_type='enterprise' -> dim_enterprise_subject
--   D2. subject_type='person'     -> dim_person_subject
--   D3. 写入 rule_version / quality_status / quality_issue / updated_at
--
-- Step E) 消费约束（应用层）
--   E1. 企业主题页面默认 WHERE subject_type='enterprise'
--   E2. 对私交易专题可使用 vw_dim_subject_union 或 person 表 + 事实表 JOIN
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dim_enterprise_subject：企业主体维表（年度快照）
-- 含义：由 dwd_inv_header 中识别为“企业税号”的主体抽取而来，沉淀企业口径主数据。
-- 粒度：一行 = 一个年度（stat_year）下的一个企业主体（taxpayer_id）。
-- 用途：全量企业数据库、票企关联视图、组织树等企业主题页面的默认主体底座。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_enterprise_subject (
    enterprise_subject_id  VARCHAR NOT NULL PRIMARY KEY, -- 企业主体主键（建议 ETL 生成稳定 ID）
    stat_year              SMALLINT NOT NULL,            -- 年度快照（与 dwd_inv_header.stat_year 对齐）

    -- 复用发票主表命名（dwd_inv_header）：保留销/购两侧票面字段，避免口径映射歧义
    xfsbh                 VARCHAR, -- 销方纳税人识别号（同名复用）
    xfmc                  VARCHAR, -- 销方名称（同名复用）
    gfsbh                 VARCHAR, -- 购方纳税人识别号（同名复用）
    gfmc                  VARCHAR, -- 购方名称（同名复用）

    taxpayer_id            VARCHAR NOT NULL, -- 企业纳税人识别号（来源：xfsbh/gfsbh）
    enterprise_name_std    VARCHAR NOT NULL, -- 企业标准名称（规范化名称，用于检索与聚合）
    enterprise_name_raw    VARCHAR,          -- 企业原始名称（票面原文，可用于追溯）

    has_seller_role        BOOLEAN DEFAULT FALSE, -- 是否出现过销方角色（来源：xfsbh/xfmc）
    has_buyer_role         BOOLEAN DEFAULT FALSE, -- 是否出现过购方角色（来源：gfsbh/gfmc）

    first_seen_batch_id    VARCHAR NOT NULL, -- 首次出现批次（来源：import_batch_id 聚合最小值口径）
    last_seen_batch_id     VARCHAR NOT NULL, -- 最近出现批次（来源：import_batch_id 聚合最大值口径）
    data_first_seen_date   DATE,             -- 首次业务日期（来源：invoice_date 最小值）
    data_last_seen_date    DATE,             -- 最近业务日期（来源：invoice_date 最大值）

    rule_version           VARCHAR DEFAULT 'v1',  -- 主体识别规则版本（企业/个人判定规则）
    quality_status         VARCHAR DEFAULT 'ok',  -- 质量状态：ok/warning/error
    quality_issue          VARCHAR,               -- 质量问题说明（如名称冲突、口径冲突）
    updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 维表更新时间

    UNIQUE (stat_year, taxpayer_id),              -- 同年度同税号唯一
    CHECK (length(trim(taxpayer_id)) > 0),        -- 禁止空税号
    CHECK (quality_status IN ('ok', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_ent_subj_year_tax    ON dim_enterprise_subject (stat_year, taxpayer_id);
CREATE INDEX IF NOT EXISTS idx_ent_subj_year_name   ON dim_enterprise_subject (stat_year, enterprise_name_std);
CREATE INDEX IF NOT EXISTS idx_ent_subj_last_batch  ON dim_enterprise_subject (last_seen_batch_id);

-- -----------------------------------------------------------------------------
-- dim_person_subject：个人主体维表（年度快照，明文）
-- 含义：由 dwd_inv_header 中识别为“身份证号”的主体抽取而来。
-- 粒度：一行 = 一个年度（stat_year）下的一个个人主体（id_card_no）。
-- 用途：企业对私交易分析、采购对私风险识别等专题；默认不计入企业口径 KPI。
-- 说明：按当前业务决策，身份证号与姓名采用明文存储。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_person_subject (
    person_subject_id      VARCHAR NOT NULL PRIMARY KEY, -- 个人主体主键（建议 ETL 生成稳定 ID）
    stat_year              SMALLINT NOT NULL,            -- 年度快照（与 dwd_inv_header.stat_year 对齐）

    -- 复用发票主表命名（dwd_inv_header）：保留销/购两侧票面字段，避免口径映射歧义
    xfsbh                 VARCHAR, -- 销方识别号（同名复用；识别为个人时通常为身份证号）
    xfmc                  VARCHAR, -- 销方名称（同名复用；识别为个人时通常为姓名）
    gfsbh                 VARCHAR, -- 购方识别号（同名复用；识别为个人时通常为身份证号）
    gfmc                  VARCHAR, -- 购方名称（同名复用；识别为个人时通常为姓名）

    id_card_no             VARCHAR NOT NULL, -- 身份证号（明文；来源：xfsbh/gfsbh 识别为个人时）
    person_name            VARCHAR,          -- 姓名（明文；来源：xfmc/gfmc）

    has_seller_role        BOOLEAN DEFAULT FALSE, -- 是否出现过销方角色（个人主体场景）
    has_buyer_role         BOOLEAN DEFAULT FALSE, -- 是否出现过购方角色（个人主体场景）

    first_seen_batch_id    VARCHAR NOT NULL, -- 首次出现批次（来源：import_batch_id 聚合最小值口径）
    last_seen_batch_id     VARCHAR NOT NULL, -- 最近出现批次（来源：import_batch_id 聚合最大值口径）
    data_first_seen_date   DATE,             -- 首次业务日期（来源：invoice_date 最小值）
    data_last_seen_date    DATE,             -- 最近业务日期（来源：invoice_date 最大值）

    rule_version           VARCHAR DEFAULT 'v1',  -- 主体识别规则版本
    quality_status         VARCHAR DEFAULT 'ok',  -- 质量状态：ok/warning/error
    quality_issue          VARCHAR,               -- 质量问题说明
    updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 维表更新时间

    UNIQUE (stat_year, id_card_no),              -- 同年度同身份证号唯一
    CHECK (length(trim(id_card_no)) > 0),        -- 禁止空身份证号
    CHECK (quality_status IN ('ok', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_person_subj_year_idcard ON dim_person_subject (stat_year, id_card_no);
CREATE INDEX IF NOT EXISTS idx_person_subj_last_batch ON dim_person_subject (last_seen_batch_id);

-- -----------------------------------------------------------------------------
-- vw_dim_subject_union：统一主体查询视图（企业 + 个人）
-- 含义：将两张主体维表投影为统一字段，便于跨主体专题（如企业对私交易）直接查询。
-- 重要：企业主题页面默认仍建议仅使用 dim_enterprise_subject，不应直接把本视图作为企业口径底表。
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS vw_dim_subject_union AS
SELECT
    enterprise_subject_id AS subject_id,
    stat_year,
    'enterprise' AS subject_type,
    xfsbh,
    xfmc,
    gfsbh,
    gfmc,
    taxpayer_id AS subject_no,
    enterprise_name_std AS subject_name_std,
    enterprise_name_raw AS subject_name_raw,
    has_seller_role,
    has_buyer_role,
    first_seen_batch_id,
    last_seen_batch_id,
    data_first_seen_date,
    data_last_seen_date,
    rule_version,
    quality_status,
    quality_issue,
    updated_at
FROM dim_enterprise_subject
UNION ALL
SELECT
    person_subject_id AS subject_id,
    stat_year,
    'person' AS subject_type,
    xfsbh,
    xfmc,
    gfsbh,
    gfmc,
    id_card_no AS subject_no,
    person_name AS subject_name_std,
    person_name AS subject_name_raw,
    has_seller_role,
    has_buyer_role,
    first_seen_batch_id,
    last_seen_batch_id,
    data_first_seen_date,
    data_last_seen_date,
    rule_version,
    quality_status,
    quality_issue,
    updated_at
FROM dim_person_subject;

-- -----------------------------------------------------------------------------
-- 统一主体库（当前阶段：不引入年度维度）
-- 设计目标：
-- 1) 主体主表只维护“主体是谁”的稳定信息；
-- 2) 来源记录表维护“信息从哪里来、何时来、原文是什么”；
-- 3) 组织机构主体与自然人主体在同一主表内统一管理，通过 subject_category 分域。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_subject_master (
    subject_id             VARCHAR NOT NULL PRIMARY KEY, -- 统一主体 ID（建议 ETL 生成稳定 ID，如 SUB_xxx）
    subject_name           VARCHAR NOT NULL,             -- 主体名称（当前展示主名称）
    subject_name_std       VARCHAR,                      -- 主体规范化名称（检索/去重）
    subject_category       VARCHAR NOT NULL,             -- 主体类别：org/person
    org_category           VARCHAR,                      -- 机构类别（仅组织机构主体适用）
    subject_no             VARCHAR,                      -- 主体标识号（统一社会信用代码/身份证号/其他）
    subject_no_type        VARCHAR,                      -- 标识号类型：uscc/id_card/taxpayer_id/other
    source_status          VARCHAR DEFAULT 'single',     -- 来源状态：single/merged/conflict/pending
    first_source_system    VARCHAR,                      -- 首次来源系统（invoice/external/manual）
    first_import_batch_id  VARCHAR,                      -- 首次导入批次（命名与 DWD 一致）
    first_import_session_id VARCHAR,                     -- 首次导入会话（命名与 DWD 一致）
    last_import_batch_id   VARCHAR,                      -- 最近导入批次（命名与 DWD 一致）
    last_import_session_id VARCHAR,                      -- 最近导入会话（命名与 DWD 一致）
    quality_status         VARCHAR DEFAULT 'ok',         -- 质量状态：ok/warning/error
    quality_issue          VARCHAR,                      -- 质量问题说明
    subject_build_run_id   VARCHAR,                      -- 主体构建批次（归集/分类/关联链路 run_id）
    subject_snapshot_id    VARCHAR,                      -- 主体快照批次（可重算追溯）
    category_rule_version  VARCHAR,                      -- 分类规则版本（如 subject_category_matching.yaml hash/version）
    category_rule_enabled_at_run BOOLEAN DEFAULT TRUE,   -- 本次跑批时该类别是否处于启用状态
    category_status_note   VARCHAR,                      -- 类别状态备注（如 category_disabled_at_run）
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (subject_category IN ('org', 'person')),
    CHECK (source_status IN ('single', 'merged', 'conflict', 'pending')),
    CHECK (quality_status IN ('ok', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_subject_master_name_std ON dim_subject_master (subject_name_std);
CREATE INDEX IF NOT EXISTS idx_subject_master_category ON dim_subject_master (subject_category);
CREATE INDEX IF NOT EXISTS idx_subject_master_org_cat  ON dim_subject_master (org_category);
CREATE INDEX IF NOT EXISTS idx_subject_master_no       ON dim_subject_master (subject_no);
CREATE INDEX IF NOT EXISTS idx_subject_master_last_bat ON dim_subject_master (last_import_batch_id);
CREATE INDEX IF NOT EXISTS idx_subject_master_runid    ON dim_subject_master (subject_build_run_id);
CREATE INDEX IF NOT EXISTS idx_subject_master_snapshot ON dim_subject_master (subject_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_subject_master_rulever  ON dim_subject_master (category_rule_version);

-- -----------------------------------------------------------------------------
-- dim_enterprise_year_rel：企业-年度关系物理表（推荐主事实表）
-- 设计定位：
-- 1) dim_subject_master 只存“主体是谁”的稳定信息（不按年度拆行）；
-- 2) 本表存“主体在哪些年度参与业务”的关系事实（按年度拆行）；
-- 3) 前端主体库默认查主表，按年度筛选时联接本表，兼顾全集视角与年度追溯。
--
-- 粒度：
-- - 一行 = 一个企业主体（subject_id）在一个统计年度（stat_year）的一条关系记录
-- - 主键：subject_id + stat_year
--
-- 口径建议：
-- - first_seen_* / last_seen_* 基于当年票据口径聚合（不是跨年口径）
-- - has_seller_role / has_buyer_role 为“该年度是否出现过该角色”
-- - 若未来需要更细粒度（按月/按季度），建议新增关系层表，不破坏本表主键
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_enterprise_year_rel (
    subject_id                 VARCHAR  NOT NULL, -- 关联 dim_subject_master.subject_id（企业主体）
    stat_year                  SMALLINT NOT NULL, -- 统计年度（建议与 dwd_inv_header.stat_year 对齐）

    year_role_tag              VARCHAR  DEFAULT 'unknown', -- 年度角色标签：seller / buyer / both / unknown
    has_seller_role            BOOLEAN  DEFAULT FALSE,     -- 当年是否出现过销方角色
    has_buyer_role             BOOLEAN  DEFAULT FALSE,     -- 当年是否出现过购方角色

    year_first_seen_batch_id   VARCHAR,  -- 当年首次出现批次（按年度最小批次口径）
    year_last_seen_batch_id    VARCHAR,  -- 当年最后出现批次（按年度最大批次口径）
    year_first_seen_session_id VARCHAR,  -- 当年首次出现会话（可选）
    year_last_seen_session_id  VARCHAR,  -- 当年最后出现会话（可选）
    year_first_seen_date       DATE,     -- 当年首次业务日期（如 invoice_date 最小值）
    year_last_seen_date        DATE,     -- 当年最后业务日期（如 invoice_date 最大值）

    invoice_count              BIGINT  DEFAULT 0,          -- 当年涉及发票条数（可按 header 粒度）
    amount_jshj_sum            DECIMAL(18,2) DEFAULT 0,    -- 当年价税合计汇总（可选：jshj 汇总）

    relation_build_run_id      VARCHAR,  -- 年度关系构建任务 run_id（重算追溯）
    relation_snapshot_id       VARCHAR,  -- 年度关系快照 ID（与重算批次关联）
    quality_status             VARCHAR DEFAULT 'ok', -- 质量状态：ok / warning / error
    quality_issue              VARCHAR,              -- 质量问题说明（如年度冲突、批次缺失）
    updated_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (subject_id, stat_year),
    CHECK (year_role_tag IN ('seller', 'buyer', 'both', 'unknown')),
    CHECK (quality_status IN ('ok', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_ent_year_rel_year            ON dim_enterprise_year_rel (stat_year);
CREATE INDEX IF NOT EXISTS idx_ent_year_rel_last_batch      ON dim_enterprise_year_rel (year_last_seen_batch_id);
CREATE INDEX IF NOT EXISTS idx_ent_year_rel_snapshot        ON dim_enterprise_year_rel (relation_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_ent_year_rel_quality         ON dim_enterprise_year_rel (quality_status);

-- -----------------------------------------------------------------------------
-- v_enterprise_latest_year：企业最近活跃年度视图
-- 用途：
-- - 主体库列表默认展示“最近活跃年度标签”时使用
-- - 避免每次在前端做 max(stat_year) 聚合
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_enterprise_latest_year AS
SELECT
    r.subject_id,
    MAX(r.stat_year) AS latest_stat_year,
    MAX(r.year_last_seen_date) AS latest_seen_date
FROM dim_enterprise_year_rel r
GROUP BY r.subject_id;

-- -----------------------------------------------------------------------------
-- v_enterprise_year_summary：年度汇总视图（管理看板/筛选器可直接消费）
-- 用途：
-- - 提供“每年主体数、角色分布、票据规模”的快速统计
-- - 作为前端年度下拉与年度概览卡片的数据来源
-- -----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_enterprise_year_summary AS
SELECT
    stat_year,
    COUNT(*) AS enterprise_count, -- 当年主体数（按 subject_id 去重后行数）
    SUM(CASE WHEN has_seller_role THEN 1 ELSE 0 END) AS seller_subject_count,
    SUM(CASE WHEN has_buyer_role THEN 1 ELSE 0 END) AS buyer_subject_count,
    SUM(CASE WHEN has_seller_role AND has_buyer_role THEN 1 ELSE 0 END) AS both_role_subject_count,
    SUM(COALESCE(invoice_count, 0)) AS invoice_count_sum,
    SUM(COALESCE(amount_jshj_sum, 0)) AS amount_jshj_sum
FROM dim_enterprise_year_rel
GROUP BY stat_year;

-- -----------------------------------------------------------------------------
-- 回填模板（示例 SQL，不会自动执行）
-- 目标：从 dwd_inv_header 回填 dim_enterprise_year_rel
-- 说明：
-- 1) 仅示例口径，可按业务改造（例如金额口径改为净额 net_jshj）；
-- 2) 默认只处理组织机构主体（dim_subject_master.subject_category='org'）；
-- 3) 通过 subject_no 关联主体主表；若需更严格，可叠加名称相似度或规则版本约束。
-- -----------------------------------------------------------------------------
--
-- Step A) 拉平销/购主体候选（统一为 subject_no + role）
-- WITH dwd_subject_union AS (
--     SELECT
--         h.stat_year,
--         TRIM(h.xfsbh) AS subject_no,
--         'seller' AS role_tag,
--         h.import_batch_id,
--         h.import_session_id,
--         h.invoice_date,
--         COALESCE(h.jshj, 0) AS amount_jshj
--     FROM dwd_inv_header h
--     WHERE TRIM(COALESCE(h.xfsbh, '')) <> ''
--
--     UNION ALL
--
--     SELECT
--         h.stat_year,
--         TRIM(h.gfsbh) AS subject_no,
--         'buyer' AS role_tag,
--         h.import_batch_id,
--         h.import_session_id,
--         h.invoice_date,
--         COALESCE(h.jshj, 0) AS amount_jshj
--     FROM dwd_inv_header h
--     WHERE TRIM(COALESCE(h.gfsbh, '')) <> ''
-- ),
--
-- Step B) 关联主体主表并做年度聚合
-- year_agg AS (
--     SELECT
--         m.subject_id,
--         u.stat_year,
--         BOOL_OR(u.role_tag = 'seller') AS has_seller_role,
--         BOOL_OR(u.role_tag = 'buyer')  AS has_buyer_role,
--         COUNT(*) AS invoice_count,
--         SUM(u.amount_jshj) AS amount_jshj_sum,
--         MIN(u.invoice_date) AS year_first_seen_date,
--         MAX(u.invoice_date) AS year_last_seen_date,
--         MIN(u.import_batch_id) AS year_first_seen_batch_id,
--         MAX(u.import_batch_id) AS year_last_seen_batch_id,
--         MIN(u.import_session_id) AS year_first_seen_session_id,
--         MAX(u.import_session_id) AS year_last_seen_session_id
--     FROM dwd_subject_union u
--     JOIN dim_subject_master m
--       ON m.subject_no = u.subject_no
--      AND m.subject_category = 'org'
--     GROUP BY m.subject_id, u.stat_year
-- )
--
-- Step C) UPSERT 到 dim_enterprise_year_rel（DuckDB 语法）
-- INSERT INTO dim_enterprise_year_rel (
--     subject_id,
--     stat_year,
--     year_role_tag,
--     has_seller_role,
--     has_buyer_role,
--     year_first_seen_batch_id,
--     year_last_seen_batch_id,
--     year_first_seen_session_id,
--     year_last_seen_session_id,
--     year_first_seen_date,
--     year_last_seen_date,
--     invoice_count,
--     amount_jshj_sum,
--     relation_build_run_id,
--     relation_snapshot_id,
--     quality_status,
--     quality_issue,
--     updated_at
-- )
-- SELECT
--     subject_id,
--     stat_year,
--     CASE
--         WHEN has_seller_role AND has_buyer_role THEN 'both'
--         WHEN has_seller_role THEN 'seller'
--         WHEN has_buyer_role THEN 'buyer'
--         ELSE 'unknown'
--     END AS year_role_tag,
--     has_seller_role,
--     has_buyer_role,
--     year_first_seen_batch_id,
--     year_last_seen_batch_id,
--     year_first_seen_session_id,
--     year_last_seen_session_id,
--     year_first_seen_date,
--     year_last_seen_date,
--     invoice_count,
--     amount_jshj_sum,
--     'RUN_20260430_DEMO' AS relation_build_run_id, -- 示例：替换为真实 run_id
--     'SNAP_20260430_DEMO' AS relation_snapshot_id, -- 示例：替换为真实 snapshot_id
--     'ok' AS quality_status,
--     NULL AS quality_issue,
--     CURRENT_TIMESTAMP AS updated_at
-- FROM year_agg
-- ON CONFLICT (subject_id, stat_year) DO UPDATE SET
--     year_role_tag = EXCLUDED.year_role_tag,
--     has_seller_role = EXCLUDED.has_seller_role,
--     has_buyer_role = EXCLUDED.has_buyer_role,
--     year_first_seen_batch_id = EXCLUDED.year_first_seen_batch_id,
--     year_last_seen_batch_id = EXCLUDED.year_last_seen_batch_id,
--     year_first_seen_session_id = EXCLUDED.year_first_seen_session_id,
--     year_last_seen_session_id = EXCLUDED.year_last_seen_session_id,
--     year_first_seen_date = EXCLUDED.year_first_seen_date,
--     year_last_seen_date = EXCLUDED.year_last_seen_date,
--     invoice_count = EXCLUDED.invoice_count,
--     amount_jshj_sum = EXCLUDED.amount_jshj_sum,
--     relation_build_run_id = EXCLUDED.relation_build_run_id,
--     relation_snapshot_id = EXCLUDED.relation_snapshot_id,
--     quality_status = EXCLUDED.quality_status,
--     quality_issue = EXCLUDED.quality_issue,
--     updated_at = CURRENT_TIMESTAMP;
--
-- Step D) 快速验收（示例）
-- -- 1) 年度覆盖检查
-- -- SELECT stat_year, COUNT(*) FROM dim_enterprise_year_rel GROUP BY stat_year ORDER BY stat_year DESC;
-- -- 2) 角色分布检查
-- -- SELECT stat_year, year_role_tag, COUNT(*) FROM dim_enterprise_year_rel GROUP BY stat_year, year_role_tag ORDER BY stat_year DESC, year_role_tag;
-- -- 3) 与视图一致性
-- -- SELECT * FROM v_enterprise_year_summary ORDER BY stat_year DESC;
--
-- -----------------------------------------------------------------------------
-- 变体模板 1：按单年回填（建议用于试运行/灰度）
-- 使用方式：
-- - 将 :target_year 替换为目标年度（如 2026）
-- - 建议先执行 DELETE 再 INSERT，确保口径干净可控
-- -----------------------------------------------------------------------------
-- -- 可选：先清理目标年度（谨慎执行）
-- -- DELETE FROM dim_enterprise_year_rel WHERE stat_year = :target_year;
--
-- WITH dwd_subject_union AS (
--     SELECT
--         h.stat_year,
--         TRIM(h.xfsbh) AS subject_no,
--         'seller' AS role_tag,
--         h.import_batch_id,
--         h.import_session_id,
--         h.invoice_date,
--         COALESCE(h.jshj, 0) AS amount_jshj
--     FROM dwd_inv_header h
--     WHERE h.stat_year = :target_year
--       AND TRIM(COALESCE(h.xfsbh, '')) <> ''
--
--     UNION ALL
--
--     SELECT
--         h.stat_year,
--         TRIM(h.gfsbh) AS subject_no,
--         'buyer' AS role_tag,
--         h.import_batch_id,
--         h.import_session_id,
--         h.invoice_date,
--         COALESCE(h.jshj, 0) AS amount_jshj
--     FROM dwd_inv_header h
--     WHERE h.stat_year = :target_year
--       AND TRIM(COALESCE(h.gfsbh, '')) <> ''
-- ),
-- year_agg AS (
--     SELECT
--         m.subject_id,
--         u.stat_year,
--         BOOL_OR(u.role_tag = 'seller') AS has_seller_role,
--         BOOL_OR(u.role_tag = 'buyer')  AS has_buyer_role,
--         COUNT(*) AS invoice_count,
--         SUM(u.amount_jshj) AS amount_jshj_sum,
--         MIN(u.invoice_date) AS year_first_seen_date,
--         MAX(u.invoice_date) AS year_last_seen_date,
--         MIN(u.import_batch_id) AS year_first_seen_batch_id,
--         MAX(u.import_batch_id) AS year_last_seen_batch_id,
--         MIN(u.import_session_id) AS year_first_seen_session_id,
--         MAX(u.import_session_id) AS year_last_seen_session_id
--     FROM dwd_subject_union u
--     JOIN dim_subject_master m
--       ON m.subject_no = u.subject_no
--      AND m.subject_category = 'org'
--     GROUP BY m.subject_id, u.stat_year
-- )
-- INSERT INTO dim_enterprise_year_rel (
--     subject_id, stat_year, year_role_tag, has_seller_role, has_buyer_role,
--     year_first_seen_batch_id, year_last_seen_batch_id,
--     year_first_seen_session_id, year_last_seen_session_id,
--     year_first_seen_date, year_last_seen_date,
--     invoice_count, amount_jshj_sum,
--     relation_build_run_id, relation_snapshot_id, quality_status, quality_issue, updated_at
-- )
-- SELECT
--     subject_id,
--     stat_year,
--     CASE
--         WHEN has_seller_role AND has_buyer_role THEN 'both'
--         WHEN has_seller_role THEN 'seller'
--         WHEN has_buyer_role THEN 'buyer'
--         ELSE 'unknown'
--     END,
--     has_seller_role,
--     has_buyer_role,
--     year_first_seen_batch_id,
--     year_last_seen_batch_id,
--     year_first_seen_session_id,
--     year_last_seen_session_id,
--     year_first_seen_date,
--     year_last_seen_date,
--     invoice_count,
--     amount_jshj_sum,
--     'RUN_YEAR_:target_year',
--     'SNAP_YEAR_:target_year',
--     'ok',
--     NULL,
--     CURRENT_TIMESTAMP
-- FROM year_agg
-- ON CONFLICT (subject_id, stat_year) DO UPDATE SET
--     year_role_tag = EXCLUDED.year_role_tag,
--     has_seller_role = EXCLUDED.has_seller_role,
--     has_buyer_role = EXCLUDED.has_buyer_role,
--     year_first_seen_batch_id = EXCLUDED.year_first_seen_batch_id,
--     year_last_seen_batch_id = EXCLUDED.year_last_seen_batch_id,
--     year_first_seen_session_id = EXCLUDED.year_first_seen_session_id,
--     year_last_seen_session_id = EXCLUDED.year_last_seen_session_id,
--     year_first_seen_date = EXCLUDED.year_first_seen_date,
--     year_last_seen_date = EXCLUDED.year_last_seen_date,
--     invoice_count = EXCLUDED.invoice_count,
--     amount_jshj_sum = EXCLUDED.amount_jshj_sum,
--     relation_build_run_id = EXCLUDED.relation_build_run_id,
--     relation_snapshot_id = EXCLUDED.relation_snapshot_id,
--     quality_status = EXCLUDED.quality_status,
--     quality_issue = EXCLUDED.quality_issue,
--     updated_at = CURRENT_TIMESTAMP;
--
-- -----------------------------------------------------------------------------
-- 变体模板 2：按批次范围回填（常用于补导/重跑某段历史）
-- 使用方式：
-- - 将 :batch_from / :batch_to 替换为批次区间（字符串比较，建议统一批次格式）
-- - 若需仅针对某年，可在 WHERE 再叠加 stat_year 条件
-- -----------------------------------------------------------------------------
-- WITH dwd_subject_union AS (
--     SELECT
--         h.stat_year,
--         TRIM(h.xfsbh) AS subject_no,
--         'seller' AS role_tag,
--         h.import_batch_id,
--         h.import_session_id,
--         h.invoice_date,
--         COALESCE(h.jshj, 0) AS amount_jshj
--     FROM dwd_inv_header h
--     WHERE TRIM(COALESCE(h.xfsbh, '')) <> ''
--       AND TRIM(COALESCE(h.import_batch_id, '')) >= ':batch_from'
--       AND TRIM(COALESCE(h.import_batch_id, '')) <= ':batch_to'
--
--     UNION ALL
--
--     SELECT
--         h.stat_year,
--         TRIM(h.gfsbh) AS subject_no,
--         'buyer' AS role_tag,
--         h.import_batch_id,
--         h.import_session_id,
--         h.invoice_date,
--         COALESCE(h.jshj, 0) AS amount_jshj
--     FROM dwd_inv_header h
--     WHERE TRIM(COALESCE(h.gfsbh, '')) <> ''
--       AND TRIM(COALESCE(h.import_batch_id, '')) >= ':batch_from'
--       AND TRIM(COALESCE(h.import_batch_id, '')) <= ':batch_to'
-- ),
-- year_agg AS (
--     SELECT
--         m.subject_id,
--         u.stat_year,
--         BOOL_OR(u.role_tag = 'seller') AS has_seller_role,
--         BOOL_OR(u.role_tag = 'buyer')  AS has_buyer_role,
--         COUNT(*) AS invoice_count,
--         SUM(u.amount_jshj) AS amount_jshj_sum,
--         MIN(u.invoice_date) AS year_first_seen_date,
--         MAX(u.invoice_date) AS year_last_seen_date,
--         MIN(u.import_batch_id) AS year_first_seen_batch_id,
--         MAX(u.import_batch_id) AS year_last_seen_batch_id,
--         MIN(u.import_session_id) AS year_first_seen_session_id,
--         MAX(u.import_session_id) AS year_last_seen_session_id
--     FROM dwd_subject_union u
--     JOIN dim_subject_master m
--       ON m.subject_no = u.subject_no
--      AND m.subject_category = 'org'
--     GROUP BY m.subject_id, u.stat_year
-- )
-- INSERT INTO dim_enterprise_year_rel (
--     subject_id, stat_year, year_role_tag, has_seller_role, has_buyer_role,
--     year_first_seen_batch_id, year_last_seen_batch_id,
--     year_first_seen_session_id, year_last_seen_session_id,
--     year_first_seen_date, year_last_seen_date,
--     invoice_count, amount_jshj_sum,
--     relation_build_run_id, relation_snapshot_id, quality_status, quality_issue, updated_at
-- )
-- SELECT
--     subject_id,
--     stat_year,
--     CASE
--         WHEN has_seller_role AND has_buyer_role THEN 'both'
--         WHEN has_seller_role THEN 'seller'
--         WHEN has_buyer_role THEN 'buyer'
--         ELSE 'unknown'
--     END,
--     has_seller_role,
--     has_buyer_role,
--     year_first_seen_batch_id,
--     year_last_seen_batch_id,
--     year_first_seen_session_id,
--     year_last_seen_session_id,
--     year_first_seen_date,
--     year_last_seen_date,
--     invoice_count,
--     amount_jshj_sum,
--     'RUN_BATCH_:batch_from_:batch_to',
--     'SNAP_BATCH_:batch_from_:batch_to',
--     'ok',
--     NULL,
--     CURRENT_TIMESTAMP
-- FROM year_agg
-- ON CONFLICT (subject_id, stat_year) DO UPDATE SET
--     year_role_tag = EXCLUDED.year_role_tag,
--     has_seller_role = EXCLUDED.has_seller_role,
--     has_buyer_role = EXCLUDED.has_buyer_role,
--     year_first_seen_batch_id = EXCLUDED.year_first_seen_batch_id,
--     year_last_seen_batch_id = EXCLUDED.year_last_seen_batch_id,
--     year_first_seen_session_id = EXCLUDED.year_first_seen_session_id,
--     year_last_seen_session_id = EXCLUDED.year_last_seen_session_id,
--     year_first_seen_date = EXCLUDED.year_first_seen_date,
--     year_last_seen_date = EXCLUDED.year_last_seen_date,
--     invoice_count = EXCLUDED.invoice_count,
--     amount_jshj_sum = EXCLUDED.amount_jshj_sum,
--     relation_build_run_id = EXCLUDED.relation_build_run_id,
--     relation_snapshot_id = EXCLUDED.relation_snapshot_id,
--     quality_status = EXCLUDED.quality_status,
--     quality_issue = EXCLUDED.quality_issue,
--     updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS dim_subject_source_record (
    source_record_id       VARCHAR NOT NULL PRIMARY KEY, -- 来源记录 ID（建议 ETL 生成稳定 ID）
    subject_id             VARCHAR,                      -- 关联统一主体 ID（待匹配时可为空）
    source_system          VARCHAR NOT NULL,             -- 来源系统：invoice/external/manual
    import_batch_id        VARCHAR,                      -- 导入批次 ID（命名与 DWD 一致）
    import_session_id      VARCHAR,                      -- 导入会话 ID（命名与 DWD 一致）
    ods_file_seq           INTEGER,                      -- ODS 分片序号（命名与 DWD 一致）
    source_excel_file      VARCHAR,                      -- 来源 Excel 文件路径（命名与 DWD 一致）
    source_parquet_file    VARCHAR,                      -- 来源 ODS Parquet 路径（命名与 DWD 一致）
    source_sheet           VARCHAR,                      -- 来源工作表名（命名与 DWD 一致）
    source_row_no          BIGINT,                       -- 来源行号（可为空）
    raw_subject_name       VARCHAR,                      -- 原始主体名称
    raw_subject_no         VARCHAR,                      -- 原始主体标识号
    raw_subject_no_type    VARCHAR,                      -- 原始标识号类型
    raw_subject_category   VARCHAR,                      -- 原始主体类别：org/person/unknown
    raw_org_category       VARCHAR,                      -- 原始机构类别
    subject_build_run_id   VARCHAR,                      -- 主体构建批次（归集/分类/关联链路 run_id）
    subject_snapshot_id    VARCHAR,                      -- 主体快照批次（可重算追溯）
    category_rule_version  VARCHAR,                      -- 分类规则版本（如 subject_category_matching.yaml hash/version）
    category_rule_enabled_at_run BOOLEAN DEFAULT TRUE,   -- 本次跑批时该类别是否处于启用状态
    category_status_note   VARCHAR,                      -- 类别状态备注（如 category_disabled_at_run）
    match_status           VARCHAR DEFAULT 'matched',    -- 匹配状态：matched/pending/conflict
    match_rule             VARCHAR,                      -- 命中的匹配规则（如 uscc_exact/name_fuzzy）
    match_confidence       DECIMAL(5,4),                 -- 匹配置信度（0~1）
    payload_json           JSON,                         -- 原始扩展信息（字段保真）
    ingest_ts              TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 进入 ODS/主体链路时间（命名与 DWD 一致）
    CHECK (source_system IN ('invoice', 'external', 'manual')),
    CHECK (match_status IN ('matched', 'pending', 'conflict'))
);

CREATE INDEX IF NOT EXISTS idx_subject_src_subject_id ON dim_subject_source_record (subject_id);
CREATE INDEX IF NOT EXISTS idx_subject_src_system     ON dim_subject_source_record (source_system);
CREATE INDEX IF NOT EXISTS idx_subject_src_batch      ON dim_subject_source_record (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_subject_src_match      ON dim_subject_source_record (match_status);
CREATE INDEX IF NOT EXISTS idx_subject_src_name       ON dim_subject_source_record (raw_subject_name);
CREATE INDEX IF NOT EXISTS idx_subject_src_no         ON dim_subject_source_record (raw_subject_no);
CREATE INDEX IF NOT EXISTS idx_subject_src_runid      ON dim_subject_source_record (subject_build_run_id);
CREATE INDEX IF NOT EXISTS idx_subject_src_snapshot   ON dim_subject_source_record (subject_snapshot_id);

-- 主体分类快照（可重算追溯）
CREATE TABLE IF NOT EXISTS dim_subject_category_snapshot (
    snapshot_row_id             VARCHAR NOT NULL PRIMARY KEY, -- 快照行 ID（建议：subject_id + snapshot_id）
    snapshot_id                 VARCHAR NOT NULL,             -- 快照批次 ID（一次重算/归集对应一个 snapshot）
    subject_build_run_id        VARCHAR,                      -- 主体构建批次 run_id
    subject_id                  VARCHAR NOT NULL,             -- 统一主体 ID
    subject_category            VARCHAR,                      -- 主体域类别：org/person
    org_category                VARCHAR,                      -- 组织机构类别编码（SC-ENT/...）
    category_rule_version       VARCHAR,                      -- 分类规则版本
    category_rule_enabled_at_run BOOLEAN DEFAULT TRUE,        -- 跑批时类别是否启用
    category_status_note        VARCHAR,                      -- 类别状态备注（如 category_disabled_at_run）
    infer_reasons_json          JSON,                         -- 推断原因（InferResult.reasons）
    infer_needs_review          BOOLEAN DEFAULT FALSE,        -- 推断是否需复核
    infer_skipped_disabled_json JSON,                         -- 被停用而跳过的类别列表
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subj_snap_snapshot_id ON dim_subject_category_snapshot (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_subj_snap_subject_id  ON dim_subject_category_snapshot (subject_id);
CREATE INDEX IF NOT EXISTS idx_subj_snap_org_cat     ON dim_subject_category_snapshot (org_category);

-- 主体关系快照（分类重算后的关联重建结果）
CREATE TABLE IF NOT EXISTS dim_subject_relation_snapshot (
    relation_row_id              VARCHAR NOT NULL PRIMARY KEY, -- 快照行 ID（建议：snapshot_id + left/right/type）
    snapshot_id                  VARCHAR NOT NULL,             -- 快照批次 ID
    subject_build_run_id         VARCHAR,                      -- 主体构建批次 run_id
    relation_type                VARCHAR NOT NULL,             -- 关系类型：TRADE_COUNTERPARTY / ...
    left_subject_id              VARCHAR NOT NULL,             -- 关系左侧主体（如销方）
    right_subject_id             VARCHAR NOT NULL,             -- 关系右侧主体（如购方）
    relation_strength            DECIMAL(10,4),                -- 关系强度（当前用发票条数）
    relation_confidence          DECIMAL(5,4),                 -- 关系置信度（当前规则先给 1.0000）
    evidence_count               BIGINT DEFAULT 0,             -- 证据条数
    trade_invoice_count          BIGINT DEFAULT 0,             -- 交易发票数
    trade_amount_jshj            DECIMAL(18,2) DEFAULT 0,      -- 交易价税合计（jshj）
    first_invoice_date           DATE,                         -- 首次出现日期
    last_invoice_date            DATE,                         -- 最近出现日期
    evidence_json                JSON,                         -- 证据摘要（样例 header_uuid 等）
    created_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subj_rel_snap_snapshot ON dim_subject_relation_snapshot (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_subj_rel_snap_left     ON dim_subject_relation_snapshot (left_subject_id);
CREATE INDEX IF NOT EXISTS idx_subj_rel_snap_right    ON dim_subject_relation_snapshot (right_subject_id);
CREATE INDEX IF NOT EXISTS idx_subj_rel_snap_type     ON dim_subject_relation_snapshot (relation_type);

-- 主体关系当前表（最新快照投影，便于页面/接口直接查询）
CREATE TABLE IF NOT EXISTS dim_subject_relation_current (
    relation_key                 VARCHAR NOT NULL PRIMARY KEY, -- 稳定键：left/right/type
    snapshot_id                  VARCHAR NOT NULL,
    subject_build_run_id         VARCHAR,
    relation_type                VARCHAR NOT NULL,
    left_subject_id              VARCHAR NOT NULL,
    right_subject_id             VARCHAR NOT NULL,
    relation_strength            DECIMAL(10,4),
    relation_confidence          DECIMAL(5,4),
    evidence_count               BIGINT DEFAULT 0,
    trade_invoice_count          BIGINT DEFAULT 0,
    trade_amount_jshj            DECIMAL(18,2) DEFAULT 0,
    first_invoice_date           DATE,
    last_invoice_date            DATE,
    evidence_json                JSON,
    updated_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subj_rel_cur_left  ON dim_subject_relation_current (left_subject_id);
CREATE INDEX IF NOT EXISTS idx_subj_rel_cur_right ON dim_subject_relation_current (right_subject_id);
CREATE INDEX IF NOT EXISTS idx_subj_rel_cur_type  ON dim_subject_relation_current (relation_type);

CREATE TABLE IF NOT EXISTS dim_ind_rule (
    industry_id      VARCHAR NOT NULL PRIMARY KEY,
    industry_name    VARCHAR,
    cr1_warn         DECIMAL(4,2) DEFAULT 0.30,
    cr1_high         DECIMAL(4,2) DEFAULT 0.50,
    cr3_warn         DECIMAL(4,2) DEFAULT 0.50,
    cr3_high         DECIMAL(4,2) DEFAULT 0.70,
    large_amount_threshold   DECIMAL(18,2) DEFAULT 1000000,
    weekend_amount_threshold DECIMAL(18,2) DEFAULT 100000,
    rule_note        VARCHAR,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

