-- =============================================================================
-- 财务账表导入与发票净额核对（dm_finance_ledger*）
-- 用途：持久化外部财务账表汇总行，与 DWD/DWS 发票净额只读比对。
-- =============================================================================

-- 导入批次元数据
CREATE TABLE IF NOT EXISTS dm_finance_ledger_batch (
    batch_id        VARCHAR NOT NULL PRIMARY KEY,
    batch_name      VARCHAR,
    source_file     VARCHAR,
    stat_year       SMALLINT,
    row_count       INTEGER DEFAULT 0,
    reject_count    INTEGER DEFAULT 0,
    import_status   VARCHAR DEFAULT '成功',  -- 成功 / 警告 / 失败
    detail_json     TEXT,                    -- 拒收清单与文件级阻断日志（JSON）
    imported_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fin_ledger_batch_time ON dm_finance_ledger_batch (imported_at DESC);

-- 账表汇总行（按主体 + 期间 + 可选科目）
CREATE TABLE IF NOT EXISTS dm_finance_ledger (
    row_id            VARCHAR NOT NULL PRIMARY KEY,
    batch_id          VARCHAR NOT NULL,
    seq_no            INTEGER,
    tax_id            VARCHAR NOT NULL,     -- 归一化税号/主体识别号
    entity_name       VARCHAR,
    stat_year         SMALLINT NOT NULL,
    stat_month        SMALLINT,               -- NULL 表示年度汇总口径
    role_type         VARCHAR DEFAULT '销项', -- 销项 / 进项（与 DWS role_type 对齐）
    subject_code      VARCHAR,
    subject_name      VARCHAR,
    ledger_amount     DECIMAL(18,2) NOT NULL,
    source_excel_file VARCHAR,
    source_sheet      VARCHAR,
    ingest_ts         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fin_ledger_batch ON dm_finance_ledger (batch_id);
CREATE INDEX IF NOT EXISTS idx_fin_ledger_key ON dm_finance_ledger (tax_id, stat_year, stat_month);
