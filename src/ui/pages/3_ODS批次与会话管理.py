from __future__ import annotations

from pathlib import Path
import json
import shutil

import streamlit as st

import sys

project_root = Path(__file__).resolve().parents[3]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn, get_db_mode
from config.table_type_labels import table_type_display
from src.ui.ui_style import apply_business_style
from src.ui.auth import require_login, has_permission


apply_business_style()
require_login(redirect=True)
st.title("ODS 批次与会话管理")
st.caption("用于查看 / 校验 / 清理 ODS 批次与会话（同时维护 Parquet 与 manifests/日志的一致性）。")


def _safe_get_conn():
    try:
        return get_conn()
    except Exception as exc:  # pragma: no cover - UI 兜底
        st.error(f"无法连接 DuckDB：{type(exc).__name__}\n\n{exc}")
        st.stop()


conn = _safe_get_conn()


st.markdown("### 1. 批次与会话总览")

overview_df = conn.execute(
    """
    SELECT
        l.import_batch_id AS batch_id,
        l.import_session_id AS session_id,
        l.load_time,
        l.file_count,
        l.total_rows,
        l.success_count,
        l.fail_count,
        l.warn_count,
        COALESCE(s.status, 'unknown') AS batch_status,
        s.message AS batch_message
    FROM ods_load_log l
    LEFT JOIN ods_batch_state s
      ON l.import_batch_id = s.import_batch_id
    ORDER BY l.load_time DESC
    """
).df()

if overview_df.empty:
    st.info("当前尚未检测到任何 ODS 导入日志。")
    st.stop()

st.dataframe(overview_df, use_container_width=True)


st.markdown("### 2. 选择批次 + 会话进行校验/清理")

batch_options = sorted(overview_df["batch_id"].unique().tolist())
col_a, col_b = st.columns(2)
with col_a:
    selected_batch = st.selectbox("选择批次（batch_id）", options=batch_options)
with col_b:
    session_options = overview_df.loc[
        overview_df["batch_id"] == selected_batch, "session_id"
    ].unique().tolist()
    selected_session = st.selectbox("选择会话（session_id）", options=session_options)

ods_root = project_root / "data" / "ods"


def _scan_batch_files(batch_id: str) -> dict:
    """
    扫描 data/ods/批次=.../ 下的所有 parquet 与 manifests 文件，用于和数据库中的日志比对。
    """
    batch_dir = ods_root / f"批次={batch_id}"
    parquet_files: list[str] = []
    table_types: set[str] = set()
    parquet_by_table_type: dict[str, int] = {}
    if batch_dir.exists():
        for p in batch_dir.rglob("*.parquet"):
            parquet_files.append(str(p))
            # 目录结构：批次=.../表类型=xxx/ods_file_seq=.../file.parquet
            table_type = None
            for parent in p.parents:
                name = parent.name
                if name.startswith("表类型="):
                    table_type = name.split("=", 1)[-1]
                    table_types.add(table_type)
                    break
            if table_type:
                parquet_by_table_type[table_type] = parquet_by_table_type.get(table_type, 0) + 1

    manifests_root = ods_root / "manifests" / f"批次={batch_id}"
    manifest_files: list[str] = []
    manifest_by_table_type: dict[str, int] = {}
    if manifests_root.exists():
        for p in manifests_root.rglob("manifest_*.json"):
            manifest_files.append(str(p))
            table_type = None
            for parent in p.parents:
                name = parent.name
                if name.startswith("表类型="):
                    table_type = name.split("=", 1)[-1]
                    table_types.add(table_type)
                    break
            if table_type:
                manifest_by_table_type[table_type] = (
                    manifest_by_table_type.get(table_type, 0) + 1
                )

    return {
        "batch_dir": str(batch_dir),
        "parquet_count": len(parquet_files),
        "parquet_samples": parquet_files[:5],
        "table_types": sorted(table_types),
        "parquet_by_table_type": parquet_by_table_type,
        "manifest_root": str(manifests_root),
        "manifest_count": len(manifest_files),
        "manifest_samples": manifest_files[:5],
        "manifest_by_table_type": manifest_by_table_type,
    }


scan_info = _scan_batch_files(selected_batch)

st.markdown("#### 当前批次在文件系统中的情况")
met_a, met_b, met_c, met_d = st.columns(4)
with met_a:
    st.metric("Parquet 文件数", int(scan_info.get("parquet_count", 0)))
with met_b:
    st.metric("表类型数", len(scan_info.get("table_types", []) or []))
with met_c:
    st.metric("Manifest 文件数", int(scan_info.get("manifest_count", 0)))
