"""
ODS 数据预览 API 支撑：从 DuckDB `ods_load_log` 取批次/会话元数据，从 Parquet 抽样行。
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any

from config.field_mapping import get_field_mapping_config_info
from config.sheet_mapping import SHEET_MAPPING
from config.table_type_labels import TABLE_TYPE_LABELS


def _safe_int(v: Any) -> int | None:
    try:
        if v is None:
            return None
        n = int(v)
        return n
    except Exception:
        return None


def _cursor_where_clause(
    *,
    cursor: dict[str, Any] | None,
    keyset_exprs: list[tuple[str, str]],
) -> tuple[str, list[Any]]:
    """
    Keyset pagination where clause for lexicographic order.
    cursor payload:
      { file, sheet, seq, key, ts }
    """
    if not cursor or not keyset_exprs:
        return "", []

    cursor_vals: dict[str, Any] = {}
    has_any = False
    for name, _ in keyset_exprs:
        if name == "seq":
            v = _safe_int(cursor.get("seq"))
            cursor_vals[name] = int(v or 0)
            if v is not None:
                has_any = True
        else:
            v = str(cursor.get(name) or "")
            cursor_vals[name] = v
            if v:
                has_any = True
    if not has_any:
        return "", []

    # Lexicographic (k1, k2, ..., kn) > cursor
    # Expand to OR chain to avoid tuple comparisons:
    # (k1>?) OR (k1=? AND k2>?) OR ...
    clauses: list[str] = []
    params: list[Any] = []
    for i in range(len(keyset_exprs)):
        and_parts: list[str] = []
        for j in range(i):
            nmj, exprj = keyset_exprs[j]
            and_parts.append(f"({exprj} = ?)")
            params.append(cursor_vals.get(nmj))
        nmi, expri = keyset_exprs[i]
        and_parts.append(f"({expri} > ?)")
        params.append(cursor_vals.get(nmi))
        clauses.append("(" + " AND ".join(and_parts) + ")")

    return "WHERE " + " OR ".join(clauses), params


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _effective_ods_dir() -> str:
    """与 sheet_mapping_server / excel_to_ods 默认 ODS 根目录一致。"""
    env = (os.getenv("INVOICELENS_ODS_DIR") or "").strip()
    if env:
        return env
    return str(_project_root() / "data" / "ods")


def _effective_ods_raw_dir() -> str:
    """与 excel_to_ods 默认 ODS_RAW 根目录一致。"""
    env = (os.getenv("INVOICELENS_ODS_RAW_DIR") or "").strip()
    if env:
        return env
    return str(_project_root() / "data" / "ods_raw")


def _validate_ods_identifier(raw: str | None, *, label: str) -> tuple[bool, str]:
    """防止路径穿越；batch_id / session_id 仅允许单行文本。"""
    s = str(raw or "").strip()
    if not s:
        return False, f"{label} 不能为空"
    if len(s) > 512:
        return False, f"{label} 过长"
    if ".." in s or "/" in s or "\\" in s or "\x00" in s:
        return False, f"{label} 含有非法字符"
    return True, s


def _parse_parquet_paths(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except Exception:
        return []
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for x in v:
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
    return out


def _table_type_from_parquet_path(p: str) -> str | None:
    try:
        path = Path(p)
    except Exception:
        return None
    for parent in path.parents:
        name = parent.name
        if name.startswith("表类型="):
            return name.split("=", 1)[-1].strip() or None
    return None


def _primary_sheet_cn_for_table_type(table_type: str) -> str:
    """
    Tab 标题：与 sheet_mapping.yaml 中该 table_type **首次出现** 的 Sheet 中文名一致。
    YAML 未覆盖的类型回退 TABLE_TYPE_LABELS / code。
    """
    for sheet_cn, tt in SHEET_MAPPING.items():
        if tt == table_type:
            s = (str(sheet_cn) if sheet_cn is not None else "").strip()
            return s or str(table_type)
    return (TABLE_TYPE_LABELS.get(table_type) or table_type or "unknown").strip() or str(table_type)


def _tab_title_for_table_type(table_type: str, used: set[str]) -> str:
    base = _primary_sheet_cn_for_table_type(table_type)
    title = base
    if title in used:
        title = f"{base}（{table_type}）"
    used.add(title)
    return title


def _ordered_table_types_present(by_type: dict[str, list[Any]]) -> list[str]:
    """
    本批次 Parquet 中出现的 table_type，按 sheet_mapping.yaml 文件中的条目顺序排列
    （每种类型取 YAML 中第一次映射到它的位置）；YAML 未声明的 code 按字典序附后。
    """
    ordered: list[str] = []
    seen: set[str] = set()
    for _sk, tt in SHEET_MAPPING.items():
        if not isinstance(tt, str) or not tt.strip():
            continue
        ttn = tt.strip()
        if ttn in by_type and ttn not in seen:
            ordered.append(ttn)
            seen.add(ttn)
    extra = sorted(k for k in by_type.keys() if k not in seen)
    return ordered + extra


def tab_order_meta_from_parquet_paths(paths: list[str]) -> tuple[list[dict[str, str]], list[str]]:
    """
    由 ODS Parquet 路径列表得到与「ODS 数据预览」一致的 Tab 顺序与标题（仅依赖路径中的 表类型= 分区）。
    返回 (tab_order_meta, warnings)；paths 为空时 meta 为空并应在 warnings 中提示调用方。
    """
    warnings: list[str] = []
    if not paths:
        return [], ["该范围未记录任何 parquet_paths（可能导入未写出 ODS）"]

    by_type: dict[str, list[str]] = defaultdict(list)
    for p in paths:
        tt = _table_type_from_parquet_path(p)
        if tt:
            by_type[tt].append(p)

    used_titles: set[str] = set()
    tab_order_meta: list[dict[str, str]] = []
    for table_type in _ordered_table_types_present(by_type):
        title = _tab_title_for_table_type(table_type, used_titles)
        tab_order_meta.append({"title": title, "table_type": table_type})

    return tab_order_meta, warnings


def load_ods_tab_order_meta_for_dwd(
    conn: Any,
    *,
    batch_id: str,
    session_id: str | None = None,
) -> dict[str, Any]:
    """
    为 DWD 预览 Tab 提供与 ODS 一致的 table_type 顺序与中文标题。
    - 指定 session_id：仅该会话 ods_load_log.parquet_paths；
    - session_id 为空：该批次下所有会话路径合并（去重保序）。
    """
    ok, bid = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok:
        return {"ok": False, "error": {"message": bid}}

    sid = str(session_id or "").strip()
    paths: list[str] = []

    if sid:
        ok_s, smsg = _validate_ods_identifier(sid, label="session_id")
        if not ok_s:
            return {"ok": False, "error": {"message": smsg}}
        try:
            row = conn.execute(
                """
                SELECT parquet_paths
                FROM ods_load_log
                WHERE import_batch_id = ? AND import_session_id = ?
                LIMIT 1
                """,
                [bid, sid],
            ).fetchone()
        except Exception as exc:
            return {
                "ok": False,
                "error": {
                    "message": "查询会话失败",
                    "exception_type": type(exc).__name__,
                    "detail": str(exc),
                },
            }
        if not row:
            return {"ok": False, "error": {"message": "未找到该批次与会话对应的 ods_load_log 记录"}}
        paths = _parse_parquet_paths(str(row[0]) if row[0] is not None else None)
    else:
        try:
            rows = conn.execute(
                "SELECT parquet_paths FROM ods_load_log WHERE import_batch_id = ?",
                [bid],
            ).fetchall()
        except Exception as exc:
            return {
                "ok": False,
                "error": {
                    "message": "查询批次失败",
                    "exception_type": type(exc).__name__,
                    "detail": str(exc),
                },
            }
        for (raw_paths,) in rows:
            paths.extend(_parse_parquet_paths(str(raw_paths) if raw_paths is not None else None))
        seen: set[str] = set()
        uniq: list[str] = []
        for p in paths:
            if p not in seen:
                seen.add(p)
                uniq.append(p)
        paths = uniq

    tab_order_meta, warns = tab_order_meta_from_parquet_paths(paths)
    return {
        "ok": True,
        "batch_id": bid,
        "session_id": sid,
        "tab_order_meta": tab_order_meta,
        "warnings": warns,
    }


def _preferred_field_order(table_type: str) -> list[str]:
    cfg, _ = get_field_mapping_config_info()
    sheets = cfg.get("sheets") or {}
    for sk, tt in SHEET_MAPPING.items():
        if tt == table_type and sk in sheets and isinstance(sheets[sk], dict):
            return [str(k) for k in sheets[sk].keys()]
    df = cfg.get("default_fields") or {}
    if isinstance(df, dict):
        return [str(k) for k in df.keys()]
    return []


def _field_mapping_sheet_key_for_table_type(table_type: str) -> str | None:
    """
    数据预览 Tab 标题取 sheet_mapping.yaml 的“首次出现名”，但字段顺序/中文标签来自 field_mapping.yaml 的 sheets 块。
    某些类型可能存在多个 sheet key（如「发票基础数据」「发票基础信息」同映射 inv_header），而 field_mapping.yaml 只维护其中一个。
    这里返回“在 field_mapping.yaml.sheets 中实际存在”的那个 key，便于 UI 标注对齐关系。
    """
    cfg, _ = get_field_mapping_config_info()
    sheets = cfg.get("sheets") or {}
    if not isinstance(sheets, dict):
        return None
    for sk, tt in SHEET_MAPPING.items():
        if tt == table_type and sk in sheets and isinstance(sheets[sk], dict):
            return str(sk)
    return None


def _default_label_zh_only(cfg: dict[str, Any], fname: str) -> str:
    """仅从 default_fields 取 label_zh（API 形态：{ field: { label_zh, aliases } }）。"""
    df = cfg.get("default_fields") or {}
    if not isinstance(df, dict):
        return ""
    ent = df.get(fname)
    if isinstance(ent, dict):
        return str(ent.get("label_zh") or "").strip()
    return ""


def _field_labels_for_table_type(table_type: str, cfg: dict[str, Any] | None = None) -> dict[str, str]:
    """
    预览用中英表头：sheet 显式 label_zh 优先，否则继承 default 同名字段。
    注意：绝不能用英文字段名占位当「中文标签」，否则第二行会与第一行重复。
    """
    if cfg is None:
        cfg, _ = get_field_mapping_config_info()
    sheets = cfg.get("sheets") or {}
    labels: dict[str, str] = {}

    sheet_key = _field_mapping_sheet_key_for_table_type(table_type)

    if sheet_key and sheet_key in sheets and isinstance(sheets[sheet_key], dict):
        for fname, entry in sheets[sheet_key].items():
            fk = str(fname)
            lz_sheet = ""
            if isinstance(entry, dict):
                lz_sheet = str(entry.get("label_zh") or "").strip()
            merged = lz_sheet or _default_label_zh_only(cfg, fk)
            if merged:
                labels[fk] = merged

    df = cfg.get("default_fields") or {}
    if isinstance(df, dict):
        for fname, ent in df.items():
            fk = str(fname)
            if fk in labels:
                continue
            if isinstance(ent, dict):
                lz = str(ent.get("label_zh") or "").strip()
            else:
                lz = ""
            if lz:
                labels[fk] = lz

    return labels


def _order_columns(all_cols: list[str], preferred: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for p in preferred:
        if p in all_cols and p not in seen:
            out.append(p)
            seen.add(p)
    rest = sorted((c for c in all_cols if c not in seen), key=lambda x: x.lower())
    return out + rest


# 分区第三级目录现为 ods_file_seq=（见 excel_to_ods）；勿再用「序号=」以免与业务列「序号」在 hive 下同名列冲突。
_PREVIEW_META_FIELDS_ORDER = [
    # 由导入链路追加的溯源字段（Excel 之外）
    "source_excel_file",
    "source_sheet",
    "source_parquet_file",
    "ingest_ts",
    # hive partitioning 自动解析出的分区列（目录：批次/表类型/ods_file_seq）
    "批次",
    "表类型",
    "ods_file_seq",
]

# 预览表头：field_mapping 未覆盖的列（溯源/分区）补中文说明
_PREVIEW_FALLBACK_LABEL_ZH: dict[str, str] = {
    "source_excel_file": "来源 Excel 文件",
    "source_sheet": "来源 Sheet",
    "source_parquet_file": "来源 Parquet 文件",
    "ingest_ts": "导入时间",
    "批次": "批次（分区）",
    "表类型": "表类型（分区）",
    "ods_file_seq": "ODS 文件序号（分区）",
    # 历史数据：目录仍为 序号= 时 DuckDB 会解析出该列；与 Excel「序号」列同名冲突时数值可能错误，建议重导
    "序号": "序号（若与分区同名则可能为分区值，建议重导）",
}


def _preview_header_label_zh(field: str, label_map: dict[str, str], cfg: dict[str, Any]) -> str:
    f = str(field)
    lz = (label_map.get(f) or "").strip()
    if lz:
        return lz
    lz2 = _default_label_zh_only(cfg, f)
    if lz2:
        return lz2
    return _PREVIEW_FALLBACK_LABEL_ZH.get(f, f)


def _select_preview_columns(all_cols: list[str], preferred_sheet_fields: list[str]) -> list[str]:
    """
    标准预览列顺序：
    - **完整**按 field_mapping.yaml 对应 sheet 块的字段键顺序列出（与 Parquet 是否含该列无关；缺失列由调用方补空值）
    - 溯源/分区列仅追加 Parquet 中实际存在的（仍在固定顺序内）
    - 未配置 sheet 块（preferred 为空）时，回退为 Parquet 全列稳定排序
    """
    present = list(dict.fromkeys(str(c) for c in all_cols if str(c)))
    present_set = set(present)

    pref = [str(f).strip() for f in preferred_sheet_fields if str(f).strip()]
    if not pref:
        return _order_columns(present, [])

    ordered: list[str] = []
    for fs in pref:
        if fs not in ordered:
            ordered.append(fs)

    meta: list[str] = []
    for f in _PREVIEW_META_FIELDS_ORDER:
        if f in present_set and f not in ordered and f not in meta:
            meta.append(f)

    return ordered + meta


def _sql_escape_str(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _duck_sql_ident(name: str) -> str:
    s = str(name)
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", s):
        return s
    return '"' + s.replace('"', '""') + '"'


def _union_parquet_column_names(conn: Any, files_sql: str) -> set[str]:
    """LIMIT 0 探测 union_by_name 后的列集合，避免 ORDER BY 引用 Parquet 中不存在的列（汇总表等）。"""
    try:
        probe = f"SELECT * FROM read_parquet({files_sql}, union_by_name=true) LIMIT 0"
        df0 = conn.execute(probe).fetchdf()
        return {str(c) for c in df0.columns}
    except Exception:
        return set()


def _preview_keyset_sql_exprs(present: set[str]) -> list[tuple[str, str]]:
    """返回游标/排序使用的键表达式列表（仅包含实际存在的列）。"""
    if not present:
        return []

    def one_str(col: str) -> str:
        q = _duck_sql_ident(col)
        return f"COALESCE(CAST({q} AS VARCHAR), '')"

    out: list[tuple[str, str]] = []
    if "source_parquet_file" in present:
        out.append(("file", one_str("source_parquet_file")))
    if "source_sheet" in present:
        out.append(("sheet", one_str("source_sheet")))

    seq_parts: list[str] = []
    if "seq_no" in present:
        seq_parts.append("TRY_CAST(seq_no AS BIGINT)")
    zh_seq = "序号"
    if zh_seq in present:
        seq_parts.append(f"TRY_CAST({_duck_sql_ident(zh_seq)} AS BIGINT)")
    if seq_parts:
        out.append(("seq", "COALESCE(" + ", ".join(seq_parts + ["CAST(0 AS BIGINT)"]) + ")"))

    key_parts = [
        f"CAST({_duck_sql_ident(n)} AS VARCHAR)"
        for n in ("sdfphm", "invoice_no", "invoice_code")
        if n in present
    ]
    if key_parts:
        out.append(("key", "COALESCE(" + ", ".join(key_parts + ["''"]) + ")"))
    if "ingest_ts" in present:
        out.append(("ts", one_str("ingest_ts")))

    return out


def _read_union_parquet_sample(
    conn: Any,
    paths: list[str],
    row_limit: int,
    *,
    columns_hint: list[str] | None = None,
) -> Any:
    """使用 DuckDB read_parquet 做 union_by_name，避免把整批大文件读入 pandas。"""
    if row_limit < 1:
        row_limit = 1
    if row_limit > 5000:
        row_limit = 5000

    existing = [p for p in paths if Path(p).exists()]
    if not existing:
        raise FileNotFoundError("parquet 路径均不存在（可能已被清理）")

    files_sql = "[" + ", ".join(_sql_escape_str(p) for p in existing) + "]"
    # 性能优化：优先尝试让 DuckDB 只读取需要的列（减少 IO / 解压 / 转换开销）。
    # 注意：不同 parquet 文件列集合不完全一致时，columns 形参在某些 DuckDB 版本/场景可能不兼容；
    # 因此这里采用“先试 columns_hint，失败则回退全量读取”的策略，保证不影响可用性。
    sql = None
    if columns_hint:
        cols = [str(c).strip() for c in columns_hint if str(c).strip()]
        # 去重保持顺序
        dedup: list[str] = []
        seen = set()
        for c in cols:
            if c in seen:
                continue
            seen.add(c)
            dedup.append(c)
        if dedup:
            cols_sql = "[" + ", ".join(_sql_escape_str(c) for c in dedup) + "]"
            sql = (
                f"SELECT * FROM read_parquet({files_sql}, union_by_name=true, columns={cols_sql}) "
                f"LIMIT {int(row_limit)}"
            )
    if not sql:
        sql = f"SELECT * FROM read_parquet({files_sql}, union_by_name=true) LIMIT {int(row_limit)}"
    try:
        return conn.execute(sql).fetchdf()
    except Exception:
        # columns_hint 失败：回退到全量读取再裁剪（依旧比 pandas 合并更稳）
        if columns_hint:
            sql2 = f"SELECT * FROM read_parquet({files_sql}, union_by_name=true) LIMIT {int(row_limit)}"
            try:
                return conn.execute(sql2).fetchdf()
            except Exception:
                pass
        # 最终回退：逐文件 pandas 合并（列不一致时更慢但较稳）
        import pandas as pd

        chunks: list[Any] = []
        for p in existing:
            try:
                chunks.append(pd.read_parquet(p))
            except Exception:
                continue
        if not chunks:
            raise
        df = pd.concat(chunks, ignore_index=True, sort=False)
        return df.head(row_limit)


def _select_raw_preview_columns(all_cols: list[str]) -> list[str]:
    """raw 视图：尽量保持原始列顺序，仅把溯源/分区字段挪到最后。"""
    present = list(dict.fromkeys(str(c) for c in all_cols if str(c)))
    present_set = set(present)
    meta = [c for c in _PREVIEW_META_FIELDS_ORDER if c in present_set]
    core = [c for c in present if c not in meta]
    return core + meta


def _preview_invoice_date_str(s: str) -> str:
    """invoice_date 列统一展示为 YYYY-MM-DD（截断 T/空格后的时间部分）。"""
    t = s.strip()
    if len(t) >= 10 and t[4] == "-" and t[7] == "-":
        head = t[:10]
        if head.replace("-", "").isdigit():
            return head
    return t


def _df_to_row_dicts(df: Any) -> list[dict[str, str]]:
    import datetime as dt
    import numpy as np
    import pandas as pd

    rows: list[dict[str, str]] = []
    for _, row in df.iterrows():
        rec: dict[str, str] = {}
        for col in df.columns:
            key = str(col)
            v = row[col]
            if pd.isna(v):
                rec[key] = ""
            else:
                try:
                    if isinstance(v, dt.time):
                        rec[key] = v.strftime("%H:%M:%S")
                    elif isinstance(v, pd.Timestamp):
                        ts = v
                        if (
                            ts.hour == 0
                            and ts.minute == 0
                            and ts.second == 0
                            and getattr(ts, "microsecond", 0) == 0
                        ):
                            rec[key] = ts.strftime("%Y-%m-%d")
                        else:
                            rec[key] = ts.strftime("%Y-%m-%d %H:%M:%S")
                    elif isinstance(v, np.datetime64):
                        ts = pd.Timestamp(v)
                        if (
                            ts.hour == 0
                            and ts.minute == 0
                            and ts.second == 0
                            and getattr(ts, "microsecond", 0) == 0
                        ):
                            rec[key] = ts.strftime("%Y-%m-%d")
                        else:
                            rec[key] = ts.strftime("%Y-%m-%d %H:%M:%S")
                    elif isinstance(v, dt.datetime):
                        if (
                            v.hour == 0
                            and v.minute == 0
                            and v.second == 0
                            and v.microsecond == 0
                        ):
                            rec[key] = v.strftime("%Y-%m-%d")
                        else:
                            rec[key] = v.strftime("%Y-%m-%d %H:%M:%S")
                    elif isinstance(v, dt.date):
                        rec[key] = v.isoformat()
                    elif hasattr(v, "isoformat"):
                        rec[key] = v.isoformat()
                    else:
                        rec[key] = str(v)
                except Exception:
                    rec[key] = str(v)
            if key.lower() == "invoice_date" and rec[key]:
                rec[key] = _preview_invoice_date_str(rec[key])
        rows.append(rec)
    return rows


def _dwd_row_counts_by_import_session(conn: Any) -> tuple[dict[tuple[str, str], int], dict[tuple[str, str], int]]:
    """按 (import_batch_id, import_session_id) 汇总 DWD 行数，供批次列表按会话展示。"""
    hdr: dict[tuple[str, str], int] = {}
    dtl: dict[tuple[str, str], int] = {}
    try:
        for bid, sid, n in conn.execute(
            """
            SELECT import_batch_id, COALESCE(import_session_id, ''), COUNT(*)::BIGINT
            FROM dwd_inv_header
            GROUP BY 1, 2
            """
        ).fetchall():
            hdr[(str(bid or ""), str(sid or ""))] = int(n or 0)
    except Exception:
        pass
    try:
        for bid, sid, n in conn.execute(
            """
            SELECT import_batch_id, COALESCE(import_session_id, ''), COUNT(*)::BIGINT
            FROM dwd_inv_detail
            GROUP BY 1, 2
            """
        ).fetchall():
            dtl[(str(bid or ""), str(sid or ""))] = int(n or 0)
    except Exception:
        pass
    return hdr, dtl


def list_ods_preview_batches(conn: Any, *, limit: int = 80) -> dict[str, Any]:
    lim = max(1, min(int(limit), 200))
    try:
        df = conn.execute(
            f"""
            SELECT import_batch_id, import_session_id, load_time,
                   file_count, total_rows, success_count, fail_count, warn_count,
                   parquet_paths, dwd_session_processed_at
            FROM ods_load_log
            ORDER BY load_time DESC
            LIMIT {lim}
            """
        ).fetchdf()
    except Exception as exc:
        return {
            "ok": False,
            "ods_dir_hint": _effective_ods_dir(),
            "error": {
                "message": "查询 ods_load_log 失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    import pandas as pd

    hdr_sess, dtl_sess = _dwd_row_counts_by_import_session(conn)

    batches: list[dict[str, Any]] = []
    for _, r in df.iterrows():
        raw_paths = r.get("parquet_paths")
        paths = _parse_parquet_paths(str(raw_paths) if raw_paths is not None and not pd.isna(raw_paths) else None)
        lt = r.get("load_time")
        if lt is not None and hasattr(lt, "isoformat"):
            load_iso = lt.isoformat()
        else:
            load_iso = str(lt or "")
        dw_at = r.get("dwd_session_processed_at")
        if dw_at is not None and hasattr(dw_at, "isoformat"):
            dwd_proc_iso = dw_at.isoformat()
        else:
            dwd_proc_iso = str(dw_at or "")
        bid = str(r.get("import_batch_id") or "")
        sid = str(r.get("import_session_id") or "")
        sess_key = (bid, sid)

        batches.append(
            {
                "batch_id": bid,
                "session_id": sid,
                "load_time": load_iso,
                "dwd_session_processed_at": dwd_proc_iso,
                "file_count": int(r.get("file_count") or 0),
                "total_rows": int(r.get("total_rows") or 0),
                "success_count": int(r.get("success_count") or 0),
                "fail_count": int(r.get("fail_count") or 0),
                "warn_count": int(r.get("warn_count") or 0),
                "parquet_path_count": len(paths),
                "dwd_header_rows": int(hdr_sess.get(sess_key, 0)),
                "dwd_detail_rows": int(dtl_sess.get(sess_key, 0)),
            }
        )

    return {"ok": True, "batches": batches, "ods_dir_hint": _effective_ods_dir()}


def load_ods_import_session_summary(
    conn: Any,
    *,
    batch_id: str,
    session_id: str,
    sample_limit: int = 30,
) -> dict[str, Any]:
    """读取导入会话的格式检测快照（字段映射模板）与失败/拒收聚合（只读）。"""
    b = str(batch_id or "").strip()
    s = str(session_id or "").strip()
    if not b or not s:
        return {"ok": False, "error": {"message": "batch_id 与 session_id 均不能为空"}}

    try:
        from src.local_api.data_quality import (
            _fetch_ods_import_file_logs,
            _fetch_ods_import_template_meta,
            _summarize_lineage_reject,
        )

        file_logs, fetch_err = _fetch_ods_import_file_logs(conn, batch_id=b, session_id=s)
        template_meta = _fetch_ods_import_template_meta(conn, batch_id=b, session_id=s)
        failure_summary = _summarize_lineage_reject(file_logs)

        fail_files: list[dict[str, Any]] = []
        reject_samples: list[dict[str, Any]] = []
        reject_ranges: list[dict[str, Any]] = []
        lim = max(1, min(int(sample_limit or 30), 100))

        for log in file_logs:
            status = str(log.get("status") or "")
            blocking = bool(log.get("file_blocking"))
            if blocking or status in {"失败", "failed", "失败(阻断)"}:
                fail_files.append(
                    {
                        "file_name": str(log.get("file_name") or log.get("source_excel_file") or ""),
                        "status": status or ("阻断" if blocking else "失败"),
                        "file_blocking": blocking,
                        "reason": str(log.get("reason") or log.get("detail") or ""),
                        "exception_type": str(log.get("exception_type") or "") or None,
                    }
                )
            for sample in log.get("reject_row_samples") or []:
                if not isinstance(sample, dict) or len(reject_samples) >= lim:
                    continue
                reject_samples.append(
                    {
                        "seq_no": sample.get("seq_no"),
                        "sheet": str(sample.get("sheet") or ""),
                        "field": str(sample.get("field") or "") or None,
                        "reason": str(sample.get("reason") or ""),
                        "exception_type": str(sample.get("exception_type") or "") or None,
                        "source_excel_file": str(
                            log.get("source_excel_file") or log.get("file_name") or ""
                        )
                        or None,
                    }
                )
            for rng in log.get("reject_row_ranges") or []:
                if not isinstance(rng, dict) or len(reject_ranges) >= lim:
                    continue
                reject_ranges.append(
                    {
                        "seq_no_start": rng.get("seq_no_start"),
                        "seq_no_end": rng.get("seq_no_end"),
                        "reason": str(rng.get("reason") or ""),
                        "source_excel_file": str(
                            log.get("source_excel_file") or log.get("file_name") or ""
                        )
                        or None,
                    }
                )

        return {
            "ok": True,
            "batch_id": b,
            "session_id": s,
            "field_mapping_template": template_meta,
            "failure_summary": failure_summary,
            "fail_files": fail_files,
            "reject_row_samples": reject_samples,
            "reject_row_ranges": reject_ranges,
            "fetch_warning": fetch_err,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "读取导入会话摘要失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }


def load_ods_preview_session(
    conn: Any,
    *,
    batch_id: str,
    session_id: str,
    row_limit: int = 400,
    view: str = "std",
    meta_only: bool = False,
    only_table_type: str | None = None,
    include_counts: bool = False,
) -> dict[str, Any]:
    b = str(batch_id or "").strip()
    s = str(session_id or "").strip()
    if not b or not s:
        return {"ok": False, "error": {"message": "batch_id 与 session_id 均不能为空"}}

    try:
        row = conn.execute(
            """
            SELECT parquet_paths, detail_json, file_count, success_count, fail_count, warn_count, load_time
            FROM ods_load_log
            WHERE import_batch_id = ? AND import_session_id = ?
            LIMIT 1
            """,
            [b, s],
        ).fetchone()
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "查询会话失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    if not row:
        return {"ok": False, "error": {"message": "未找到该批次与会话对应的 ods_load_log 记录"}}

    raw_paths, detail_json, file_count, success_count, fail_count, warn_count, load_time = row
    paths: list[str] = []
    ods_dir_used = _effective_ods_dir()
    if str(view or "std").lower() == "raw":
        ods_dir_used = _effective_ods_raw_dir()
        try:
            detail = json.loads(str(detail_json) if detail_json is not None else "[]")
            if isinstance(detail, list):
                for item in detail:
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("import_session_id") or "").strip() != s:
                        continue
                    if str(item.get("import_batch_id") or "").strip() != b:
                        continue
                    paths.extend(
                        [
                            str(x)
                            for x in (item.get("written_raw_parquet_files") or [])
                            if isinstance(x, str) and str(x).strip()
                        ]
                    )
        except Exception:
            paths = []
    else:
        paths = _parse_parquet_paths(str(raw_paths) if raw_paths is not None else None)
    if not paths:
        return {
            "ok": True,
            "batch_id": b,
            "session_id": s,
            "view": "raw" if str(view or "std").lower() == "raw" else "std",
            "ods_dir_used": ods_dir_used,
            "load_time": load_time.isoformat() if hasattr(load_time, "isoformat") else str(load_time or ""),
            "file_count": int(file_count or 0),
            "success_count": int(success_count or 0),
            "fail_count": int(fail_count or 0),
            "warn_count": int(warn_count or 0),
            "row_limit_applied": int(min(max(row_limit, 1), 5000)),
            "tables": {},
            "tab_order": [],
            "warnings": [
                "raw 视图未记录任何 written_raw_parquet_files（可能该会话导入发生在开启 raw 落盘之前）"
                if str(view or "std").lower() == "raw"
                else "该会话未记录任何 parquet_paths（可能导入未写出 ODS）"
            ],
        }

    by_type: dict[str, list[str]] = defaultdict(list)
    for p in paths:
        tt = _table_type_from_parquet_path(p)
        if tt:
            by_type[tt].append(p)

    tables_out: dict[str, Any] = {}
    used_titles: set[str] = set()
    tab_order: list[str] = []
    tab_order_meta: list[dict[str, str]] = []
    warnings: list[str] = []

    rl = int(row_limit)
    if rl < 1:
        rl = 1
    if rl > 5000:
        rl = 5000

    # Tab 顺序与标题：仅依赖路径中的 table_type（无需读 parquet）
    title_by_type: dict[str, str] = {}
    for table_type in _ordered_table_types_present(by_type):
        title = _tab_title_for_table_type(table_type, used_titles)
        title_by_type[table_type] = title
        tab_order.append(title)
        tab_order_meta.append({"title": title, "table_type": table_type})

    # 仅取元信息（加速首屏）：不读取 parquet 行数据
    if meta_only:
        row_counts: dict[str, int] = {}
        if include_counts:
            # COUNT 可能仍有一定 IO；仅在前端明确需要时计算
            only_tt = (str(only_table_type).strip() if only_table_type is not None else "").strip()
            types = [only_tt] if only_tt else _ordered_table_types_present(by_type)
            for table_type in types:
                plist = by_type.get(table_type) or []
                existing = [p for p in plist if Path(p).exists()]
                if not existing:
                    row_counts[table_type] = 0
                    continue
                files_sql = "[" + ", ".join(_sql_escape_str(str(p)) for p in existing) + "]"
                try:
                    n = conn.execute(
                        f"SELECT COUNT(*) AS n FROM read_parquet({files_sql}, union_by_name=true)"
                    ).fetchone()
                    row_counts[table_type] = int(n[0] or 0) if n else 0
                except Exception:
                    # COUNT 失败不影响首屏
                    continue
        return {
            "ok": True,
            "batch_id": b,
            "session_id": s,
            "view": "raw" if str(view or "std").lower() == "raw" else "std",
            "ods_dir_used": ods_dir_used,
            "load_time": load_time.isoformat() if hasattr(load_time, "isoformat") else str(load_time or ""),
            "file_count": int(file_count or 0),
            "success_count": int(success_count or 0),
            "fail_count": int(fail_count or 0),
            "warn_count": int(warn_count or 0),
            "row_limit_applied": rl,
            "tables": {},
            "tab_order": tab_order,
            "tab_order_meta": tab_order_meta,
            "row_counts": row_counts,
            "warnings": warnings,
        }

    only_tt = (str(only_table_type).strip() if only_table_type is not None else "").strip()
    if only_tt:
        # 仅加载某一个 table_type（用于前端 Tab 懒加载）
        wanted = {only_tt}
    else:
        wanted = None

    for table_type in _ordered_table_types_present(by_type):
        if wanted is not None and table_type not in wanted:
            continue
        plist = by_type.get(table_type) or []
        title = title_by_type.get(table_type) or _tab_title_for_table_type(table_type, used_titles)
        columns_hint: list[str] | None = None
        if str(view or "std").lower() != "raw":
            # 标准视图：优先只读取“映射字段 + 溯源/分区字段”，减少 Parquet IO
            pref_hint = _preferred_field_order(table_type)
            columns_hint = list(pref_hint) + list(_PREVIEW_META_FIELDS_ORDER)
        try:
            df = _read_union_parquet_sample(conn, plist, rl, columns_hint=columns_hint)
        except Exception as exc:
            warnings.append(f"{title}: 读取 Parquet 失败（{type(exc).__name__}）")
            continue

        if df is None or len(df) == 0:
            continue

        cols = [str(c) for c in df.columns]
        pref = _preferred_field_order(table_type)
        if str(view or "std").lower() == "raw":
            ordered = _select_raw_preview_columns(cols)
            df = df[[c for c in ordered if c in df.columns]]
        else:
            ordered = _select_preview_columns(cols, pref)
            import pandas as pd

            if pref:
                # 按 field_mapping sheet 全量字段展示：Parquet 未写入的列补空（避免“只显示少数几列”）
                for c in ordered:
                    if c not in df.columns:
                        df[c] = pd.NA
                df = df[ordered]
            else:
                df = df[[c for c in ordered if c in df.columns]]

        cfg_fm, _ = get_field_mapping_config_info()
        label_map = _field_labels_for_table_type(table_type, cfg_fm)
        columns = [{"field": c, "label_zh": _preview_header_label_zh(c, label_map, cfg_fm)} for c in ordered]
        rows = _df_to_row_dicts(df)

        tables_out[title] = {
            "table_type": table_type,
            "parquet_files": len([x for x in plist if Path(x).exists()]),
            "field_mapping_sheet_key": _field_mapping_sheet_key_for_table_type(table_type),
            "columns": columns,
            "rows": rows,
        }

    return {
        "ok": True,
        "batch_id": b,
        "session_id": s,
        "view": "raw" if str(view or "std").lower() == "raw" else "std",
        "ods_dir_used": ods_dir_used,
        "load_time": load_time.isoformat() if hasattr(load_time, "isoformat") else str(load_time or ""),
        "file_count": int(file_count or 0),
        "success_count": int(success_count or 0),
        "fail_count": int(fail_count or 0),
        "warn_count": int(warn_count or 0),
        "row_limit_applied": rl,
        "tables": tables_out,
        "tab_order": tab_order,
        "tab_order_meta": tab_order_meta,
        "warnings": warnings,
    }


def load_ods_preview_table_page(
    conn: Any,
    *,
    batch_id: str,
    session_id: str,
    table_type: str,
    limit: int = 200,
    cursor: dict[str, Any] | None = None,
    view: str = "std",
) -> dict[str, Any]:
    """
    单表按游标分页预览：
    - order by: source_parquet_file, source_sheet, seq_num, key_str, ingest_ts
    - cursor 为上一页最后一行的上述 key，取严格大于 cursor 的下一页
    """
    b = str(batch_id or "").strip()
    s = str(session_id or "").strip()
    tt = str(table_type or "").strip()
    if not b or not s or not tt:
        return {"ok": False, "error": {"message": "batch_id / session_id / table_type 不能为空"}}

    lim = int(limit or 200)
    if lim < 1:
        lim = 1
    if lim > 1000:
        lim = 1000

    # fetch parquet paths for this session/table_type
    try:
        row = conn.execute(
            """
            SELECT parquet_paths, detail_json
            FROM ods_load_log
            WHERE import_batch_id = ? AND import_session_id = ?
            LIMIT 1
            """,
            [b, s],
        ).fetchone()
    except Exception as exc:
        return {
            "ok": False,
            "error": {"message": "查询会话失败", "exception_type": type(exc).__name__, "detail": str(exc)},
        }
    if not row:
        return {"ok": False, "error": {"message": "未找到该会话"}}

    raw_paths, detail_json = row
    paths: list[str] = []
    if str(view or "std").lower() == "raw":
        try:
            detail = json.loads(str(detail_json) if detail_json is not None else "[]")
            if isinstance(detail, list):
                for item in detail:
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("import_session_id") or "").strip() != s:
                        continue
                    if str(item.get("import_batch_id") or "").strip() != b:
                        continue
                    paths.extend(
                        [str(x) for x in (item.get("written_raw_parquet_files") or []) if isinstance(x, str) and x]
                    )
        except Exception:
            paths = []
    else:
        paths = _parse_parquet_paths(str(raw_paths) if raw_paths is not None else None)

    by_type: dict[str, list[str]] = defaultdict(list)
    for p in paths:
        t2 = _table_type_from_parquet_path(p)
        if t2:
            by_type[t2].append(p)
    plist = by_type.get(tt) or []
    existing = [p for p in plist if Path(p).exists()]
    if not existing:
        return {"ok": True, "batch_id": b, "session_id": s, "table_type": tt, "columns": [], "rows": [], "has_more": False}

    # column selection
    cfg_fm, _ = get_field_mapping_config_info()
    label_map = _field_labels_for_table_type(tt, cfg_fm)

    # Determine preferred order for std view
    preferred = _preferred_field_order(tt) if str(view or "std").lower() != "raw" else []
    # Always request ordering columns (if present) to compute cursor
    ordering_cols = ["source_parquet_file", "source_sheet", "ingest_ts", "seq_no", "序号", "invoice_no", "invoice_code", "sdfphm"]
    if str(view or "std").lower() == "raw":
        columns_hint = ordering_cols
    else:
        columns_hint = list(dict.fromkeys(list(preferred) + list(_PREVIEW_META_FIELDS_ORDER) + ordering_cols))

    files_sql = "[" + ", ".join(_sql_escape_str(str(p)) for p in existing) + "]"

    present_cols = _union_parquet_column_names(conn, files_sql)
    keyset_exprs = _preview_keyset_sql_exprs(present_cols)

    if present_cols:
        columns_hint = [c for c in columns_hint if c in present_cols]

    cols_sql = ""
    if columns_hint:
        cols_sql = "[" + ", ".join(_sql_escape_str(str(c)) for c in columns_hint) + "]"

    where_sql, params = _cursor_where_clause(
        cursor=cursor,
        keyset_exprs=keyset_exprs,
    )

    # Fetch lim+1 to determine has_more
    order_sql = ""
    if keyset_exprs:
        order_sql = " ORDER BY " + ", ".join(expr for _, expr in keyset_exprs)
    order_tail = f"{where_sql}{order_sql} LIMIT {lim + 1}"
    sql_full = f"SELECT * FROM read_parquet({files_sql}, union_by_name=true) {order_tail}"
    df = None
    if df is None:
        try:
            df = conn.execute(sql_full, params).fetchdf()
        except Exception as exc2:
            return {
                "ok": False,
                "error": {
                    "message": "读取 Parquet 分页失败",
                    "exception_type": type(exc2).__name__,
                    "detail": str(exc2),
                    "detail_fallback": "",
                },
            }

    if df is None or len(df) == 0:
        return {"ok": True, "batch_id": b, "session_id": s, "table_type": tt, "columns": [], "rows": [], "has_more": False}

    has_more = len(df) > lim
    if has_more:
        df = df.head(lim)

    # Select output columns (std: full mapping order; raw: keep original order, meta at end)
    cols = [str(c) for c in df.columns]
    if str(view or "std").lower() == "raw":
        ordered = _select_raw_preview_columns(cols)
        df = df[[c for c in ordered if c in df.columns]]
    else:
        ordered = _select_preview_columns(cols, preferred)
        import pandas as pd
        for c in ordered:
            if c not in df.columns:
                df[c] = pd.NA
        df = df[ordered]

    columns = [{"field": c, "label_zh": _preview_header_label_zh(c, label_map, cfg_fm)} for c in ordered]
    rows = _df_to_row_dicts(df)

    # next cursor from last row using ordering expressions
    last = rows[-1] if rows else {}
    def _get(name: str) -> str:
        return str(last.get(name) or "")
    seq_str = _get("seq_no") or _get("序号")
    try:
        seq_i = int(float(seq_str)) if seq_str.strip() else 0
    except Exception:
        seq_i = 0
    next_cursor = {
        "file": _get("source_parquet_file"),
        "sheet": _get("source_sheet"),
        "seq": seq_i,
        "key": _get("sdfphm") or _get("invoice_no") or _get("invoice_code"),
        "ts": _get("ingest_ts"),
    }

    return {
        "ok": True,
        "batch_id": b,
        "session_id": s,
        "table_type": tt,
        "view": "raw" if str(view or "std").lower() == "raw" else "std",
        "limit": lim,
        "has_more": has_more,
        "next_cursor": next_cursor if has_more else None,
        "field_mapping_sheet_key": _field_mapping_sheet_key_for_table_type(tt),
        "columns": columns,
        "rows": rows,
    }


def _is_parquet_path_referenced_by_other_sessions(
    conn: Any,
    batch_id: str,
    session_id: str,
    parquet_path: str,
) -> bool:
    """同 Streamlit 批次管理：其它会话若仍引用该 parquet 路径则不可删文件。"""
    try:
        rows = conn.execute(
            """
            SELECT import_session_id, parquet_paths
            FROM ods_load_log
            WHERE import_batch_id = ?
              AND import_session_id <> ?
              AND parquet_paths LIKE ?
            """,
            [batch_id, session_id, f"%{parquet_path}%"],
        ).fetchall()
    except Exception:
        return False
    for sid, raw in rows or []:
        paths = _parse_parquet_paths(str(raw) if raw is not None else None)
        if parquet_path in paths:
            return True
    return False


def delete_ods_import_session(conn: Any, *, batch_id: str, session_id: str) -> dict[str, Any]:
    """
    删除单次导入会话：parquet_paths 中的文件、对应 manifest、ods_load_log 行；
    若该 batch 下已无会话则清理 ods_batch_state。
    """
    ok_b, b = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok_b:
        return {"ok": False, "error": {"message": b}}
    ok_s, s = _validate_ods_identifier(session_id, label="session_id")
    if not ok_s:
        return {"ok": False, "error": {"message": s}}

    ods_root = Path(_effective_ods_dir())
    ods_raw_root = Path(_effective_ods_raw_dir())
    removed_paths: list[str] = []
    skipped_paths: list[str] = []

    try:
        row = conn.execute(
            """
            SELECT parquet_paths, detail_json
            FROM ods_load_log
            WHERE import_batch_id = ? AND import_session_id = ?
            LIMIT 1
            """,
            [b, s],
        ).fetchone()
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "查询 ods_load_log 失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    if not row:
        return {"ok": False, "error": {"message": "未找到该批次与会话对应的 ods_load_log 记录"}}

    parquet_paths = _parse_parquet_paths(str(row[0]) if row[0] is not None else None)
    raw_parquet_paths: list[str] = []
    try:
        detail = json.loads(str(row[1]) if row[1] is not None else "[]")
        if isinstance(detail, list):
            for item in detail:
                if not isinstance(item, dict):
                    continue
                if str(item.get("import_session_id") or "").strip() != s:
                    continue
                if str(item.get("import_batch_id") or "").strip() != b:
                    continue
                raw_parquet_paths.extend(
                    [str(x) for x in (item.get("written_raw_parquet_files") or []) if isinstance(x, str) and x]
                )
    except Exception:
        raw_parquet_paths = []

    for p in parquet_paths:
        try:
            if _is_parquet_path_referenced_by_other_sessions(conn, b, s, str(p)):
                skipped_paths.append(str(p))
                continue
            pp = Path(p)
            if pp.exists() and pp.is_file():
                pp.unlink()
                removed_paths.append(str(pp))
                try:
                    parent = pp.parent
                    if parent.exists() and parent.is_dir() and not any(parent.iterdir()):
                        parent.rmdir()
                except Exception:
                    pass
        except Exception as exc:
            skipped_paths.append(f"{p} ({type(exc).__name__}: {exc})")

    for p in raw_parquet_paths:
        try:
            pp = Path(p)
            if pp.exists() and pp.is_file():
                pp.unlink()
                removed_paths.append(str(pp))
                try:
                    parent = pp.parent
                    if parent.exists() and parent.is_dir() and not any(parent.iterdir()):
                        parent.rmdir()
                except Exception:
                    pass
        except Exception as exc:
            skipped_paths.append(f"{p} ({type(exc).__name__}: {exc})")

    manifests_root = ods_root / "manifests" / f"批次={b}"
    if manifests_root.exists():
        try:
            for mf in manifests_root.rglob(f"manifest_{s}.json"):
                try:
                    mf.unlink()
                    removed_paths.append(str(mf))
                except Exception:
                    pass
        except Exception:
            pass

    manifests_raw_root = ods_raw_root / "manifests" / f"批次={b}"
    if manifests_raw_root.exists():
        try:
            for mf in manifests_raw_root.rglob(f"manifest_{s}.json"):
                try:
                    mf.unlink()
                    removed_paths.append(str(mf))
                except Exception:
                    pass
        except Exception:
            pass

    try:
        conn.execute(
            "DELETE FROM ods_load_log WHERE import_batch_id = ? AND import_session_id = ?",
            [b, s],
        )
        left = conn.execute(
            "SELECT COUNT(*) FROM ods_load_log WHERE import_batch_id = ?",
            [b],
        ).fetchone()
        if left and int(left[0] or 0) == 0:
            conn.execute("DELETE FROM ods_batch_state WHERE import_batch_id = ?", [b])
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "删除数据库记录失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    return {
        "ok": True,
        "scope": "session",
        "batch_id": b,
        "session_id": s,
        "ods_dir": str(ods_root),
        "removed_paths": removed_paths,
        "skipped_paths": skipped_paths,
    }


def delete_ods_import_batch(conn: Any, *, batch_id: str) -> dict[str, Any]:
    """删除整个导入批次：ODS 下该批次目录、manifests、ods_load_log / ods_batch_state 中相关记录。"""
    ok_b, b = _validate_ods_identifier(batch_id, label="batch_id")
    if not ok_b:
        return {"ok": False, "error": {"message": b}}

    ods_root = Path(_effective_ods_dir())
    ods_raw_root = Path(_effective_ods_raw_dir())
    removed_paths: list[str] = []

    batch_dir = ods_root / f"批次={b}"
    if batch_dir.exists():
        try:
            shutil.rmtree(batch_dir)
            removed_paths.append(str(batch_dir))
        except Exception as exc:
            return {
                "ok": False,
                "error": {
                    "message": f"删除 Parquet 目录失败：{type(exc).__name__}",
                    "detail": str(exc),
                },
            }

    manifests_root = ods_root / "manifests" / f"批次={b}"
    if manifests_root.exists():
        try:
            shutil.rmtree(manifests_root)
            removed_paths.append(str(manifests_root))
        except Exception as exc:
            return {
                "ok": False,
                "error": {
                    "message": f"删除 manifests 目录失败：{type(exc).__name__}",
                    "detail": str(exc),
                },
            }

    raw_batch_dir = ods_raw_root / f"批次={b}"
    if raw_batch_dir.exists():
        try:
            shutil.rmtree(raw_batch_dir)
            removed_paths.append(str(raw_batch_dir))
        except Exception:
            pass

    raw_manifests_root = ods_raw_root / "manifests" / f"批次={b}"
    if raw_manifests_root.exists():
        try:
            shutil.rmtree(raw_manifests_root)
            removed_paths.append(str(raw_manifests_root))
        except Exception:
            pass

    try:
        conn.execute("DELETE FROM ods_load_log WHERE import_batch_id = ?", [b])
        conn.execute("DELETE FROM ods_batch_state WHERE import_batch_id = ?", [b])
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": "删除数据库记录失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    return {
        "ok": True,
        "scope": "batch",
        "batch_id": b,
        "ods_dir": str(ods_root),
        "removed_paths": removed_paths,
    }
