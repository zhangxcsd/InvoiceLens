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
st.title("子公司对比（P0 框架占位）")
st.caption("目标：在集团口径下对比各子公司规模/风险/集中度，形成排名与画像。")


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
- **输入**：DWS（趋势、供应商集中度、质量得分）+ DM（疑点计数/风险得分）
- **输出**：排名表、风险对比图、疑点类型分布（支持点击下钻到公司级详情）
- **下一步**：先产出 `dws_quality` + 疑点汇总，再接“综合评级”逻辑
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

st.info("P0 占位：这里将展示综合评级排名、风险对比、疑点分布。")

