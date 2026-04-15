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
st.title("数据概览（P0 框架占位）")
st.caption("目标：用最少的图表与指标，让审计人员快速理解规模、趋势与风险概貌。")


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
- **输入**：ODS/DWD（发票明细与主表）+ 组织维表（企业/层级）
- **输出**：DWS 汇总（趋势/分布/质量）+ 可下钻明细
- **下一步**：先打通 `DWD -> DWS` 的最小链路，再把指标卡/趋势图接到真实查询
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

col1, col2, col3, col4 = st.columns(4)
with col1:
    st.metric("发票张数", "—")
with col2:
    st.metric("价税合计", "—")
with col3:
    st.metric("供应商数", "—")
with col4:
    st.metric("疑点数", "—")

st.info("P0 占位：这里将展示月度趋势、税率分布、品类分布等图表。")

