from __future__ import annotations

import json
from typing import Any

import pandas as pd
import streamlit as st

from src.services.ingestion_service import aggregate_reject_samples, logs_to_df, summarize_logs
from src.ui.ui_style import card_close, card_open


def _status_style(df: pd.DataFrame):
    def color(s: str) -> str:
        if s == "成功":
            return "background-color: #E1F5EE; color: #085041;"
        if s == "警告":
            return "background-color: #FAEEDA; color: #633806;"
        if s in {"失败"}:
            return "background-color: #FCEBEB; color: #791F1F;"
        if s == "跳过重复":
            return "background-color: #EBF4FF; color: #185FA5;"
        if s in {"已解压", "跳过"}:
            return "background-color: #F1EFE8; color: #444441;"
        return ""

    if df.empty or "状态" not in df.columns:
        return df
    return df.style.applymap(color, subset=["状态"])


def render_import_result(*, logs: list[dict], title: str) -> None:
    card_open(title)
    if not logs:
        st.info("暂无结果。")
        card_close()
        return

    summary = summarize_logs(logs)
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("文件总数", summary["total"])
    c2.metric("成功", summary["ok"])
    c3.metric("警告", summary["warn"])
    c4.metric("失败", summary["fail"])

    st.markdown("#### 文件日志")
    status_filter = st.multiselect(
        "状态筛选",
        options=["成功", "警告", "失败", "跳过重复", "已解压", "跳过"],
        default=["成功", "警告", "失败", "跳过重复"],
    )

    df = logs_to_df(logs)
    if status_filter and not df.empty:
        df = df[df["状态"].isin(status_filter)].copy()

    st.dataframe(_status_style(df), use_container_width=True, hide_index=True)

    with st.expander("查看明细（拒收/写出/异常）", expanded=False):
        idx = st.number_input(
            "选择第 N 条（从 1 开始）",
            min_value=1,
            max_value=max(1, len(logs)),
            value=1,
            step=1,
        )
        x = logs[int(idx) - 1]
        st.json(
            {
                "file_name": x.get("file_name"),
                "source_excel_file": x.get("source_excel_file"),
                "status": x.get("status"),
                "reason": x.get("reason"),
                "exception_type": x.get("exception_type"),
                "detail": x.get("detail"),
                "reject_row_ranges": x.get("reject_row_ranges"),
                "reject_row_samples": x.get("reject_row_samples"),
                "written_parquet_files": x.get("written_parquet_files"),
            }
        )

    samples_df = aggregate_reject_samples(logs)
    if not samples_df.empty:
        st.markdown("#### 拒收样本（节选）")
        st.dataframe(samples_df, use_container_width=True, hide_index=True)

    st.download_button(
        "下载本次日志（JSON）",
        data=json.dumps(logs, ensure_ascii=False, indent=2),
        file_name="ods_import_logs.json",
        mime="application/json",
        use_container_width=True,
    )
    card_close()


def render_import_history(
    *,
    history_df: pd.DataFrame,
    detail_logs_by_session: dict[str, list[dict[str, Any]]],
) -> tuple[str | None, str | None]:
    card_open("导入历史（按批次 / 会话回看）")
    if history_df.empty:
        st.info("暂无导入历史。")
        card_close()
        return None, None

    batches = history_df["batch_id"].dropna().astype(str).unique().tolist()
    selected_batch = st.selectbox("选择批次（batch_id）", options=batches, index=0)
    df_b = history_df[history_df["batch_id"].astype(str) == str(selected_batch)].copy()
    sessions = df_b["session_id"].dropna().astype(str).unique().tolist()
    selected_session = st.selectbox("选择会话（session_id）", options=sessions, index=0)

    row = df_b[df_b["session_id"].astype(str) == str(selected_session)].head(1)
    st.dataframe(
        row.drop(columns=["detail_json"], errors="ignore"),
        use_container_width=True,
        hide_index=True,
    )
    card_close()
    return str(selected_batch), str(selected_session)

