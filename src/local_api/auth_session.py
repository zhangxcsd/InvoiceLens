"""API 会话与 RBAC 门控（token 落盘，进程重启后可恢复）。"""

from __future__ import annotations

import json
import logging
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from src.local_api.users_api import has_permission

logger = logging.getLogger(__name__)

_SESSIONS_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "sessions.json"
_SESSION_TTL_HOURS = float(os.getenv("INVOICELENS_SESSION_TTL_HOURS", "168"))

_SESSIONS: dict[str, dict[str, Any]] = {}
_SESSION_LOCK = threading.RLock()
_SESSIONS_LOADED = False

_AUTH_EXEMPT_PATHS = frozenset(
    {
        "/api/auth/login",
        "/api/users/login",
        "/health",
    }
)

_ADMIN_READ_PATHS = frozenset(
    {
        "/api/users",
        "/api/users/roles",
        "/api/users/audit-log",
    }
)

_WRITE_PATHS = frozenset(
    {
        "/api/users",
        "/api/users/update",
        "/api/users/delete",
        "/api/settings/thresholds",
        "/api/settings/license",
        "/api/settings/instance",
        "/api/audit/flags/confirm",
        "/api/audit/run",
        "/api/report/generate",
        "/api/report/delivery-package",
        "/api/report/templates/save",
        "/api/report/templates/delete",
        "/api/report/archive/batch-download",
        "/api/import/start",
        "/api/import-sessions",
        "/api/import-sessions/upload",
        "/api/import-sessions/upload-file",
        "/api/dwd/build",
        "/api/dwd/force-rebuild",
        "/api/dwd/rollback",
        "/api/dwd-preview/delete",
        "/api/ods-preview/delete",
        "/api/dim-dict",
        "/api/field-mapping",
        "/api/field-mapping/save",
        "/api/field-mapping/templates/create",
        "/api/field-mapping/templates/save",
        "/api/field-mapping/templates/delete",
        "/api/field-mapping/templates/activate",
        "/api/field-mapping/templates/import-zip",
        "/api/field-mapping/templates/import-zip/preview",
        "/api/enterprise-year-roster/manual-upsert",
        "/api/audited-enterprise/registry",
        "/api/audited-enterprise/contribution",
        "/api/audited-enterprise/registry/bootstrap-demo",
        "/api/audited-enterprise/contribution/bootstrap-demo",
        "/api/dim/audited-enterprise/registry/import-excel",
        "/api/dim/audited-enterprise/contribution/import-excel",
        "/api/dim/org-hier/import",
        "/api/dim/org-hier/rebuild",
        "/api/dim-tax-code/import",
        "/api/dim-tax-code/reapply-risk-rules",
        "/api/dim-tax-code/risk-rules",
        "/api/finance/ledger/import",
        "/api/finance/reconcile/sync-flags",
        "/api/quality/semantic/sync-flags",
        "/api/quality/red-invoice-parse",
        "/api/subject-category/rules",
        "/api/subject-category/recompute",
        "/api/subject-library/import-external",
        "/api/subject-library/repair",
        "/api/subject-library/ingest-from-dwd",
        "/api/subject-library/pipeline",
        "/api/subject-library/rebuild-rename-signals",
        "/api/dim/task-chain/run",
        "/api/dim/task-chain/retry-step",
        "/api/compare/rebuild",
        "/api/dws/rebuild",
        "/api/export/invoices",
        "/api/demo/seed-analysis-data",
        "/api/header-coverage",
    }
)

_WRITE_PREFIXES = (
    "/api/dim/",
    "/api/dwd/",
    "/api/dwd-preview/",
    "/api/import/",
    "/api/import-sessions",
    "/api/report/",
    "/api/settings/",
    "/api/audit/",
    "/api/field-mapping",
    "/api/enterprise-year-roster/",
    "/api/dim-dict",
    "/api/users",
    "/api/audited-enterprise/",
    "/api/dim/audited-enterprise/",
    "/api/dim-tax-code/",
    "/api/subject-category/",
    "/api/subject-library/",
    "/api/finance/",
    "/api/quality/",
    "/api/ods-preview/",
    "/api/compare/",
    "/api/dws/",
    "/api/export/",
    "/api/demo/",
    "/api/header-coverage",
)


def _session_expires_at() -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=_SESSION_TTL_HOURS)
    return exp.isoformat()


