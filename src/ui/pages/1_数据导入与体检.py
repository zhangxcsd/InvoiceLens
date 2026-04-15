from __future__ import annotations

import json
import hashlib
import zipfile
from datetime import datetime
from pathlib import Path
import sys
import uuid

import pandas as pd
import streamlit as st

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from src.ui.auth import require_login
from src.ui.ui_style import apply_business_style, card_close, card_open
from src.services.ingestion_service import (
    fetch_import_history,
    parse_detail_logs,
    run_import_directory,
    run_import_uploaded,
    save_uploaded_files,
)
from src.ui.components.import_views import render_import_history, render_import_result


apply_business_style()
require_login(redirect=True)

st.title("数据导入")
st.caption("将金税导出的 Excel 导入 ODS（Parquet），生成批次/会话日志与拒收清单，支持回看与复核。")

INPUT_DIR = project_root / "data" / "input_excel"
ODS_DIR = project_root / "data" / "ods"
DEFAULT_SOURCE_DIR = project_root / "Source_Data" / "Invoice"


def _get_conn_or_stop():
    try:
        return get_conn()
    except Exception as exc:
        msg = str(exc)
        if "File is already open" in msg or "already open" in msg or "Cannot open file" in msg:
            st.error(
                "无法打开 DuckDB 数据库文件（很可能被其他程序占用）。\n\n"
                "请关闭占用 `data/database/warehouse.duckdb` 的程序（常见：DBeaver），然后重试。"
            )
        else:
            st.error(f"无法连接数据库：{type(exc).__name__}\n\n{msg}")
        st.stop()


# ===== 顶部指标：最近一次导入汇总 =====
card_open("导入概览")
st.markdown(
    """
<div class="il-muted">
输出位置：<code>data/ods</code>（Parquet 分区：批次/表类型/ods_file_seq） · 日志：<code>ods_load_log</code> · Manifest：<code>data/ods/manifests</code>
</div>
""",
    unsafe_allow_html=True,
)

conn0 = _get_conn_or_stop()
try:
    last = conn0.execute(
        """
        SELECT import_batch_id, import_session_id, load_time, file_count, success_count, fail_count, warn_count
        FROM ods_load_log
        ORDER BY load_time DESC
        LIMIT 1
        """
    ).fetchone()
except Exception:
    last = None

if last:
    lb, ls, lt, fc, sc, fac, wc = last
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("最近批次", str(lb))
    m2.metric("文件数", int(fc or 0))
    m3.metric("失败", int(fac or 0))
    m4.metric("警告", int(wc or 0))
else:
    st.info("暂无导入历史。")
card_close()


# ===== 导入配置 =====
card_open("导入设置")
col_a, col_b, col_c = st.columns([1.2, 1, 1])
with col_a:
    default_batch = datetime.now().strftime("%Y%m%d")
    import_batch_id = st.text_input("业务批次（import_batch_id）", value=default_batch)
    st.caption("建议：按“年度/批次”组织；同批次允许续跑，但不建议并发。")
with col_b:
    force_reimport = st.checkbox("强制重导（跳过文件指纹去重）", value=False)
with col_c:
    import_workers = st.number_input("并行进程（可选）", min_value=1, max_value=8, value=4, step=1)
card_close()


tab_dir, tab_upload = st.tabs(["从本机目录导入（推荐）", "上传 Excel 导入"])

