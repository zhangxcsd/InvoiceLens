"""Smoke: 前端构建产物、build_meta 与打包二进制可启动。"""
from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _assert_build_artifacts() -> None:
    dist_index = ROOT / "frontend" / "dist" / "index.html"
    assert dist_index.is_file(), f"missing {dist_index}"

    meta_path = ROOT / "config" / "build_meta.json"
    assert meta_path.is_file(), f"missing {meta_path}"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert str(meta.get("app_version") or "").strip(), "build_meta.app_version empty"
    assert meta.get("build_time"), "build_meta.build_time missing"


def _packaged_binary() -> Path | None:
    # Windows PyInstaller 产物为 .exe；Linux/macOS 为无扩展名二进制。
    candidates = ("InvoiceLens.exe", "InvoiceLens") if platform.system() == "Windows" else ("InvoiceLens", "InvoiceLens.exe")
    for name in candidates:
        p = ROOT / "dist" / name
        if p.is_file():
            return p
    return None


def _wait_health(port: int, timeout_s: float = 120.0) -> None:
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.time() + timeout_s
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(1)
    raise RuntimeError(f"health check timeout for {url}: {last_err}")


def _json_request(url: str, *, method: str = "GET", body: dict | None = None, headers: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req_headers = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"ok": False, "error": {"message": raw}}
        return exc.code, payload


def _smoke_packaged_binary(exe: Path) -> None:
    port = _pick_free_port()
    env = {
        **os.environ,
        "INVOICELENS_LOCAL_API_PORT": str(port),
        "INVOICELENS_LOCAL_API_HOST": "127.0.0.1",
        "INVOICELENS_SERVE_UI": "1",
    }
    proc = subprocess.Popen(
        [str(exe)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_health(port)

        status, body = _json_request(
            f"http://127.0.0.1:{port}/api/auth/login",
            method="POST",
            body={"username": "", "password": ""},
        )
        assert status == 200, body
        assert body.get("ok") is True
        token = str(body.get("token") or "")
        assert token

        me_status, me_body = _json_request(
            f"http://127.0.0.1:{port}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert me_status == 200, me_body
        assert me_body.get("ok") is True

        lic_status, lic_body = _json_request(
            f"http://127.0.0.1:{port}/api/settings/license",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert lic_status == 200, lic_body
        assert lic_body.get("ok") is True
        assert "gates" in lic_body

        compare_status, compare_body = _json_request(
            f"http://127.0.0.1:{port}/api/compare/meta",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert compare_status == 403, compare_body
        assert compare_body.get("error", {}).get("code") == "license_cross_group_denied"

        index_url = f"http://127.0.0.1:{port}/"
        with urllib.request.urlopen(index_url, timeout=10) as resp:
            html = resp.read(512).decode("utf-8", errors="replace")
        assert "<" in html
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description="InvoiceLens packaging smoke")
    parser.add_argument(
        "--require-binary",
        action="store_true",
        help="若 dist/InvoiceLens(.exe) 不存在则失败（CI / 完整本地打包冒烟）",
    )
    args = parser.parse_args()
    require_binary = args.require_binary or os.environ.get("INVOICELENS_REQUIRE_PACKAGED_BINARY") == "1"

    _assert_build_artifacts()
    exe = _packaged_binary()
    if exe is None:
        if require_binary:
            raise SystemExit(
                f"test_packaging_smoke: FAIL — packaged binary missing under {ROOT / 'dist'} "
                f"(platform={platform.system()})",
            )
        print(
            f"test_packaging_smoke: skip binary smoke (dist/InvoiceLens not built on {platform.system()})",
        )
    else:
        print(f"test_packaging_smoke: binary={exe.name} platform={platform.system()}")
        _smoke_packaged_binary(exe)
    print("test_packaging_smoke: OK")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"test_packaging_smoke: FAIL — HTTP {exc.code}: {body}", file=sys.stderr)
        raise SystemExit(1) from exc
    except urllib.error.URLError as exc:
        print(f"test_packaging_smoke: FAIL — {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
