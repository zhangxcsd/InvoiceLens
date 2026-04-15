from __future__ import annotations

from pathlib import Path
from uuid import uuid4
import json

import streamlit as st

import sys

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.ui.ui_style import apply_business_style
from src.ui.auth import require_login, has_permission, set_user_password


apply_business_style()
user = require_login(allow_roles={"admin"}, redirect=True)

st.title("用户管理（P0）")
st.caption("管理员维护用户、角色与权限；关键动作会记录到审计日志。")


def _safe_get_conn():
    try:
        c = get_conn()
        init_all_tables(c)
        return c
    except Exception as exc:
        st.error(f"无法连接/初始化 DuckDB：{type(exc).__name__}\n\n{exc}")
        st.stop()


conn = _safe_get_conn()

tab_users, tab_roles, tab_audit = st.tabs(["用户", "角色与权限", "操作审计日志"])

with tab_users:
    st.subheader("用户列表")
    df = conn.execute(
        """
        SELECT user_id, username, display_name, role_id, is_active, created_at, last_login_at
        FROM auth_user
        ORDER BY created_at DESC
        """
    ).df()
    st.dataframe(df, use_container_width=True)

    st.markdown("#### 新增用户")
    with st.form("create_user", clear_on_submit=True):
        username = st.text_input("账号（username）")
        display_name = st.text_input("显示名（可选）")
        role_rows = conn.execute(
            "SELECT role_id, role_name FROM auth_role ORDER BY is_system DESC, role_id"
        ).fetchall()
        role_map = {str(rid): f"{rid}（{rname}）" for rid, rname in role_rows}
        role_id = st.selectbox("角色", options=list(role_map.keys()), format_func=lambda x: role_map.get(x, x))
        password = st.text_input("初始密码", type="password")
        password2 = st.text_input("重复密码", type="password")
        ok = st.form_submit_button("创建用户", type="primary")
    if ok:
        if not username.strip():
            st.error("username 不能为空。")
            st.stop()
        if not password or password != password2:
            st.error("两次密码不一致。")
            st.stop()
        user_id = uuid4().hex
        try:
            conn.execute(
                """
                INSERT INTO auth_user(user_id, username, display_name, password_hash, role_id, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)
                """,
                [user_id, username.strip(), display_name.strip() or None, "TEMP", role_id],
            )
            set_user_password(conn, user_id, password)
            conn.execute(
                """
                INSERT INTO auth_audit_log(user_id, username, action, object_type, object_id, detail_json, created_at)
                VALUES (?, ?, 'create_user', 'auth_user', ?, ?, CURRENT_TIMESTAMP)
                """,
                [
                    user.user_id,
                    user.username,
                    user_id,
                    json.dumps({"username": username.strip(), "role_id": role_id}, ensure_ascii=False),
                ],
            )
            st.success("用户创建成功。")
            st.rerun()
        except Exception as exc:
            st.error(f"创建失败：{type(exc).__name__}\n\n{exc}")

    st.markdown("#### 用户操作")
    target_user = st.selectbox(
        "选择用户（按 username）",
        options=df["username"].tolist() if not df.empty else [],
    )
    if target_user:
        urow = conn.execute(
            "SELECT user_id, username, role_id, is_active FROM auth_user WHERE username=?",
            [target_user],
        ).fetchone()
        if urow:
            target_user_id, target_username, target_role_id, target_active = urow
            col_a, col_b = st.columns(2)
            with col_a:
                st.write(f"当前角色：`{target_role_id}`")
                role_rows = conn.execute(
                    "SELECT role_id, role_name FROM auth_role ORDER BY is_system DESC, role_id"
                ).fetchall()
                role_map = {str(rid): f"{rid}（{rname}）" for rid, rname in role_rows}
                new_role = st.selectbox(
                    "变更角色",
                    options=list(role_map.keys()),
                    index=list(role_map.keys()).index(str(target_role_id))
                    if str(target_role_id) in role_map
                    else 0,
                    format_func=lambda x: role_map.get(x, x),
                )
                if st.button("保存角色变更", use_container_width=True):
                    try:
                        conn.execute(
                            "UPDATE auth_user SET role_id=? WHERE user_id=?",
                            [new_role, target_user_id],
                        )
                        conn.execute(
                            """
                            INSERT INTO auth_audit_log(user_id, username, action, object_type, object_id, detail_json, created_at)
                            VALUES (?, ?, 'update_user_role', 'auth_user', ?, ?, CURRENT_TIMESTAMP)
                            """,
                            [
                                user.user_id,
                                user.username,
                                str(target_user_id),
                                json.dumps({"role_id": str(target_role_id), "new_role_id": new_role}, ensure_ascii=False),
                            ],
                        )
                        st.success("已更新角色。")
                        st.rerun()
                    except Exception as exc:
                        st.error(f"更新失败：{type(exc).__name__}\n\n{exc}")
            with col_b:
                st.write(f"账号状态：`{'启用' if target_active else '禁用'}`")
                if st.button("切换启用/禁用", use_container_width=True):
                    try:
                        conn.execute(
                            "UPDATE auth_user SET is_active=? WHERE user_id=?",
                            [not bool(target_active), target_user_id],
                        )
                        conn.execute(
                            """
                            INSERT INTO auth_audit_log(user_id, username, action, object_type, object_id, detail_json, created_at)
                            VALUES (?, ?, 'toggle_user_active', 'auth_user', ?, ?, CURRENT_TIMESTAMP)
                            """,
                            [
                                user.user_id,
                                user.username,
                                str(target_user_id),
                                json.dumps({"is_active": bool(target_active), "new_is_active": (not bool(target_active))}, ensure_ascii=False),
                            ],
                        )
                        st.success("已更新状态。")
                        st.rerun()
                    except Exception as exc:
                        st.error(f"更新失败：{type(exc).__name__}\n\n{exc}")

                st.markdown("**重置密码**")
                new_pw1 = st.text_input("新密码", type="password")
                new_pw2 = st.text_input("重复新密码", type="password")
                if st.button("重置密码", type="primary", use_container_width=True):
                    if not new_pw1 or new_pw1 != new_pw2:
                        st.error("两次密码不一致。")
                        st.stop()
                    try:
                        set_user_password(conn, str(target_user_id), new_pw1)
                        conn.execute(
                            """
                            INSERT INTO auth_audit_log(user_id, username, action, object_type, object_id, detail_json, created_at)
                            VALUES (?, ?, 'reset_password', 'auth_user', ?, ?, CURRENT_TIMESTAMP)
                            """,
                            [
                                user.user_id,
                                user.username,
                                str(target_user_id),
                                json.dumps({"username": str(target_username)}, ensure_ascii=False),
                            ],
                        )
                        st.success("密码已重置。")
                    except Exception as exc:
                        st.error(f"重置失败：{type(exc).__name__}\n\n{exc}")

with tab_roles:
    st.subheader("角色与权限（P0：查看为主）")
    rdf = conn.execute(
        """
        SELECT role_id, role_name, is_system, permissions_json, created_at, updated_at
        FROM auth_role
        ORDER BY is_system DESC, role_id
        """
    ).df()
    st.dataframe(rdf, use_container_width=True)
    st.info("P0 阶段建议先用预置角色（admin/manager/auditor/viewer）。后续可在此页增加“自定义角色编辑器”。")

with tab_audit:
    st.subheader("操作审计日志（最近 200 条）")
    adf = conn.execute(
        """
        SELECT log_id, created_at, username, action, object_type, object_id, detail_json
        FROM auth_audit_log
        ORDER BY created_at DESC
        LIMIT 200
        """
    ).df()
    st.dataframe(adf, use_container_width=True)

