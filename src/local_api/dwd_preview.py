"""
DWD 数据查看：从 DuckDB `dwd_inv_header` / `dwd_inv_detail` 按批次/会话分页抽样；
并提供仅删除 DWD 落库行、重置 `ods_load_log` DWD 水位的运维接口（不删 ODS、不重跑清洗）。
"""

from __future__ import annotations

import re
from typing import Any

from src.local_api.ods_preview import _df_to_row_dicts, _validate_ods_identifier, load_ods_tab_order_meta_for_dwd

_TABLE_TYPE_CODE_RE = re.compile(r"^[A-Za-z0-9_]+$")


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
    按主键小批次删除会话行，规避 DuckDB 在大批量条件 DELETE 时可能出现的
    `Failed to delete all rows from index` 异常。
    """
    where_sql = """
      import_batch_id = ?
      AND (
        import_session_id = ?
        OR (
          (import_session_id IS NULL OR trim(CAST(import_session_id AS VARCHAR)) = '')
          AND strpos(CAST(source_parquet_file AS VARCHAR), ?) > 0
        )
      )
    """
    params = [import_batch_id, import_session_id, sess_needle]
    deleted = 0
    step = max(1, int(batch_size))
    while True:
        ids = conn.execute(
            f"SELECT {pk} FROM {table} WHERE {where_sql} LIMIT ?",
            [*params, step],
        ).fetchall()
        keys = [str(r[0]) for r in ids if r and r[0] is not None and str(r[0]).strip()]
        if not keys:
            break
        qs = ",".join(["?"] * len(keys))
        conn.execute(f"DELETE FROM {table} WHERE {pk} IN ({qs})", keys)
        deleted += len(keys)
    return deleted


def _validate_dwd_table_type_code(raw: str | None) -> tuple[bool, str]:
    s = str(raw or "").strip()
    if not s:
        return False, "table_type 不能为空"
    if len(s) > 120 or not _TABLE_TYPE_CODE_RE.match(s):
        return False, "table_type 非法"
    return True, s


def _dwd_phys_for_table_type(table_type: str) -> tuple[str, str, str] | None:
    """(duckdb_table, pk_column, path_segment) — path_segment 用于匹配 source_parquet_file 中的 表类型=…"""
    if table_type == "inv_header":
        return ("dwd_inv_header", "header_uuid", "inv_header")
    if table_type == "inv_detail":
        return ("dwd_inv_detail", "detail_uuid", "inv_detail")
    return None


def list_dwd_preview_tabs(conn: Any, *, batch_id: str, session_id: str | None = None) -> dict[str, Any]:
    """
    与 ODS 本会话/整批的表类型顺序一致；仅列出当前 DWD 中按 source_parquet_file 血缘可匹配且行数 > 0 的 Tab。
    当前清洗管线仅写入 inv_header / inv_detail，其余 ODS 类型不会出现 Tab。
    """
    meta = load_ods_tab_order_meta_for_dwd(conn, batch_id=batch_id, session_id=session_id)
    if not meta.get("ok"):
        return meta

    bid = str(meta["batch_id"])
    sid = str(meta.get("session_id") or "")
    warnings: list[str] = list(meta.get("warnings") or [])
    tabs: list[dict[str, Any]] = []

    for item in meta.get("tab_order_meta") or []:
        tt = str(item.get("table_type") or "").strip()
        title = str(item.get("title") or tt).strip() or tt
        phys = _dwd_phys_for_table_type(tt)
        if not phys:
            continue
        dwd_table, _pk, seg = phys
        needle = f"表类型={seg}"
        base_where: list[str] = ["import_batch_id = ?"]
        base_params: list[Any] = [bid]
        if sid:
            base_where.append("import_session_id = ?")
            base_params.append(sid)
        base_where_sql = " AND ".join(base_where)
        sql_cnt = (
            f"SELECT COUNT(*)::BIGINT FROM {dwd_table} "
            f"WHERE {base_where_sql} AND strpos(CAST(source_parquet_file AS VARCHAR), ?) > 0"
        )
        try:
            cnt = int(conn.execute(sql_cnt, base_params + [needle]).fetchone()[0] or 0)
        except Exception as exc:
            warnings.append(f"{title}: DWD 计数失败（{type(exc).__name__}）")
            continue
        if cnt <= 0:
            continue
        ly = "header" if dwd_table == "dwd_inv_header" else "detail"
        tabs.append({"table_type": tt, "title": title, "layer": ly, "row_count": cnt})

    return {"ok": True, "batch_id": bid, "session_id": sid, "tabs": tabs, "warnings": warnings}


def load_dwd_preview_table_page(
    conn: Any,
    *,
    batch_id: str,
    session_id: str | None = None,
    layer: str = "detail",
    table_type: str | None = None,
    limit: int = 200,
    cursor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    按 import_batch_id（及可选 import_session_id）筛选 DWD 表，按主键递增分页。

    - table_type: 若指定 ``inv_header`` / ``inv_detail``，则按 ``source_parquet_file`` 中的 ``表类型=…`` 过滤，
      与 ODS Tab 对齐；优先于 layer。
    - layer: ``header`` → dwd_inv_header / header_uuid；``detail`` → dwd_inv_detail / detail_uuid（无 table_type 时）
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

    tt_in = str(table_type or "").strip()
    phys: tuple[str, str, str] | None = None
    if tt_in:
        ok_tt, tmsg = _validate_dwd_table_type_code(tt_in)
        if not ok_tt:
            return {"ok": False, "error": {"message": tmsg}}
        phys = _dwd_phys_for_table_type(tt_in)
        if not phys:
            return {
                "ok": False,
                "error": {"message": f"table_type={tt_in} 尚未接入 DWD 预览（当前仅支持 inv_header / inv_detail）"},
            }

    if phys:
        table, pk, seg = phys
        ly = "header" if table == "dwd_inv_header" else "detail"
        type_filter_sql = " AND strpos(CAST(source_parquet_file AS VARCHAR), ?) > 0"
        type_params: list[Any] = [f"表类型={seg}"]
    else:
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

    columns = [{"field": str(c), "label_zh": str(c)} for c in df.columns]

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
        nh = _delete_rows_by_session_batched(
            conn,
            table="dwd_inv_header",
            pk="header_uuid",
            import_batch_id=bid,
            import_session_id=sid,
            sess_needle=sess_needle,
        )
        nd = _delete_rows_by_session_batched(
            conn,
            table="dwd_inv_detail",
            pk="detail_uuid",
            import_batch_id=bid,
            import_session_id=sid,
            sess_needle=sess_needle,
        )
        conn.execute(
            """
            UPDATE ods_load_log
            SET dwd_session_processed_at = NULL
            WHERE import_batch_id = ? AND import_session_id = ?
            """,
            [bid, sid],
        )
    except Exception as exc:
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
        "deleted_header_rows": nh,
        "deleted_detail_rows": nd,
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
        nh = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM dwd_inv_header WHERE import_batch_id = ?",
                [bid],
            ).fetchone()[0]
        )
        nd = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM dwd_inv_detail WHERE import_batch_id = ?",
                [bid],
            ).fetchone()[0]
        )
        conn.execute("DELETE FROM dwd_inv_header WHERE import_batch_id = ?", [bid])
        conn.execute("DELETE FROM dwd_inv_detail WHERE import_batch_id = ?", [bid])
        conn.execute(
            """
            UPDATE ods_load_log
            SET dwd_session_processed_at = NULL
            WHERE import_batch_id = ?
            """,
            [bid],
        )
    except Exception as exc:
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
        "deleted_header_rows": nh,
        "deleted_detail_rows": nd,
        "ods_sessions_reset": int(n_log),
    }
