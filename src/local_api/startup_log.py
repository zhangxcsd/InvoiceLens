"""打包版文件日志（console=False 时写入 data/logs/）。"""
from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from pathlib import Path


def log_file_path() -> Path:
    from src.local_api.bundle_paths import data_root

    return data_root() / "data" / "logs" / "invoicelens.log"


def configure_startup_logging(*, force_file: bool = False) -> Path | None:
    """配置根日志；打包或无控制台时写入文件。"""
    frozen = getattr(sys, "frozen", False)
    if not frozen and not force_file:
        return None

    path = log_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    if not any(isinstance(h, logging.FileHandler) and getattr(h, "baseFilename", "") == str(path) for h in root.handlers):
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
        )
        root.addHandler(fh)
        root.setLevel(logging.INFO)

    class _Tee:
        def __init__(self, stream, log_path: Path) -> None:
            self._stream = stream
            self._log_path = log_path

        def write(self, data: str) -> int:
            if self._stream is not None:
                try:
                    self._stream.write(data)
                except Exception:
                    pass
            if data:
                try:
                    with self._log_path.open("a", encoding="utf-8") as f:
                        f.write(data)
                except Exception:
                    pass
            return len(data)

        def flush(self) -> None:
            if self._stream is not None:
                try:
                    self._stream.flush()
                except Exception:
                    pass

    sys.stdout = _Tee(sys.stdout, path)  # type: ignore[assignment]
    sys.stderr = _Tee(sys.stderr, path)  # type: ignore[assignment]

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[InvoiceLens] 启动日志: {path} ({stamp})")  # noqa: T201
    return path
