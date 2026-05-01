"""回归冒烟：验证本地 API 启动后 dim_tax_code 接口不会挂起/断开。"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


_ROOT = Path(__file__).resolve().parents[1]


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _http_json(url: str, timeout_sec: float = 8.0) -> dict:
    with urlopen(url, timeout=timeout_sec) as resp:  # noqa: S310 (仅本机回归冒烟)
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


def _wait_until_ready(base_url: str, timeout_sec: float = 120.0) -> None:
    deadline = time.time() + timeout_sec
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            payload = _http_json(f"{base_url}/api/dim-tax-code/filter-options", timeout_sec=3.0)
            if bool(payload.get("ok")):
                return
            last_err = RuntimeError(f"接口返回 ok=False: {payload}")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        time.sleep(0.8)
    raise RuntimeError(f"等待本地 API 就绪超时: {last_err}")


def main() -> None:
    port = _pick_free_port()
    base = f"http://127.0.0.1:{port}"
    log_file = Path(tempfile.gettempdir()) / f"invoicelens_local_api_smoke_{port}.log"

    env = os.environ.copy()
    env["INVOICELENS_LOCAL_API_HOST"] = "127.0.0.1"
    env["INVOICELENS_LOCAL_API_PORT"] = str(port)

    with log_file.open("w", encoding="utf-8", errors="replace") as fp:
        proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "src.local_api.sheet_mapping_server"],
            cwd=str(_ROOT),
            env=env,
            stdout=fp,
            stderr=subprocess.STDOUT,
        )

    try:
        _wait_until_ready(base)

        # 连续请求，覆盖最易出现 socket hang up 的两个接口。
        for i in range(3):
            payload = _http_json(f"{base}/api/dim-tax-code/filter-options", timeout_sec=8.0)
            if not bool(payload.get("ok")):
                raise RuntimeError(f"第 {i + 1} 次 filter-options 失败: {payload}")

        rows = _http_json(
            f"{base}/api/dim-tax-code/rows?keyword=__smoke_no_hit__&clean_status=all&risk=all",
            timeout_sec=20.0,
        )
        if not bool(rows.get("ok")):
            raise RuntimeError(f"rows 接口失败: {rows}")

        print("SMOKE PASS: local api dim-tax-code endpoints are healthy.")
        print(f"base_url={base}")
    except (URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        tail = ""
        try:
            content = log_file.read_text(encoding="utf-8", errors="replace")
            tail = "\n".join(content.splitlines()[-40:])
        except Exception:  # noqa: BLE001
            tail = "<无法读取日志>"
        raise SystemExit(f"SMOKE FAIL: {type(exc).__name__}: {exc}\n--- server log tail ---\n{tail}") from exc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    main()

