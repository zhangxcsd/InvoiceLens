from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pandas as pd

from db.schema_sqlfiles import init_all_tables
from src.ingestion.excel_to_ods import load_excel_batch_to_ods


@dataclass(frozen=True)
class ScanResult:
    excel_paths: list[str]
    zip_paths: list[str]


def scan_directory(root_dir: Path, *, recursive: bool = True, include_zip: bool = False) -> ScanResult:
    exts = {".xlsx", ".xls"}
    excel: list[Path] = []
    zips: list[Path] = []
    it = root_dir.rglob("*") if recursive else root_dir.iterdir()
    for p in it:
        if not p.is_file():
            continue
        name = p.name
        if name.startswith("~$"):
            continue
        try:
            if p.stat().st_size <= 0:
                continue
        except Exception:
            continue
        suf = p.suffix.lower()
        if suf in exts:
            excel.append(p)
        elif include_zip and suf == ".zip":
            zips.append(p)
    return ScanResult(
        excel_paths=[str(p) for p in sorted(excel, key=lambda x: str(x))],
        zip_paths=[str(p) for p in sorted(zips, key=lambda x: str(x))],
    )


def safe_extract_zip_excels(
    zip_path: Path,
    *,
    out_root: Path,
    max_members: int = 2000,
    max_total_uncompressed_bytes: int = 2_000_000_000,
    max_single_member_bytes: int = 500_000_000,
) -> tuple[list[str], dict]:
    """
    ZIP 文件级兜底：任何异常不抛出，返回失败日志（file_blocking=true）。
    """
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
                try:
                    if target.stat().st_size > 0 and not target.name.startswith("~$"):
                        extracted.append(str(target))
                except Exception:
                    pass

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


def summarize_logs(logs: list[dict]) -> dict[str, int]:
    total = len(logs)
    fail = sum(1 for x in logs if x.get("file_blocking") is True or x.get("status") == "失败")
    warn = sum(1 for x in logs if x.get("status") == "警告")
    dup = sum(1 for x in logs if x.get("status") == "跳过重复")
    ok = sum(1 for x in logs if x.get("status") == "成功")
    written = sum(len(x.get("written_parquet_files", []) or []) for x in logs)
    return {"total": total, "ok": ok, "warn": warn, "fail": fail, "dup": dup, "written_files": written}


def logs_to_df(logs: list[dict]) -> pd.DataFrame:
    rows = []
    for x in logs:
        rows.append(
            {
                "状态": x.get("status") or ("失败" if x.get("file_blocking") else "未知"),
                "文件名": x.get("file_name"),
                "来源文件": x.get("source_excel_file"),
                "写出文件数": len(x.get("written_parquet_files", []) or []),
                "写出行数": x.get("rows_written_ods"),
                "拒收行数": x.get("rows_dropped_within_file"),
                "原因": x.get("reason"),
                "异常类型": x.get("exception_type"),
                "批次": x.get("import_batch_id"),
                "会话": x.get("import_session_id"),
                "时间": x.get("load_time"),
            }
        )
    return pd.DataFrame(rows)


def aggregate_reject_samples(logs: list[dict], *, per_file_limit: int = 3, total_limit: int = 50) -> pd.DataFrame:
    samples: list[dict[str, Any]] = []
    for x in logs:
        for rs in (x.get("reject_row_samples") or [])[:per_file_limit]:
            samples.append(
                {
                    "file_name": x.get("file_name"),
                    "sheet": rs.get("sheet"),
                    "seq_no": rs.get("seq_no"),
                    "field": rs.get("field"),
                    "reason": rs.get("reason"),
                }
            )
            if len(samples) >= total_limit:
                break
        if len(samples) >= total_limit:
            break
    return pd.DataFrame(samples)


