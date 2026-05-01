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

-- DWD→DIM 任务运行台账（任务中心运行记录）
CREATE TABLE IF NOT EXISTS ads_etl_task_run_log (
    run_id         VARCHAR NOT NULL PRIMARY KEY,
    task_code      VARCHAR NOT NULL,
    task_name      VARCHAR,
    status         VARCHAR NOT NULL, -- success / failed / running
    trigger_source VARCHAR,          -- manual_ui / api / scheduler
    run_mode       VARCHAR,          -- incremental / full / chained
    params_json    VARCHAR,          -- 请求参数快照（JSON 字符串）
    result_json    VARCHAR,          -- 结果快照（JSON 字符串）
    rows_affected  BIGINT DEFAULT 0,
    error_message  VARCHAR,
    calc_batch_id  VARCHAR,
    import_batch_id VARCHAR,
    started_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at    TIMESTAMP,
    duration_ms    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_task_run_task_time ON ads_etl_task_run_log (task_code, started_at);
CREATE INDEX IF NOT EXISTS idx_task_run_status    ON ads_etl_task_run_log (status, started_at);

