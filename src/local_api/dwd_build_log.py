"""DWD/cleaner 构建日志落盘（data/logs/dwd/）。"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def dwd_logs_dir() -> Path:
    from src.local_api.bundle_paths import data_root

    p = data_root() / "data" / "logs" / "dwd"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _sanitize_token(raw: str, *, max_len: int = 80) -> str:
    s = re.sub(r"[^\w.-]+", "_", (raw or "").strip())[:max_len]
    return s or "unknown"


def new_dwd_run_id(*, import_batch_id: str, prefix: str = "dwd") -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{_sanitize_token(import_batch_id, max_len=48)}_{ts}"


def dwd_log_file_path(run_id: str) -> Path:
    return dwd_logs_dir() / f"{_sanitize_token(run_id)}.log"


def write_dwd_build_log(*, run_id: str, import_batch_id: str, payload: dict[str, Any]) -> str | None:
    """写入构建结果 JSON 摘要；返回相对 data 根的路径字符串。"""
    try:
        path = dwd_log_file_path(run_id)
        header = [
            "# InvoiceLens DWD build log",
            f"run_id={run_id}",
            f"import_batch_id={import_batch_id}",
            f"timestamp={datetime.now(timezone.utc).isoformat()}",
            "",
        ]
        body = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        path.write_text("\n".join(header) + body + "\n", encoding="utf-8")
        return str(path)
    except Exception:
        logger.exception("写入 DWD 构建日志失败")
        return None


def read_dwd_build_log(run_id: str, *, tail_chars: int = 120_000) -> dict[str, Any]:
    path = dwd_log_file_path(run_id)
    if not path.is_file():
        return {"ok": False, "error": {"message": "日志文件不存在", "code": "log_not_found"}}
    try:
        text = path.read_text(encoding="utf-8")
        truncated = False
        if tail_chars > 0 and len(text) > tail_chars:
            text = "...(truncated)\n" + text[-tail_chars:]
            truncated = True
        return {
            "ok": True,
            "run_id": run_id,
            "path": str(path),
            "content": text,
            "size_bytes": path.stat().st_size,
            "truncated": truncated,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
