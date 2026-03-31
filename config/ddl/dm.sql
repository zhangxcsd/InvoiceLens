CREATE TABLE IF NOT EXISTS dm_audit_flag (
    flag_id        VARCHAR NOT NULL PRIMARY KEY,
    rule_id        VARCHAR NOT NULL,
    risk_level     VARCHAR NOT NULL,
    flag_type      VARCHAR NOT NULL,
    group_id       VARCHAR NOT NULL,
    entity_id      VARCHAR,
    entity_name    VARCHAR,
    seller_name    VARCHAR,
    seller_tax_no  VARCHAR,
    amount         DECIMAL(18,2),
    invoice_list   VARCHAR,   -- 相关 header_uuid 列表（JSON）
    description    VARCHAR,
    suggestion     VARCHAR,
    is_confirmed   BOOLEAN DEFAULT FALSE,
    confirm_note   VARCHAR,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    analysis_batch VARCHAR NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flag_group ON dm_audit_flag (group_id, analysis_batch);
CREATE INDEX IF NOT EXISTS idx_flag_risk  ON dm_audit_flag (risk_level);
CREATE INDEX IF NOT EXISTS idx_flag_rule  ON dm_audit_flag (rule_id);

CREATE TABLE IF NOT EXISTS dm_circ_inv (
    circ_id        VARCHAR NOT NULL PRIMARY KEY,
    group_id       VARCHAR NOT NULL,
    party_a_tax    VARCHAR NOT NULL,
    party_a_name   VARCHAR,
    party_b_tax    VARCHAR NOT NULL,
    party_b_name   VARCHAR,
    amount_a_to_b  DECIMAL(18,2),
    amount_b_to_a  DECIMAL(18,2),
    circular_ratio DECIMAL(8,6),
    risk_level     VARCHAR NOT NULL,
    analysis_batch VARCHAR NOT NULL,
    UNIQUE (group_id, party_a_tax, party_b_tax, analysis_batch)
);

CREATE TABLE IF NOT EXISTS dm_shell_co (
    shell_id           VARCHAR NOT NULL PRIMARY KEY,
    group_id           VARCHAR NOT NULL,
    group_member_tax   VARCHAR NOT NULL,
    group_member_name  VARCHAR,
    intermediary_tax   VARCHAR NOT NULL,
    intermediary_name  VARCHAR,
    final_target_tax   VARCHAR,
    final_target_name  VARCHAR,
    amount_in          DECIMAL(18,2),
    amount_out         DECIMAL(18,2),
    passthrough_ratio  DECIMAL(8,6),
    risk_level         VARCHAR NOT NULL,
    analysis_batch     VARCHAR NOT NULL
);

