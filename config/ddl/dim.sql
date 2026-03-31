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
    tax_code         VARCHAR NOT NULL PRIMARY KEY,
    goods_name       VARCHAR,
    goods_short_name VARCHAR,
    description      VARCHAR,
    level_pian       VARCHAR,  level_lei   VARCHAR,  level_zhang VARCHAR,
    level_jie        VARCHAR,  level_tiao  VARCHAR,  level_kuan  VARCHAR,
    level_xiang      VARCHAR,  level_mu    VARCHAR,  level_zimu  VARCHAR,
    level_ximu       VARCHAR,
    code_depth       INTEGER,
    is_leaf          BOOLEAN,
    parent_code      VARCHAR,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tax_short  ON dim_tax_code (goods_short_name);
CREATE INDEX IF NOT EXISTS idx_tax_parent ON dim_tax_code (parent_code);

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