with met_d:
    st.metric("批次目录", "存在" if Path(scan_info.get("batch_dir", "")).exists() else "缺失")

has_unknown_sheet = "unknown_sheet" in (scan_info.get("table_types", []) or [])
has_path_risks = (scan_info.get("parquet_count", 0) == 0) or (
    scan_info.get("manifest_count", 0) == 0
)
default_expand = bool(has_unknown_sheet or has_path_risks)

with st.expander("文件系统核对（更推荐看统计；技术样例默认隐藏）", expanded=default_expand):
    st.write(f"- ODS 批次目录：`{scan_info.get('batch_dir')}`")
    st.write(f"- Manifests 目录：`{scan_info.get('manifest_root')}`")

    table_types = scan_info.get("table_types", []) or []
    parquet_by_tt: dict[str, int] = scan_info.get("parquet_by_table_type", {}) or {}
    manifest_by_tt: dict[str, int] = scan_info.get("manifest_by_table_type", {}) or {}

    rows = []
    for tt in table_types:
        rows.append(
            {
                "table_type": tt,
                "table_type_中文": table_type_display(tt),
                "parquet_文件数": int(parquet_by_tt.get(tt, 0)),
                "manifest_文件数": int(manifest_by_tt.get(tt, 0)),
            }
        )

    st.markdown("**按表类型统计（文件数）**")
    st.dataframe(rows, use_container_width=True)

    if has_unknown_sheet:
        st.warning("检测到 `unknown_sheet`：说明存在无法映射的 sheet（建议完善 `config/sheet_mapping.yaml`）。")

    show_tech_samples = st.checkbox("显示技术样例（路径列表）", value=False)
    if show_tech_samples or default_expand:
        st.markdown("**Parquet 样例（最多 5 条）**")
        st.dataframe(
            {"parquet_path": scan_info.get("parquet_samples", [])},
            use_container_width=True,
        )
        st.markdown("**Manifest 样例（最多 5 条）**")
        st.dataframe(
            {"manifest_path": scan_info.get("manifest_samples", [])},
            use_container_width=True,
        )


st.markdown("#### 与导入日志的简单一致性检查")

log_row = (
    overview_df[
        (overview_df["batch_id"] == selected_batch)
        & (overview_df["session_id"] == selected_session)
    ]
    .head(1)
    .to_dict("records")
)

if not log_row:
    st.warning("在 ods_load_log 中未找到对应的批次+会话记录。")
else:
    row = log_row[0]
    issues: list[str] = []
    if scan_info["parquet_count"] == 0:
        issues.append(
            "该批次在文件系统中未检测到任何 Parquet：可能曾被手工删除，需要重新导入。"
        )
    if scan_info["manifest_count"] == 0:
        issues.append(
            "该批次在 manifests 中未找到任何 manifest_* 文件：可能曾被手工删除或尚未生成。"
        )

    if issues:
        st.warning("检测到以下潜在不一致 / 风险：")
        for msg in issues:
            st.write(f"- {msg}")
    else:
        st.success("未发现明显不一致：该批次既有 Parquet 也有 manifests 记录。")


st.markdown("### 3. 安全删除批次（Parquet + manifests + 日志）")

st.caption(
    "删除操作会：\n"
    "- 删除所选 batch_id 下的全部 Parquet 目录（data/ods/批次=...）。\n"
    "- 删除对应批次的 manifests 目录。\n"
    "- 删除 ods_load_log 与 ods_batch_state 中该批次的全部记录（所有会话）。\n"
    "仅在确认不再需要该批次数据时使用。"
)

db_mode = get_db_mode()
if db_mode != "dev":
    st.error("当前为生产/定版模式（INVOICELENS_DB_MODE=prod），禁止在 UI 中删除批次数据。")
