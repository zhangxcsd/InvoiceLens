-- 导入批次状态机（简化：running/success/failed）
CREATE TABLE IF NOT EXISTS ods_batch_state (
    import_batch_id TEXT NOT NULL PRIMARY KEY,
    status           VARCHAR NOT NULL,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message          VARCHAR
);

-- 文件指纹表：用于导入前“重复候选”拦截
CREATE TABLE IF NOT EXISTS ods_file_fingerprint (
    file_hash                    VARCHAR NOT NULL PRIMARY KEY,
    first_success_import_batch_id    TEXT,
    first_success_import_session_id  TEXT,
    last_status                 VARCHAR,
    last_seen_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 导入日志：粒度按（import_batch_id, import_session_id）
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

    PRIMARY KEY (import_batch_id, import_session_id)
);

-- ============================================================
-- ODS 业务数据外部视图（直接读取 data/ods 的 Parquet）
--
-- 审计含义：
-- - ODS 的“主表/明细表”并不落在 DuckDB 内部表中，而是以 Parquet 作为原始落盘。
-- - 这里用 VIEW 把 Parquet 以“可查询”的方式挂载进 DuckDB，便于联查与后续 ETL。
-- - 必须保留 SQL 注释：后续导出审计报告时可直接引用本段解释。
--
-- 说明：
-- - hive_partitioning=1 会把目录上的 “批次=.../表类型=.../序号=...” 自动解析成分区列
-- - union_by_name=true 允许不同 Parquet 文件列集合不完全一致时进行按列名对齐（更鲁棒）
-- ============================================================

-- ods_inv_header：发票主表（ODS 原始数据视图）
CREATE VIEW IF NOT EXISTS ods_inv_header AS
SELECT *
FROM read_parquet(
    'data/ods/批次=*/表类型=inv_header/**/*.parquet',
    hive_partitioning=1,
    union_by_name=true
);

-- ods_inv_detail：发票明细表（ODS 原始数据视图）
CREATE VIEW IF NOT EXISTS ods_inv_detail AS
SELECT *
FROM read_parquet(
    'data/ods/批次=*/表类型=inv_detail/**/*.parquet',
    hive_partitioning=1,
    union_by_name=true
);

