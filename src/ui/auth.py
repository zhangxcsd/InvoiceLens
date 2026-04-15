from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import streamlit as st

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pbkdf2_hash(password: str, *, salt_hex: str | None = None, iterations: int = 200_000) -> str:
    """
    存储格式：pbkdf2_sha256$iter$salt_hex$hash_hex
    """
    if salt_hex is None:
        salt_hex = uuid4().hex
    salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt_hex}${dk.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        alg, it_s, salt_hex, hash_hex = stored.split("$", 3)
        if alg != "pbkdf2_sha256":
            return False
        it = int(it_s)
        cand = _pbkdf2_hash(password, salt_hex=salt_hex, iterations=it)
        return hmac.compare_digest(cand, stored)
    except Exception:
        return False


@dataclass(frozen=True)
class User:
    user_id: str
    username: str
    display_name: str | None
    role_id: str
    role_name: str | None
    permissions: dict[str, Any]


def _auth_enabled() -> bool:
    v = (os.getenv("INVOICELENS_AUTH") or "1").strip().lower()
    return v not in {"0", "false", "off", "no"}


def _audit(action: str, *, object_type: str | None = None, object_id: str | None = None, detail: dict | None = None) -> None:
    try:
        conn = get_conn()
        u = st.session_state.get("auth_user") or {}
        conn.execute(
            """
            INSERT INTO auth_audit_log(user_id, username, action, object_type, object_id, detail_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            [
                u.get("user_id"),
                u.get("username"),
                action,
                object_type,
                object_id,
                json.dumps(detail or {}, ensure_ascii=False),
            ],
        )
    except Exception:
        # 审计日志失败不应阻断主流程
        pass


def ensure_bootstrap_admin() -> None:
    """
    若系统尚无任何用户，则引导在 UI 中初始化管理员账号。
    """
    if not _auth_enabled():
        return
    conn = get_conn()
    try:
        init_all_tables(conn)
        cnt = conn.execute("SELECT COUNT(*) FROM auth_user").fetchone()[0]
    except Exception:
        return
    if int(cnt or 0) > 0:
        return

    st.warning("系统尚未初始化管理员账号。请先创建管理员后再继续使用。")
    with st.form("bootstrap_admin", clear_on_submit=False):
        username = st.text_input("管理员账号（username）", value="admin")
        display = st.text_input("显示名（可选）", value="管理员")
        pw1 = st.text_input("管理员密码", type="password")
        pw2 = st.text_input("重复密码", type="password")
        ok = st.form_submit_button("初始化管理员", type="primary")
    if ok:
        if not username.strip():
            st.error("username 不能为空。")
            st.stop()
        if not pw1 or pw1 != pw2:
            st.error("两次密码不一致。")
            st.stop()
        user_id = uuid4().hex
        pw_hash = _pbkdf2_hash(pw1)
        conn.execute(
            """
            INSERT INTO auth_user(user_id, username, display_name, password_hash, role_id, is_active, created_at)
            VALUES (?, ?, ?, ?, 'admin', TRUE, CURRENT_TIMESTAMP)
            """,
            [user_id, username.strip(), display.strip() or None, pw_hash],
        )
        _audit("bootstrap_admin", object_type="auth_user", object_id=user_id, detail={"username": username.strip()})
        st.success("管理员初始化完成，请使用该账号登录。")
        st.stop()
    st.stop()


def login_panel() -> None:
    """
    侧边栏登录框（P0 原型）。
    """
    if not _auth_enabled():
        return
    ensure_bootstrap_admin()

    if st.session_state.get("auth_user"):
        u = st.session_state["auth_user"]
        name = u.get("display_name") or u.get("username")
        st.sidebar.success(f"已登录：{name}")
        if st.sidebar.button("退出登录", use_container_width=True):
            _audit("logout")
            st.session_state.pop("auth_user", None)
            st.rerun()
        return

    st.sidebar.markdown("### 登录")
    with st.sidebar.form("login_form", clear_on_submit=False):
        username = st.text_input("账号", value="")
        password = st.text_input("密码", type="password", value="")
        ok = st.form_submit_button("登录", type="primary", use_container_width=True)
    if ok:
        conn = get_conn()
        row = conn.execute(
            """
            SELECT u.user_id, u.username, u.display_name, u.password_hash, u.role_id,
                   r.role_name, r.permissions_json
            FROM auth_user u
            LEFT JOIN auth_role r ON u.role_id = r.role_id
            WHERE u.username = ?
            """,
            [username.strip()],
        ).fetchone()
        if not row:
            st.sidebar.error("账号或密码错误。")
            return
        user_id, uname, display, pw_hash, role_id, role_name, perm_json = row
        # 激活校验
        active = conn.execute("SELECT is_active FROM auth_user WHERE user_id=?", [user_id]).fetchone()
        if active and active[0] is False:
            st.sidebar.error("账号已被禁用。")
            return
        if not _verify_password(password, str(pw_hash)):
            st.sidebar.error("账号或密码错误。")
            return
        try:
            perms = json.loads(perm_json) if perm_json else {}
        except Exception:
            perms = {}
        st.session_state["auth_user"] = {
            "user_id": str(user_id),
            "username": str(uname),
            "display_name": str(display) if display is not None else None,
            "role_id": str(role_id),
            "role_name": str(role_name) if role_name is not None else None,
            "permissions": perms,
            "login_at": _utc_now_iso(),
        }
        try:
            conn.execute(
                "UPDATE auth_user SET last_login_at=CURRENT_TIMESTAMP WHERE user_id=?",
                [user_id],
            )
        except Exception:
            pass
        _audit("login", object_type="auth_user", object_id=str(user_id))
        st.rerun()

def logout_button(*, where: str = "sidebar") -> None:
    if not _auth_enabled():
        return
    if not st.session_state.get("auth_user"):
        return
    u = st.session_state["auth_user"]
    name = u.get("display_name") or u.get("username")
    if where == "sidebar":
        st.sidebar.success(f"已登录：{name}")
        if st.sidebar.button("退出登录", use_container_width=True):
            _audit("logout")
            st.session_state.pop("auth_user", None)
            st.switch_page("src/ui/pages/0_登录.py")
    else:
        st.success(f"已登录：{name}")
        if st.button("退出登录"):
            _audit("logout")
            st.session_state.pop("auth_user", None)
            st.switch_page("src/ui/pages/0_登录.py")


def redirect_to_login(message: str | None = None) -> None:
    if message:
        st.info(message)
    st.switch_page("src/ui/pages/0_登录.py")


def require_login(*, allow_roles: set[str] | None = None, redirect: bool = True) -> User | None:
    if not _auth_enabled():
        return None
    ensure_bootstrap_admin()
    u = st.session_state.get("auth_user")
    if not u:
        if redirect:
            redirect_to_login("请先登录后再使用本页。")
        st.info("请先登录后再使用本页。")
        st.stop()
    user = User(
        user_id=u["user_id"],
        username=u["username"],
        display_name=u.get("display_name"),
        role_id=u.get("role_id"),
        role_name=u.get("role_name"),
        permissions=u.get("permissions") or {},
    )
    if allow_roles and user.role_id not in allow_roles:
        st.error("权限不足。")
        st.stop()
    return user


def has_permission(key: str) -> bool:
    if not _auth_enabled():
        return True
    u = st.session_state.get("auth_user") or {}
    perms = u.get("permissions") or {}
    if perms.get("admin") is True:
        return True
    return bool(perms.get(key))


def set_user_password(conn, user_id: str, new_password: str) -> None:
    conn.execute(
        "UPDATE auth_user SET password_hash=? WHERE user_id=?",
        [_pbkdf2_hash(new_password), user_id],
    )

