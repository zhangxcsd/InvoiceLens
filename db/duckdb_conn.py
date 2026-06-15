"""
InvoiceLens · 票鉴
db/duckdb_conn.py

DuckDB 连接管理（单例模式）。
全局共享一个连接，所有模块通过 get_conn() 获取。
"""

import duckdb
import os
import threading
import time
from pathlib import Path

_DEFAULT_DB_PATH = Path(__file__).parent.parent / "data" / "database" / "warehouse.duckdb"
DB_PATH = Path(os.getenv("INVOICELENS_DB_PATH") or _DEFAULT_DB_PATH)

# ThreadingHTTPServer 会并发处理请求；DuckDB 连接对象不保证跨线程安全。
# 这里改为“每线程一个连接”（thread-local），避免首屏并发请求导致偶发异常。
_tls = threading.local()


def _is_conn_alive(conn: duckdb.DuckDBPyConnection) -> bool:
    try:
        conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def _is_transient_db_open_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return (
        "file is already open" in msg
        or "another process" in msg
        or "进程无法访问" in msg
        or "unique file handle conflict" in msg
        or "already attached" in msg
    )


def get_db_mode() -> str:
    """
    数据库运行模式开关（避免“开发期自动清库”误入定版/生产）：
    - dev: 允许重建数据库文件（清空历史数据）
    - prod: 禁止重建数据库文件（必须走迁移）
    通过环境变量 INVOICELENS_DB_MODE 控制，默认 dev（当前项目处于快速迭代期）。
    """
    mode = (os.getenv("INVOICELENS_DB_MODE") or "dev").strip().lower()
    return mode if mode in {"dev", "prod"} else "dev"


def get_conn() -> duckdb.DuckDBPyConnection:
    """
    获取全局 DuckDB 连接（单例）。
    首次调用时自动创建 data/database/ 目录和数据库文件。
    """
    conn = getattr(_tls, "conn", None)
    if conn is not None and not _is_conn_alive(conn):
        try:
            conn.close()
        except Exception:
            pass
        _tls.conn = None
        conn = None
    if conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Windows 上若有其它进程（例如 DB GUI / 另一份服务）占用 duckdb 文件，会报
        # "File is already open ..."。这里做轻量重试，降低“刚启动/刚重启”时的偶发失败。
        last_exc: Exception | None = None
        for i in range(15):
            try:
                conn = duckdb.connect(str(DB_PATH))
                last_exc = None
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if _is_transient_db_open_error(exc):
                    time.sleep(0.15 * (i + 1))
                    continue
                raise
        if conn is None:
            assert last_exc is not None
            raise last_exc
        conn.execute("SET threads TO 4")
        conn.execute("SET memory_limit = '4GB'")
        tmp_dir = DB_PATH.parent / "tmp"
        tmp_dir.mkdir(exist_ok=True)
        conn.execute(f"SET temp_directory = '{tmp_dir}'")
        # DuckDB 1.5+ top_n 优化在 ORDER BY 中文 VARCHAR + LIMIT 时会触发
        # InvalidInputException: Invalid unicode (byte sequence mismatch)。
        conn.execute("SET disabled_optimizers='top_n'")
        _tls.conn = conn
    return conn


def close_conn():
    """关闭当前线程连接（程序退出时调用）"""
    conn = getattr(_tls, "conn", None)
    if conn is not None:
        conn.close()
        _tls.conn = None


def warm_thread_local_connections(*, count: int = 4) -> int:
    """
    在多个工作线程上预建 DuckDB 连接并完成 init_all_tables，
    避免 ThreadingHTTPServer 首次请求承担 DDL 冷启动（约 1～2s）。
    """
    from concurrent.futures import ThreadPoolExecutor

    from db.schema_sqlfiles import init_all_tables

    workers = max(1, int(count or 1))

    def _warm_one() -> None:
        init_all_tables(get_conn())

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(lambda _: _warm_one(), range(workers)))
    return workers


def rebuild_database_files(*, remove_tmp: bool = False) -> dict:
    """
    面向未来：不考虑历史兼容时的一键重建。
    - 关闭现有连接
    - 删除 duckdb 文件（及可能的 wal）
    - 可选清空 tmp 目录（默认不删，避免误伤其他临时文件）
    """
    if get_db_mode() != "dev":
        raise RuntimeError(
            "当前为生产/定版模式（INVOICELENS_DB_MODE=prod），禁止重建数据库文件；请改用迁移脚本升级表结构。"
        )
    close_conn()
    removed: list[str] = []
    missing: list[str] = []

    for p in [DB_PATH, DB_PATH.with_suffix(DB_PATH.suffix + ".wal")]:
        try:
            p.unlink()
            removed.append(str(p))
        except FileNotFoundError:
            missing.append(str(p))

    if remove_tmp:
        tmp_dir = DB_PATH.parent / "tmp"
        if tmp_dir.exists() and tmp_dir.is_dir():
            for child in tmp_dir.glob("*"):
                try:
                    if child.is_file():
                        child.unlink()
                        removed.append(str(child))
                except FileNotFoundError:
                    missing.append(str(child))

    return {"removed": removed, "missing": missing, "db_path": str(DB_PATH)}
