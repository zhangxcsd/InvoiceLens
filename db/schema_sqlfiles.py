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
    """
    占位视图：无 Parquet 时仍须含 batch_id / import_session_id 等列，否则 cleaner 中
    「WHERE batch_id = …」会对全 ODS 专项视图 Binder 报错（仅 __placeholder__ 不够）。
    使用 OR REPLACE，避免旧版占位卡在 IF NOT EXISTS。
    """
    conn.execute(
        f"CREATE OR REPLACE VIEW {view_name} AS "
        "SELECT "
        "CAST(NULL AS VARCHAR) AS batch_id, "
        "CAST(NULL AS VARCHAR) AS import_session_id, "
        "CAST(NULL AS VARCHAR) AS source_parquet_file, "
        "CAST(NULL AS BIGINT) AS ods_file_seq "
        "WHERE FALSE"
    )


def _ods_view_has_placeholder_column(conn, view_name: str) -> bool:
    """占位视图仅含 __placeholder__ 列；若仍被用于 WHERE batch_id=… 会 Binder Error。"""
    try:
        rows = conn.execute(f"DESCRIBE {view_name}").fetchall()
        return any(str(r[0]) == "__placeholder__" for r in rows)
    except Exception:
        return False


def _ods_inv_core_view_needs_parquet_mount(conn, view_name: str) -> bool:
    """
    True：仍为占位，或 DESCRIBE 中缺少 batch_id（清洗 SQL 依赖 hive 分区别名）。
    仅检 __placeholder__ 可能漏掉异常中间态，故同时检查 batch_id。
    """
    try:
        rows = conn.execute(f"DESCRIBE {view_name}").fetchall()
        names = [str(r[0]) for r in rows]
        if any(n == "__placeholder__" for n in names):
            return True
        lower = {n.lower() for n in names}
        return "batch_id" not in lower
    except Exception:
        return True


def _repair_core_ods_inv_views_if_placeholder(conn) -> None:
    """
    主循环中若 OR REPLACE 曾失败，回退的 CREATE VIEW IF NOT EXISTS 不会覆盖已存在的占位视图，
    导致 ods_inv_* 永久卡在 __placeholder__。此处对核心发票视图在「磁盘已有 parquet」时强制 OR REPLACE。
    """
    for stmt in [s.strip() for s in DDL_ODS.split(";") if s.strip()]:
        view_m = _RE_VIEW_NAME.search(stmt)
        read_m = _RE_READ_PARQUET_LITERAL.search(stmt)
        if not view_m or not read_m:
            continue
        vn = view_m.group("name")
        if vn not in ("ods_inv_header", "ods_inv_detail"):
            continue
        pattern = read_m.group("pattern")
        if not _ods_inv_core_view_needs_parquet_mount(conn, vn):
            continue
        if not _matches_any_parquet(pattern):
            continue
        replace_stmt = re.sub(
            r"CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\b",
            "CREATE OR REPLACE VIEW",
            stmt,
            count=1,
            flags=re.IGNORECASE,
        )
        try:
            conn.execute(replace_stmt)
            logger.info("已用 Parquet 覆盖占位 ODS 视图: %s", vn)
        except Exception as exc:
            logger.warning("覆盖占位 ODS 视图失败（将尝试 DROP 后重建）: %s (%s)", vn, exc)
            try:
                conn.execute(f"DROP VIEW IF EXISTS {vn}")
                conn.execute(replace_stmt)
                logger.info("已 DROP 后重建 ODS 视图: %s", vn)
            except Exception as exc2:
                logger.warning("DROP 后仍无法创建 ODS 视图: %s (%s)", vn, exc2)


def ensure_ods_inv_views_materialized(conn) -> None:
    """
    DWD 清洗依赖 ods_inv_header / ods_inv_detail 含 batch_id 等列。
    先做一次核心视图自愈（与 init_all_tables 末尾逻辑一致），再校验；避免仅依赖 cleaner 内调用顺序。
    """
    _repair_core_ods_inv_views_if_placeholder(conn)
    for vn in ("ods_inv_header", "ods_inv_detail"):
        if _ods_inv_core_view_needs_parquet_mount(conn, vn):
            raise RuntimeError(
                f"{vn} 未正确挂载 ODS Parquet（缺少 batch_id 列或仍为占位视图 __placeholder__）。"
                "请确认 data/ods 下已存在 inv_header / inv_detail 的 parquet，并从仓库根目录启动本地 API；"
                "若仍报此错，请关闭「InvoiceLens-LocalAPI」窗口后重新运行 dev.bat，避免旧进程占用端口。"
            )


