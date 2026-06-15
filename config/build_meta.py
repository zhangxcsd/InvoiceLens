"""读取 frontend 构建写入的 build_meta.json（应用版本与构建时间）。"""
from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path


def _meta_path() -> Path:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass) / "config" / "build_meta.json"
    return Path(__file__).resolve().parent / "build_meta.json"


@lru_cache(maxsize=1)
def read_build_meta() -> dict[str, str | None]:
    fallback = {"app_version": "dev", "build_time": None}
    meta_path = _meta_path()
    if not meta_path.is_file():
        return fallback
    try:
        raw = json.loads(meta_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return fallback
        version = str(raw.get("app_version") or "dev").strip() or "dev"
        build_time = raw.get("build_time")
        return {
            "app_version": version,
            "build_time": str(build_time).strip() if build_time else None,
        }
    except Exception:  # noqa: BLE001
        return fallback
