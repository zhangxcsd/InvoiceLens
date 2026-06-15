"""PyInstaller 打包与开发模式下的资源根路径。"""

from __future__ import annotations

import sys
from pathlib import Path


def bundle_root() -> Path:
    """只读资源（config、frontend/dist、assets）所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parents[2]


def data_root() -> Path:
    """可写数据目录（data/）的 cwd 基准；打包后为 exe 所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]
