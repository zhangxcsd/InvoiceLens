-- 幂等补丁：企业年度花名册表 + 报送覆盖视图（基于国家出资企业口径）
-- init_all_tables 对 CREATE VIEW IF NOT EXISTS 不会覆盖旧定义，本文件供迁移显式 OR REPLACE。

CREATE TABLE IF NOT EXISTS dim_enterprise_year_roster (
    stat_year                         SMALLINT NOT NULL,
    enterprise_id                     VARCHAR NOT NULL,
    enterprise_name                   VARCHAR,
    state_investor                    VARCHAR NOT NULL,
    state_investor_unified_credit_code VARCHAR,
    is_member                         BOOLEAN DEFAULT TRUE,
    registry_row_id                   VARCHAR,
    data_source                       VARCHAR,
    source_record_id                  VARCHAR,
    calc_version                      VARCHAR,
    quality_status                    VARCHAR,
    quality_issue                     VARCHAR,
    updated_at                        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stat_year, enterprise_id)
);

CREATE INDEX IF NOT EXISTS idx_ent_year_roster_year_state
    ON dim_enterprise_year_roster (stat_year, state_investor);
CREATE INDEX IF NOT EXISTS idx_ent_year_roster_state_code
    ON dim_enterprise_year_roster (stat_year, state_investor_unified_credit_code);
