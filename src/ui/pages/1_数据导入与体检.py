from pathlib import Path

import streamlit as st

import sys
import uuid
import hashlib
import zipfile
from datetime import datetime

project_root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(project_root))

from db.duckdb_conn import get_conn
from db.duckdb_conn import get_db_mode, rebuild_database_files
from db.schema_sqlfiles import init_all_tables
from src.ingestion.excel_to_ods import load_excel_batch_to_ods


st.title("数据导入与体检（占位页）")

input_dir = project_root / "data" / "input_excel"
ods_dir = project_root / "data" / "ods"
source_invoice_dir = project_root / "Source_Data" / "Invoice"

db_mode = get_db_mode()
with st.sidebar:
    st.markdown("### 运行模式")
    if db_mode == "dev":
        st.success("DB 模式：dev（允许重建数据库）")
    else:
        st.info("DB 模式：prod（禁止重建数据库，需迁移升级）")
    st.caption("通过环境变量 `INVOICELENS_DB_MODE=dev|prod` 控制。")

    st.markdown("### 危险操作")
    if db_mode == "dev":
        st.warning("重建数据库会清空历史数据（删除 `warehouse.duckdb`）。")
        confirm_text = st.text_input("输入 `REBUILD` 二次确认", value="", help="仅开发模式可用")
        if st.button("重建数据库（清空历史）", type="secondary", use_container_width=True):
            if confirm_text.strip().upper() != "REBUILD":
                st.error("确认词不匹配：请输入 `REBUILD` 才会执行。")
            else:
                try:
                    ret = rebuild_database_files(remove_tmp=False)
                    st.success("已重建数据库文件。")
                    st.json(ret)
                except Exception as exc:
                    st.error(f"重建失败：{type(exc).__name__}\n\n{exc}")
    else:
        st.caption("生产/定版模式下禁用重建。")

st.write("该页面用于后续接入 Excel 导入、列名匹配、体检报告与拒收清单。")
st.code(
    f"input_excel: {input_dir}\nods: {ods_dir}",
    language="text",
)

st.markdown("### 阶段一：ODS 导入（P0 骨架）")
st.caption("点击后会生成 ODS Parquet（按 `批次/表类型/序号`），并写入 `ods_load_log` / 指纹去重（如已初始化）。")


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


def _scan_excel_files(root_dir: Path, *, recursive: bool = True) -> list[str]:
    """
    从目录递归扫描 Excel 文件路径。
    - 不依赖文件名规则
    - 跳过 Excel 临时文件（~$ 开头）
    - 返回确定性排序结果
    """
    exts = {".xlsx", ".xls"}
    paths: list[Path] = []
    if recursive:
        for p in root_dir.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in exts:
                continue
            if p.name.startswith("~$"):
                continue
            if p.stat().st_size <= 0:
                continue
            paths.append(p)
    else:
        for p in root_dir.iterdir():
            if not p.is_file():
                continue
            if p.suffix.lower() not in exts:
                continue
            if p.name.startswith("~$"):
                continue
            if p.stat().st_size <= 0:
                continue
            paths.append(p)
    return [str(p) for p in sorted(paths, key=lambda x: str(x))]


def _scan_zip_files(root_dir: Path, *, recursive: bool = True) -> list[Path]:
    paths: list[Path] = []
    it = root_dir.rglob("*") if recursive else root_dir.iterdir()
    for p in it:
        if not p.is_file():
            continue
        if p.suffix.lower() != ".zip":
            continue
        if p.stat().st_size <= 0:
            continue
        paths.append(p)
    return sorted(paths, key=lambda x: str(x))


