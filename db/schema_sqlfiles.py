from __future__ import annotations

"""
InvoiceLens · 票鉴
db/schema_sqlfiles.py

DuckDB 建表入口（只加载外置 SQL）。

- 全部 DDL 在 `config/ddl/*.sql`（必须保留 SQL 注释）
- 本文件禁止内嵌任何大段 SQL 字符串
"""

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_DDL_ROOT = Path(__file__).resolve().parents[1] / "config" / "ddl"
_PROJECT_ROOT = Path(__file__).resolve().parents[1]


_RE_VIEW_NAME = re.compile(
    r"CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+AS\b",
    flags=re.IGNORECASE,
)
_RE_READ_PARQUET_LITERAL = re.compile(
    r"read_parquet\s*\(\s*'(?P<pattern>[^']+)'\s*,",
    flags=re.IGNORECASE | re.DOTALL,
)


def _matches_any_parquet(pattern: str) -> bool:
    """
    DuckDB 的 read_parquet glob 在“无匹配文件”时会直接抛 IOException。
    这里用本地文件系统预检：如果 ODS 还没产出任何 parquet，则返回 False。
    """
    if not pattern:
        return True
    # 仅处理项目内相对路径（例如 data/ods/...），避免误判外部路径
    p = pattern.replace("\\", "/")
    if "://" in p:
        return True
    # DuckDB glob 以项目 cwd 为基准；本项目以仓库根目录为基准更符合直觉
    abs_glob = str((_PROJECT_ROOT / p).resolve())
    # pathlib 不支持部分 glob 语法，这里用 glob 模块更贴近行为
    import glob

    return len(glob.glob(abs_glob, recursive=True)) > 0


def _create_empty_view(conn, view_name: str) -> None:
    # 占位视图：至少保证对象存在，后续导入 ODS parquet 后可重新初始化以挂载真实视图
    conn.execute(
        f"CREATE VIEW IF NOT EXISTS {view_name} AS "
        "SELECT NULL::VARCHAR AS __placeholder__ WHERE FALSE"
    )


def _load_ddl_file(name: str) -> str:
    p = _DDL_ROOT / name
    if not p.exists():
        raise FileNotFoundError(f"DDL 文件未找到：{p}")
    return p.read_text(encoding="utf-8")


DDL_ODS = _load_ddl_file("ods.sql")
DDL_DIM = _load_ddl_file("dim.sql")
DDL_DWD = _load_ddl_file("dwd.sql")
DDL_DWS = _load_ddl_file("dws.sql")
DDL_DM = _load_ddl_file("dm.sql")
DDL_ADS = _load_ddl_file("ads.sql")


def get_all_ddl() -> str:
    return "\n".join([DDL_ODS, DDL_DIM, DDL_DWD, DDL_DWS, DDL_DM, DDL_ADS])


def init_all_tables(conn) -> dict:
    ddl = get_all_ddl()
    stmts = [s.strip() for s in ddl.split(";") if s.strip()]

    def _has_exec(stmt: str) -> bool:
        for line in stmt.splitlines():
            s = line.strip()
            if not s or s.startswith("--"):
                continue
            return True
        return False

    executed = 0
    skipped = 0
    skip_reasons: list[dict] = []
    for stmt in stmts:
        if _has_exec(stmt):
            # 预检：ODS VIEW 在未导入任何 parquet 前应允许“初始化跳过而不中断”
            view_m = _RE_VIEW_NAME.search(stmt)
            read_m = _RE_READ_PARQUET_LITERAL.search(stmt)
            if view_m and read_m:
                view_name = view_m.group("name")
                pattern = read_m.group("pattern")
                if not _matches_any_parquet(pattern):
                    _create_empty_view(conn, view_name)
                    skipped += 1
                    skip_reasons.append(
                        {
                            "object": view_name,
                            "kind": "view",
                            "reason": "ODS Parquet 尚未生成（read_parquet 无匹配文件，已创建空占位视图）",
                            "pattern": pattern,
                        }
                    )
                    logger.warning(
                        "初始化跳过真实 ODS 视图（无 parquet 匹配），已创建占位视图: %s pattern=%s",
                        view_name,
                        pattern,
                    )
                    continue
                # 若 parquet 已存在，则需要覆盖掉此前可能创建的“占位视图”
                # DDL 文件中是 CREATE VIEW IF NOT EXISTS，这里提升为 OR REPLACE 以确保切换到真实视图
                replace_stmt = re.sub(
                    r"^CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\b",
                    "CREATE OR REPLACE VIEW",
                    stmt,
                    count=1,
                    flags=re.IGNORECASE,
                )
                try:
                    conn.execute(replace_stmt)
                    executed += 1
                    continue
                except Exception as exc:
                    # 如果真实视图创建失败，回退到原 stmt 的执行/兜底逻辑
                    logger.warning(
                        "真实 ODS 视图创建失败，将回退执行原语句: %s (%s)",
                        view_name,
                        type(exc).__name__,
                    )

            try:
                conn.execute(stmt)
                executed += 1
            except Exception as exc:
                # 兜底：若仍因 read_parquet 无匹配导致异常，则不中断初始化
                msg = str(exc)
                if "No files found that match the pattern" in msg and view_m:
                    view_name = view_m.group("name")
                    _create_empty_view(conn, view_name)
                    skipped += 1
                    skip_reasons.append(
                        {
                            "object": view_name,
                            "kind": "view",
                            "reason": "ODS Parquet 尚未生成（DuckDB 抛出无匹配文件异常，已创建空占位视图）",
                            "exception_type": type(exc).__name__,
                        }
                    )
                    logger.warning(
                        "初始化捕获 read_parquet 无匹配异常，已创建占位视图: %s (%s)",
                        view_name,
                        type(exc).__name__,
                    )
                    continue
                raise

    def count_tables(prefix: str) -> int:
        return conn.execute(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema='main' AND table_type='BASE TABLE' "
            "AND table_name LIKE ?",
            [f"{prefix}%"],
        ).fetchone()[0]

    return {
        "executed": executed,
        "skipped": skipped,
        "skip_reasons": skip_reasons,
        "ods": count_tables("ods_"),
        "dim": count_tables("dim_"),
        "dwd": count_tables("dwd_"),
        "dws": count_tables("dws_"),
        "dm": count_tables("dm_"),
        "ads": count_tables("ads_"),
        "total": conn.execute(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema='main' AND table_type='BASE TABLE'"
        ).fetchone()[0],
    }

