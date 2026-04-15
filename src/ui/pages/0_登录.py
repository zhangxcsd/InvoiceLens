from pathlib import Path

import streamlit as st

import sys

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.ui.ui_style import apply_business_style
from src.ui.auth import ensure_bootstrap_admin, logout_button
from src.ui.auth import _verify_password  # noqa: SLF001

import json


apply_business_style()
st.title("登录")
st.caption("本工具为本地离线运行；账号权限用于控制危险操作与审计留痕。")

conn = get_conn()
init_all_tables(conn)

ensure_bootstrap_admin()

# 已登录则显示退出，并提供快捷跳转建议
if st.session_state.get("auth_user"):
    logout_button(where="main")
    st.markdown("### 继续使用")
    st.page_link("src/ui/pages/1_数据导入与体检.py", label="进入：数据导入与体检", icon="➡️")
    st.page_link("src/ui/pages/2_ODS导入统计与核对.py", label="进入：ODS 导入统计与核对", icon="➡️")
    st.page_link("src/ui/pages/3_ODS批次与会话管理.py", label="进入：ODS 批次与会话管理", icon="➡️")
    st.stop()

st.markdown("### 请输入账号密码")
with st.form("login_page_form", clear_on_submit=False):
    username = st.text_input("账号", value="")
    password = st.text_input("密码", type="password", value="")
    ok = st.form_submit_button("登录", type="primary")

if ok:
    row = conn.execute(
        """
        SELECT u.user_id, u.username, u.display_name, u.password_hash, u.role_id,
               r.role_name, r.permissions_json, u.is_active
        FROM auth_user u
        LEFT JOIN auth_role r ON u.role_id = r.role_id
        WHERE u.username = ?
        """,
        [username.strip()],
    ).fetchone()
    if not row:
        st.error("账号或密码错误。")
        st.stop()
    user_id, uname, display, pw_hash, role_id, role_name, perm_json, is_active = row
    if is_active is False:
        st.error("账号已被禁用。")
        st.stop()
    if not _verify_password(password, str(pw_hash)):
        st.error("账号或密码错误。")
        st.stop()
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
    }
    try:
        conn.execute(
            "UPDATE auth_user SET last_login_at=CURRENT_TIMESTAMP WHERE user_id=?",
            [user_id],
        )
    except Exception:
        pass
    st.success("登录成功。")
    st.switch_page("src/ui/pages/1_数据导入与体检.py")

