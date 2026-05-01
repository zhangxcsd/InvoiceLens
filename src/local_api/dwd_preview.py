"""
DWD 数据查看：从 DuckDB `dwd_inv_header` / `dwd_inv_detail` 按批次/会话分页抽样；
并提供仅删除 DWD 落库行、重置 `ods_load_log` DWD 水位的运维接口（不删 ODS、不重跑清洗）。
"""

from __future__ import annotations

import re
import uuid
from functools import lru_cache
from typing import Any

from config.dwd_mapping_loader import load_merged_dwd_mapping
from db.duckdb_conn import close_conn
from src.local_api.ods_preview import _df_to_row_dicts, _validate_ods_identifier

_TABLE_TYPE_CODE_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _duckdb_fatal_connection(exc: BaseException) -> bool:
    m = str(exc).lower()
    return ("invalidated" in m and "database" in m) or ("fatal" in m and "restart" in m)


def _close_conn_if_duckdb_unusable(exc: BaseException) -> None:
    """DuckDB 在部分错误后会话连接不可再用；丢弃线程本地连接，便于后续请求自动重建。"""
    m = str(exc).lower()
    if _duckdb_fatal_connection(exc) or "failed to delete all rows from index" in m:
        try:
            close_conn()
        except Exception:
            pass


def _assert_dwd_sql_ident(name: str, *, label: str) -> str:
    s = str(name or "").strip()
    if not s or not _TABLE_TYPE_CODE_RE.match(s):
        raise ValueError(f"{label} 非法: {name!r}")
    return s


def _dwd_sort_tables_header_last(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """先删子表/扩展表，最后删 dwd_inv_header，降低宽表依赖顺序风险。"""
    return sorted(pairs, key=lambda x: (1 if x[0] == "dwd_inv_header" else 0, x[0]))


def _dwd_restore_primary_key_if_missing(conn: Any, *, table: str, pk: str) -> None:
    """CTAS 新表无 PRIMARY KEY；与 DDL 对齐，避免后续写入/清洗报约束缺失。"""
    t = _assert_dwd_sql_ident(table, label="table")
    p = _assert_dwd_sql_ident(pk, label="pk")
    try:
        n = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM duckdb_constraints() "
                "WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'",
                [t],
            ).fetchone()[0]
            or 0
        )
    except Exception:
        n = 0
    if n > 0:
        return
    conn.execute(f"ALTER TABLE {t} ADD PRIMARY KEY ({p})")


def _dwd_swap_table_keep_where(
    conn: Any,
    *,
    table: str,
    pk: str,
    keep_where_sql: str,
    keep_params: list[Any],
) -> int:
    """
    用 ``CREATE TABLE AS SELECT * WHERE <保留条件>`` 替换原表，**不执行 DELETE**，
    规避 DuckDB 在部分库上对 ART/主键/二级索引维护的 ``Failed to delete all rows from index`` 缺陷
    （该缺陷在 ``DELETE WHERE pk = ?`` 单条时仍可能触发）。
    返回删除行数（原表行数 − 新表行数）。
    """
    t = _assert_dwd_sql_ident(table, label="table")
    p = _assert_dwd_sql_ident(pk, label="pk")
    n_before = int(conn.execute(f"SELECT COUNT(*)::BIGINT FROM {t}").fetchone()[0] or 0)
    n_keep = int(
        conn.execute(f"SELECT COUNT(*)::BIGINT FROM {t} WHERE {keep_where_sql}", keep_params).fetchone()[0] or 0
    )
    n_del = n_before - n_keep
    if n_del <= 0:
        return 0
    tmp = f"ilswap_{t}_{uuid.uuid4().hex}"
    _assert_dwd_sql_ident(tmp, label="tmp_table")
    conn.execute("BEGIN TRANSACTION")
    try:
        conn.execute(f"CREATE TABLE {tmp} AS SELECT * FROM {t} WHERE {keep_where_sql}", keep_params)
        conn.execute(f"DROP TABLE {t}")
        conn.execute(f"ALTER TABLE {tmp} RENAME TO {t}")
        _dwd_restore_primary_key_if_missing(conn, table=t, pk=p)
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    return n_del


