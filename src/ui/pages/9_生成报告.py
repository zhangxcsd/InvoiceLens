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
st.title("生成报告（P0 框架占位）")
st.caption("目标：把“数据概览 + 风险疑点 + 关键证据”固化为可交付报告（Word/PDF）。")


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
- **输入**：DWS（指标与图表数据集）+ DM（疑点清单/确认情况）
- **输出**：报告文件（docx/pdf）+ 归档信息（可选）
- **下一步**：先实现最小报告（1）摘要（2）疑点清单（3）附录统计
"""
    )

if st.button("初始化/刷新数据库对象（建表 + 视图）", type="secondary"):
    try:
        ret = init_all_tables(conn)
        st.success("初始化完成。")
        st.json(ret)
    except Exception as exc:
        st.error(f"初始化失败：{type(exc).__name__}\n\n{exc}")

report_title = st.text_input("报告标题", value="发票数据审计分析报告")
st.multiselect(
    "选择报告章节（占位）",
    options=["摘要", "数据概览", "供应商集中度", "审计疑点", "关联交易", "子公司对比", "附录（口径与字段）"],
    default=["摘要", "数据概览", "审计疑点"],
)
st.radio("输出格式（占位）", options=["Word（docx）", "PDF", "两者都要"], index=0)

st.button("生成报告（占位）", type="primary", disabled=True)
st.info("P0 占位：下一步会把 DWS/DM 的数据集拼装为报告并提供下载。")

