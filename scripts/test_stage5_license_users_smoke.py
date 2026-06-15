"""CI smoke: 授权导入 + 用户/登录/审计 API。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.license_gate import (
    api_settings_license,
    api_settings_license_post,
    check_export_allowed,
)
from src.local_api.users_api import (
    api_audit_log_list,
    api_auth_login,
    api_users_create,
    api_users_list,
    api_users_roles,
)


def _with_temp_config(fn) -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        users = root / "users.json"
        audit = root / "audit_log.json"
        lic = root / "license_override.json"
        with (
            patch("src.local_api.users_api._USERS_PATH", users),
            patch("src.local_api.users_api._AUDIT_PATH", audit),
            patch("src.local_api.license_gate._LICENSE_OVERRIDE_PATH", lic),
        ):
            fn(root)


def test_license_get_and_import() -> None:
    def run(_root: Path) -> None:
        base = api_settings_license()
        assert base.get("ok") is True
        assert base.get("export_report") is False

        denied = check_export_allowed()
        assert denied is not None
        assert denied["error"]["code"] == "license_export_denied"

        imported = api_settings_license_post(
            {
                "license": {
                    "tier": "pro",
                    "export_report": True,
                    "expires_at": "2099-12-31",
                    "max_entities": 99,
                },
                "actor": "admin",
            }
        )
        assert imported.get("ok") is True
        lic = api_settings_license()
        assert lic.get("export_report") is True
        assert lic.get("max_entities") == 99
        assert check_export_allowed() is None

        reset = api_settings_license_post({"reset": True})
        assert reset.get("ok") is True
        assert api_settings_license().get("export_report") is False

    _with_temp_config(run)


def test_users_login_and_audit() -> None:
    def run(_root: Path) -> None:
        roles = api_users_roles()
        assert roles.get("ok") is True
        assert len(roles.get("roles") or []) >= 3

        blank = api_auth_login({"username": "", "password": ""})
        assert blank.get("ok") is True
        assert blank["user"]["username"] == "admin"

        bad = api_auth_login({"username": "admin", "password": "wrong"})
        assert bad.get("ok") is False

        ok = api_auth_login({"username": "admin", "password": "admin"})
        assert ok.get("ok") is True

        created = api_users_create(
            {
                "username": "analyst1",
                "display_name": "分析师甲",
                "role": "analyst",
                "password": "pass1234",
                "actor": "admin",
            }
        )
        assert created.get("ok") is True

        users = api_users_list()
        assert users.get("ok") is True
        assert any(u.get("username") == "analyst1" for u in users.get("users") or [])

        logs = api_audit_log_list(limit=50)
        assert logs.get("ok") is True
        actions = {e.get("action") for e in logs.get("entries") or []}
        assert "login" in actions
        assert "user_create" in actions

    _with_temp_config(run)


def main() -> None:
    test_license_get_and_import()
    test_users_login_and_audit()
    print("stage5_license_users_smoke: OK")


if __name__ == "__main__":
    main()