@lru_cache(maxsize=1)
def _dwd_column_label_maps() -> dict[str, dict[str, str]]:
    """
    从 config/dwd_mapping*.yaml 构建列中文名映射：
    - 优先 comment（更像列名展示）
    - 其次 rule_zh（规则说明）
    """
    out: dict[str, dict[str, str]] = {}
    try:
        merged = load_merged_dwd_mapping()
    except Exception:
        return out
    tables = merged.get("tables")
    if not isinstance(tables, dict):
        return out

    for tname, tdef in tables.items():
        if not isinstance(tdef, dict):
            continue
        cols = tdef.get("columns")
        if not isinstance(cols, dict):
            continue
        cmap: dict[str, str] = {}
        for cname, cdef in cols.items():
            if not isinstance(cdef, dict):
                continue
            key = str(cname).strip()
            if not key:
                continue
            label = str(cdef.get("comment") or "").strip() or str(cdef.get("rule_zh") or "").strip()
            if label:
                cmap[key] = label
        if cmap:
            out[str(tname)] = cmap
    return out


def _delete_rows_by_session_batched(
    conn: Any,
    *,
    table: str,
    pk: str,
    import_batch_id: str,
    import_session_id: str,
    sess_needle: str,
    batch_size: int = 200,
) -> int:
    """
    删除会话命中行：用 CTAS 保留「非本会话删除范围」的行并替换表，避免 DuckDB DELETE+ART 索引缺陷
    （含单条 ``DELETE WHERE pk=?`` 仍失败的情形）。``batch_size`` 保留签名兼容，已不使用。
    """
    _ = batch_size
    keep_where = """
import_batch_id IS DISTINCT FROM ?
OR NOT (
  import_session_id = ?
  OR (
    (import_session_id IS NULL OR trim(CAST(import_session_id AS VARCHAR)) = '')
    AND strpos(CAST(source_parquet_file AS VARCHAR), ?) > 0
  )
)
"""
    params: list[Any] = [import_batch_id, import_session_id, sess_needle]
    return _dwd_swap_table_keep_where(conn, table=table, pk=pk, keep_where_sql=keep_where, keep_params=params)


def _delete_rows_by_batch_batched(
    conn: Any,
    *,
    table: str,
    pk: str,
    import_batch_id: str,
    batch_size: int = 200,
) -> int:
    """
    删除某批次全部行：用 CTAS 保留 ``import_batch_id`` 与目标批次不同的行并替换表，避免 DuckDB DELETE 索引缺陷。
    ``batch_size`` 保留签名兼容，已不使用。
    """
    _ = batch_size
    bid = str(import_batch_id or "").strip()
    if not bid:
        return 0
    return _dwd_swap_table_keep_where(
        conn,
        table=table,
        pk=pk,
        keep_where_sql="import_batch_id IS DISTINCT FROM ?",
        keep_params=[bid],
    )


def _validate_dwd_table_type_code(raw: str | None) -> tuple[bool, str]:
    s = str(raw or "").strip()
    if not s:
        return False, "table_type 不能为空"
    if len(s) > 120 or not _TABLE_TYPE_CODE_RE.match(s):
        return False, "table_type 非法"
    return True, s


def _dwd_phys_for_table_type(table_type: str) -> tuple[str, str, str] | None:
    """
    (duckdb_table, pk_column, path_segment)：
    - duckdb_table / pk_column 来自 dwd_mapping 汇总
    - path_segment 使用 ODS table_type（用于 source_parquet_file 中 `表类型=<table_type>` 过滤）
    """
    try:
        merged = load_merged_dwd_mapping()
    except Exception:
        return None
    tables = merged.get("tables")
    if not isinstance(tables, dict):
        return None
    tt = str(table_type or "").strip()
    if not tt:
        return None
    for dwd_table, tdef in tables.items():
        if not isinstance(tdef, dict):
            continue
        src_tts = tdef.get("from_table_types")
        if not isinstance(src_tts, list) or tt not in [str(x).strip() for x in src_tts]:
            continue
        pks = tdef.get("primary_key")
        if not isinstance(pks, list) or len(pks) != 1 or not str(pks[0]).strip():
            continue
        return (str(dwd_table), str(pks[0]).strip(), tt)
    return None