def _safe_extract_zip_excels(
    zip_path: Path,
    *,
    out_root: Path,
    max_members: int = 2000,
    max_total_uncompressed_bytes: int = 2_000_000_000,
    max_single_member_bytes: int = 500_000_000,
) -> tuple[list[str], dict]:
    log = {
        "file_name": zip_path.name,
        "source_excel_file": str(zip_path),
        "file_hash": None,
        "status": "跳过",
        "file_blocking": False,
        "reason": None,
        "exception_type": None,
        "detail": None,
        "reject_row_ranges": [],
        "reject_row_samples": [],
        "written_parquet_files": [],
    }
    try:
        h = hashlib.sha256()
        with zip_path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        zip_hash = h.hexdigest()[:16]
        dest_dir = out_root / f"zip_{zip_hash}"
        dest_dir.mkdir(parents=True, exist_ok=True)

        extracted: list[str] = []
        with zipfile.ZipFile(zip_path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            if len(infos) > max_members:
                raise ValueError(f"ZIP 成员过多：{len(infos)} > {max_members}")

            total_size = 0
            for info in infos:
                total_size += int(info.file_size or 0)
                if total_size > max_total_uncompressed_bytes:
                    raise ValueError("ZIP 解压总量超限（疑似解压炸弹）")
                if int(info.file_size or 0) > max_single_member_bytes:
                    continue

                name = info.filename.replace("\\", "/")
                if not name or name.endswith("/"):
                    continue
                lower = name.lower()
                if not (lower.endswith(".xlsx") or lower.endswith(".xls")):
                    continue

                target = (dest_dir / name).resolve()
                if not str(target).startswith(str(dest_dir.resolve())):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, target.open("wb") as dst:
                    dst.write(src.read())
                if target.stat().st_size > 0 and not target.name.startswith("~$"):
                    extracted.append(str(target))

        if extracted:
            log["status"] = "已解压"
            log["reason"] = f"从 ZIP 提取 Excel：{len(extracted)} 个"
        else:
            log["status"] = "跳过"
            log["reason"] = "ZIP 中未发现 xlsx/xls"
        return extracted, log
    except Exception as exc:
        log["status"] = "失败"
        log["file_blocking"] = True
        log["reason"] = "ZIP 解压失败（文件级阻断，已跳过该压缩包）"
        log["exception_type"] = type(exc).__name__
        log["detail"] = str(exc)
        return [], log


col_a, col_b = st.columns(2)
with col_a:
    default_batch = datetime.now().strftime("%Y%m%d")
    import_batch_id = st.text_input("import_batch_id（业务批次）", value=default_batch)
    st.caption("提示：可用同一个 `batch_id` 进行分次续跑；但不建议同时并发跑同一 `batch_id`。")
with col_b:
    force_reimport = st.checkbox("强制重导（跳过文件指纹去重）", value=False)

st.markdown("#### 阶段一补充：从本地目录小批量导入（推荐用于 Source_Data/Invoice）")
st.caption("说明：这是“扫描本机文件夹”的导入方式（不是上传文件）。默认目录就是 `Source_Data/Invoice`，你也可以改成任意本机目录。")
st.info(
    "处理逻辑说明：系统会先扫描目录得到全部 Excel 文件列表，然后按“**文件数上限**”或“**时间间隔**”触发一次 flush。\n\n"
    "- **flush 是同步执行**：一批没处理完不会启动下一批；因此不会出现并发写同一批次的冲突。\n"
    "- **batch_id 决定 ODS 落盘位置**：同一次目录导入过程中，所有 flush 都使用同一个 `import_batch_id`。\n"
    "- **每次 flush 会生成新的 import_session_id**：用于把日志/manifest 分段归档，便于回溯（不会覆盖上一轮日志）。"
)
col_c, col_d = st.columns(2)
with col_c:
    batch_size = st.number_input(
        "单次刷新最多处理文件数（不会限制总导入量）",
        min_value=1,
        max_value=2000,
        value=10,
        step=1,
        help="达到该数量就会触发一次 flush（导入一批并写日志）。导入会持续直到目录里的全部文件都处理完。",
    )
with col_d:
    recursive = st.checkbox("递归扫描子文件夹", value=True)

col_e, col_f = st.columns(2)
with col_e:
    flush_interval_sec = st.number_input(
        "固定刷新间隔（秒，按时间触发写入）",
        min_value=1,
        max_value=3600,
        value=10,
        step=1,
        help="这是触发 flush 的“最长等待时间”。注意：flush 是同步执行，不会中途打断正在处理的一批；如果一批处理很久，下一次 flush 会在本批完成后才开始。",
    )
with col_f:
    show_progress = st.checkbox("显示每次刷新进度", value=True)

zip_col_a, zip_col_b = st.columns(2)
with zip_col_a:
    auto_unzip_zip = st.checkbox("自动解压 ZIP（只提取 xlsx/xls）", value=False)
with zip_col_b:
    st.caption("建议：目录里存在 zip 时再开启；rar/7z 暂不支持。")

dir_col_a, dir_col_b = st.columns([3, 1])
with dir_col_a:
    import_dir_text = st.text_input(
        "本机目录路径（扫描 xlsx/xls）",
        value=str(source_invoice_dir),
        help="填写本机目录路径（支持中文路径）。会按是否递归扫描子文件夹来收集 Excel。",
    )
with dir_col_b:
    st.write("")
    st.write("")
    use_default = st.checkbox("使用默认目录", value=True, help="默认使用 Source_Data/Invoice")

import_dir = source_invoice_dir if use_default else Path(import_dir_text).expanduser()

if st.button("扫描目录并小批量导入", type="primary", use_container_width=True):
    if not import_dir.exists():
        st.error(f"找不到目录：`{import_dir}`")
        st.stop()

    conn = _get_conn_or_stop()
    try:
        init_ret = init_all_tables(conn)
    except Exception as exc:
        # 面向未来：若旧库残留导致 schema/索引冲突，直接重建数据库文件后重试一次
        msg = str(exc)
        if "does not have a column named" in msg or "Binder Error" in msg:
            if get_db_mode() == "dev":
                st.warning("检测到数据库结构与最新 DDL 不一致：将重建数据库文件并重新初始化（开发模式，不保留历史数据）。")
                rebuild_database_files(remove_tmp=False)
                conn = _get_conn_or_stop()
                init_ret = init_all_tables(conn)
            else:
                st.error(
                    "检测到数据库结构与最新 DDL 不一致，但当前为定版/生产模式（INVOICELENS_DB_MODE=prod），"
                    "禁止自动清库重建。\n\n"
                    "请使用数据库迁移脚本升级表结构，或在确认允许清库的情况下切换到开发模式。"
                )
                st.stop()
        else:
            raise
    if init_ret.get("skipped"):
        st.warning(
            "初始化时检测到 ODS Parquet 尚未生成：已创建占位 ODS 视图以保证流程不中断。"
            "当你完成一次导入生成 Parquet 后，再次初始化会自动把占位视图替换为真实 read_parquet 视图。"
        )
        with st.expander("查看初始化跳过原因（ODS 视图占位）", expanded=False):
            st.json(init_ret.get("skip_reasons", []))
    ods_dir.mkdir(parents=True, exist_ok=True)
    input_dir.mkdir(parents=True, exist_ok=True)

    excel_paths = _scan_excel_files(import_dir, recursive=recursive)
    zip_logs: list[dict] = []
    if auto_unzip_zip:
        unpack_root = input_dir / "unpacked" / f"批次={import_batch_id}"
        unpack_root.mkdir(parents=True, exist_ok=True)
        for zp in _scan_zip_files(import_dir, recursive=recursive):
            extracted, zlog = _safe_extract_zip_excels(zp, out_root=unpack_root)
            zip_logs.append(zlog)
            excel_paths.extend(extracted)
        excel_paths = sorted(set(excel_paths))

    if not excel_paths:
        st.warning("目录下未找到可导入的 Excel（xlsx/xls）。")
        st.stop()

    session_id = uuid.uuid4().hex
    all_logs: list[dict] = []
    if zip_logs:
        all_logs.extend(zip_logs)
    total_files = len(excel_paths)
    buffer: list[str] = []
    last_flush_at = datetime.now()
    flush_count = 0

    with st.spinner("正在扫描并分批导入（可能需要几分钟）..."):
        for i, p in enumerate(excel_paths, start=1):
            buffer.append(p)
            now = datetime.now()
            elapsed = (now - last_flush_at).total_seconds()

            # 到达任一触发条件：最大文件数，或时间间隔到
            should_flush = len(buffer) >= int(batch_size) or elapsed >= int(flush_interval_sec)
            if not should_flush:
                continue

            flush_count += 1
            chunk_session_id = uuid.uuid4().hex  # 每次刷新一个 session，避免日志被覆盖
            chunk = buffer
            buffer = []
            last_flush_at = now

            if show_progress:
                st.write(
                    f"刷新 {flush_count}: files={len(chunk)} / {total_files} "
                    f"(使用同一个 batch_id={import_batch_id}, session={chunk_session_id[:8]}...)"
                )

            try:
                logs = load_excel_batch_to_ods(
                    excel_paths=chunk,
                    ods_dir=str(ods_dir),
                    batch_id=import_batch_id,  # 保证 ODS 落盘位置不随刷新变化
                    conn=conn,
                    import_session_id=chunk_session_id,
                    force_reimport=force_reimport,
                    force_reason="user_force_reimport" if force_reimport else None,
                )
                all_logs.extend(logs)
            except Exception as exc:
                # 刷新级兜底：不让单次导入异常阻断后续刷新
                all_logs.append(
                    {
                        "file_name": "<flush>",
                        "source_excel_file": "<flush>",
                        "file_hash": None,
                        "status": "失败",
                        "file_blocking": True,
                        "reason": "刷新导入异常（UI 脚本层兜底）",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                        "reject_row_ranges": [],
                        "reject_row_samples": [],
                        "written_parquet_files": [],
                    }
                )

        # 收尾：把剩余不足一轮的文件也写入
        if buffer:
            flush_count += 1
            chunk_session_id = uuid.uuid4().hex
            chunk = buffer
            buffer = []
            if show_progress:
                st.write(
                    f"最后刷新 {flush_count}: files={len(chunk)} / {total_files} "
                    f"(使用 batch_id={import_batch_id}, session={chunk_session_id[:8]}...)"
                )
            try:
                logs = load_excel_batch_to_ods(
                    excel_paths=chunk,
                    ods_dir=str(ods_dir),
                    batch_id=import_batch_id,
                    conn=conn,
                    import_session_id=chunk_session_id,
                    force_reimport=force_reimport,
                    force_reason="user_force_reimport" if force_reimport else None,
                )
                all_logs.extend(logs)
            except Exception as exc:
                all_logs.append(
                    {
                        "file_name": "<flush>",
                        "source_excel_file": "<flush>",
                        "file_hash": None,
                        "status": "失败",
                        "file_blocking": True,
                        "reason": "收尾刷新导入异常（UI 脚本层兜底）",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                        "reject_row_ranges": [],
                        "reject_row_samples": [],
                        "written_parquet_files": [],
                    }
                )

    st.success("目录小批量导入完成。")
    total = len(all_logs)
    fail = sum(1 for x in all_logs if x.get("file_blocking"))
    warn = sum(1 for x in all_logs if x.get("status") == "警告")
    dup = sum(1 for x in all_logs if x.get("status") == "跳过重复")
    sheet_count = sum(len(x.get("written_parquet_files", [])) for x in all_logs)
    st.write(
        f"文件数={total}，失败={fail}，警告={warn}，跳过重复={dup}，写出 sheet 数={sheet_count}"
    )

    # 文件级阻断失败原因（用于快速定位“没导入”的根因）
    fail_files = [
        x
        for x in all_logs
        if x.get("file_blocking") is True
        or (x.get("status") == "失败" and x.get("written_parquet_files") == [])
    ]
    if fail_files:
        st.subheader("文件级失败原因（用于排障）")
        detail_rows = []
        for x in fail_files:
            detail_rows.append(
                {
                    "file_name": x.get("file_name"),
                    "source_excel_file": x.get("source_excel_file"),
                    "reason": x.get("reason"),
                    "exception_type": x.get("exception_type"),
                    "detail": x.get("detail"),
                    "reject_row_ranges": x.get("reject_row_ranges"),
                    "written_parquet_files": x.get("written_parquet_files"),
                }
            )
        st.dataframe(detail_rows, use_container_width=True)

    # 归档策略：仅展示“最近一个 session”的拒收样本，其余 session 视为已归档
    latest_session_id = None
    latest_load_time = None
    for x in all_logs:
        sid = x.get("import_session_id")
        lt = x.get("load_time")
        if not sid or not lt:
            continue
        if latest_load_time is None or str(lt) > str(latest_load_time):
            latest_load_time = lt
            latest_session_id = sid

    samples = []
    source_logs = all_logs
    if latest_session_id is not None:
        source_logs = [x for x in all_logs if x.get("import_session_id") == latest_session_id]
        st.caption(
            f"当前仅展示最近一次导入会话的拒收样本：batch_id={import_batch_id}, "
            f"session_id={latest_session_id[:8]}..., load_time={latest_load_time}"
        )

    for x in source_logs:
        for rs in x.get("reject_row_samples", [])[:2]:
            samples.append(
                {
                    **rs,
                    "file_name": x.get("file_name"),
                    "batch_id": x.get("import_batch_id", import_batch_id),
                    "session_id": x.get("import_session_id"),
                    "load_time": x.get("load_time"),
                }
            )
    if samples:
        st.subheader("拒收样本（节选）")
        st.dataframe(samples[:30], use_container_width=True)

