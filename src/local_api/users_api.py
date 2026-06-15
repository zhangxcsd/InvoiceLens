"""本地用户/角色与审计日志（JSON 存储，桌面离线 MVP）。"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)

_USERS_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "users.json"
_AUDIT_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "audit_log.json"
_MAX_AUDIT = 2000

ROLES: dict[str, dict[str, Any]] = {
    "admin": {
        "label": "管理员",
        "permissions": ["*"],
        "description": "全部功能，含用户管理与授权导入。",
    },
    "analyst": {
        "label": "分析师",
        "permissions": ["read", "write", "export", "audit_flags"],
        "description": "分析与规则操作；不可管理用户或授权。",
    },
    "viewer": {
        "label": "查看者",
        "permissions": ["read"],
        "description": "只读查看，不可导出或修改配置。",
    },
}


def _hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    s = salt or secrets.token_hex(8)
    digest = hashlib.sha256(f"{s}:{password}".encode("utf-8")).hexdigest()
    return digest, s


def _verify_password(password: str, password_hash: str, salt: str) -> bool:
    digest, _ = _hash_password(password, salt)
    return secrets.compare_digest(digest, password_hash)


def _default_users_doc() -> dict[str, Any]:
    pw_hash, salt = _hash_password("admin")
    return {
        "users": [
            {
                "username": "admin",
                "display_name": "管理员",
                "role": "admin",
                "enabled": True,
                "password_hash": pw_hash,
                "salt": salt,
            }
        ]
    }


def _load_users_doc() -> dict[str, Any]:
    if not _USERS_PATH.is_file():
        doc = _default_users_doc()
        _save_users_doc(doc)
        return doc
    try:
        raw = json.loads(_USERS_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("users"), list):
            doc = _default_users_doc()
            _save_users_doc(doc)
            return doc
        return raw
    except Exception as exc:  # noqa: BLE001
        logger.warning("read users.json: %s", exc)
        doc = _default_users_doc()
        _save_users_doc(doc)
        return doc


def _save_users_doc(doc: dict[str, Any]) -> None:
    _USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _USERS_PATH.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _public_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "username": row.get("username"),
        "display_name": row.get("display_name"),
        "role": row.get("role"),
        "enabled": bool(row.get("enabled", True)),
    }


def role_label(role: str) -> str:
    meta = ROLES.get(role) or {}
    return str(meta.get("label") or role)


def has_permission(role: str, perm: str) -> bool:
    meta = ROLES.get(role) or {}
    perms = meta.get("permissions") or []
    if "*" in perms:
        return True
    return perm in perms


def append_audit_log(*, action: str, username: str, detail: dict[str, Any] | None = None) -> None:
    try:
        entries: list[dict[str, Any]] = []
        if _AUDIT_PATH.is_file():
            raw = json.loads(_AUDIT_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                entries = raw
        entries.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "action": action,
                "username": username,
                "detail": detail or {},
            }
        )
        if len(entries) > _MAX_AUDIT:
            entries = entries[-_MAX_AUDIT:]
        _AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        _AUDIT_PATH.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("append audit log: %s", exc)


def api_auth_login(body: dict[str, Any]) -> dict[str, Any]:
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")

    doc = _load_users_doc()
    users = doc.get("users") or []

    # 兼容 Phase 1：空账号直接登录默认管理员（仅当无显式用户名时）
    if not username and not password:
        for row in users:
            if row.get("username") == "admin" and row.get("enabled", True):
                user = _public_user(row)
                user["role_label"] = role_label(str(user.get("role") or ""))
                append_audit_log(action="login", username="admin", detail={"mode": "demo_blank"})
                from src.local_api.auth_session import issue_session_token

                token = issue_session_token("admin", str(user.get("role") or "admin"))
                return {"ok": True, "user": user, "token": token}

    if not username:
        return {"ok": False, "error": {"message": "请输入账号", "code": "invalid_credentials"}}

    for row in users:
        if str(row.get("username") or "") != username:
            continue
        if not row.get("enabled", True):
            return {"ok": False, "error": {"message": "账号已禁用", "code": "user_disabled"}}
        if not _verify_password(password, str(row.get("password_hash") or ""), str(row.get("salt") or "")):
            return {"ok": False, "error": {"message": "账号或密码错误", "code": "invalid_credentials"}}
        user = _public_user(row)
        user["role_label"] = role_label(str(user.get("role") or ""))
        append_audit_log(action="login", username=username)
        from src.local_api.auth_session import issue_session_token

        token = issue_session_token(username, str(user.get("role") or role))
        return {"ok": True, "user": user, "token": token}

    return {"ok": False, "error": {"message": "账号或密码错误", "code": "invalid_credentials"}}


def api_auth_me(headers: Mapping[str, str]) -> dict[str, Any]:
    from src.local_api.auth_session import resolve_session_from_headers

    session = resolve_session_from_headers(headers)
    if not session:
        return {"ok": False, "error": {"message": "未登录或会话已失效", "code": "auth_required"}}

    username = str(session.get("username") or "").strip()
    if not username:
        return {"ok": False, "error": {"message": "未登录或会话已失效", "code": "auth_required"}}

    doc = _load_users_doc()
    for row in doc.get("users") or []:
        if str(row.get("username") or "") != username:
            continue
        if not row.get("enabled", True):
            return {"ok": False, "error": {"message": "账号已禁用", "code": "user_disabled"}}
        user = _public_user(row)
        user["role_label"] = role_label(str(user.get("role") or ""))
        return {"ok": True, "user": user}

    return {"ok": False, "error": {"message": "用户不存在", "code": "user_not_found"}}


def api_auth_logout(headers: Mapping[str, str]) -> dict[str, Any]:
    from src.local_api.auth_session import logout_from_headers, resolve_session_from_headers

    session = resolve_session_from_headers(headers)
    if session:
        logout_from_headers(headers)
        append_audit_log(
            action="logout",
            username=str(session.get("username") or "unknown"),
        )
    return {"ok": True}


def api_users_list() -> dict[str, Any]:
    doc = _load_users_doc()
    rows = [_public_user(u) for u in doc.get("users") or []]
    for r in rows:
        r["role_label"] = role_label(str(r.get("role") or ""))
    return {"ok": True, "users": rows, "path": str(_USERS_PATH)}


def api_users_roles() -> dict[str, Any]:
    items = []
    for key, meta in ROLES.items():
        items.append(
            {
                "role": key,
                "label": meta.get("label"),
                "description": meta.get("description"),
                "permissions": meta.get("permissions") or [],
            }
        )
    return {"ok": True, "roles": items}


def api_users_create(body: dict[str, Any]) -> dict[str, Any]:
    username = str(body.get("username") or "").strip()
    display_name = str(body.get("display_name") or body.get("displayName") or "").strip()
    role = str(body.get("role") or "viewer").strip()
    password = str(body.get("password") or "")
    actor = str(body.get("actor") or body.get("username") or "system").strip()

    if not username or not display_name:
        return {"ok": False, "error": {"message": "username 与 display_name 必填", "exception_type": "ValidationError"}}
    if role not in ROLES:
        return {"ok": False, "error": {"message": f"未知角色: {role}", "exception_type": "ValidationError"}}
    if len(password) < 4:
        return {"ok": False, "error": {"message": "密码至少 4 位", "exception_type": "ValidationError"}}

    doc = _load_users_doc()
    users: list[dict[str, Any]] = list(doc.get("users") or [])
    if any(str(u.get("username")) == username for u in users):
        return {"ok": False, "error": {"message": "用户名已存在", "exception_type": "ConflictError"}}

    pw_hash, salt = _hash_password(password)
    users.append(
        {
            "username": username,
            "display_name": display_name,
            "role": role,
            "enabled": True,
            "password_hash": pw_hash,
            "salt": salt,
        }
    )
    doc["users"] = users
    _save_users_doc(doc)
    append_audit_log(action="user_create", username=actor, detail={"target": username, "role": role})
    user = _public_user(users[-1])
    user["role_label"] = role_label(role)
    return {"ok": True, "user": user}


def api_users_update(body: dict[str, Any]) -> dict[str, Any]:
    username = str(body.get("username") or "").strip()
    actor = str(body.get("actor") or "system").strip()
    if not username:
        return {"ok": False, "error": {"message": "username 必填", "exception_type": "ValidationError"}}

    doc = _load_users_doc()
    users: list[dict[str, Any]] = list(doc.get("users") or [])
    idx = next((i for i, u in enumerate(users) if str(u.get("username")) == username), None)
    if idx is None:
        return {"ok": False, "error": {"message": "用户不存在", "exception_type": "NotFoundError"}}

    row = dict(users[idx])
    if "display_name" in body or "displayName" in body:
        row["display_name"] = str(body.get("display_name") or body.get("displayName") or "").strip()
    if "role" in body:
        role = str(body.get("role") or "").strip()
        if role not in ROLES:
            return {"ok": False, "error": {"message": f"未知角色: {role}", "exception_type": "ValidationError"}}
        row["role"] = role
    if "enabled" in body:
        row["enabled"] = bool(body.get("enabled"))
    if body.get("password"):
        pw = str(body.get("password"))
        if len(pw) < 4:
            return {"ok": False, "error": {"message": "密码至少 4 位", "exception_type": "ValidationError"}}
        pw_hash, salt = _hash_password(pw)
        row["password_hash"] = pw_hash
        row["salt"] = salt

    users[idx] = row
    doc["users"] = users
    _save_users_doc(doc)
    append_audit_log(action="user_update", username=actor, detail={"target": username})
    user = _public_user(row)
    user["role_label"] = role_label(str(user.get("role") or ""))
    return {"ok": True, "user": user}


def api_users_delete(body: dict[str, Any]) -> dict[str, Any]:
    username = str(body.get("username") or "").strip()
    actor = str(body.get("actor") or "system").strip()
    if not username:
        return {"ok": False, "error": {"message": "username 必填", "exception_type": "ValidationError"}}
    if username == "admin":
        return {"ok": False, "error": {"message": "不能删除内置 admin 账号", "exception_type": "ValidationError"}}

    doc = _load_users_doc()
    users: list[dict[str, Any]] = list(doc.get("users") or [])
    new_users = [u for u in users if str(u.get("username")) != username]
    if len(new_users) == len(users):
        return {"ok": False, "error": {"message": "用户不存在", "exception_type": "NotFoundError"}}
    doc["users"] = new_users
    _save_users_doc(doc)
    append_audit_log(action="user_delete", username=actor, detail={"target": username})
    return {"ok": True, "deleted": username}


def api_audit_log_list(*, limit: int = 200, action: str | None = None, username: str | None = None) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    if _AUDIT_PATH.is_file():
        try:
            raw = json.loads(_AUDIT_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                entries = list(reversed(raw))
        except Exception as exc:  # noqa: BLE001
            logger.warning("read audit log: %s", exc)

    if action:
        entries = [e for e in entries if str(e.get("action") or "") == action]
    if username:
        entries = [e for e in entries if str(e.get("username") or "") == username]

    lim = max(1, min(int(limit or 200), 1000))
    return {"ok": True, "entries": entries[:lim], "total": len(entries), "path": str(_AUDIT_PATH)}