def force_remount_ods_inv_core_views(conn) -> None:
    """
    不依赖 DESCRIBE：只要磁盘上存在对应 glob 的 parquet，即 DROP + CREATE OR REPLACE。
    供 cleaner 在 Binder 仍报 batch_id/__placeholder__ 时二次强制挂载（避免占位视图卡死）。
    """
    for stmt in [s.strip() for s in DDL_ODS.split(";") if s.strip()]:
        view_m = _RE_VIEW_NAME.search(stmt)
        read_m = _RE_READ_PARQUET_LITERAL.search(stmt)
        if not view_m or not read_m:
            continue
        vn = view_m.group("name")
        if vn not in ("ods_inv_header", "ods_inv_detail"):
            continue
        pattern = read_m.group("pattern")
        if not _matches_any_parquet(pattern):
            continue
        replace_stmt = re.sub(
            r"CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\b",
            "CREATE OR REPLACE VIEW",
            stmt,
            count=1,
            flags=re.IGNORECASE,
        )
        try:
            conn.execute(f"DROP VIEW IF EXISTS {vn}")
            conn.execute(replace_stmt)
            logger.info("已强制重挂 ODS 视图: %s", vn)
        except Exception as exc:
            logger.warning("强制重挂 ODS 视图失败: %s (%s)", vn, exc)


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
DDL_AUTH = _load_ddl_file("auth.sql")
DDL_ADS = _load_ddl_file("ads.sql")


def get_all_ddl() -> str:
    return "\n".join([DDL_ODS, DDL_DIM, DDL_DWD, DDL_DWS, DDL_DM, DDL_AUTH, DDL_ADS])


def _table_exists(conn, name: str) -> bool:
    # DuckDB information_schema 中 table_name 大小写可能与 DDL 不一致，用 lower 比较
    n = conn.execute(
        "SELECT COUNT(*) FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_type = 'BASE TABLE' AND lower(table_name) = lower(?)",
        [name],
    ).fetchone()[0]
    return int(n or 0) > 0


def _column_exists(conn, table: str, column: str) -> bool:
    n = conn.execute(
        "SELECT COUNT(*) FROM information_schema.columns "
        "WHERE table_schema = 'main' AND lower(table_name) = lower(?) AND lower(column_name) = lower(?)",
        [table, column],
    ).fetchone()[0]
    return int(n or 0) > 0


def _duckdb_table_columns_lower(conn, table: str) -> set[str]:
    """用 DESCRIBE 取列名（不依赖 information_schema 大小写），用于迁移补列。"""
    try:
        rows = conn.execute(f"DESCRIBE {table}").fetchall()
        return {str(r[0]).lower() for r in rows}
    except Exception:
        return set()


def migrate_legacy_dwd_schema(conn) -> None:
    """
    旧版 warehouse.duckdb 中 dwd_* 可能早于当前 DDL（缺 stat_month 等）。
    CREATE TABLE IF NOT EXISTS 不会补列，后续 CREATE INDEX 引用新列会 Binder Error。
    在跑完整 DDL 前补列并尽量从 invoice_date 回填。
    """
    if _table_exists(conn, "dwd_inv_header") and not _column_exists(conn, "dwd_inv_header", "invoice_time"):
        conn.execute("ALTER TABLE dwd_inv_header ADD COLUMN invoice_time TIME")
        logger.info("已迁移：dwd_inv_header.invoice_time")
    if _table_exists(conn, "dwd_inv_header") and not _column_exists(conn, "dwd_inv_header", "stat_month"):
        conn.execute("ALTER TABLE dwd_inv_header ADD COLUMN stat_month SMALLINT")
        conn.execute(
            """
            UPDATE dwd_inv_header
            SET stat_month = CAST(EXTRACT(month FROM invoice_date) AS SMALLINT)
            WHERE invoice_date IS NOT NULL
            """
        )
    if _table_exists(conn, "dwd_inv_detail") and not _column_exists(conn, "dwd_inv_detail", "stat_month"):
        conn.execute("ALTER TABLE dwd_inv_detail ADD COLUMN stat_month SMALLINT")
        conn.execute(
            """
            UPDATE dwd_inv_detail
            SET stat_month = CAST(EXTRACT(month FROM invoice_date) AS SMALLINT)
            WHERE invoice_date IS NOT NULL
            """
        )


