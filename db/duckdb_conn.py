"""
InvoiceLens · 票鉴
db/duckdb_conn.py

DuckDB 连接管理（单例模式）。
全局共享一个连接，所有模块通过 get_conn() 获取。
"""

import duckdb
import os
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "database" / "warehouse.duckdb"

_conn: duckdb.DuckDBPyConnection | None = None


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
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = duckdb.connect(str(DB_PATH))
        _conn.execute("SET threads TO 4")
        _conn.execute("SET memory_limit = '4GB'")
        tmp_dir = DB_PATH.parent / "tmp"
        tmp_dir.mkdir(exist_ok=True)
        _conn.execute(f"SET temp_directory = '{tmp_dir}'")
    return _conn


def close_conn():
    """关闭连接（程序退出时调用）"""
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


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