def run_import_directory(
    *,
    conn,
    import_batch_id: str,
    import_dir: Path,
    ods_dir: Path,
    input_dir: Path,
    recursive: bool,
    auto_unzip_zip: bool,
    batch_size: int,
    flush_interval_sec: int,
    force_reimport: bool,
    import_workers: int | None,
) -> list[dict]:
    """
    扫描目录并分批导入（同步 flush）。
    返回 logs（list[dict]），结构由 excel_to_ods.py 决定，UI 可直接渲染/回看。
    """
    init_all_tables(conn)
    ods_dir.mkdir(parents=True, exist_ok=True)
    input_dir.mkdir(parents=True, exist_ok=True)

    scan = scan_directory(import_dir, recursive=recursive, include_zip=auto_unzip_zip)
    excel_paths = list(scan.excel_paths)
    zip_logs: list[dict] = []

    if auto_unzip_zip and scan.zip_paths:
        unpack_root = input_dir / "unpacked" / f"批次={import_batch_id}"
        unpack_root.mkdir(parents=True, exist_ok=True)
        for zp in scan.zip_paths:
            extracted, zlog = safe_extract_zip_excels(Path(zp), out_root=unpack_root)
            zip_logs.append(zlog)
            excel_paths.extend(extracted)
        excel_paths = sorted(set(excel_paths))

    if not excel_paths and zip_logs:
        return zip_logs
    if not excel_paths:
        return []

    total_files = len(excel_paths)
    buffer: list[str] = []
    all_logs: list[dict] = []
    if zip_logs:
        all_logs.extend(zip_logs)

    last_flush_at = datetime.now()

    def do_flush(chunk: list[str]) -> None:
        session_id = uuid4().hex
        try:
            logs = load_excel_batch_to_ods(
                excel_paths=chunk,
                ods_dir=str(ods_dir),
                batch_id=import_batch_id,
                conn=conn,
                import_session_id=session_id,
                force_reimport=force_reimport,
                force_reason="user_force_reimport" if force_reimport else None,
                import_workers=import_workers,
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
                    "reason": "刷新导入异常（服务层兜底）",
                    "exception_type": type(exc).__name__,
                    "detail": str(exc),
                    "reject_row_ranges": [],
                    "reject_row_samples": [],
                    "written_parquet_files": [],
                    "import_batch_id": import_batch_id,
                    "import_session_id": session_id,
                }
            )

    for i, p in enumerate(excel_paths, start=1):
        buffer.append(p)
        now = datetime.now()
        elapsed = (now - last_flush_at).total_seconds()
        should_flush = len(buffer) >= int(batch_size) or elapsed >= int(flush_interval_sec)
        if should_flush:
            chunk = buffer
            buffer = []
            do_flush(chunk)
            last_flush_at = datetime.now()
        _ = i / max(1, total_files)

    if buffer:
        do_flush(buffer)

    return all_logs


def run_import_uploaded(
    *,
    conn,
    import_batch_id: str,
    ods_dir: Path,
    saved_paths: list[str],
    force_reimport: bool,
    import_workers: int | None,
) -> list[dict]:
    init_all_tables(conn)
    ods_dir.mkdir(parents=True, exist_ok=True)
    return load_excel_batch_to_ods(
        excel_paths=saved_paths,
        ods_dir=str(ods_dir),
        batch_id=import_batch_id,
        conn=conn,
        import_session_id=uuid4().hex,
        force_reimport=force_reimport,
        force_reason="user_force_reimport" if force_reimport else None,
        import_workers=import_workers,
    )


def save_uploaded_files(
    *,
    uploaded_files,
    input_dir: Path,
    import_batch_id: str,
) -> list[str]:
    save_root = input_dir / "uploaded" / f"批次={import_batch_id}"
    save_root.mkdir(parents=True, exist_ok=True)
    saved_paths: list[str] = []
    for uf in uploaded_files:
        raw = uf.getvalue()
        h = hashlib.sha256(raw).hexdigest()[:10]
        stem = Path(uf.name).stem
        suffix = Path(uf.name).suffix
        out = save_root / f"{stem}_{h}{suffix}"
        out.write_bytes(raw)
        saved_paths.append(str(out))
    return saved_paths


def fetch_import_history(conn, *, limit: int = 200) -> pd.DataFrame:
    init_all_tables(conn)
    return conn.execute(
        """
        SELECT import_batch_id AS batch_id,
               import_session_id AS session_id,
               load_time,
               file_count,
               success_count,
               fail_count,
               warn_count,
               detail_json
        FROM ods_load_log
        ORDER BY load_time DESC
        LIMIT ?
        """,
        [int(limit)],
    ).df()


def parse_detail_logs(detail_json: str | None) -> list[dict]:
    if not detail_json:
        return []
    try:
        v = json.loads(detail_json)
        return v if isinstance(v, list) else []
    except Exception:
        return []