def migrate_ods_load_log_dwd_watermark(conn) -> None:
    """为 ods_load_log 补 DWD 处理水位列（旧库 CREATE TABLE IF NOT EXISTS 不会自动加列）。"""
    if not _table_exists(conn, "ods_load_log"):
        return
    cols = _duckdb_table_columns_lower(conn, "ods_load_log")
    if "dwd_session_processed_at" in cols:
        return
    conn.execute("ALTER TABLE ods_load_log ADD COLUMN dwd_session_processed_at TIMESTAMP")
    logger.info("已迁移：ods_load_log.dwd_session_processed_at")


def migrate_dwd_spc_transport_unique_header_line(conn) -> None:
    """
    专项运输表与 dwd_inv_detail 对齐：若表已存在且 (header_uuid, logic_line_no) 无重复，则补
    UNIQUE(header_uuid, logic_line_no)。旧版 UNIQUE(header_uuid, source_scope_key, logic_line_no) 保留与否由 DuckDB 决定；
    新约束与「同票同 logic_line_no 唯一槽位」一致。
    """
    for tbl in ("dwd_spc_transport_passenger", "dwd_spc_transport_freight"):
        if not _table_exists(conn, tbl):
            continue
        try:
            dup = conn.execute(
                f"""
                SELECT COUNT(*) FROM (
                  SELECT 1 FROM {tbl}
                  GROUP BY header_uuid, logic_line_no
                  HAVING COUNT(*) > 1
                ) t
                """
            ).fetchone()[0]
            if int(dup or 0) > 0:
                logger.warning(
                    "%s 存在重复 (header_uuid, logic_line_no)，跳过 ADD UNIQUE；请清理或重建库",
                    tbl,
                )
                continue
        except Exception as exc:
            logger.debug("检查 %s 重复键时跳过: %s", tbl, exc)
            continue
        try:
            conn.execute(
                f"ALTER TABLE {tbl} "
                f"ADD CONSTRAINT {tbl}_hdr_line_uq UNIQUE (header_uuid, logic_line_no)"
            )
            logger.info("已迁移：%s UNIQUE(header_uuid, logic_line_no)", tbl)
        except Exception as exc:
            msg = str(exc).lower()
            if "already exists" in msg or "duplicate" in msg:
                continue
            logger.debug("%s UNIQUE 迁移跳过（可能已存在）: %s", tbl, exc)


def migrate_dwd_spc_buyer_seller_columns(conn) -> None:
    """
    专项明细表补齐购销方字段：
    - xfsbh / xfmc / gfsbh / gfmc
    旧库表已存在时，CREATE TABLE IF NOT EXISTS 不会自动补列，这里做幂等迁移。
    """
    target_tables = (
        "dwd_spc_transport_passenger",
        "dwd_spc_transport_freight",
        "dwd_spc_vehicle_sales",
        "dwd_spc_construction_service",
        "dwd_spc_estate_lease",
    )
    target_cols = ("xfsbh", "xfmc", "gfsbh", "gfmc")
    for tbl in target_tables:
        if not _table_exists(conn, tbl):
            continue
        for col in target_cols:
            if _column_exists(conn, tbl, col):
                continue
            try:
                conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} VARCHAR")
                logger.info("已迁移：%s.%s", tbl, col)
            except Exception as exc:
                logger.debug("迁移补列跳过：%s.%s (%s)", tbl, col, exc)


def migrate_dwd_inv_detail_unique_header_line(conn) -> None:
    """
    旧库若曾不含 UNIQUE(header_uuid, logic_line_no)，在表已存在且数据无重复时补约束。
    若 (header_uuid, logic_line_no) 已有多行（例如历史「detail_uuid 含 sheet」策略），则跳过并打日志；见 docs/dwd_inv_detail_multi_sheet_dedup.md。
    """
    if not _table_exists(conn, "dwd_inv_detail"):
        return
    try:
        dup = conn.execute(
            """
            SELECT COUNT(*) FROM (
              SELECT 1 FROM dwd_inv_detail
              GROUP BY header_uuid, logic_line_no
              HAVING COUNT(*) > 1
            ) t
            """
        ).fetchone()[0]
        if int(dup or 0) > 0:
            logger.warning(
                "dwd_inv_detail 存在重复 (header_uuid, logic_line_no)，跳过 ADD UNIQUE；"
                "请清理或重建库后再对齐 docs/dwd_inv_detail_multi_sheet_dedup.md"
            )
            return
    except Exception as exc:
        logger.debug("检查 dwd_inv_detail 重复键时跳过: %s", exc)
        return
    try:
        conn.execute(
            "ALTER TABLE dwd_inv_detail "
            "ADD CONSTRAINT dwd_inv_detail_hdr_line_uq UNIQUE (header_uuid, logic_line_no)"
        )
        logger.info("已迁移：dwd_inv_detail UNIQUE(header_uuid, logic_line_no)")
    except Exception as exc:
        msg = str(exc).lower()
        if "already exists" in msg or "duplicate" in msg:
            return
        logger.debug("dwd_inv_detail UNIQUE 迁移跳过（可能已存在）: %s", exc)


