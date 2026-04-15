from pathlib import Path

import streamlit as st

import sys

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.ui.ui_style import apply_business_style
from src.ui.auth import require_login, has_permission


apply_business_style()
require_login(redirect=True)
if not has_permission("can_view_troubleshooting"):
    st.error("权限不足：仅管理员可访问技术/排障入口。")
    st.stop()
st.title("技术/排障入口（P0 框架占位）")
st.caption("目标：给开发/管理员提供可回溯与自检能力，业务用户默认不需要。")


def _safe_get_conn():
    try:
        return get_conn()
    except Exception as exc:
        st.error(f"无法连接 DuckDB：{type(exc).__name__}\n\n{exc}")
        st.stop()


conn = _safe_get_conn()

st.markdown("### 数据库对象自检")
if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

col_a, col_b = st.columns(2)
with col_a:
    if st.button("查看表/视图清单（前 50）"):
        try:
            df = conn.execute(
                """
                SELECT table_name, table_type
                FROM information_schema.tables
                WHERE table_schema='main'
                ORDER BY table_type, table_name
                LIMIT 50
                """
            ).df()
            st.dataframe(df, use_container_width=True)
        except Exception as exc:
            st.error(f"查询失败：{type(exc).__name__}\n\n{exc}")
with col_b:
    if st.button("查看 ODS 导入日志（前 50）"):
        try:
            df = conn.execute(
                """
                SELECT import_batch_id, import_session_id, load_time, file_count, success_count, fail_count, warn_count
                FROM ods_load_log
                ORDER BY load_time DESC
                LIMIT 50
                """
            ).df()
            st.dataframe(df, use_container_width=True)
        except Exception as exc:
            st.error(f"查询失败：{type(exc).__name__}\n\n{exc}")

st.markdown("### 运行环境信息")
st.code(f"project_root: {project_root}", language="text")

