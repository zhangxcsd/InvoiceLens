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
st.title("供应商分析（P0 框架占位）")
st.caption("目标：识别供应商集中度风险（CR1/CR3/CR10、Top 供应商、帕累托）。")


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
- **输入**：DWD（净额口径的发票明细）+ 组织维表 + 行业阈值模板（dim_ind_rule）
- **输出**：DWS 供应商集中度汇总（`dws_sup_conc`）与下钻明细
- **下一步**：先产出 `dws_sup_conc`，再接 CR 指标卡/Top 表/帕累托图
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

col1, col2, col3 = st.columns(3)
with col1:
    st.metric("CR1", "—")
with col2:
    st.metric("CR3", "—")
with col3:
    st.metric("CR10", "—")

st.info("P0 占位：这里将展示 Top 供应商表格、帕累托图以及阈值模板选择。")