def _dwd_preview_target_tables(conn: Any) -> list[tuple[str, str]]:
    """
    返回可用于 DWD 预览/删除的表与主键：(table, pk)。
    规则：
    - 来自 dwd_mapping（含 include）
    - 仅保留单主键表
    - 表中需存在 import_batch_id 列（删除/筛选所需）
    """
    out: list[tuple[str, str]] = []
    try:
        merged = load_merged_dwd_mapping()
    except Exception:
        return out
    tables = merged.get("tables")
    if not isinstance(tables, dict):
        return out
    for dwd_table, tdef in tables.items():
        if not isinstance(tdef, dict):
            continue
        pks = tdef.get("primary_key")
        if not isinstance(pks, list) or len(pks) != 1 or not str(pks[0]).strip():
            continue
        pk = str(pks[0]).strip()
        try:
            desc_rows = conn.execute(f"DESCRIBE {dwd_table}").fetchall()
        except Exception:
            continue
        cols = {str(r[0]).strip() for r in desc_rows if r and r[0] is not None}
        if "import_batch_id" not in cols:
            continue
        out.append((str(dwd_table), pk))
    return out


@lru_cache(maxsize=1)
def _dwd_table_label_map() -> dict[str, str]:
    """从 dwd_mapping 汇总中取各 DWD 表的中文名（label_zh），供 Tab 展示。"""
    out: dict[str, str] = {}
    try:
        merged = load_merged_dwd_mapping()
    except Exception:
        return out
    tables = merged.get("tables")
    if not isinstance(tables, dict):
        return out
    for tname, tdef in tables.items():
        if not isinstance(tdef, dict):
            continue
        label = str(tdef.get("label_zh") or "").strip()
        if label:
            out[str(tname)] = label
    return out


def _infer_layer_from_table(table: str) -> str:
    t = str(table).lower()
    if t.endswith("_header") or "header" in t:
        return "header"
    return "detail"


def list_dwd_preview_tabs(conn: Any, *, batch_id: str, session_id: str | None = None) -> dict[str, Any]:
    """
    以 DWD 物理表为主返回 Tab：
    - 来自 dwd_mapping（含 include），且实际表存在、含 import_batch_id
    - 按 import_batch_id（及可选 import_session_id）统计行数
    - 仅返回行数 > 0 的表

    注：DWD 层不以 ODS 的 table_type 作为主入口；table_type 仅用于血缘/来源过滤的次级筛选（如需）。
    """
    ok, bid = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok:
        return {"ok": False, "error": {"message": bid}}

    sid = str(session_id or "").strip()
    if sid:
        ok2, smsg = _validate_ods_identifier(session_id, label="session_id")
        if not ok2:
            return {"ok": False, "error": {"message": smsg}}

    warnings: list[str] = []
    tabs: list[dict[str, Any]] = []

    label_map = _dwd_table_label_map()
    for table, _pk in _dwd_preview_target_tables(conn):
        base_where: list[str] = ["import_batch_id = ?"]
        base_params: list[Any] = [bid]
        if sid:
            base_where.append("import_session_id = ?")
            base_params.append(sid)
        base_where_sql = " AND ".join(base_where)
        try:
            cnt = int(
                conn.execute(
                    f"SELECT COUNT(*)::BIGINT FROM {table} WHERE {base_where_sql}",
                    base_params,
                ).fetchone()[0]
                or 0
            )
        except Exception as exc:
            warnings.append(f"{table}: DWD 计数失败（{type(exc).__name__}）")
            continue
        if cnt <= 0:
            continue
        tabs.append(
            {
                "dwd_table": table,
                "title": label_map.get(table, table),
                "layer": _infer_layer_from_table(table),
                "row_count": cnt,
            }
        )

    # 稳定排序：优先 header，再按表名；避免每次 describe/迭代顺序不同导致 UI 抖动
    tabs.sort(key=lambda x: (0 if x.get("layer") == "header" else 1, str(x.get("dwd_table") or "")))

    return {"ok": True, "batch_id": bid, "session_id": sid, "tabs": tabs, "warnings": warnings}