def migrate_dim_subject_governance_columns(conn) -> None:
    """
    主体库治理字段迁移（Step B）：
    - dim_subject_master / dim_subject_source_record 补 run/snapshot/rule/status 字段
    说明：旧库使用 CREATE TABLE IF NOT EXISTS 时不会自动补列，因此需显式 ALTER。
    """
    targets = {
        "dim_subject_master": (
            ("subject_build_run_id", "VARCHAR"),
            ("subject_snapshot_id", "VARCHAR"),
            ("category_rule_version", "VARCHAR"),
            ("category_rule_enabled_at_run", "BOOLEAN DEFAULT TRUE"),
            ("category_status_note", "VARCHAR"),
        ),
        "dim_subject_source_record": (
            ("subject_build_run_id", "VARCHAR"),
            ("subject_snapshot_id", "VARCHAR"),
            ("category_rule_version", "VARCHAR"),
            ("category_rule_enabled_at_run", "BOOLEAN DEFAULT TRUE"),
            ("category_status_note", "VARCHAR"),
        ),
    }
    for tbl, cols in targets.items():
        if not _table_exists(conn, tbl):
            continue
        for col, ddl in cols:
            if _column_exists(conn, tbl, col):
                continue
            try:
                conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} {ddl}")
                logger.info("已迁移：%s.%s", tbl, col)
            except Exception as exc:
                logger.debug("主体治理补列跳过：%s.%s (%s)", tbl, col, exc)


def migrate_dim_enterprise_year_rel_columns(conn) -> None:
    """
    企业-年度关系表补列迁移：
    旧库可能已存在 dim_enterprise_year_rel，但字段不完整（CREATE TABLE IF NOT EXISTS 不会补列）。
    """
    tbl = "dim_enterprise_year_rel"
    if not _table_exists(conn, tbl):
        return
    cols = (
        ("year_role_tag", "VARCHAR DEFAULT 'unknown'"),
        ("has_seller_role", "BOOLEAN DEFAULT FALSE"),
        ("has_buyer_role", "BOOLEAN DEFAULT FALSE"),
        ("year_first_seen_batch_id", "VARCHAR"),
        ("year_last_seen_batch_id", "VARCHAR"),
        ("year_first_seen_session_id", "VARCHAR"),
        ("year_last_seen_session_id", "VARCHAR"),
        ("year_first_seen_date", "DATE"),
        ("year_last_seen_date", "DATE"),
        ("invoice_count", "BIGINT DEFAULT 0"),
        ("amount_jshj_sum", "DECIMAL(18,2) DEFAULT 0"),
        ("relation_build_run_id", "VARCHAR"),
        ("relation_snapshot_id", "VARCHAR"),
        ("quality_status", "VARCHAR DEFAULT 'ok'"),
        ("quality_issue", "VARCHAR"),
        ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
    )
    for col, ddl in cols:
        if _column_exists(conn, tbl, col):
            continue
        try:
            conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} {ddl}")
            logger.info("已迁移：%s.%s", tbl, col)
        except Exception as exc:
            logger.debug("年度关系补列跳过：%s.%s (%s)", tbl, col, exc)


def init_all_tables(conn) -> dict:
    migrate_legacy_dwd_schema(conn)
    migrate_ods_load_log_dwd_watermark(conn)
    migrate_dwd_spc_buyer_seller_columns(conn)
    migrate_dim_subject_governance_columns(conn)
    migrate_dim_enterprise_year_rel_columns(conn)
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
                    r"CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\b",
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
                # ODS 视图：若上面 OR REPLACE 失败而落到此处，须用 OR REPLACE 覆盖已有占位视图；
                # CREATE VIEW IF NOT EXISTS 在对象已存在时不会更新，会导致永久卡在 __placeholder__。
                exec_stmt = stmt
                if view_m and read_m:
                    exec_stmt = re.sub(
                        r"CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\b",
                        "CREATE OR REPLACE VIEW",
                        stmt,
                        count=1,
                        flags=re.IGNORECASE,
                    )
                conn.execute(exec_stmt)
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

    _repair_core_ods_inv_views_if_placeholder(conn)

    migrate_dwd_inv_detail_unique_header_line(conn)
    migrate_dwd_spc_transport_unique_header_line(conn)

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

