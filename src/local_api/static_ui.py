"""打包模式下由 Local API 托管 frontend/dist 静态资源。"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from src.local_api.bundle_paths import bundle_root

_DIST_DIR = bundle_root() / "frontend" / "dist"


def _dist_enabled() -> bool:
    if os.getenv("INVOICELENS_SERVE_UI", "").strip().lower() in {"1", "true", "yes"}:
        return True
    return (_DIST_DIR / "index.html").is_file()


def dist_dir() -> Path | None:
    if not _dist_enabled():
        return None
    return _DIST_DIR


def try_serve_static(path: str) -> tuple[int, str, bytes] | None:
    root = dist_dir()
    if root is None:
        return None

    rel = path.lstrip("/") or "index.html"
    if rel == "":
        rel = "index.html"

    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None

    if candidate.is_dir():
        candidate = candidate / "index.html"

    if not candidate.is_file():
        if not rel.endswith(".html"):
            spa = root / "index.html"
            if spa.is_file():
                candidate = spa
            else:
                return None
        else:
            return None

    data = candidate.read_bytes()
    ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
    return 200, ctype, data
