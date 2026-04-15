from pathlib import Path

import streamlit as st

import sys

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from src.ui.ui_style import apply_business_style


apply_business_style()
st.title("参数与字典（P0 框架占位）")
st.caption("目标：集中维护阈值模板、集团成员税号、枚举映射等，避免散落在代码里。")


def _safe_get_conn():
    try:
        return get_conn()
    except Exception as exc:
        st.error(f"无法连接 DuckDB：{type(exc).__name__}\n\n{exc}")
        st.stop()


conn = _safe_get_conn()

with st.expander("本页在平台中的定位（点击展开）", expanded=True):
    st.markdown(
        """
- **输入**：业务人员维护的参数与字典（行业阈值、成员税号、规则参数）
- **输出**：dim 表/配置文件被分析模块引用（做到“改配置不改代码”）
- **下一步**：优先把 `dim_ind_rule`（行业阈值）与集团成员税号配置做成可编辑表格
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

st.info("P0 占位：这里将提供可编辑表格（行业阈值、成员税号、枚举映射）。")

