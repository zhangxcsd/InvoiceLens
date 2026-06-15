"""Smoke: API 会话 token 与 RBAC 门控。"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.auth_session import (
    _SESSIONS_PATH,
    check_api_access,
    issue_session_token,
    reload_sessions_for_tests,
    revoke_session_token,
)
from src.local_api.users_api import api_auth_login, api_auth_logout, api_auth_me, has_permission

# 与 frontend/src/users/rbacNav.ts NAV_REQUIRED_PERMISSION 对齐（抽样）
_NAV_ADMIN_ONLY = ("users_list", "settings_license")
_NAV_WRITE_ONLY = ("ods_to_dwd_center", "import_mapping_config", "flags_rules")
_NAV_EXPORT_ONLY = ("import_invoice_export", "report_config")


def _assert_viewer_blocked(path: str, method: str, viewer_token: str) -> None:
    ok, status, _ = check_api_access(path, method, {"X-Session-Token": viewer_token})
    assert not ok and status == 403, f"viewer should be blocked: {method} {path}"


def _assert_analyst_allowed(path: str, method: str, analyst_token: str) -> None:
    ok, status, _ = check_api_access(path, method, {"Authorization": f"Bearer {analyst_token}"})
    assert ok and status == 200, f"analyst should be allowed: {method} {path}"


def _assert_analyst_blocked(path: str, method: str, analyst_token: str) -> None:
    ok, status, _ = check_api_access(path, method, {"Authorization": f"Bearer {analyst_token}"})
    assert not ok and status == 403, f"analyst should be blocked: {method} {path}"


def _assert_admin_allowed(path: str, method: str, admin_token: str) -> None:
    ok, status, _ = check_api_access(path, method, {"Authorization": f"Bearer {admin_token}"})
    assert ok and status == 200, f"admin should be allowed: {method} {path}"


def main() -> None:
    login = api_auth_login({"username": "", "password": ""})
    assert login.get("ok") is True
    token = str(login.get("token") or "")
    assert token

    ok, status, _ = check_api_access(
        "/api/audited-enterprise/registry",
        "GET",
        {"Authorization": f"Bearer {token}"},
    )
    assert ok and status == 200

    ok_admin, status_admin, _ = check_api_access(
        "/api/users",
        "POST",
        {"Authorization": f"Bearer {token}"},
    )
    assert ok_admin and status_admin == 200

    viewer_token = issue_session_token("viewer_user", "viewer")
    analyst_token = issue_session_token("analyst_user", "analyst")
    admin_token = token

    for path in (
        "/api/dwd/force-rebuild",
        "/api/import-sessions",
        "/api/export/invoices",
        "/api/finance/reconcile/sync-flags",
        "/api/finance/ledger/import",
        "/api/dim-tax-code/import",
        "/api/dim-tax-code/reapply-risk-rules",
        "/api/dim-tax-code/risk-rules",
        "/api/subject-category/recompute",
        "/api/subject-category/rules",
        "/api/subject-library/import-external",
        "/api/subject-library/pipeline",
        "/api/dim-dict",
        "/api/field-mapping",
        "/api/field-mapping/templates/create",
        "/api/field-mapping/templates/save",
        "/api/field-mapping/templates/delete",
        "/api/field-mapping/templates/activate",
        "/api/audit/flags/confirm",
        "/api/report/generate",
        "/api/report/templates/save",
        "/api/report/templates/delete",
        "/api/report/delivery-package",
        "/api/report/archive/batch-download",
        "/api/settings/thresholds",
        "/api/settings/instance",
        "/api/settings/license",
        "/api/dim/task-chain/run",
        "/api/dim/task-chain/retry-step",
        "/api/field-mapping/templates/import-zip",
        "/api/import-sessions/upload",
        "/api/import-sessions/upload-file",
        "/api/dim/audited-enterprise/registry/import-excel",
        "/api/dim/audited-enterprise/contribution/import-excel",
        "/api/dim/org-hier/import",
    ):
        _assert_viewer_blocked(path, "POST", viewer_token)

    ok_v_admin, st_v_admin, _ = check_api_access(
        "/api/users",
        "POST",
        {"X-Session-Token": viewer_token},
    )
    assert not ok_v_admin and st_v_admin == 403

    for path in (
        "/api/dwd/build",
        "/api/dwd/retry-step",
        "/api/dim/enterprise-year-rel/rebuild",
        "/api/subject-library/repair",
        "/api/export/invoices",
        "/api/finance/reconcile/sync-flags",
        "/api/finance/ledger/import",
        "/api/dim-tax-code/reapply-risk-rules",
        "/api/subject-category/recompute",
        "/api/subject-library/ingest-from-dwd",
        "/api/dim-dict",
        "/api/field-mapping",
        "/api/field-mapping/templates/create",
        "/api/field-mapping/templates/save",
        "/api/field-mapping/templates/delete",
        "/api/field-mapping/templates/activate",
        "/api/audit/flags/confirm",
        "/api/report/generate",
        "/api/report/templates/save",
        "/api/report/templates/delete",
        "/api/report/delivery-package",
        "/api/report/archive/batch-download",
        "/api/settings/thresholds",
        "/api/settings/instance",
        "/api/dim/task-chain/run",
        "/api/dim/task-chain/retry-step",
        "/api/field-mapping/templates/import-zip",
        "/api/import-sessions/upload",
        "/api/import-sessions/upload-file",
        "/api/dim/audited-enterprise/registry/import-excel",
        "/api/dim/audited-enterprise/contribution/import-excel",
        "/api/dim/org-hier/import",
    ):
        _assert_analyst_allowed(path, "POST", analyst_token)

    for path in (
        "/api/field-mapping/templates/import-zip",
        "/api/import-sessions/upload",
        "/api/import-sessions/upload-file",
        "/api/dim/audited-enterprise/registry/import-excel",
    ):
        _assert_admin_allowed(path, "POST", admin_token)

    _assert_analyst_blocked("/api/settings/license", "POST", analyst_token)
    _assert_admin_allowed("/api/settings/license", "POST", admin_token)

    assert has_permission("viewer", "read")
    assert not has_permission("viewer", "write")
    assert has_permission("analyst", "write")
    assert has_permission("analyst", "export")
    assert has_permission("analyst", "audit_flags")
    assert not has_permission("viewer", "audit_flags")

    revoke_session_token(viewer_token)
    revoke_session_token(analyst_token)

    me_ok = api_auth_me({"Authorization": f"Bearer {token}"})
    assert me_ok.get("ok") is True
    assert me_ok["user"]["username"] == "admin"

    me_denied = api_auth_me({})
    assert me_denied.get("ok") is False

    logout_ok = api_auth_logout({"Authorization": f"Bearer {token}"})
    assert logout_ok.get("ok") is True
    me_after_logout = api_auth_me({"Authorization": f"Bearer {token}"})
    assert me_after_logout.get("ok") is False

    # 重新登录供后续无需依赖上面 token
    login2 = api_auth_login({"username": "", "password": ""})
    assert login2.get("ok") is True
    token2 = str(login2.get("token") or "")
    assert token2

    for nav_key in _NAV_ADMIN_ONLY:
        assert not has_permission("viewer", "admin"), nav_key
        assert has_permission("admin", "admin"), nav_key
    for nav_key in _NAV_WRITE_ONLY:
        assert not has_permission("viewer", "write"), nav_key
        assert has_permission("analyst", "write"), nav_key
    for nav_key in _NAV_EXPORT_ONLY:
        assert not has_permission("viewer", "export"), nav_key
        assert has_permission("analyst", "export"), nav_key

    revoke_session_token(token2)

    # 会话落盘：重启（重载）后 token 仍有效
    with tempfile.TemporaryDirectory() as td:
        sessions_path = Path(td) / "sessions.json"
        with patch("src.local_api.auth_session._SESSIONS_PATH", sessions_path):
            reload_sessions_for_tests()
            persisted = issue_session_token("persist_user", "analyst")
            assert sessions_path.is_file()
            reload_sessions_for_tests()
            ok_p, st_p, _ = check_api_access(
                "/api/dwd/build",
                "POST",
                {"Authorization": f"Bearer {persisted}"},
            )
            assert ok_p and st_p == 200, "persisted session should survive reload"
            revoke_session_token(persisted)
            reload_sessions_for_tests()

    print("test_rbac_smoke: OK")


if __name__ == "__main__":
    main()
