from pathlib import Path

import streamlit as st

import sys

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables
from config.table_type_labels import table_type_display
from src.ui.ui_style import apply_business_style
from src.ui.auth import require_login


apply_business_style()
require_login(redirect=True)
st.title("ODS 导入统计与核对")
st.caption("用于核对各批次、各表类型的导入行数，方便与来源系统/报表比对。")


def _safe_query(sql: str, params: list | None = None):
    try:
        conn = get_conn()
    except Exception as exc:
        st.error(f"无法连接 DuckDB：{type(exc).__name__}\n\n{exc}")
        st.stop()
    try:
        return conn.execute(sql, params or []).df()
    except Exception as exc:
        st.error(f"查询执行失败：{type(exc).__name__}\n\n{exc}")
        st.stop()


tab_ods, tab_files = st.tabs(["按 ODS 视图统计", "按导入日志统计"])

with tab_ods:
    st.subheader("按批次 + 表类型统计 ODS 行数")
    st.caption(
        "数据来源：`ods_inv_header` / `ods_inv_detail` 视图；"
        "Parquet 目录为 `data/ods/批次=<id>/表类型=<table_type>/ods_file_seq=<n>/`，"
        "视图内可用列 `batch_id` / `table_type`（由分区列 `批次` / `表类型` 别名而来）。"
    )

    col1, col2 = st.columns(2)
    with col1:
        only_latest_batch = st.checkbox("仅显示最近批次", value=True)
    with col2:
        show_detail = st.checkbox("同时展示明细表（inv_detail）统计", value=True)

    # 检查 ods 视图是否已挂载真实 parquet（而不是占位视图）
    cols_df = _safe_query(
        """
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_name IN ('ods_inv_header', 'ods_inv_detail')
        """
    )
    header_has_batch = (
        not cols_df[cols_df["table_name"] == "ods_inv_header"]
        .query("column_name == 'batch_id'")
        .empty
    )
    detail_has_batch = (
        not cols_df[cols_df["table_name"] == "ods_inv_detail"]
        .query("column_name == 'batch_id'")
        .empty
    )

    if not header_has_batch and not detail_has_batch:
        st.warning(
            "当前 ODS 视图仍为占位视图（尚未检测到带 `batch_id/table_type` 列的 Parquet）。"
        )
        if st.button("重新初始化 ODS 视图（刷新 read_parquet 挂载）"):
            try:
                conn = get_conn()
                init_ret = init_all_tables(conn)
                st.success(f"ODS 视图初始化完成：{init_ret}")
            except Exception as exc:
                st.error(f"重新初始化失败：{type(exc).__name__}\n\n{exc}")
    header_ready = header_has_batch
    detail_ready = detail_has_batch

    # 先取所有批次（即使视图还在占位状态，也允许用户使用“按导入日志统计”页签）
    if header_ready and detail_ready:
        batches_df = _safe_query(
            """
            SELECT DISTINCT batch_id
            FROM (
                SELECT batch_id FROM ods_inv_header
                UNION ALL
                SELECT batch_id FROM ods_inv_detail
            )
            ORDER BY batch_id
            """
        )
    elif header_ready:
        batches_df = _safe_query(
            """
            SELECT DISTINCT batch_id
            FROM ods_inv_header
            ORDER BY batch_id
            """
        )
    elif detail_ready:
        batches_df = _safe_query(
            """
            SELECT DISTINCT batch_id
            FROM ods_inv_detail
            ORDER BY batch_id
            """
        )
    else:
        batches_df = _safe_query(
            """
            SELECT ''::VARCHAR AS batch_id
            WHERE FALSE
            """
        )
        if batches_df.empty:
            st.info("当前尚未检测到任何 ODS 数据（请先完成一次导入）。")
        else:
            batch_options = batches_df["batch_id"].tolist()
            default_batch = batch_options[-1] if only_latest_batch else None
            selected_batch = st.multiselect(
                "选择要核对的批次（留空则显示全部）",
                options=batch_options,
                default=[default_batch] if default_batch else [],
            )

            cond = ""
            params: list = []
            if selected_batch:
                cond = "WHERE batch_id IN ({})".format(
                    ",".join(["?"] * len(selected_batch))
                )
                params.extend(selected_batch)

            if header_ready:
                header_sql = f"""
                SELECT
                    batch_id,
                    table_type,
                    COUNT(*) AS row_count
                FROM ods_inv_header
                {cond}
                GROUP BY batch_id, table_type
                ORDER BY batch_id, table_type
                """
                header_df = _safe_query(header_sql, params)
                if not header_df.empty and "table_type" in header_df.columns:
                    header_df = header_df.copy()
                    header_df.insert(
                        header_df.columns.get_loc("table_type") + 1,
                        "table_type_中文",
                        header_df["table_type"].map(table_type_display),
                    )
                st.markdown("#### 发票主表 `ods_inv_header` 行数")
                st.dataframe(header_df, use_container_width=True)

            if show_detail and detail_ready:
                detail_sql = f"""
                SELECT
                    batch_id,
                    table_type,
                    COUNT(*) AS row_count
                FROM ods_inv_detail
                {cond}
                GROUP BY batch_id, table_type
                ORDER BY batch_id, table_type
                """
                detail_df = _safe_query(detail_sql, params)
                if not detail_df.empty and "table_type" in detail_df.columns:
                    detail_df = detail_df.copy()
                    detail_df.insert(
                        detail_df.columns.get_loc("table_type") + 1,
                        "table_type_中文",
                        detail_df["table_type"].map(table_type_display),
                    )
                st.markdown("#### 发票明细表 `ods_inv_detail` 行数")
                st.dataframe(detail_df, use_container_width=True)

with tab_files:
    st.subheader("按导入日志统计（文件级）")
    st.caption("数据来源：`ods_load_log`（按导入批次 + 会话的汇总统计），可用于核对文件数量、失败/警告情况。")

    log_df = _safe_query(
        """
        SELECT
            import_batch_id AS batch_id,
            import_session_id AS session_id,
            load_time,
            file_count,
            success_count,
            fail_count,
            warn_count
        FROM ods_load_log
        ORDER BY load_time DESC
        """
    )
    if log_df.empty:
        st.info("当前尚未检测到任何导入日志。")
    else:
        st.dataframe(log_df, use_container_width=True)

