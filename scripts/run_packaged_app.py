"""打包版入口：启动 Local API 并托管 frontend/dist。"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="InvoiceLens packaged app launcher")
    parser.add_argument("--host", default=None, help="Local API bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="Local API port (default 8765)")
    args = parser.parse_args(argv)

    from src.local_api.bundle_paths import bundle_root, data_root

    root = data_root()
    bundle = bundle_root()
    os.chdir(root)
    os.environ.setdefault("INVOICELENS_SERVE_UI", "1")
    os.environ.setdefault("INVOICELENS_LOCAL_API_HOST", args.host or "127.0.0.1")
    os.environ.setdefault("INVOICELENS_LOCAL_API_PORT", str(args.port or 8765))

    dist_index = bundle / "frontend" / "dist" / "index.html"
    if not dist_index.is_file():
        print(f"[InvoiceLens] 缺少前端构建产物: {dist_index}")  # noqa: T201
        print("[InvoiceLens] 请先执行: cd frontend && npm run build")  # noqa: T201
        return 1

    host = os.environ["INVOICELENS_LOCAL_API_HOST"]
    port = os.environ["INVOICELENS_LOCAL_API_PORT"]
    print("[InvoiceLens] 打包模式启动 Local API + 静态 UI")  # noqa: T201
    print(f"[InvoiceLens] 浏览器打开: http://{host}:{port}/")  # noqa: T201

    from src.local_api.startup_log import configure_startup_logging

    configure_startup_logging(force_file=getattr(sys, "frozen", False))

    from src.local_api.sheet_mapping_server import main as api_main

    return api_main()


if __name__ == "__main__":
    raise SystemExit(main())