else:
    if not has_permission("can_delete_data"):
        st.info("当前账号无数据删除权限：仍可查看与校验，但无法执行删除。")
        st.stop()
    st.markdown("#### 删除范围选择")
    delete_mode = st.radio(
        "删除范围",
        options=["按批次删除（删除该 batch 下所有会话数据）", "按会话删除（仅删除该 session 写入的数据）"],
        index=0,
    )

    st.caption(
        "说明：ODS Parquet 目录结构不包含 session_id；但系统会在 `ods_load_log.parquet_paths` 记录“每个 session 实际写出的文件列表”，"
        "并按 session 生成 manifest（`manifest_{session_id}.json`）。因此按会话删除会基于该列表精准删除，不会误删其他会话的数据。"
    )

    confirm_batch = st.selectbox(
        "二次确认：选择要删除的 batch_id",
        options=batch_options,
        index=batch_options.index(selected_batch) if selected_batch in batch_options else 0,
    )

    selected_session_to_delete: str | None = None
    if delete_mode.startswith("按会话删除"):
        batch_sessions_df = overview_df.loc[
            overview_df["batch_id"] == confirm_batch,
            ["session_id", "load_time", "file_count", "total_rows", "success_count", "fail_count", "warn_count"],
        ].copy()
        if not batch_sessions_df.empty:
            batch_sessions_df["session_id"] = batch_sessions_df["session_id"].astype(str)
        batch_sessions_df = batch_sessions_df.sort_values(
            by=["load_time", "session_id"], ascending=[False, True]
        )

        st.markdown("#### 选择要删除的 session（勾选左侧复选框）")
        btn_a, btn_b = st.columns(2)
        with btn_a:
            select_all = st.button("全选", use_container_width=True)
        with btn_b:
            clear_all = st.button("全不选", use_container_width=True)

        default_checked = False
        if selected_session and not batch_sessions_df.empty:
            default_checked = True

        # 允许“全选/全不选”，并默认勾选当前页面已选 session（若存在）
        checked_col: list[bool] = []
        for sid in batch_sessions_df["session_id"].tolist():
            if select_all:
                checked_col.append(True)
            elif clear_all:
                checked_col.append(False)
            else:
                checked_col.append(bool(default_checked and sid == str(selected_session)))
        batch_sessions_df.insert(0, "选择", checked_col)

        edited = st.data_editor(
            batch_sessions_df,
            hide_index=True,
            use_container_width=True,
            column_config={
                "选择": st.column_config.CheckboxColumn(required=True),
                "session_id": st.column_config.TextColumn("session_id", disabled=True),
            },
            disabled=[
                "session_id",
                "load_time",
                "file_count",
                "total_rows",
                "success_count",
                "fail_count",
                "warn_count",
            ],
            key=f"delete_sessions_{confirm_batch}",
        )
        selected_sessions_to_delete = (
            edited.loc[edited["选择"] == True, "session_id"].astype(str).tolist()  # noqa: E712
            if edited is not None and not edited.empty
            else []
        )
    else:
        selected_sessions_to_delete = []

    danger = st.checkbox("我已知晓该操作会永久删除数据（不可恢复）", value=False)

    def _safe_parse_json_list(raw: str | None) -> list[str]:
        if not raw:
            return []
        try:
            v = json.loads(raw)
            if isinstance(v, list):
                return [str(x) for x in v if x]
        except Exception:
            return []
        return []

    def _is_path_referenced_by_other_sessions(
        batch_id: str, session_id: str, parquet_path: str
    ) -> bool:
        """
        兜底安全检查：极端情况下若同一 parquet_path 被其它 session 引用，则按 session 删除不应删除该文件。
        由于 parquet_paths 存为 JSON 文本，这里用 LIKE 做近似匹配，再在 Python 侧二次校验。
        """
        try:
            rows = conn.execute(
                """
                SELECT import_session_id, parquet_paths
                FROM ods_load_log
                WHERE import_batch_id = ?
                  AND import_session_id <> ?
                  AND parquet_paths LIKE ?
                """,
                [batch_id, session_id, f"%{parquet_path}%"],
            ).fetchall()
        except Exception:
            return False
        for sid, raw in rows or []:
            paths = _safe_parse_json_list(raw)
            if parquet_path in paths:
                return True
        return False

    btn_label = (
        "删除所选批次（全量）"
        if delete_mode.startswith("按批次删除")
        else "删除所选会话（精准，可多选）"
    )
    if st.button(btn_label, type="primary", disabled=not danger):
        if confirm_batch.strip() != str(confirm_batch).strip():
            st.error("batch_id 非法，已取消删除。")
            st.stop()

        removed_paths: list[str] = []
        skipped_paths: list[str] = []

        if delete_mode.startswith("按批次删除"):
            # 1) 删除 Parquet 目录
            batch_dir = ods_root / f"批次={confirm_batch}"
            if batch_dir.exists():
                try:
                    shutil.rmtree(batch_dir)
                    removed_paths.append(str(batch_dir))
                except Exception as exc:  # pragma: no cover - UI 兜底
                    st.error(f"删除 Parquet 目录失败：{type(exc).__name__}\n\n{exc}")
                    st.stop()

            # 2) 删除 manifests 目录
            manifests_root = ods_root / "manifests" / f"批次={confirm_batch}"
            if manifests_root.exists():
                try:
                    shutil.rmtree(manifests_root)
                    removed_paths.append(str(manifests_root))
                except Exception as exc:  # pragma: no cover
                    st.error(f"删除 manifests 目录失败：{type(exc).__name__}\n\n{exc}")
                    st.stop()

            # 3) 删除数据库中的日志与批次状态（按 batch 全量清理）
            try:
                conn.execute(
                    "DELETE FROM ods_load_log WHERE import_batch_id = ?",
                    [confirm_batch],
                )
                conn.execute(
                    "DELETE FROM ods_batch_state WHERE import_batch_id = ?",
                    [confirm_batch],
                )
            except Exception as exc:  # pragma: no cover
                st.error(f"删除数据库日志失败：{type(exc).__name__}\n\n{exc}")
                st.stop()

            st.success("批次删除完成。")
            st.json({"removed_paths": removed_paths})
        else:
            # 按 session 精准删除：只删除这些 session 实际写出的 parquet_paths + manifest_{session}.json，并删掉这些 session 的日志行
            if not selected_sessions_to_delete:
                st.error("未选择任何 session_id，已取消删除。")
                st.stop()

            parquet_paths_by_session: dict[str, list[str]] = {}
            for sid in selected_sessions_to_delete:
                try:
                    row = conn.execute(
                        """
                        SELECT parquet_paths
                        FROM ods_load_log
                        WHERE import_batch_id = ? AND import_session_id = ?
                        """,
                        [confirm_batch, sid],
                    ).fetchone()
                except Exception as exc:  # pragma: no cover
                    st.error(f"读取会话日志失败：{type(exc).__name__}\n\n{exc}")
                    st.stop()
                parquet_paths_by_session[str(sid)] = _safe_parse_json_list(row[0] if row else None)

            # 1) 删除 parquet 文件（逐个删；若被其它 session 引用则跳过）
            for sid, parquet_paths in parquet_paths_by_session.items():
                for p in parquet_paths:
                    try:
                        if _is_path_referenced_by_other_sessions(
                            str(confirm_batch), str(sid), str(p)
                        ):
                            skipped_paths.append(str(p))
                            continue
                        pp = Path(p)
                        if pp.exists() and pp.is_file():
                            pp.unlink()
                            removed_paths.append(str(pp))
                            # 尝试清理空的序号目录（可选，不影响核心）
                            try:
                                parent = pp.parent
                                if parent.exists() and parent.is_dir() and not any(parent.iterdir()):
                                    parent.rmdir()
                            except Exception:
                                pass
                    except Exception as exc:
                        st.warning(
                            f"删除 parquet 失败（已跳过）：{p}\n{type(exc).__name__}: {exc}"
                        )

            # 2) 删除这些 session 对应的 manifests（批次内所有表类型目录下的 manifest_{session}.json）
            try:
                manifests_root = ods_root / "manifests" / f"批次={confirm_batch}"
                if manifests_root.exists():
                    for sid in selected_sessions_to_delete:
                        for mf in manifests_root.rglob(f"manifest_{sid}.json"):
                            try:
                                mf.unlink()
                                removed_paths.append(str(mf))
                            except Exception as exc:
                                st.warning(
                                    f"删除 manifest 失败（已跳过）：{mf}\n{type(exc).__name__}: {exc}"
                                )
            except Exception:
                pass

            # 3) 删除数据库中这些 session 的日志记录
            try:
                placeholders = ",".join(["?"] * len(selected_sessions_to_delete))
                conn.execute(
                    f"""
                    DELETE FROM ods_load_log
                    WHERE import_batch_id = ?
                      AND import_session_id IN ({placeholders})
                    """,
                    [confirm_batch, *selected_sessions_to_delete],
                )
                # 若该 batch 下已无任何 session 日志，则同步清理 batch_state（避免悬挂）
                left = conn.execute(
                    "SELECT COUNT(*) FROM ods_load_log WHERE import_batch_id = ?",
                    [confirm_batch],
                ).fetchone()
                if left and int(left[0] or 0) == 0:
                    conn.execute(
                        "DELETE FROM ods_batch_state WHERE import_batch_id = ?",
                        [confirm_batch],
                    )
            except Exception as exc:  # pragma: no cover
                st.error(f"删除会话日志失败：{type(exc).__name__}\n\n{exc}")
                st.stop()

            st.success("会话删除完成（仅删除所选 session 写入的文件/manifest/日志）。")
            st.json(
                {
                    "removed_paths": removed_paths,
                    "skipped_paths": skipped_paths,
                    "parquet_paths_in_log": parquet_paths_by_session,
                }
            )

