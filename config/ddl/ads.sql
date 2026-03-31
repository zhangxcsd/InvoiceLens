CREATE TABLE IF NOT EXISTS ads_scorecard (
    scorecard_id   VARCHAR NOT NULL PRIMARY KEY,
    group_id       VARCHAR NOT NULL,
    entity_id      VARCHAR NOT NULL,
    entity_name    VARCHAR,
    stat_year      SMALLINT NOT NULL,
    total_amount   DECIMAL(18,2),
    total_count    INT,
    supplier_count INT,
    flag_total     INT DEFAULT 0,
    flag_high      INT DEFAULT 0,
    flag_medium    INT DEFAULT 0,
    flag_low       INT DEFAULT 0,
    risk_score     DECIMAL(5,2) DEFAULT 100,
    risk_level     VARCHAR,
    cr1            DECIMAL(8,6),
    cancel_ratio   DECIMAL(8,6),
    quality_score  DECIMAL(5,2),
    analysis_batch VARCHAR NOT NULL,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (group_id, entity_id, stat_year, analysis_batch)
);

CREATE INDEX IF NOT EXISTS idx_sc_group ON ads_scorecard (group_id, stat_year);

CREATE TABLE IF NOT EXISTS ads_group (
    group_id       VARCHAR NOT NULL PRIMARY KEY,
    group_name     VARCHAR NOT NULL,
    sys_id         VARCHAR,
    industry       VARCHAR,
    data_years     VARCHAR,   -- 已导入年份（JSON）
    total_entities INT DEFAULT 0,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ads_org_member (
    member_id   VARCHAR NOT NULL PRIMARY KEY,
    group_id    VARCHAR NOT NULL,
    entity_id   VARCHAR NOT NULL,
    entity_name VARCHAR,
    is_active   BOOLEAN DEFAULT TRUE,
    added_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (group_id, entity_id)
);

CREATE TABLE IF NOT EXISTS ads_import_log (
    batch_id      VARCHAR NOT NULL PRIMARY KEY,
    group_id      VARCHAR NOT NULL,
    stat_year     SMALLINT,
    load_time     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    file_count    INT,
    total_rows    INT,
    success_count INT,
    fail_count    INT,
    warn_count    INT,
    parquet_paths VARCHAR,
    detail_json   VARCHAR
);

