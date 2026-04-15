from __future__ import annotations

import streamlit as st


def apply_business_style() -> None:
    """
    继承 `invoicelens.html` 的原型风格（商务、简约、浅灰底、卡片化）。
    Streamlit 的 theme（.streamlit/config.toml）负责基础配色，这里做细节一致性微调。
    """
    st.markdown(
        """
<style>
/* ===== 原型变量（与 invoicelens.html 对齐）===== */
:root{
  --accent:#0072D1;--accent-mid:#185FA5;
  --danger:#E24B4A;--warn:#BA7517;--green:#1D9E75;
  --bg:#F5F7FA;--border:#E2E6EE;--border-light:#EEF1F6;
  --text:#1A1D23;--text-2:#5A6070;--text-3:#9AA0AD;
  --radius:10px;--radius-sm:7px;
}

/* 主背景 */
[data-testid="stAppViewContainer"]{ background: var(--bg); }

/* 全局：收敛默认标题字号，减少“一级标题过大”的观感 */
h1 { font-size: 1.35rem !important; font-weight: 650 !important; letter-spacing: -0.01em; color: var(--text); }
h2 { font-size: 1.15rem !important; font-weight: 650 !important; letter-spacing: -0.01em; color: var(--text); }
h3 { font-size: 1.02rem !important; font-weight: 650 !important; color: var(--text); }

/* 让 caption 更像“说明文字”而不是抢眼标题 */
.stCaption, [data-testid="stCaptionContainer"] { color: var(--text-2) !important; }

/* Metric：卡片化 */
[data-testid="stMetric"] {
  background: #FFFFFF;
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 14px 16px;
}

/* Dataframe/Table：边框更干净 */
[data-testid="stDataFrame"], [data-testid="stTable"] {
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
}

/* 侧边栏：标题更克制 */
[data-testid="stSidebar"] h2, [data-testid="stSidebar"] h3 {
  font-size: 1.00rem !important;
}

/* 按钮：更接近原型（primary 为纯色蓝） */
div.stButton > button {
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

div.stButton > button[kind="primary"]{
  background: var(--accent) !important;
  border-color: var(--accent) !important;
  color: #fff !important;
}
div.stButton > button[kind="primary"]:hover{
  background: var(--accent-mid) !important;
  border-color: var(--accent-mid) !important;
}

/* 卡片容器：用于页面结构化（手动用 markdown 包一层） */
.il-card{
  background:#fff;
  border:1px solid var(--border-light);
  border-radius:var(--radius);
  padding:18px 20px;
  margin: 0 0 16px 0;
}
.il-card-title{
  font-size:13px;
  font-weight:600;
  color:var(--text);
  margin: 0 0 12px 0;
}
.il-muted{ color: var(--text-2); font-size: 13px; }

</style>
""",
        unsafe_allow_html=True,
    )


def card_open(title: str) -> None:
    st.markdown(
        f"""
<div class="il-card">
  <div class="il-card-title">{title}</div>
""",
        unsafe_allow_html=True,
    )


def card_close() -> None:
    st.markdown("</div>", unsafe_allow_html=True)