def _parse_expires_at(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        s = str(raw).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _is_expired(row: dict[str, Any]) -> bool:
    exp = _parse_expires_at(row.get("expires_at"))
    if exp is None:
        return False
    return datetime.now(timezone.utc) > exp


def _ensure_sessions_loaded() -> None:
    global _SESSIONS_LOADED  # noqa: PLW0603
    with _SESSION_LOCK:
        if _SESSIONS_LOADED:
            return
        _SESSIONS_LOADED = True
        if not _SESSIONS_PATH.is_file():
            return
        try:
            raw = json.loads(_SESSIONS_PATH.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return
            now = datetime.now(timezone.utc)
            for token, row in raw.items():
                if not isinstance(row, dict):
                    continue
                exp = _parse_expires_at(row.get("expires_at"))
                if exp is not None and now > exp:
                    continue
                _SESSIONS[str(token)] = {
                    "username": row.get("username"),
                    "role": row.get("role"),
                    "expires_at": row.get("expires_at"),
                }
        except Exception as exc:  # noqa: BLE001
            logger.warning("load sessions.json: %s", exc)


def _persist_sessions() -> None:
    try:
        _SESSIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _SESSION_LOCK:
            doc = {
                token: {
                    "username": row.get("username"),
                    "role": row.get("role"),
                    "expires_at": row.get("expires_at"),
                }
                for token, row in _SESSIONS.items()
            }
        _SESSIONS_PATH.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("persist sessions: %s", exc)


def issue_session_token(username: str, role: str) -> str:
    _ensure_sessions_loaded()
    token = secrets.token_urlsafe(32)
    expires_at = _session_expires_at()
    with _SESSION_LOCK:
        _SESSIONS[token] = {"username": username, "role": role, "expires_at": expires_at}
    _persist_sessions()
    return token


def revoke_session_token(token: str) -> None:
    _ensure_sessions_loaded()
    with _SESSION_LOCK:
        _SESSIONS.pop(token, None)
    _persist_sessions()


def logout_from_headers(headers: Mapping[str, str]) -> None:
    token = _extract_token(headers)
    if token:
        revoke_session_token(token)


def _extract_token(headers: Mapping[str, str]) -> str:
    auth = str(headers.get("Authorization") or headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return str(headers.get("X-Session-Token") or headers.get("x-session-token") or "").strip()


def resolve_session_from_headers(headers: Mapping[str, str]) -> dict[str, Any] | None:
    _ensure_sessions_loaded()
    token = _extract_token(headers)
    if not token:
        return None
    with _SESSION_LOCK:
        row = _SESSIONS.get(token)
        if not row:
            return None
        if _is_expired(row):
            _SESSIONS.pop(token, None)
            _persist_sessions()
            return None
        return {"token": token, "username": row.get("username"), "role": row.get("role")}


def reload_sessions_for_tests() -> None:
    """测试用：清空内存并重新从磁盘加载。"""
    global _SESSIONS_LOADED  # noqa: PLW0603
    with _SESSION_LOCK:
        _SESSIONS.clear()
        _SESSIONS_LOADED = False
    _ensure_sessions_loaded()


def _required_permission(path: str, method: str) -> str | None:
    m = method.upper()
    if m in ("GET", "HEAD", "OPTIONS"):
        if path in _ADMIN_READ_PATHS:
            return "admin"
        return "read"
    if path in _WRITE_PATHS:
        if path.startswith("/api/users"):
            return "admin"
        if path.startswith("/api/settings/license"):
            return "admin"
        if path.startswith("/api/export/"):
            return "export"
        if "/audit/" in path and ("confirm" in path or path.endswith("/run")):
            return "audit_flags"
        if path.startswith("/api/report/"):
            return "export"
        return "write"
    if m in ("POST", "PUT", "PATCH", "DELETE"):
        for prefix in _WRITE_PREFIXES:
            if path.startswith(prefix):
                if path.startswith("/api/users"):
                    return "admin"
                if path.startswith("/api/settings/license"):
                    return "admin"
                if path.startswith("/api/export/"):
                    return "export"
                if "/audit/" in path and ("confirm" in path or path.endswith("/run")):
                    return "audit_flags"
                if path.startswith("/api/report/"):
                    return "export"
                return "write"
        if path.startswith("/api/import-sessions/") and path.endswith("/start-import"):
            return "write"
        if path.startswith("/api/"):
            return "write"
    return "read"


def check_api_access(path: str, method: str, headers: Mapping[str, str]) -> tuple[bool, int, dict[str, Any]]:
    """返回 (allowed, http_status, payload_if_denied)。"""
    if path in _AUTH_EXEMPT_PATHS:
        return True, 200, {}
    if not path.startswith("/api/"):
        return True, 200, {}

    session = resolve_session_from_headers(headers)
    if not session:
        return False, 401, {
            "ok": False,
            "error": {"message": "未登录或会话已失效", "code": "auth_required"},
        }

    perm = _required_permission(path, method)
    role = str(session.get("role") or "viewer")
    if perm == "admin" and role != "admin" and not has_permission(role, "*"):
        return False, 403, {
            "ok": False,
            "error": {"message": "需要管理员权限", "code": "forbidden"},
        }
    if perm and not has_permission(role, perm):
        return False, 403, {
            "ok": False,
            "error": {"message": f"当前角色无「{perm}」权限", "code": "forbidden"},
        }
    return True, 200, {}
