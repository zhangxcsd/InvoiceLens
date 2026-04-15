-- =============================================================================
-- auth_*：用户与权限（本地单机版最小实现）
--
-- 审计含义：
-- - 本工具面向审计场景，需对“危险操作/数据删除/疑点确认/报告导出”等动作做到
--   可控（权限）与可追溯（审计日志）。
-- - 本地离线运行，不依赖外部 IAM；因此提供最小的用户/角色/权限表。
--
-- 设计原则：
-- - 密码仅存 hash（PBKDF2），不落明文。
-- - 权限以 JSON 存储（permissions_json），便于迭代扩展。
-- - 关键动作写入 auth_audit_log，便于回溯。
-- =============================================================================

CREATE TABLE IF NOT EXISTS auth_role (
    role_id          VARCHAR NOT NULL PRIMARY KEY,
    role_name        VARCHAR NOT NULL,
    permissions_json VARCHAR NOT NULL,
    is_system        BOOLEAN DEFAULT FALSE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_user (
    user_id        VARCHAR NOT NULL PRIMARY KEY,
    username       VARCHAR NOT NULL UNIQUE,
    display_name   VARCHAR,
    password_hash  VARCHAR NOT NULL,
    role_id        VARCHAR NOT NULL,
    is_active      BOOLEAN DEFAULT TRUE,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at  TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_role ON auth_user (role_id, is_active);

CREATE SEQUENCE IF NOT EXISTS seq_auth_audit_id START 1;
CREATE TABLE IF NOT EXISTS auth_audit_log (
    log_id       BIGINT NOT NULL DEFAULT nextval('seq_auth_audit_id') PRIMARY KEY,
    user_id      VARCHAR,
    username     VARCHAR,
    action       VARCHAR NOT NULL,
    object_type  VARCHAR,
    object_id    VARCHAR,
    detail_json  VARCHAR,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON auth_audit_log (created_at);

-- =============================================================================
-- 预置角色（system roles）
-- =============================================================================
INSERT OR IGNORE INTO auth_role(role_id, role_name, permissions_json, is_system)
VALUES
('admin',   '管理员',  '{"admin": true, "can_manage_users": true, "can_delete_data": true, "can_view_troubleshooting": true, "can_confirm_flags": true, "can_export_report": true}', TRUE),
('manager', '审计经理','{"can_manage_users": false, "can_delete_data": false, "can_view_troubleshooting": false, "can_confirm_flags": true,  "can_export_report": true}', TRUE),
('auditor', '审计员',  '{"can_manage_users": false, "can_delete_data": false, "can_view_troubleshooting": false, "can_confirm_flags": true,  "can_export_report": false}', TRUE),
('viewer',  '只读',    '{"can_manage_users": false, "can_delete_data": false, "can_view_troubleshooting": false, "can_confirm_flags": false, "can_export_report": false}', TRUE);