with tab_dir:
    card_open("从本机目录导入")
    st.caption("扫描本机文件夹（可递归）导入所有 xlsx/xls；可选自动解压 zip（仅提取 xlsx/xls）。")
    col1, col2, col3 = st.columns([2.5, 1, 1])
    with col1:
        use_default = st.checkbox("使用默认目录（Source_Data/Invoice）", value=True)
        import_dir_text = st.text_input(
            "本机目录路径",
            value=str(DEFAULT_SOURCE_DIR),
            disabled=use_default,
        )
    with col2:
        recursive = st.checkbox("递归子目录", value=True)
        auto_unzip_zip = st.checkbox("自动解压 ZIP", value=False)
    with col3:
        batch_size = st.number_input("单次 flush 文件数", min_value=1, max_value=2000, value=20, step=1)
        flush_interval_sec = st.number_input("flush 间隔（秒）", min_value=1, max_value=3600, value=15, step=1)

    import_dir = DEFAULT_SOURCE_DIR if use_default else Path(import_dir_text).expanduser()

    scan_clicked = st.button("扫描目录", use_container_width=True)
    if scan_clicked:
        if not import_dir.exists():
            st.error(f"找不到目录：`{import_dir}`")
        else:
            excel_paths = _scan_excel_files(import_dir, recursive=recursive)
            zips = _scan_zip_files(import_dir, recursive=recursive) if auto_unzip_zip else []
            st.success(f"扫描完成：Excel={len(excel_paths)}，ZIP={len(zips)}")
            st.session_state["import_scan"] = {
                "excel_paths": excel_paths,
                "zip_paths": [str(p) for p in zips],
                "import_dir": str(import_dir),
                "recursive": bool(recursive),
                "auto_unzip_zip": bool(auto_unzip_zip),
            }

    run_clicked = st.button("开始导入（扫描目录）", type="primary", use_container_width=True)
    card_close()

    if run_clicked:
        if not import_dir.exists():
            st.error(f"找不到目录：`{import_dir}`")
            st.stop()

        conn = _get_conn_or_stop()
    # 进度条与状态仅 UI 侧展示；导入与日志由服务层统一产出
        progress = st.progress(0, text="准备导入…")
        status = st.empty()

        with st.spinner("正在导入（可能需要几分钟）…"):
            status.write("正在扫描并导入…")
            logs = run_import_directory(
                conn=conn,
                import_batch_id=import_batch_id,
                import_dir=import_dir,
                ods_dir=ODS_DIR,
                input_dir=INPUT_DIR,
                recursive=bool(recursive),
                auto_unzip_zip=bool(auto_unzip_zip),
                batch_size=int(batch_size),
                flush_interval_sec=int(flush_interval_sec),
                force_reimport=bool(force_reimport),
                import_workers=int(import_workers) if import_workers else None,
            )
            progress.progress(1.0, text="导入完成")
            status.write("导入完成。")

        st.session_state["last_import_logs"] = logs
        render_import_result(logs=logs, title="本次导入结果（目录导入）")

with tab_upload:
    card_open("上传 Excel 导入")
    st.caption("适合临时导入少量文件。上传后会保存到 `data/input_excel/uploaded/批次=.../` 再进入同一导入链路。")
    uploaded = st.file_uploader(
        "选择 Excel 文件（可多选）",
        type=["xlsx", "xls"],
        accept_multiple_files=True,
    )
    run_upload = st.button("开始导入（上传文件）", type="primary", use_container_width=True, disabled=not bool(uploaded))
    card_close()

    if run_upload and uploaded:
        conn = _get_conn_or_stop()
        try:
            saved_paths = save_uploaded_files(
                uploaded_files=uploaded,
                input_dir=INPUT_DIR,
                import_batch_id=import_batch_id,
            )
        except Exception as exc:
            st.error(f"保存上传文件失败：{type(exc).__name__}\n\n{exc}")
            st.stop()
        if not saved_paths:
            st.error("未能保存任何上传文件，已取消导入。")
            st.stop()
        with st.spinner("正在导入上传文件…"):
            logs = run_import_uploaded(
                conn=conn,
                import_batch_id=import_batch_id,
                ods_dir=ODS_DIR,
                saved_paths=saved_paths,
                force_reimport=bool(force_reimport),
                import_workers=int(import_workers) if import_workers else None,
            )
        st.session_state["last_import_logs"] = logs
        render_import_result(logs=logs, title="本次导入结果（上传导入）")


# ===== 导入历史：按批次/会话回看 =====
card_open("导入历史（按批次 / 会话回看）")
conn_hist = _get_conn_or_stop()
try:
    df_hist = fetch_import_history(conn_hist, limit=200)
except Exception as exc:
    df_hist = pd.DataFrame()
    st.error(f"读取导入历史失败：{type(exc).__name__}\n\n{exc}")

selected_batch, selected_session = render_import_history(
    history_df=df_hist,
    detail_logs_by_session={},
)
if selected_batch and selected_session and not df_hist.empty:
    row = df_hist[
        (df_hist["batch_id"].astype(str) == str(selected_batch))
        & (df_hist["session_id"].astype(str) == str(selected_session))
    ].head(1)
    raw = (row["detail_json"].iloc[0] if not row.empty else None) or ""
    detail_logs = parse_detail_logs(raw)
    if detail_logs:
        render_import_result(logs=detail_logs, title="历史会话明细（来自 ods_load_log.detail_json）")
    else:
        card_open("历史会话明细")
        st.info("该会话未存明细日志（detail_json 为空）。")
        card_close()

