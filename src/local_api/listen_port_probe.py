"""
检测本机 TCP 端口是否已有 LISTEN，用于避免多个 Local API 同时监听同一端口（会导致 Vite 代理随机命中异常进程，出现 socket hang up）。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class PortListenConflict:
    port: int
    pids: tuple[int, ...]
    """多条 LISTEN 记录（可能为同一 PID 绑定多地址，或重复进程）。"""


def _parse_netstat_win(lines: str, port: int) -> list[int]:
    """解析 `netstat -ano` 输出，返回在 port 上处于 LISTENING 的 PID 列表（去重前）。"""
    port_suffix = f":{port}"
    pids: list[int] = []
    for raw in lines.splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        # 英文 / 简中常见状态名
        if "listening" not in low and "监听" not in line:
            continue
        if port_suffix not in line:
            continue
        parts = line.split()
        if not parts:
            continue
        tail = parts[-1]
        if tail.isdigit():
            pids.append(int(tail))
    return pids


def _listen_pids_windows(port: int) -> list[int]:
    creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0  # type: ignore[attr-defined]
    proc = subprocess.run(
        ["netstat", "-ano", "-p", "TCP"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
        creationflags=creationflags,
    )
    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return _parse_netstat_win(out, port)


def _listen_pids_unix_lsof(port: int) -> list[int] | None:
    lsof = shutil.which("lsof")
    if not lsof:
        return None
    proc = subprocess.run(
        [lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    if proc.returncode != 0 and not (proc.stdout or "").strip():
        return None
    pids: list[int] = []
    for line in (proc.stdout or "").splitlines():
        s = line.strip()
        if s.isdigit():
            pids.append(int(s))
    return pids


def _listen_pids_unix_ss(port: int) -> list[int] | None:
    ss = shutil.which("ss")
    if not ss:
        return None
    proc = subprocess.run(
        [ss, "-Htan", f"sport = :{port}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    if proc.returncode != 0:
        return None
    pids: list[int] = []
    for line in (proc.stdout or "").splitlines():
        for m in re.finditer(r"pid=(\d+)", line):
            pids.append(int(m.group(1)))
    return pids if pids else None


def tcp_listen_pids(port: int) -> list[int]:
    """返回在 TCP `port` 上处于 LISTEN 的进程 PID（去重、升序）。"""
    raw: list[int]
    if sys.platform == "win32":
        raw = _listen_pids_windows(port)
    else:
        raw = _listen_pids_unix_lsof(port) or _listen_pids_unix_ss(port) or []
    uniq = sorted({p for p in raw if p > 0})
    return uniq


def check_listen_port_singleton(port: int) -> PortListenConflict | None:
    """
    若端口已有监听则返回冲突信息；无监听返回 None。
    多个 PID 同时监听视为严重冲突（与单 PID 多地址不同：tcp_listen_pids 已去重 PID）。
    """
    pids = tuple(tcp_listen_pids(port))
    if not pids:
        return None
    return PortListenConflict(port=port, pids=pids)


def format_port_conflict_message(c: PortListenConflict, *, api_cmd: str) -> str:
    if len(c.pids) > 1:
        return (
            f"[InvoiceLensLocalAPI] 端口 {c.port} 上存在多个监听进程（PID: {', '.join(map(str, c.pids))}），"
            f"会导致前端代理随机失败（socket hang up）。\n"
            "请先结束多余进程，例如在项目根目录执行 dev.bat kill-api-port，"
            f"或逐个结束：{' / '.join(f'taskkill /PID {p} /F' for p in c.pids)}\n"
            f"然后仅启动一份：{api_cmd}"
        )
    return (
        f"[InvoiceLensLocalAPI] 端口 {c.port} 已被占用（PID {c.pids[0]}）。"
        f"请先结束该进程或改用其他端口（环境变量 INVOICELENS_LOCAL_API_PORT）。\n"
        f"推荐：{api_cmd}"
    )


def assert_listen_port_free_or_exit(port: int) -> None:
    """
    启动 Local API 前调用：若端口已被监听则打印说明并 sys.exit(1)。
    设置环境变量 INVOICELENS_SKIP_PORT_GUARD=1 可跳过（仅用于特殊排障）。
    """
    if (os.getenv("INVOICELENS_SKIP_PORT_GUARD") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return
    c = check_listen_port_singleton(port)
    if c is None:
        return
    print(format_port_conflict_message(c, api_cmd="dev.bat api 或 python -m src.local_api.sheet_mapping_server"))  # noqa: T201
    raise SystemExit(1)


def _cli_main() -> int:
    """供 `python -m src.local_api.listen_port_probe`：检查默认或环境变量指定的端口。"""
    port = int((os.getenv("INVOICELENS_LOCAL_API_PORT") or "8765").strip())
    c = check_listen_port_singleton(port)
    if c is None:
        print(f"[listen_port_probe] 端口 {port} 当前无 TCP LISTEN，可启动 Local API。")  # noqa: T201
        return 0
    print(format_port_conflict_message(c, api_cmd="dev.bat api"))  # noqa: T201
    return 1


if __name__ == "__main__":
    raise SystemExit(_cli_main())
