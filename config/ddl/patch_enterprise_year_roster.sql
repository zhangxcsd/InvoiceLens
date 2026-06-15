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
    in_registry                       BOOLEAN DEFAULT FALSE,
    in_manual                         BOOLEAN DEFAULT FALSE,
    manual_updated_at                 TIMESTAMP,
    manual_note                       VARCHAR,
    updated_at                        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stat_year, enterprise_id)
);

CREATE INDEX IF NOT EXISTS idx_ent_year_roster_year_state
    ON dim_enterprise_year_roster (stat_year, state_investor);
CREATE INDEX IF NOT EXISTS idx_ent_year_roster_state_code
    ON dim_enterprise_year_roster (stat_year, state_investor_unified_credit_code);

-- 来源标识（混合维护，见 docs/dim_enterprise_year_roster_policy.md）
ALTER TABLE dim_enterprise_year_roster ADD COLUMN IF NOT EXISTS in_registry BOOLEAN DEFAULT FALSE;
ALTER TABLE dim_enterprise_year_roster ADD COLUMN IF NOT EXISTS in_manual BOOLEAN DEFAULT FALSE;
ALTER TABLE dim_enterprise_year_roster ADD COLUMN IF NOT EXISTS manual_updated_at TIMESTAMP;
ALTER TABLE dim_enterprise_year_roster ADD COLUMN IF NOT EXISTS manual_note VARCHAR;

UPDATE dim_enterprise_year_roster
SET in_registry = TRUE,
    data_source = 'registry'
WHERE trim(COALESCE(data_source, '')) IN ('audited_enterprise_registry', 'registry')
  AND COALESCE(in_manual, FALSE) = FALSE;

UPDATE dim_enterprise_year_roster
SET in_registry = TRUE,
    in_manual = FALSE,
    data_source = 'registry'
WHERE registry_row_id IS NOT NULL
  AND trim(COALESCE(registry_row_id, '')) <> ''
  AND COALESCE(in_registry, FALSE) = FALSE
  AND COALESCE(in_manual, FALSE) = FALSE;
