-- dws_trade_sum：实体交易汇总（关联交易分析基础表）
CREATE TABLE IF NOT EXISTS dws_trade_sum (
    trade_sum_uuid    VARCHAR NOT NULL PRIMARY KEY,
    stat_year         SMALLINT NOT NULL,
    entity_id         VARCHAR NOT NULL,
    entity_name       VARCHAR,
    role_type         VARCHAR NOT NULL,     -- 销方 / 购方
    counterparty_id   VARCHAR NOT NULL,
    counterparty_name VARCHAR NOT NULL,
    counterparty_role VARCHAR NOT NULL,
    -- 供应商 / 客户 / 往来单位（既是供应商又是客户）
    total_amount      DECIMAL(18,2) NOT NULL,  -- net_jshj 年度汇总
    invoice_cnt       INT NOT NULL,
    max_invoice_amt   DECIMAL(18,2) NOT NULL,
    latest_invoice_date DATE NOT NULL,
    update_time       TIMESTAMP NOT NULL,
    UNIQUE (entity_id, stat_year, role_type, counterparty_id)
);

CREATE INDEX IF NOT EXISTS idx_trd_counter   ON dws_trade_sum (counterparty_id, stat_year);
CREATE INDEX IF NOT EXISTS idx_trd_year_ent ON dws_trade_sum (stat_year, entity_id);

-- dws_inv_trend：月度开票趋势汇总
CREATE TABLE IF NOT EXISTS dws_inv_trend (
    trend_uuid    VARCHAR NOT NULL PRIMARY KEY,
    entity_id     VARCHAR NOT NULL,
    entity_name   VARCHAR,
    stat_year     SMALLINT NOT NULL,
    stat_month    TINYINT NOT NULL,
    role_type     VARCHAR NOT NULL,   -- 进项 / 销项
    normal_cnt    INT DEFAULT 0,
    normal_je     DECIMAL(18,2) DEFAULT 0,
    normal_jshj   DECIMAL(18,2) DEFAULT 0,
    red_cnt       INT DEFAULT 0,
    red_jshj      DECIMAL(18,2) DEFAULT 0,
    cancel_cnt    INT DEFAULT 0,
    net_jshj      DECIMAL(18,2) DEFAULT 0,   -- 核心趋势字段
    holiday_cnt   INT DEFAULT 0,
    weekend_large_cnt INT DEFAULT 0,
    update_time   TIMESTAMP NOT NULL,
    UNIQUE (entity_id, stat_year, stat_month, role_type)
);

CREATE INDEX IF NOT EXISTS idx_trend_year_ent  ON dws_inv_trend (stat_year, entity_id);

-- dws_sup_conc：供应商集中度汇总
CREATE TABLE IF NOT EXISTS dws_sup_conc (
    conc_uuid          VARCHAR NOT NULL PRIMARY KEY,
    entity_id          VARCHAR NOT NULL,
    entity_name        VARCHAR,
    stat_year          SMALLINT NOT NULL,
    supplier_id        VARCHAR NOT NULL,
    supplier_name      VARCHAR,
    is_new_supplier    BOOLEAN DEFAULT FALSE,
    first_invoice_date DATE,
    last_invoice_date  DATE,
    net_jshj           DECIMAL(18,2) NOT NULL,
    invoice_cnt        INT NOT NULL,
    max_single_amt     DECIMAL(18,2),
    goods_categories   VARCHAR,   -- JSON 数组
    tax_codes          VARCHAR,   -- JSON 数组
    tax_rates          VARCHAR,   -- JSON 数组
    amount_rank        INT,
    amount_ratio       DECIMAL(8,6),
    cumulative_ratio   DECIMAL(8,6),
    update_time        TIMESTAMP NOT NULL,
    UNIQUE (entity_id, stat_year, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_sup_year_ent ON dws_sup_conc (stat_year, entity_id);
CREATE INDEX IF NOT EXISTS idx_sup_rank     ON dws_sup_conc (stat_year, entity_id, amount_rank);

-- dws_goods_cat：商品品类汇总
CREATE TABLE IF NOT EXISTS dws_goods_cat (
    category_uuid   VARCHAR NOT NULL PRIMARY KEY,
    entity_id       VARCHAR NOT NULL,
    stat_year       SMALLINT NOT NULL,
    stat_quarter    TINYINT NOT NULL,
    tax_code_short  VARCHAR,
    tax_code_level2 VARCHAR,
    net_jshj        DECIMAL(18,2) DEFAULT 0,
    invoice_cnt     INT DEFAULT 0,
    supplier_cnt    INT DEFAULT 0,
    avg_single_amt  DECIMAL(18,2),
    max_single_amt  DECIMAL(18,2),
    distinct_tax_rates INT DEFAULT 1,
    update_time     TIMESTAMP NOT NULL,
    UNIQUE (entity_id, stat_year, stat_quarter, tax_code_short)
);

-- dws_quality：数据质量汇总
CREATE TABLE IF NOT EXISTS dws_quality (
    quality_uuid       VARCHAR NOT NULL PRIMARY KEY,
    entity_id          VARCHAR NOT NULL,
    entity_name        VARCHAR,
    stat_year          SMALLINT NOT NULL,
    header_total       INT DEFAULT 0,
    header_unbalanced  INT DEFAULT 0,
    header_missing_detail INT DEFAULT 0,
    header_invalid_tax_no INT DEFAULT 0,
    detail_total       INT DEFAULT 0,
    detail_orphan      INT DEFAULT 0,
    detail_null_ssflbm INT DEFAULT 0,
    unmatched_red_cnt  INT DEFAULT 0,
    fully_reversed_cnt INT DEFAULT 0,
    quality_score      DECIMAL(5,2),
    update_time        TIMESTAMP NOT NULL,
    UNIQUE (entity_id, stat_year)
);

