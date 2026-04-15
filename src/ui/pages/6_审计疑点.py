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
st.title("审计疑点（P0 框架占位）")
st.caption("目标：规则化/可解释地标记疑点，并沉淀到 DM 层以便筛选、确认与出报告。")


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
- **输入**：DWD/DWS（发票、供应商、趋势等）+ 规则参数（阈值、开关）
- **输出**：DM 疑点表（`dm_audit_flag`）+ 可回溯的解释与建议
- **下一步**：先落地 2~3 条“高性价比规则”跑通 end-to-end（含 SQL 注释与审计含义）
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

st.info("P0 占位：这里将提供规则开关/阈值配置、运行按钮，以及疑点列表（按风险等级筛选）。")

