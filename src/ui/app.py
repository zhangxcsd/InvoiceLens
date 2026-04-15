from pathlib import Path

import streamlit as st


from src.ui.ui_style import apply_business_style
from src.ui.auth import logout_button


st.set_page_config(page_title="InvoiceLens", page_icon=":bar_chart:", layout="wide")
apply_business_style()
logout_button(where="sidebar")

st.title("InvoiceLens 本地审计工具")
st.caption("最小可运行骨架：Streamlit + DuckDB + 规则分层结构")

st.markdown(
    """
### 已就绪模块
- 数据导入与 ODS 占位
- DuckDB 连接与 Schema 初始化占位
- 迁移脚本占位

请通过左侧 Pages 进入示例页面。
"""
)

project_root = Path(__file__).resolve().parents[2]
st.info(f"项目根目录：`{project_root}`")