def load_dwd_preview_table_page(
    conn: Any,
    *,
    batch_id: str,
    session_id: str | None = None,
    layer: str = "detail",
    dwd_table: str | None = None,
    table_type: str | None = None,
    limit: int = 200,
    cursor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    按 import_batch_id（及可选 import_session_id）筛选 DWD 表，按主键递增分页。

    - dwd_table: 若指定，则直接查询指定 DWD 表（须在 dwd_mapping 且为单主键表），优先级最高。
    - table_type: 若指定，则按 dwd_mapping 动态解析目标 DWD 表，并按 ``source_parquet_file`` 中 ``表类型=<table_type>`` 过滤。
      优先于 layer（低于 dwd_table）。
    - layer: 无 table_type 时用于兼容旧行为：``header``→dwd_inv_header，``detail``→dwd_inv_detail。
    - cursor: ``{\"pk\": \"<uuid>\"}`` 表示上一页最后一行的主键，取严格大于 pk 的下一页
    """
    ok, bid = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok:
        return {"ok": False, "error": {"message": bid}}

    sid = str(session_id or "").strip()
    if sid:
        ok2, smsg = _validate_ods_identifier(session_id, label="session_id")
        if not ok2:
            return {"ok": False, "error": {"message": smsg}}

    dt_in = str(dwd_table or "").strip()
    tt_in = str(table_type or "").strip()
    phys: tuple[str, str, str] | None = None
    if dt_in:
        # 仅允许查询已接入 mapping 的表（避免任意 SQL 注入/误读）
        candidates = {t for t, _pk in _dwd_preview_target_tables(conn)}
        if dt_in not in candidates:
            return {
                "ok": False,
                "error": {"message": f"dwd_table={dt_in} 不可预览（未接入 mapping / 非单主键 / 缺 import_batch_id）"},
            }
        # 主键来自 mapping
        try:
            merged = load_merged_dwd_mapping()
        except Exception:
            return {"ok": False, "error": {"message": "加载 dwd_mapping 失败"}}
        tdef = (merged.get("tables") or {}).get(dt_in) if isinstance(merged.get("tables"), dict) else None
        pks = tdef.get("primary_key") if isinstance(tdef, dict) else None
        if not isinstance(pks, list) or len(pks) != 1 or not str(pks[0]).strip():
            return {"ok": False, "error": {"message": f"dwd_table={dt_in} 未配置单主键，无法分页"}}
        table = dt_in
        pk = str(pks[0]).strip()
        ly = _infer_layer_from_table(table)
        type_filter_sql = ""
        type_params: list[Any] = []
    elif tt_in:
        ok_tt, tmsg = _validate_dwd_table_type_code(tt_in)
        if not ok_tt:
            return {"ok": False, "error": {"message": tmsg}}
        phys = _dwd_phys_for_table_type(tt_in)
        if not phys:
            return {
                "ok": False,
                "error": {"message": f"table_type={tt_in} 尚未接入 DWD 预览（未在 dwd_mapping 中找到可解析映射）"},
            }

    if phys:
        table, pk, seg = phys
        ly = "header" if table == "dwd_inv_header" else "detail"
        type_filter_sql = " AND strpos(CAST(source_parquet_file AS VARCHAR), ?) > 0"
        type_params: list[Any] = [f"表类型={seg}"]
    elif not dt_in:
        ly = str(layer or "detail").strip().lower()
        if ly not in {"header", "detail"}:
            return {"ok": False, "error": {"message": "layer 须为 header 或 detail"}}
        table = "dwd_inv_header" if ly == "header" else "dwd_inv_detail"
        pk = "header_uuid" if ly == "header" else "detail_uuid"
        type_filter_sql = ""
        type_params = []

    lim = int(limit or 200)
    if lim < 1:
        lim = 1
    if lim > 500:
        lim = 500

    base_where: list[str] = ["import_batch_id = ?"]
    base_params: list[Any] = [bid]
    if sid:
        base_where.append("import_session_id = ?")
        base_params.append(sid)
    base_where_sql = " AND ".join(base_where) + type_filter_sql
    row_filter_params: list[Any] = list(base_params) + type_params

    pk_val: str | None = None
    if cursor and isinstance(cursor, dict):
        raw = cursor.get("pk") or cursor.get(pk)
        if raw is not None and str(raw).strip():
            pk_val = str(raw).strip()

    q_where = base_where_sql
    fetch_params: list[Any] = list(row_filter_params)
    if pk_val:
        q_where += f" AND {pk} > ?"
        fetch_params.append(pk_val)

    sql = f"SELECT * FROM {table} WHERE {q_where} ORDER BY {pk} ASC LIMIT ?"
    fetch_params.append(lim + 1)

    try:
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM {table} WHERE {base_where_sql}", row_filter_params).fetchone()[0]
        )
    except Exception:
        total = None

    try:
        df = conn.execute(sql, fetch_params).fetchdf()
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": f"查询 {table} 失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    has_more = len(df) > lim
    if has_more:
        df = df.iloc[:lim]

    rows = _df_to_row_dicts(df)
    next_cursor: dict[str, str] | None = None
    if has_more and rows:
        last_pk = rows[-1].get(pk, "")
        if last_pk:
            next_cursor = {"pk": last_pk}

    label_map = _dwd_column_label_maps().get(table, {})
    columns = [{"field": str(c), "label_zh": label_map.get(str(c), "")} for c in df.columns]

    out: dict[str, Any] = {
        "ok": True,
        "batch_id": bid,
        "session_id": sid,
        "layer": ly,
        "table": table,
        "primary_key": pk,
        "columns": columns,
        "rows": rows,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "total_rows": total,
        "limit": lim,
    }
    if tt_in:
        out["table_type"] = tt_in
    if dt_in:
        out["dwd_table"] = dt_in
    return out


def delete_dwd_load_session(conn: Any, *, batch_id: str, session_id: str) -> dict[str, Any]:
    """删除指定导入会话在 DWD 中的行，并将该会话的 DWD 水位置空（便于后续重新增量构建）。"""
    ok_b, bid = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok_b:
        return {"ok": False, "error": {"message": bid}}
    ok_s, sid = _validate_ods_identifier(session_id, label="session_id")
    if not ok_s:
        return {"ok": False, "error": {"message": sid}}

    try:
        n_log = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM ods_load_log WHERE import_batch_id = ? AND import_session_id = ?",
                [bid, sid],
            ).fetchone()[0]
        )
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "校验 ods_load_log 失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }
    if n_log == 0:
        return {"ok": False, "error": {"message": "ods_load_log 中无该批次与会话记录", "code": "session_not_found"}}

    # 兼容旧库：部分历史 DWD 行 import_session_id 为空（NULL/空串）。
    # 运维删除路径用 source_parquet_file 兜底匹配 `会话=<sid>`，避免删不干净导致“已删除但行数不变”的错觉。
    sess_needle = f"会话={sid}"
    try:
        from db.schema_sqlfiles import init_all_tables

        deleted_by_table: dict[str, int] = {}
        for table, pk in _dwd_sort_tables_header_last(_dwd_preview_target_tables(conn)):
            deleted_by_table[table] = _delete_rows_by_session_batched(
                conn,
                table=table,
                pk=pk,
                import_batch_id=bid,
                import_session_id=sid,
                sess_needle=sess_needle,
            )
        init_all_tables(conn)
        conn.execute(
            """
            UPDATE ods_load_log
            SET dwd_session_processed_at = NULL
            WHERE import_batch_id = ? AND import_session_id = ?
            """,
            [bid, sid],
        )
    except Exception as exc:
        _close_conn_if_duckdb_unusable(exc)
        return {
            "ok": False,
            "error": {
                "message": "删除 DWD 行或重置水位失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    return {
        "ok": True,
        "scope": "session",
        "batch_id": bid,
        "session_id": sid,
        "deleted_rows_by_table": deleted_by_table,
    }


def delete_dwd_load_batch(conn: Any, *, batch_id: str) -> dict[str, Any]:
    """删除整个导入批次在 DWD 中的全部行，并将该批次下所有会话的 DWD 水位置空。"""
    ok_b, bid = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok_b:
        return {"ok": False, "error": {"message": bid}}

    try:
        n_log = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM ods_load_log WHERE import_batch_id = ?",
                [bid],
            ).fetchone()[0]
        )
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "校验 ods_load_log 失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }
    if n_log == 0:
        return {"ok": False, "error": {"message": "ods_load_log 中无该批次记录", "code": "batch_not_found"}}

    try:
        from db.schema_sqlfiles import init_all_tables

        deleted_by_table: dict[str, int] = {}
        for table, pk in _dwd_sort_tables_header_last(_dwd_preview_target_tables(conn)):
            deleted_by_table[table] = _delete_rows_by_batch_batched(
                conn, table=table, pk=pk, import_batch_id=bid
            )
        init_all_tables(conn)
        conn.execute(
            """
            UPDATE ods_load_log
            SET dwd_session_processed_at = NULL
            WHERE import_batch_id = ?
            """,
            [bid],
        )
    except Exception as exc:
        _close_conn_if_duckdb_unusable(exc)
        return {
            "ok": False,
            "error": {
                "message": "删除 DWD 行或重置水位失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    return {
        "ok": True,
        "scope": "batch",
        "batch_id": bid,
        "deleted_rows_by_table": deleted_by_table,
        "ods_sessions_reset": int(n_log),
    }
