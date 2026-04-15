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
st.title("关联交易（P0 框架占位）")
st.caption("目标：识别集团内部及疑似关联方网络，支持交互式下钻与汇总。")


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
- **输入**：DWS 交易汇总（`dws_trade_sum`）+ 集团成员税号配置（维表/参数页维护）
- **输出**：内部交易汇总、往来网络图、疑似“空壳中介/循环交易”线索（DM）
- **下一步**：先把交易汇总表 `dws_trade_sum` 稳定产出，再接网络图（Plotly 离线）
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

st.info("P0 占位：这里将展示关联网络图、内部交易汇总表、对开发票明细下钻。")

