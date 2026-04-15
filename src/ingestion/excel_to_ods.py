from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from decimal import Decimal, InvalidOperation
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pandas as pd
import polars as pl

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from config.field_mapping import get_field_mapping_for_sheet, get_sheet_header_slug_label_keys
from config.sheet_mapping import SHEET_MAPPING, update_sheet_mapping_if_missing
from config.seqno_summary_regexes import SEQNO_SUMMARY_REGEXES
from src.etl.invoice_date_parse import parse_invoice_date_raw


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    v = str(raw).strip().lower()
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    return default


# 是否保留 Excel 原始列（中文表头等）到 ODS：
# - True：保留全部原始列 + 标准英文列（数据预览可看到 Excel 全部列；可能出现“原始列 + 标准列”并存）
# - False：删除已映射到标准列的源列（更瘦、更“去重”）
_KEEP_EXCEL_SOURCE_COLUMNS = _env_bool("INVOICELENS_ODS_KEEP_EXCEL_SOURCE_COLUMNS", False)

# 是否额外写出“原始列” Parquet（保留 Excel 原表头列全集），写入独立目录 data/ods_raw。
_WRITE_RAW_PARQUET = _env_bool("INVOICELENS_ODS_WRITE_RAW_PARQUET", True)


def _default_ods_raw_dir() -> str:
    env = (os.getenv("INVOICELENS_ODS_RAW_DIR") or "").strip()
    if env:
        return env
    return str(PROJECT_ROOT / "data" / "ods_raw")


def _safe_table_type(sheet_name: str) -> str:
    allowed = []
    for char in sheet_name.strip():
        if char.isalnum() or char in ("_", "-", "."):
            allowed.append(char)
        else:
            allowed.append("_")
    cleaned = "".join(allowed).strip("_")
    return cleaned or "unknown_sheet"


def _normalize_colname(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip().replace(" ", "")


def _drop_redundant_source_columns(
    df: pd.DataFrame,
    field_cols: dict[str, Any],
    seq_col: Any,
) -> pd.DataFrame:
    """
    读入 Excel 后已在标准英文名（如 invoice_code）下写入字段值，
    原表头列（如「发票代码」）仍保留会导致与标准列语义重复、ODS/预览出现双列。
    删除「已映射到某标准字段、且物理列名与该标准字段名不同」的源列；未映射的扩展列保留。
    """
    if df is None or len(df.columns) == 0:
        return df
    present = {str(c) for c in df.columns}
    to_drop: list[str] = []
    for fn, src in field_cols.items():
        if src is None:
            continue
        std = str(fn).strip()
        sc = str(src).strip()
        if not sc or sc not in present:
            continue
        if sc != std:
            to_drop.append(sc)
    if seq_col is not None:
        sc = str(seq_col).strip()
        if sc and sc in present and sc != "序号":
            to_drop.append(sc)
    seen: set[str] = set()
    final: list[str] = []
    for c in to_drop:
        if c in seen:
            continue
        seen.add(c)
        if c in df.columns:
            final.append(c)
    if not final:
        return df
    return df.drop(columns=final, errors="ignore")


def _infer_sheet_table_type(sheet_name: str) -> tuple[str, bool]:
    """
    将 Excel sheet_name 映射到 ODS 分区 `表类型`（来自 config/sheet_mapping.py）。
    匹配策略：优先包含匹配（YAML 键去空格后出现在 sheet 名中即可），其次精确匹配；
    无法映射则退回安全化 sheet 名。

    因此「信息汇总表1」「信息汇总表2」等与「信息汇总表」同属一条 YAML 映射时，
    会落到同一 table_type，ODS/预览合并为一张逻辑表，不按 1/2 拆分。
    """
    normalized = _normalize_colname(sheet_name)
    # 包含匹配：例如“发票汇总表(2024)” -> “发票汇总表”
    for k, v in SHEET_MAPPING.items():
        if _normalize_colname(k) and _normalize_colname(k) in normalized:
            return v, False
    if normalized in map(_normalize_colname, SHEET_MAPPING.keys()):
        # 找到精确 key 的 v
        for k, v in SHEET_MAPPING.items():
            if _normalize_colname(k) == normalized:
                return v, False
    return _safe_table_type(sheet_name), True


def _infer_seq_column(columns: list[Any]) -> str | None:
    """
    ODS 行级定位依赖 Excel 列“序号”（保留原值用于 reject 回溯）。
    """
    normalized_cols = {_normalize_colname(c): c for c in columns}
    if "序号" in normalized_cols:
        return normalized_cols["序号"]
    # 兜底：包含匹配
    for c in columns:
        if "序号" in _normalize_colname(c):
            return c
    return None


def _infer_field_columns(columns: list[Any], sheet_name: str) -> dict[str, Any]:
    """
    根据 config/field_mapping.yaml（缺失时内置默认），把标准字段映射到 Excel 实际列名。
    同时支持按 Sheet 覆盖（例如“发票基础信息”“信息汇总表”使用不同别名）。
    允许“别名包含匹配”，尽量提高容错。
    """
    norm_to_col = {_normalize_colname(c): c for c in columns}
    results: dict[str, Any] = {}
    for field, aliases in get_field_mapping_for_sheet(sheet_name).items():
        chosen = None
        # 允许 Excel 直接使用标准英文列名（如 invoice_code）
        fn_norm = _normalize_colname(field)
        if fn_norm and fn_norm in norm_to_col:
            chosen = norm_to_col[fn_norm]
        for alias in aliases:
            alias_norm = _normalize_colname(alias)
            if alias_norm in norm_to_col:
                chosen = norm_to_col[alias_norm]
                break
        if chosen is None:
            # 包含匹配：别名可能嵌在列名里
            for c in columns:
                c_norm = _normalize_colname(c)
                for alias in aliases:
                    if _normalize_colname(alias) and _normalize_colname(alias) in c_norm:
                        chosen = c
                        break
                if chosen is not None:
                    break
        results[field] = chosen
    return results


def _excel_header_matches_field_mapping(col: Any, mapping: dict[str, list[str]]) -> bool:
    """
    与 _infer_field_columns 一致：标准字段名（如 invoice_code）可作表头；
    任一别名精确匹配或「列名归一化后包含别名归一化」即视为允许。
    """
    c_norm = _normalize_colname(col)
    if not c_norm:
        return False
    for field_name, aliases in mapping.items():
        fn_norm = _normalize_colname(field_name)
        if fn_norm and fn_norm == c_norm:
            return True
        for alias in aliases:
            alias_norm = _normalize_colname(alias)
            if not alias_norm:
                continue
            if alias_norm == c_norm:
                return True
        for alias in aliases:
            alias_norm = _normalize_colname(alias)
            if alias_norm and alias_norm in c_norm:
                return True
    return False


def _excel_header_matches_slug_labels(col: Any, slug_keys: list[str]) -> bool:
    """sheet_header_slugs 的键：精确或包含匹配（与字段别名策略一致）。"""
    c_norm = _normalize_colname(col)
    if not c_norm:
        return False
    for label in slug_keys:
        ln = _normalize_colname(label)
        if not ln:
            continue
        if ln == c_norm or ln in c_norm:
            return True
    return False


def _preflight_unknown_excel_columns(
    columns: list[Any],
    sheet_name: str,
    seq_col: Any | None,
) -> list[Any]:
    """
    预检：Excel 表头列集须为允许集的子集。
    允许集 = 推断的序号列 ∪ 当前 Sheet 字段映射（含标准字段英文名）∪ sheet_header_slugs 键。
    返回「不允许」的物理列名列表；空列表表示通过。
    """
    mapping = get_field_mapping_for_sheet(sheet_name)
    slug_keys = get_sheet_header_slug_label_keys()
    unknown: list[Any] = []
    for c in columns:
        if seq_col is not None and c == seq_col:
            continue
        if _excel_header_matches_field_mapping(c, mapping):
            continue
        if _excel_header_matches_slug_labels(c, slug_keys):
            continue
        unknown.append(c)
    return unknown


def _format_unknown_columns_message(unknown_cols: list[Any]) -> str:
    max_show = 30
    labels = ", ".join(repr(str(x)) for x in unknown_cols[:max_show])
    if len(unknown_cols) > max_show:
        return f"{labels} …等共 {len(unknown_cols)} 列"
    return labels


def _parse_decimal_maybe(raw: Any) -> Decimal | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # pandas(dtype=str) 对空单元格常见会产出 "nan"
    if s.lower() in {"nan", "none", "null"}:
        return None
    # 去掉千分位逗号（若 Excel 输出带逗号）
    s = s.replace(",", "")
    try:
        return Decimal(s)
    except (InvalidOperation, ValueError):
        return None


def _has_real_value(raw: Any) -> bool:
    """
    把 pandas 读入时常见的空/占位 token 视为“无值”，避免误判导致 Decimal('nan') 等问题。
    """
    if raw is None:
        return False
    try:
        if raw is pd.NA or bool(pd.isna(raw)):
            return False
    except (TypeError, ValueError):
        pass
    s = str(raw).strip()
    if not s:
        return False
    if s.lower() in {"nan", "none", "null"}:
        return False
    if s in {"--", "—", "-", "N/A", "n/a"}:
        return False
    return True


def _kprq_reject_issues(pdf: pd.DataFrame, is_summary: pd.Series) -> tuple[pd.Series, pd.Series]:
    """
    与 DWD cleaner 拒收口径对齐：非合计行须具备可解析开票日期（kprq）。
    返回 (reject_kprq: bool Series, issue: str Series，取值为 '' | 'missing' | 'parse')。
    """
    if "kprq" not in pdf.columns:
        return pd.Series(False, index=pdf.index), pd.Series(
            [""] * len(pdf), index=pdf.index, dtype=object
        )

    def _issue(v: Any) -> str:
        if not _has_real_value(v):
            return "missing"
        if parse_invoice_date_raw(v) is None:
            return "parse"
        return ""

    issues = pdf["kprq"].map(_issue).fillna("missing").astype(object)
    issues = issues.where(~is_summary, other="")
    reject_kprq = (issues.astype(str) != "") & (~is_summary)
    return reject_kprq, issues


def _normalize_cell_value(raw: Any) -> Any:
    """
    pandas.read_excel(dtype=str) 会把空单元格读成字符串 "nan"；
    同时部分导出会用 "--"/"N/A" 等作为缺失占位。ODS 层应把这些还原为真正的 NULL（None）。
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        s = raw.strip()
        if not _has_real_value(s):
            return None
        return s
    # 非字符串（极少见）：仍按 _has_real_value 的语义兜底
    if not _has_real_value(raw):
        return None
    return raw


_MISSING_LOWER_TOKENS = {"nan", "none", "null", "na", "n/a"}
_MISSING_EXACT_TOKENS = {"--", "—", "-", "N/A", "n/a"}


def _normalize_series_missing(s: pd.Series) -> pd.Series:
    """
    对字符串列做缺失归一化：
    - 去首尾空格
    - 空字符串 / 常见占位 token（nan/null/none/--/N/A） -> <NA>
    """
    # 统一成 pandas 的 string dtype，便于 .str 操作且保留 NA
    out = s.astype("string")
    out = out.str.strip()
    # 空串 -> NA
    out = out.mask(out == "", pd.NA)
    lower = out.str.lower()
    out = out.mask(lower.isin(_MISSING_LOWER_TOKENS), pd.NA)
    out = out.mask(out.isin(_MISSING_EXACT_TOKENS), pd.NA)
    return out


def _try_infer_usecols(columns: list[Any], seq_col: Any | None, field_cols: dict[str, Any]) -> list[Any] | None:
    """
    尝试收敛读取列：保留原始列 + 最小必要列（序号 + 映射字段列）。
    若无法推断或列名不稳定，返回 None 表示读取全部列。
    """
    if not columns:
        return None
    chosen: list[Any] = []
    # 关键：ODS 仍需“忠实还原”原始列，但对超大表可先仅取最小列以降耗。
    # 当前实现采取折中：只在列数非常多时才收敛（避免重复解析带来额外开销）。
    if len(columns) <= 80:
        return None
    if seq_col is not None:
        chosen.append(seq_col)
    for v in field_cols.values():
        if v is None:
            continue
        chosen.append(v)
    # 去重保持顺序
    dedup: list[Any] = []
    seen = set()
    for c in chosen:
        if c in seen:
            continue
        seen.add(c)
        dedup.append(c)
    return dedup or None


def _compute_file_hash(path: Path) -> str:
    sha256 = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha256.update(chunk)
    return f"sha256:{sha256.hexdigest()}"


def _any_existing_parquet_for_batch(conn: Any, batch_id: str) -> bool:
    """
    识别“指纹表认为已成功，但 ODS parquet 被手工删除”的情况。

    逻辑：从 ods_load_log 中取该 batch 最近几次记录，解析 parquet_paths，
    只要存在任意一个仍在磁盘上的 parquet 路径，就认为该 batch 的 ODS 产物还在。
    """
    try:
        rows = conn.execute(
            """
            SELECT parquet_paths
            FROM ods_load_log
            WHERE import_batch_id=?
            ORDER BY load_time DESC
            LIMIT 5
            """,
            [batch_id],
        ).fetchall()
    except Exception:
        return False

    for (parquet_paths_raw,) in rows or []:
        if not parquet_paths_raw:
            continue
        try:
            paths = json.loads(parquet_paths_raw)
            if not isinstance(paths, list):
                continue
        except Exception:
            continue
        for p in paths:
            try:
                if isinstance(p, str) and p and Path(p).exists():
                    return True
            except Exception:
                continue
    return False


def _extract_seq_no(row: dict[str, Any]) -> int | None:
    raw = row.get("序号")
    if raw is None:
        return None
    if isinstance(raw, str) and not raw.strip():
        return None
    try:
        return int(float(raw))
    except Exception:
        return None


def _is_total_summary_row(row: dict[str, Any]) -> bool:
    """
    识别“合计/汇总行”并静默跳过：
    - 规则：序号列不是数字，且匹配 `config/seqno_summary_regexes.yaml` 中任一正则
    - 目的：这类行不是业务明细，不应进入拒收样本/异常关注
    """
    raw = row.get("序号")
    if raw is None:
        return False
    s = str(raw).strip()
    if not s:
        return False
    # 若可解析为数字则仍按普通行处理
    if _extract_seq_no(row) is not None:
        return False
    try:
        for pat in SEQNO_SUMMARY_REGEXES:
            if not pat:
                continue
            if re.search(pat, s):
                return True
    except Exception:
        # 配置正则写错时，不影响主流程，回退为“不识别”
        return False
    return False


def _is_valid_row(row: dict[str, Any]) -> bool:
    # 旧版校验逻辑：保留以避免破坏结构；主流程会使用更严格的内联校验逻辑。
    seq_no = _extract_seq_no(row)
    if seq_no is None:
        return False
    key_fields = ("invoice_code", "invoice_no", "sdfphm")
    for field in key_fields:
        value = row.get(field)
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return True
    return False


def _compress_seq_values(seq_values: list[int]) -> list[tuple[int, int]]:
    """
    将升序整数序列压缩成若干连续区间（含端点）。
    """
    if not seq_values:
        return []
    seq_values = sorted(set(seq_values))
    ranges: list[tuple[int, int]] = []
    start = prev = seq_values[0]
    for v in seq_values[1:]:
        if v == prev + 1:
            prev = v
            continue
        ranges.append((start, prev))
        start = prev = v
    ranges.append((start, prev))
    return ranges


def _build_reject_summary(reject_rows: list[dict[str, Any]], sheet: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not reject_rows:
        return [], []

    samples: list[dict[str, Any]] = []
    reason_to_seqs: dict[str, list[int]] = {}

    for row in reject_rows[:20]:
        seq_no = _extract_seq_no(row)
        samples.append(
            {
                "seq_no": seq_no,
                "sheet": sheet,
                "field": row.get("reject_field", "unknown_field"),
                "reason": row.get("reject_reason", "RowValidationError"),
                "exception_type": row.get("exception_type", "RowValidationError"),
            }
        )

    for row in reject_rows:
        seq_no = _extract_seq_no(row)
        if seq_no is None:
            continue
        reason = row.get("reject_reason", "RowValidationError")
        reason_to_seqs.setdefault(reason, []).append(seq_no)

    reject_ranges: list[dict[str, Any]] = []
    for reason, seqs in reason_to_seqs.items():
        for start, end in _compress_seq_values(seqs):
            reject_ranges.append(
                {
                    "seq_no_start": start,
                    "seq_no_end": end,
                    "reason": reason,
                }
            )

    reject_ranges.sort(key=lambda x: (x["seq_no_start"], x["seq_no_end"]))
    return reject_ranges, samples


def _match_target_sheet(sheet_name: str, target_sheet_keys: list[str] | None) -> bool:
    """
    目标 Sheet 判定：按 UI 选择的 SHEET_MAPPING key 列表做包含/精确匹配。
    - target_sheet_keys=None：表示不过滤（兼容旧行为）
    """
    if target_sheet_keys is None:
        return True
    normalized = _normalize_colname(sheet_name)
    for k in target_sheet_keys:
        kn = _normalize_colname(k)
        if not kn:
            continue
        if kn in normalized:
            return True
    return False


def _parse_excel_worker(excel_path: str, target_sheet_keys: list[str] | None = None) -> dict[str, Any]:
    path = Path(excel_path)
    if not path.exists():
        return {
            "file_name": path.name,
            "source_excel_file": str(path),
            "file_blocking": True,
            "status": "失败",
            "reason": f"文件不存在: {excel_path}",
            "exception_type": "FileNotFoundError",
        }

    try:
        file_hash = _compute_file_hash(path)
        xls = pd.ExcelFile(path)
    except Exception as exc:
        return {
            "file_name": path.name,
            "source_excel_file": str(path),
            "file_hash": None,
            "file_blocking": True,
            "status": "失败",
            "reason": "Excel 读取失败",
            "exception_type": type(exc).__name__,
            "detail": str(exc),
        }

    sheets_payload: list[dict[str, Any]] = []
    target_seen = 0
    any_target_blocking = False
    total_valid_rows = 0
    total_reject_rows = 0
    for sheet_name in xls.sheet_names:
        if not _match_target_sheet(sheet_name, target_sheet_keys):
            continue
        target_seen += 1
        # ODS 分区表类型：按 ODS 命名规范使用安全化后的真实 sheet 名
        table_type, mapping_fallback = _infer_sheet_table_type(sheet_name)

        try:
            # 先只读表头拿列名（几乎不耗时），用于推断“序号”列与字段映射
            header_df = pd.read_excel(xls, sheet_name=sheet_name, dtype=str, nrows=0)
            cols = list(header_df.columns)
            seq_col = _infer_seq_column(cols)
            field_cols = _infer_field_columns(cols, sheet_name)
            unknown_cols = _preflight_unknown_excel_columns(cols, sheet_name, seq_col)
            if unknown_cols:
                any_target_blocking = True
                detail = _format_unknown_columns_message(unknown_cols)
                sheets_payload.append(
                    {
                        "sheet": sheet_name,
                        "table_type": table_type,
                        "mapping_fallback": mapping_fallback,
                        "valid_df": None,
                        "rows_loaded": 0,
                        "rows_written_ods": 0,
                        "reject_row_ranges": [],
                        "reject_row_samples": [],
                        "file_blocking": True,
                        "status": "失败",
                        "reason": "Excel 存在未在字段映射或 sheet_header_slugs 中配置的列（列集须为允许集的子集）",
                        "exception_type": "UnknownExcelColumnsError",
                        "detail": detail,
                    }
                )
                continue
            usecols = _try_infer_usecols(cols, seq_col, field_cols)
            pdf = pd.read_excel(xls, sheet_name=sheet_name, dtype=str, usecols=usecols)
        except Exception as exc:
            any_target_blocking = True
            sheets_payload.append(
                {
                    "sheet": sheet_name,
                    "table_type": table_type,
                    "mapping_fallback": mapping_fallback,
                    "valid_df": None,
                    "rows_loaded": 0,
                    "rows_written_ods": 0,
                    "reject_row_ranges": [],
                    "reject_row_samples": [],
                    "file_blocking": True,
                    "status": "失败",
                    "reason": "Sheet 读取失败",
                    "exception_type": type(exc).__name__,
                    "detail": str(exc),
                }
            )
            continue

        # 缺失归一化（向量化）：避免出现文本 "NaN"
        for c in pdf.columns:
            pdf[c] = _normalize_series_missing(pdf[c])

        # 追加“序号”列（用于拒收回溯与 UI 定位）
        if seq_col is not None and seq_col in pdf.columns:
            pdf["序号"] = pdf[seq_col]
        elif "序号" not in pdf.columns:
            pdf["序号"] = pd.NA

        # raw：保留原始列（仅做缺失归一化 + 序号列），供审计追溯；标准字段与溯源列另写到标准 ODS
        raw_pdf = pdf.copy()

        # 标准字段最小映射：ODS 保留为字符串/NULL（强类型解析下沉到 DWD）
        def _get_col(name: str) -> pd.Series:
            col = field_cols.get(name)
            if col is None or col not in pdf.columns:
                return pd.Series([pd.NA] * len(pdf), dtype="string")
            return pdf[col].astype("string")

        # 标准字段全量映射：按 field_mapping.yaml 的 sheet 块字段集合写出到标准 ODS
        # （缺失列补 NA），以便下游稳定按“标准字段名”消费。
        for fname in get_field_mapping_for_sheet(sheet_name).keys():
            fn = str(fname).strip()
            if not fn:
                continue
            pdf[fn] = _get_col(fn)

        rows_loaded = len(pdf)

        # ========= 向量化行级有效性判断（file_blocking=false：行级拒收） =========
        # 合计/汇总行识别：序号不是数字，且匹配配置正则 -> 静默跳过
        seq_raw = pdf["序号"].astype("string")
        seq_num = pd.to_numeric(seq_raw, errors="coerce")
        is_seq_numeric = seq_num.notna()
        is_seq_missing = seq_num.isna()
        is_summary = pd.Series([False] * len(pdf))
        if len(pdf) > 0:
            try:
                # 仅对“非数字序号”的行做 regex，减少开销
                candidates = seq_raw.fillna("")
                candidates = candidates.where(~is_seq_numeric, "")
                any_hit = pd.Series([False] * len(pdf))
                for pat in SEQNO_SUMMARY_REGEXES:
                    if not pat:
                        continue
                    any_hit = any_hit | candidates.str.contains(pat, regex=True, na=False)
                is_summary = is_seq_missing & any_hit
            except Exception:
                is_summary = pd.Series([False] * len(pdf))

        # 发票识别键：任一不空即可（ODS 仅判空，不做格式化）
        key_ok = pdf["invoice_code"].notna() | pdf["invoice_no"].notna() | pdf["sdfphm"].notna()

        # 序号缺失（且非合计行） -> 拒收
        reject_seq = is_seq_missing & (~is_summary)
        # 识别键全空 -> 拒收
        reject_key = (~reject_seq) & (~key_ok)

        # 开票日期（kprq）：与 DWD cleaner 共用 invoice_date_parse.parse_invoice_date_raw
        reject_kprq, kprq_issues = _kprq_reject_issues(pdf, is_summary)
        # 金额等可解析性仍主要在 DWD

        reject_mask = reject_seq | reject_key | reject_kprq
        valid_mask = (~reject_mask) & (~is_summary)

        reject_rows: list[dict[str, Any]] = []
        if reject_mask.any():
            # 仅构造拒收行的小样本（用于 ranges/samples），避免大表生成海量 dict。
            # 注意：合计/汇总行（is_summary=True）应“静默跳过”，不进入拒收清单。
            reject_idx = pdf.index[reject_mask].tolist()
            for i in reject_idx:
                if bool(is_summary.at[i]):
                    continue
                row = {"序号": pdf.at[i, "序号"]}
                if bool(reject_seq.at[i]):
                    row["reject_field"] = "序号"
                    row["reject_reason"] = "序号缺失/无法定位"
                    row["exception_type"] = "SeqNoMissingError"
                elif bool(reject_key.at[i]):
                    row["reject_field"] = "invoice_code+invoice_no+sdfphm"
                    row["reject_reason"] = "发票识别键全空"
                    row["exception_type"] = "InvoiceKeyMissingError"
                elif str(kprq_issues.at[i]) == "missing":
                    row["reject_field"] = "kprq"
                    row["reject_reason"] = "开票日期缺失"
                    row["exception_type"] = "DateMissingError"
                else:
                    row["reject_field"] = "kprq"
                    row["reject_reason"] = "开票日期无法解析"
                    row["exception_type"] = "DateParseError"
                reject_rows.append(row)

        reject_ranges, reject_samples = _build_reject_summary(reject_rows, sheet_name)

        valid_df = pdf.loc[valid_mask].copy()
        if not _KEEP_EXCEL_SOURCE_COLUMNS:
            valid_df = _drop_redundant_source_columns(valid_df, field_cols, seq_col)
        raw_valid_df = raw_pdf.loc[valid_mask].copy() if _WRITE_RAW_PARQUET else None
        total_valid_rows += len(valid_df)
        total_reject_rows += int(reject_mask.sum())

        sheets_payload.append(
            {
                "sheet": sheet_name,
                "table_type": table_type,
                "mapping_fallback": mapping_fallback,
                "valid_df": valid_df,
                "raw_valid_df": raw_valid_df,
                "rows_loaded": rows_loaded,
                "rows_written_ods": len(valid_df),
                "reject_row_ranges": reject_ranges,
                "reject_row_samples": reject_samples,
            }
        )

    if target_sheet_keys is not None and target_seen == 0:
        return {
            "file_name": path.name,
            "source_excel_file": str(path),
            "file_hash": file_hash,
            "file_blocking": True,
            "status": "失败",
            "reason": "未命中任何目标 Sheet（targetSheets 为空或文件不包含目标 Sheet）",
            "exception_type": "NoTargetSheetsError",
            "rows_loaded": 0,
            "rows_written_ods": 0,
            "sheets": [],
        }

    if target_sheet_keys is not None and any_target_blocking:
        # 目标 Sheet 读取失败：按文件级阻断（满足 B：整份 Excel 不写入）
        return {
            "file_name": path.name,
            "source_excel_file": str(path),
            "file_hash": file_hash,
            "file_blocking": True,
            "status": "失败",
            "reason": "目标 Sheet 读取失败（整份 Excel 不写入）",
            "exception_type": "TargetSheetReadError",
            "rows_loaded": total_reject_rows,
            "rows_written_ods": 0,
            "sheets": sheets_payload,
        }

    if total_valid_rows == 0:
        return {
            "file_name": path.name,
            "source_excel_file": str(path),
            "file_hash": file_hash,
            "file_blocking": True,
            "status": "失败",
            "reason": "文件内无有效行",
            "exception_type": "NoValidRowsError",
            "rows_loaded": total_reject_rows,
            "rows_written_ods": 0,
            "sheets": sheets_payload,
        }

    return {
        "file_name": path.name,
        "source_excel_file": str(path),
        "file_hash": file_hash,
        "file_blocking": False,
        "status": "成功" if total_reject_rows == 0 else "警告",
        "rows_loaded": total_valid_rows + total_reject_rows,
        "rows_written_ods": total_valid_rows,
        "rows_dropped_within_file": total_reject_rows,
        "sheets": sheets_payload,
    }


# 第三级 Hive 分区目录名：必须使用与 Parquet **文件内业务列**不同的键名。
# 历史版本曾用「序号=」，与 Excel 映射后的「序号」列同名；DuckDB read_parquet(hive_partitioning=1)
# 会把分区列与文件列合并为同名列，导致预览/查询里「序号」全变成分区值（错误）。
ODS_HIVE_FILE_SEQ_PREFIX = "ods_file_seq="
_LEGACY_HIVE_SEQ_PREFIX = "序号="


class _SeqAllocator:
    def __init__(self, ods_root: Path, batch_id: str) -> None:
        self.ods_root = ods_root
        self.batch_id = batch_id
        self._cache: dict[str, int] = {}

    def next_seq(self, table_type: str) -> int:
        if table_type not in self._cache:
            base = self.ods_root / f"批次={self.batch_id}" / f"表类型={table_type}"
            max_seq = 0
            if base.exists():
                for item in base.iterdir():
                    if not item.is_dir():
                        continue
                    name = item.name
                    if not (name.startswith(ODS_HIVE_FILE_SEQ_PREFIX) or name.startswith(_LEGACY_HIVE_SEQ_PREFIX)):
                        continue
                    token = name.split("=", 1)[-1]
                    if token.isdigit():
                        max_seq = max(max_seq, int(token))
            self._cache[table_type] = max_seq
        self._cache[table_type] += 1
        return self._cache[table_type]


def _write_parquet_atomic(df: pl.DataFrame, out_path: Path, compression: str = "zstd") -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    if tmp_path.exists():
        tmp_path.unlink()
    df.write_parquet(tmp_path, compression=compression)
    os.replace(tmp_path, out_path)


def load_excel_batch_to_ods(
    excel_paths: list[str],
    ods_dir: str,
    batch_id: str,
    *,
    import_workers: int | None = None,
    compression: str = "zstd",
    conn: Any | None = None,
    import_session_id: str | None = None,
    force_reimport: bool = False,
    force_reason: str | None = None,
    target_sheet_keys: list[str] | None = None,
    emit_event: Any | None = None,
) -> list[dict[str, Any]]:
    """
    进程池解析 + 主进程原子写出的最小可运行实现。

    当提供 `conn` 时，会写入 ODS 导入元数据：
    - `ods_batch_state`：running/success/failed
    - `ods_load_log`：按 (import_batch_id, import_session_id) 粒度记录
    - `ods_file_fingerprint`：基于 file_hash 的重复导入软拦截（成功/警告视为成功）
    """
    worker_count = import_workers
    if worker_count is None:
        cpu = os.cpu_count() or 2
        worker_count = min(4, max(1, cpu - 1))
    ods_root = Path(ods_dir)
    ods_raw_root = Path(_default_ods_raw_dir())
    seq_allocator = _SeqAllocator(ods_root=ods_root, batch_id=batch_id)
    now_dt = datetime.now().astimezone()
    import_ts_14 = now_dt.strftime("%Y%m%d%H%M%S")
    ingest_ts = now_dt.isoformat()
    session_id = import_session_id or uuid4().hex

    logs: list[dict[str, Any]] = []
    written_parquet_paths: list[str] = []
    written_raw_parquet_paths: list[str] = []
    unknown_sheet_mappings: dict[str, str] = {}
    file_count = len(excel_paths)
    total_rows = 0
    success_count = 0
    fail_count = 0
    warn_count = 0
    # manifest：按表类型聚合，主进程写盘，避免多进程写同一个文件导致冲突
    manifest_by_table_type: dict[str, list[dict[str, Any]]] = {}
    manifest_raw_by_table_type: dict[str, list[dict[str, Any]]] = {}
    # 序号1：excel 在入参 excel_paths 列表中的顺序（从 1 开始）
    excel_seq_map: dict[str, int] = {p: i + 1 for i, p in enumerate(excel_paths)}

    if conn is not None:
        conn.execute(
            """
            INSERT OR REPLACE INTO ods_batch_state(import_batch_id, status, message, updated_at)
            VALUES (?, 'running', ?, CURRENT_TIMESTAMP)
            """,
            [batch_id, "import started"],
        )
    # 当指定非空 target_sheet_keys 时，默认启用“严格原子（B）”写出策略：
    # - 预检阶段任何目标 Sheet 失败 => file_blocking=True，不写出
    # - 写出阶段使用 staging；全部写成功后 commit；任一失败则清理 staging，不产生部分写入
    atomic_b = bool(target_sheet_keys)

    def _emit_sheet_stage(
        *,
        file_key: str,
        file_name: str,
        sheet: str,
        stage: str,
        state: str,
        message: str | None = None,
        exception_type: str | None = None,
    ) -> None:
        if emit_event is None:
            return
        try:
            payload: dict[str, Any] = {
                "file_key": file_key,
                "file_name": file_name,
                "sheet": sheet,
                "stage": stage,
                "state": state,
            }
            if message:
                payload["message"] = message
            if exception_type:
                payload["exception_type"] = exception_type
            emit_event("sheet_stage", payload)
        except Exception:
            return

    def _parse_excel_inproc(excel_path: str, target_keys: list[str] | None) -> dict[str, Any]:
        path = Path(excel_path)
        if not path.exists():
            return {
                "file_name": path.name,
                "source_excel_file": str(path),
                "file_blocking": True,
                "status": "失败",
                "reason": f"文件不存在: {excel_path}",
                "exception_type": "FileNotFoundError",
            }
        try:
            file_hash = _compute_file_hash(path)
            xls = pd.ExcelFile(path)
        except Exception as exc:
            return {
                "file_name": path.name,
                "source_excel_file": str(path),
                "file_hash": None,
                "file_blocking": True,
                "status": "失败",
                "reason": "Excel 读取失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            }

        sheets_payload: list[dict[str, Any]] = []
        target_seen = 0
        any_target_blocking = False
        total_valid_rows = 0
        total_reject_rows = 0

        file_key = str(path.resolve())
        file_name = path.name

        for sheet_name in xls.sheet_names:
            if not _match_target_sheet(sheet_name, target_keys):
                continue
            target_seen += 1
            table_type, mapping_fallback = _infer_sheet_table_type(sheet_name)

            _emit_sheet_stage(
                file_key=file_key,
                file_name=file_name,
                sheet=sheet_name,
                stage="read_excel",
                state="running",
            )
            try:
                header_df = pd.read_excel(xls, sheet_name=sheet_name, dtype=str, nrows=0)
                cols = list(header_df.columns)
                seq_col = _infer_seq_column(cols)
                field_cols = _infer_field_columns(cols, sheet_name)
                unknown_cols = _preflight_unknown_excel_columns(cols, sheet_name, seq_col)
                if unknown_cols:
                    any_target_blocking = True
                    detail = _format_unknown_columns_message(unknown_cols)
                    msg = detail if len(detail) <= 480 else detail[:477] + "..."
                    _emit_sheet_stage(
                        file_key=file_key,
                        file_name=file_name,
                        sheet=sheet_name,
                        stage="column_preflight",
                        state="fail",
                        message=msg,
                        exception_type="UnknownExcelColumnsError",
                    )
                    _emit_sheet_stage(
                        file_key=file_key,
                        file_name=file_name,
                        sheet=sheet_name,
                        stage="read_excel",
                        state="fail",
                        message="列预检未通过",
                        exception_type="UnknownExcelColumnsError",
                    )
                    sheets_payload.append(
                        {
                            "sheet": sheet_name,
                            "table_type": table_type,
                            "mapping_fallback": mapping_fallback,
                            "valid_df": None,
                            "rows_loaded": 0,
                            "rows_written_ods": 0,
                            "reject_row_ranges": [],
                            "reject_row_samples": [],
                            "file_blocking": True,
                            "status": "失败",
                            "reason": "Excel 存在未在字段映射或 sheet_header_slugs 中配置的列（列集须为允许集的子集）",
                            "exception_type": "UnknownExcelColumnsError",
                            "detail": detail,
                        }
                    )
                    continue
                _emit_sheet_stage(
                    file_key=file_key,
                    file_name=file_name,
                    sheet=sheet_name,
                    stage="column_preflight",
                    state="pass",
                    message=f"cols={len(cols)}",
                )
                usecols = _try_infer_usecols(cols, seq_col, field_cols)
                pdf = pd.read_excel(xls, sheet_name=sheet_name, dtype=str, usecols=usecols)
                _emit_sheet_stage(
                    file_key=file_key,
                    file_name=file_name,
                    sheet=sheet_name,
                    stage="read_excel",
                    state="pass",
                    message=f"rows={len(pdf)}",
                )
            except Exception as exc:
                any_target_blocking = True
                _emit_sheet_stage(
                    file_key=file_key,
                    file_name=file_name,
                    sheet=sheet_name,
                    stage="read_excel",
                    state="fail",
                    message="Sheet 读取失败",
                    exception_type=type(exc).__name__,
                )
                sheets_payload.append(
                    {
                        "sheet": sheet_name,
                        "table_type": table_type,
                        "mapping_fallback": mapping_fallback,
                        "valid_df": None,
                        "rows_loaded": 0,
                        "rows_written_ods": 0,
                        "reject_row_ranges": [],
                        "reject_row_samples": [],
                        "file_blocking": True,
                        "status": "失败",
                        "reason": "Sheet 读取失败",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    }
                )
                continue

            for c in pdf.columns:
                pdf[c] = _normalize_series_missing(pdf[c])
            if seq_col is not None and seq_col in pdf.columns:
                pdf["序号"] = pdf[seq_col]
            elif "序号" not in pdf.columns:
                pdf["序号"] = pd.NA

            # raw：保留原始列（仅做缺失归一化 + 序号列），供审计追溯；标准字段与溯源列另写到标准 ODS
            raw_pdf = pdf.copy()

            def _get_col(name: str) -> pd.Series:
                col = field_cols.get(name)
                if col is None or col not in pdf.columns:
                    return pd.Series([pd.NA] * len(pdf), dtype="string")
                return pdf[col].astype("string")

            # 标准字段全量映射：按 field_mapping.yaml 的 sheet 块字段集合写出到标准 ODS
            for fname in get_field_mapping_for_sheet(sheet_name).keys():
                fn = str(fname).strip()
                if not fn:
                    continue
                pdf[fn] = _get_col(fn)

            rows_loaded = len(pdf)

            seq_raw = pdf["序号"].astype("string")
            seq_num = pd.to_numeric(seq_raw, errors="coerce")
            is_seq_numeric = seq_num.notna()
            is_seq_missing = seq_num.isna()
            is_summary = pd.Series([False] * len(pdf))
            if len(pdf) > 0:
                try:
                    candidates = seq_raw.fillna("")
                    candidates = candidates.where(~is_seq_numeric, "")
                    any_hit = pd.Series([False] * len(pdf))
                    for pat in SEQNO_SUMMARY_REGEXES:
                        if not pat:
                            continue
                        any_hit = any_hit | candidates.str.contains(pat, regex=True, na=False)
                    is_summary = is_seq_missing & any_hit
                except Exception:
                    is_summary = pd.Series([False] * len(pdf))

            key_ok = pdf["invoice_code"].notna() | pdf["invoice_no"].notna() | pdf["sdfphm"].notna()
            reject_seq = is_seq_missing & (~is_summary)
            reject_key = (~reject_seq) & (~key_ok)
            reject_kprq, kprq_issues = _kprq_reject_issues(pdf, is_summary)
            reject_mask = reject_seq | reject_key | reject_kprq
            valid_mask = (~reject_mask) & (~is_summary)

            reject_rows: list[dict[str, Any]] = []
            if reject_mask.any():
                reject_idx = pdf.index[reject_mask].tolist()
                for i in reject_idx:
                    if bool(is_summary.at[i]):
                        continue
                    row = {"序号": pdf.at[i, "序号"]}
                    if bool(reject_seq.at[i]):
                        row["reject_field"] = "序号"
                        row["reject_reason"] = "序号缺失/无法定位"
                        row["exception_type"] = "SeqNoMissingError"
                    elif bool(reject_key.at[i]):
                        row["reject_field"] = "invoice_code+invoice_no+sdfphm"
                        row["reject_reason"] = "发票识别键全空"
                        row["exception_type"] = "InvoiceKeyMissingError"
                    elif str(kprq_issues.at[i]) == "missing":
                        row["reject_field"] = "kprq"
                        row["reject_reason"] = "开票日期缺失"
                        row["exception_type"] = "DateMissingError"
                    else:
                        row["reject_field"] = "kprq"
                        row["reject_reason"] = "开票日期无法解析"
                        row["exception_type"] = "DateParseError"
                    reject_rows.append(row)

            reject_ranges, reject_samples = _build_reject_summary(reject_rows, sheet_name)
            valid_df = pdf.loc[valid_mask].copy()
            if not _KEEP_EXCEL_SOURCE_COLUMNS:
                valid_df = _drop_redundant_source_columns(valid_df, field_cols, seq_col)
            raw_valid_df = raw_pdf.loc[valid_mask].copy() if _WRITE_RAW_PARQUET else None
            total_valid_rows += len(valid_df)
            total_reject_rows += int(reject_mask.sum())

            _emit_sheet_stage(
                file_key=file_key,
                file_name=file_name,
                sheet=sheet_name,
                stage="format_check",
                state="pass",
                message=f"valid={len(valid_df)} reject={int(reject_mask.sum())}",
            )

            sheets_payload.append(
                {
                    "sheet": sheet_name,
                    "table_type": table_type,
                    "mapping_fallback": mapping_fallback,
                    "valid_df": valid_df,
                    "raw_valid_df": raw_valid_df,
                    "rows_loaded": rows_loaded,
                    "rows_written_ods": len(valid_df),
                    "reject_row_ranges": reject_ranges,
                    "reject_row_samples": reject_samples,
                }
            )

        if target_keys is not None and target_seen == 0:
            return {
                "file_name": path.name,
                "source_excel_file": str(path),
                "file_hash": file_hash,
                "file_blocking": True,
                "status": "失败",
                "reason": "未命中任何目标 Sheet（targetSheets 为空或文件不包含目标 Sheet）",
                "exception_type": "NoTargetSheetsError",
                "rows_loaded": 0,
                "rows_written_ods": 0,
                "sheets": [],
            }

        if target_keys is not None and any_target_blocking:
            return {
                "file_name": path.name,
                "source_excel_file": str(path),
                "file_hash": file_hash,
                "file_blocking": True,
                "status": "失败",
                "reason": "目标 Sheet 读取失败（整份 Excel 不写入）",
                "exception_type": "TargetSheetReadError",
                "rows_loaded": total_reject_rows,
                "rows_written_ods": 0,
                "sheets": sheets_payload,
            }

        if total_valid_rows == 0:
            return {
                "file_name": path.name,
                "source_excel_file": str(path),
                "file_hash": file_hash,
                "file_blocking": True if target_keys is not None else False,
                "status": "失败" if target_keys is not None else "警告",
                "reason": "目标 Sheet 无有效数据行",
                "exception_type": "NoValidRowsError",
                "rows_loaded": total_reject_rows,
                "rows_written_ods": 0,
                "sheets": sheets_payload,
            }

        return {
            "file_name": path.name,
            "source_excel_file": str(path),
            "file_hash": file_hash,
            "file_blocking": False,
            "status": "成功",
            "rows_loaded": total_valid_rows + total_reject_rows,
            "rows_written_ods": total_valid_rows,
            "rows_dropped_within_file": total_reject_rows,
            "reject_row_ranges": [],
            "reject_row_samples": [],
            "sheets": sheets_payload,
        }

    def _iter_parse_results() -> list[tuple[str, dict[str, Any]]]:
        if worker_count == 1:
            return [(p, _parse_excel_inproc(p, target_sheet_keys)) for p in excel_paths]
        out: list[tuple[str, dict[str, Any]]] = []
        with ProcessPoolExecutor(max_workers=worker_count) as pool:
            futures = {pool.submit(_parse_excel_worker, p, target_sheet_keys): p for p in excel_paths}
            for future in as_completed(futures):
                source_excel_path = futures[future]
                try:
                    parse_result = future.result()
                except Exception as exc:
                    parse_result = {
                        "file_name": Path(source_excel_path).name,
                        "source_excel_file": source_excel_path,
                        "file_hash": None,
                        "file_blocking": True,
                        "status": "失败",
                        "reason": "文件解析异常（worker 抛出未捕获异常）",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                        "reject_row_ranges": [],
                        "reject_row_samples": [],
                        "written_parquet_files": [],
                        "rows_loaded": 0,
                    }
                out.append((source_excel_path, parse_result))
        return out

    for source_excel_path, parse_result in _iter_parse_results():
        if parse_result.get("file_blocking", False):
            parse_result = {
                **parse_result,
                "import_batch_id": batch_id,
                "import_session_id": session_id,
                "load_time": ingest_ts,
            }
            logs.append(parse_result)
            fail_count += 1
            total_rows += parse_result.get("rows_loaded", 0)
            continue
        try:
            source_excel_file = parse_result["source_excel_file"]
            file_reject_ranges: list[dict[str, Any]] = []
            file_reject_samples: list[dict[str, Any]] = []
            written_files: list[str] = []
            written_raw_files: list[str] = []
            any_file_compat_used = False
            auto_reimport_due_to_missing_parquet = False
            auto_reimport_duplicate_of_batch: str | None = None
            # 序号2：同一个 Excel 文件内，同一 table_type 的 sheet 写出顺序（从 1 开始）
            table_type_sheet_seq2: dict[str, int] = {}

            # 重复导入软拦截：若历史为“成功/警告”，则跳过写出（仍保留解析日志）
            file_hash = parse_result.get("file_hash")
            if conn is not None and file_hash and (not force_reimport):
                exists = conn.execute(
                    """
                    SELECT first_success_import_batch_id, first_success_import_session_id, last_status
                    FROM ods_file_fingerprint
                    WHERE file_hash=?
                    """,
                    [file_hash],
                ).fetchone()
                if exists is not None and exists[2] in ("成功", "警告"):
                    # 若历史 batch 的 parquet 已被手工删除，则不应继续“跳过重复”，应允许重导以修复口径。
                    dup_batch = exists[0]
                    if dup_batch and _any_existing_parquet_for_batch(conn, str(dup_batch)):
                        logs.append(
                            {
                                    "import_batch_id": batch_id,
                                    "import_session_id": session_id,
                                    "load_time": ingest_ts,
                                    "file_name": parse_result["file_name"],
                                    "source_excel_file": parse_result["source_excel_file"],
                                    "file_hash": file_hash,
                                    "status": "跳过重复",
                                    "file_blocking": False,
                                    "is_duplicate": True,
                                    "duplicate_of_batch": exists[0],
                                    "is_force_reimport": False,
                                    "force_reason": None,
                                    "rows_loaded": parse_result.get("rows_loaded", 0),
                                    "rows_written_ods": 0,
                                    "rows_dropped_within_file": parse_result.get("rows_dropped_within_file", 0),
                                    "reject_row_ranges": [],
                                    "reject_row_samples": [],
                                    "written_parquet_files": [],
                            }
                        )
                        total_rows += parse_result.get("rows_loaded", 0)
                        success_count += 1
                        continue
                    # 否则：指纹存在但历史 parquet 不在（疑似被清理），允许继续写出，并在本次日志里提示
                    auto_reimport_due_to_missing_parquet = True
                    auto_reimport_duplicate_of_batch = str(dup_batch) if dup_batch else None
                    # 注：不在这里 continue，继续进入写出流程（相当于“自动重导”）

            # staging：按文件隔离，确保单文件全/不（B）
            staging_file_dir: Path | None = None
            pending_moves: list[tuple[Path, Path, dict[str, Any], str]] = []
            written_files_final: list[str] = []
            wrote_any = False
            atomic_write_failed = False

            if atomic_b:
                fh = parse_result.get("file_hash") or uuid4().hex
                safe_fh = re.sub(r"[^a-zA-Z0-9:_-]+", "_", str(fh))
                staging_file_dir = ods_root / ".staging" / f"session={session_id}" / f"file={safe_fh}"
                try:
                    staging_file_dir.mkdir(parents=True, exist_ok=True)
                except Exception:
                    staging_file_dir = None

            for sheet_payload in parse_result.get("sheets", []):
                valid_df = sheet_payload.get("valid_df")
                raw_valid_df = sheet_payload.get("raw_valid_df")
                file_reject_ranges.extend(sheet_payload.get("reject_row_ranges", []))
                file_reject_samples.extend(sheet_payload.get("reject_row_samples", []))
                if valid_df is None or len(valid_df) == 0:
                    continue

                table_type = sheet_payload["table_type"]
                if sheet_payload.get("mapping_fallback"):
                    sheet_key = sheet_payload.get("sheet")
                    if isinstance(sheet_key, str) and sheet_key.strip():
                        # 仅允许把未知 sheet 追加为“稳定英文代号”，避免把中文/脏值写回配置污染
                        unknown_sheet_mappings[sheet_key] = _safe_table_type(table_type)
                table_type_sheet_seq2[table_type] = table_type_sheet_seq2.get(table_type, 0) + 1
                seq_no_2 = table_type_sheet_seq2[table_type]
                seq = seq_allocator.next_seq(table_type)
                file_name = f"{import_ts_14}_{table_type}_{uuid4().hex}.parquet"
                out_path = (
                    ods_root
                    / f"批次={batch_id}"
                    / f"表类型={table_type}"
                    / f"{ODS_HIVE_FILE_SEQ_PREFIX}{seq}"
                    / file_name
                )
                raw_out_path = (
                    ods_raw_root
                    / f"批次={batch_id}"
                    / f"表类型={table_type}"
                    / f"{ODS_HIVE_FILE_SEQ_PREFIX}{seq}"
                    / file_name
                )
                stage_out_path = out_path
                raw_stage_out_path = raw_out_path
                if atomic_b and staging_file_dir is not None:
                    try:
                        rel = out_path.relative_to(ods_root)
                        stage_out_path = staging_file_dir / rel
                    except Exception:
                        stage_out_path = out_path
                    try:
                        rel_raw = raw_out_path.relative_to(ods_raw_root)
                        raw_stage_out_path = staging_file_dir / rel_raw
                    except Exception:
                        raw_stage_out_path = raw_out_path
                # 写出前补齐溯源元数据列（向量化：避免逐行 loop）
                try:
                    valid_df = valid_df.copy()
                    valid_df["import_session_id"] = session_id
                    valid_df["source_excel_file"] = source_excel_file
                    # 即使 staging 写出，也记录最终路径，便于后续回看定位
                    valid_df["source_parquet_file"] = str(out_path)
                    valid_df["ingest_ts"] = ingest_ts
                    valid_df["source_sheet"] = sheet_payload.get("sheet")
                except Exception:
                    # 不让元数据补齐失败影响主流程
                    pass
                if _WRITE_RAW_PARQUET and raw_valid_df is not None:
                    try:
                        raw_valid_df = raw_valid_df.copy()
                        raw_valid_df["import_session_id"] = session_id
                        raw_valid_df["source_excel_file"] = source_excel_file
                        raw_valid_df["source_parquet_file"] = str(raw_out_path)
                        raw_valid_df["ingest_ts"] = ingest_ts
                        raw_valid_df["source_sheet"] = sheet_payload.get("sheet")
                    except Exception:
                        pass

                # Polars 默认 infer_schema_length=100；当某列在前 100 行推断为某类型，
                # 但后续行为另一类型时，可能在 Parquet 写出阶段触发 ComputeError。
                # 这里做“兼容重试”：先用较大的 infer_schema_length，
                # 仍失败则退化为把非核心列统一转为 Utf8 再写出。
                try:
                    infer_len = min(len(valid_df), 20000) if valid_df is not None else 100
                    df = pl.from_pandas(valid_df, include_index=False)
                    try:
                        _emit_sheet_stage(
                            file_key=source_excel_file,
                            file_name=parse_result.get("file_name") or Path(source_excel_file).name,
                            sheet=str(sheet_payload.get("sheet") or ""),
                            stage="write_ods",
                            state="running",
                        )
                        _write_parquet_atomic(df, stage_out_path, compression=compression)
                        wrote_any = True
                        _emit_sheet_stage(
                            file_key=source_excel_file,
                            file_name=parse_result.get("file_name") or Path(source_excel_file).name,
                            sheet=str(sheet_payload.get("sheet") or ""),
                            stage="write_ods",
                            state="pass",
                            message=f"rows={len(valid_df)}",
                        )
                        seq_no_1 = excel_seq_map.get(source_excel_file, 1)
                        entry = {
                            "batch_id": batch_id,
                            "import_session_id": session_id,
                            "table_type": table_type,
                            "seq_no_1": int(seq_no_1),
                            "seq_no_2": int(seq_no_2),
                            "source_excel_file": source_excel_file,
                            "source_sheet": sheet_payload.get("sheet"),
                            "file_hash": parse_result.get("file_hash"),
                            "parquet_path": str(out_path),
                            "rows_written_ods": len(valid_df),
                        }
                        raw_entry = None
                        if _WRITE_RAW_PARQUET and raw_valid_df is not None:
                            raw_entry = {
                                **entry,
                                "parquet_path": str(raw_out_path),
                                "rows_written_ods": len(raw_valid_df),
                            }
                        if atomic_b and stage_out_path != out_path:
                            pending_moves.append((stage_out_path, out_path, entry, table_type))
                        else:
                            written_files.append(str(out_path))
                            written_files_final.append(str(out_path))
                            manifest_by_table_type.setdefault(table_type, []).append(entry)
                        if raw_entry is not None:
                            try:
                                df_raw = pl.from_pandas(raw_valid_df, include_index=False)
                                _write_parquet_atomic(df_raw, raw_stage_out_path, compression=compression)
                                if atomic_b and raw_stage_out_path != raw_out_path:
                                    pending_moves.append(
                                        (raw_stage_out_path, raw_out_path, raw_entry, f"raw:{table_type}")
                                    )
                                else:
                                    written_raw_files.append(str(raw_out_path))
                                    manifest_raw_by_table_type.setdefault(table_type, []).append(raw_entry)
                            except Exception:
                                pass
                    except Exception:
                        # 兼容重试 1：让 Polars 在更完整的样本上推断 schema
                        df_retry = pl.from_pandas(valid_df, include_index=False)
                        try:
                            _write_parquet_atomic(df_retry, stage_out_path, compression=compression)
                            wrote_any = True
                            any_file_compat_used = True
                            _emit_sheet_stage(
                                file_key=source_excel_file,
                                file_name=parse_result.get("file_name") or Path(source_excel_file).name,
                                sheet=str(sheet_payload.get("sheet") or ""),
                                stage="write_ods",
                                state="pass",
                                message=f"rows={len(valid_df)}（compat）",
                            )
                            seq_no_1 = excel_seq_map.get(source_excel_file, 1)
                            entry = {
                                "batch_id": batch_id,
                                "import_session_id": session_id,
                                "table_type": table_type,
                                "seq_no_1": int(seq_no_1),
                                "seq_no_2": int(seq_no_2),
                                "source_excel_file": source_excel_file,
                                "source_sheet": sheet_payload.get("sheet"),
                                "file_hash": parse_result.get("file_hash"),
                                "parquet_path": str(out_path),
                                "rows_written_ods": len(valid_df),
                            }
                            raw_entry = None
                            if _WRITE_RAW_PARQUET and raw_valid_df is not None:
                                raw_entry = {
                                    **entry,
                                    "parquet_path": str(raw_out_path),
                                    "rows_written_ods": len(raw_valid_df),
                                }
                            if atomic_b and stage_out_path != out_path:
                                pending_moves.append((stage_out_path, out_path, entry, table_type))
                            else:
                                written_files.append(str(out_path))
                                written_files_final.append(str(out_path))
                                manifest_by_table_type.setdefault(table_type, []).append(entry)
                            if raw_entry is not None:
                                try:
                                    df_raw = pl.from_pandas(raw_valid_df, include_index=False)
                                    _write_parquet_atomic(df_raw, raw_stage_out_path, compression=compression)
                                    if atomic_b and raw_stage_out_path != raw_out_path:
                                        pending_moves.append(
                                            (raw_stage_out_path, raw_out_path, raw_entry, f"raw:{table_type}")
                                        )
                                    else:
                                        written_raw_files.append(str(raw_out_path))
                                        manifest_raw_by_table_type.setdefault(table_type, []).append(raw_entry)
                                except Exception:
                                    pass
                        except Exception:
                            # 兼容重试 2：把非核心列统一为 Utf8，尽量避免类型不一致
                            # C：ODS 保存原始字符串，核心强类型解析下沉到 DWD；
                            # 这里不再强制保留金额/日期强类型列，避免 schema 漂移导致写出失败。
                            core_cols: set[str] = set()
                            cast_exprs = []
                            for c in df_retry.columns:
                                if c in core_cols:
                                    continue
                                cast_exprs.append(pl.col(c).cast(pl.Utf8, strict=False).alias(c))
                            df_retry2 = df_retry.with_columns(cast_exprs) if cast_exprs else df_retry
                            _write_parquet_atomic(df_retry2, stage_out_path, compression=compression)
                            wrote_any = True
                            any_file_compat_used = True
                            _emit_sheet_stage(
                                file_key=source_excel_file,
                                file_name=parse_result.get("file_name") or Path(source_excel_file).name,
                                sheet=str(sheet_payload.get("sheet") or ""),
                                stage="write_ods",
                                state="pass",
                                message=f"rows={len(valid_df)}（compat2）",
                            )
                            seq_no_1 = excel_seq_map.get(source_excel_file, 1)
                            entry = {
                                "batch_id": batch_id,
                                "import_session_id": session_id,
                                "table_type": table_type,
                                "seq_no_1": int(seq_no_1),
                                "seq_no_2": int(seq_no_2),
                                "source_excel_file": source_excel_file,
                                "source_sheet": sheet_payload.get("sheet"),
                                "file_hash": parse_result.get("file_hash"),
                                "parquet_path": str(out_path),
                                "rows_written_ods": len(valid_df),
                            }
                            raw_entry = None
                            if _WRITE_RAW_PARQUET and raw_valid_df is not None:
                                raw_entry = {
                                    **entry,
                                    "parquet_path": str(raw_out_path),
                                    "rows_written_ods": len(raw_valid_df),
                                }
                            if atomic_b and stage_out_path != out_path:
                                pending_moves.append((stage_out_path, out_path, entry, table_type))
                            else:
                                written_files.append(str(out_path))
                                written_files_final.append(str(out_path))
                                manifest_by_table_type.setdefault(table_type, []).append(entry)
                            if raw_entry is not None:
                                try:
                                    df_raw = pl.from_pandas(raw_valid_df, include_index=False)
                                    _write_parquet_atomic(df_raw, raw_stage_out_path, compression=compression)
                                    if atomic_b and raw_stage_out_path != raw_out_path:
                                        pending_moves.append(
                                            (raw_stage_out_path, raw_out_path, raw_entry, f"raw:{table_type}")
                                        )
                                    else:
                                        written_raw_files.append(str(raw_out_path))
                                        manifest_raw_by_table_type.setdefault(table_type, []).append(raw_entry)
                                except Exception:
                                    pass
                except Exception as exc:
                    atomic_write_failed = True
                    _emit_sheet_stage(
                        file_key=source_excel_file,
                        file_name=parse_result.get("file_name") or Path(source_excel_file).name,
                        sheet=str(sheet_payload.get("sheet") or ""),
                        stage="write_ods",
                        state="fail",
                        message="Parquet 写出失败",
                        exception_type=type(exc).__name__,
                    )
                    logs.append(
                        {
                            "import_batch_id": batch_id,
                            "import_session_id": session_id,
                            "load_time": ingest_ts,
                            "file_name": parse_result["file_name"],
                            "source_excel_file": source_excel_file,
                            "file_hash": parse_result.get("file_hash"),
                            "status": "失败",
                            "file_blocking": True,
                            "reason": "Parquet 写出失败（兼容重试后仍失败）",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        }
                    )
                    fail_count += 1
                    total_rows += parse_result.get("rows_loaded", 0)
                    # 原子（B）：失败时清理 staging，确保不产生部分写入
                    if atomic_b and staging_file_dir is not None:
                        try:
                            for p in staging_file_dir.rglob("*"):
                                if p.is_file():
                                    p.unlink()
                            for p in sorted([x for x in staging_file_dir.rglob("*") if x.is_dir()], reverse=True):
                                try:
                                    p.rmdir()
                                except Exception:
                                    pass
                            try:
                                staging_file_dir.rmdir()
                            except Exception:
                                pass
                        except Exception:
                            pass
                    written_files = []
                    break

            # 原子（B）：commit（staging -> final）仅在当前文件写出未失败时执行（勿用 logs[-1]，会串文件）
            if atomic_b and (not atomic_write_failed) and pending_moves:
                try:
                    for stage_p, final_p, entry, table_type in pending_moves:
                        final_p.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(stage_p, final_p)
                        if isinstance(table_type, str) and table_type.startswith("raw:"):
                            tt = table_type.split("raw:", 1)[-1] or table_type
                            written_raw_files.append(str(final_p))
                            written_files_final.append(str(final_p))
                            manifest_raw_by_table_type.setdefault(tt, []).append(entry)
                        else:
                            written_files.append(str(final_p))
                            written_files_final.append(str(final_p))
                            manifest_by_table_type.setdefault(table_type, []).append(entry)
                    # 清理 staging 目录
                    if staging_file_dir is not None:
                        try:
                            for p in sorted([x for x in staging_file_dir.rglob("*") if x.is_dir()], reverse=True):
                                try:
                                    p.rmdir()
                                except Exception:
                                    pass
                            try:
                                staging_file_dir.rmdir()
                            except Exception:
                                pass
                        except Exception:
                            pass
                except Exception as exc:
                    # commit 失败：视为文件级失败，并尽量清理 staging
                    logs.append(
                        {
                            "import_batch_id": batch_id,
                            "import_session_id": session_id,
                            "load_time": ingest_ts,
                            "file_name": parse_result["file_name"],
                            "source_excel_file": source_excel_file,
                            "file_hash": parse_result.get("file_hash"),
                            "status": "失败",
                            "file_blocking": True,
                            "reason": "原子提交失败（staging commit）",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        }
                    )
                    fail_count += 1
                    total_rows += parse_result.get("rows_loaded", 0)
                    written_files = []

            if written_files:
                extra_reason = None
                if auto_reimport_due_to_missing_parquet:
                    extra_reason = (
                        "检测到该文件曾成功导入（指纹命中），但历史 ODS Parquet 已缺失/被手工清理："
                        "本次已自动放行重导以修复口径。"
                    )
                logs.append(
                    {
                        "import_batch_id": batch_id,
                        "import_session_id": session_id,
                        "load_time": ingest_ts,
                        "file_name": parse_result["file_name"],
                        "source_excel_file": source_excel_file,
                        "file_hash": parse_result.get("file_hash"),
                        "status": (
                            "警告"
                            if (
                                (any_file_compat_used and parse_result.get("status", "成功") == "成功")
                                or auto_reimport_due_to_missing_parquet
                            )
                            else parse_result.get("status", "成功")
                        ),
                        "file_blocking": False,
                        "is_duplicate": False,
                        "duplicate_of_batch": auto_reimport_duplicate_of_batch,
                        "auto_reimport": bool(auto_reimport_due_to_missing_parquet),
                        "reason": extra_reason,
                        "is_force_reimport": force_reimport,
                        "force_reason": force_reason,
                        "rows_loaded": parse_result.get("rows_loaded", 0),
                        "rows_written_ods": parse_result.get("rows_written_ods", 0),
                        "rows_dropped_within_file": parse_result.get("rows_dropped_within_file", 0),
                        "reject_row_ranges": file_reject_ranges,
                        "reject_row_samples": file_reject_samples,
                        "written_parquet_files": written_files,
                        "written_raw_parquet_files": written_raw_files,
                    }
                )
                written_parquet_paths.extend(written_files)
                written_raw_parquet_paths.extend(written_raw_files)
                total_rows += parse_result.get("rows_loaded", 0)
                final_status = parse_result.get("status", "成功")
                if final_status == "警告":
                    warn_count += 1
                    success_count += 1
                elif final_status == "成功":
                    success_count += 1

                # 更新指纹表（成功/警告写出后记录）
                if conn is not None and file_hash and final_status in ("成功", "警告"):
                    exists = conn.execute(
                        """
                        SELECT first_success_import_batch_id, first_success_import_session_id
                        FROM ods_file_fingerprint
                        WHERE file_hash=?
                        """,
                        [file_hash],
                    ).fetchone()
                    first_batch = batch_id if exists is None else (exists[0] or batch_id)
                    first_session = session_id if exists is None else (exists[1] or session_id)
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO ods_file_fingerprint(
                            file_hash,
                            first_success_import_batch_id,
                            first_success_import_session_id,
                            last_status,
                            last_seen_at,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        """,
                        [file_hash, first_batch, first_session, final_status],
                    )
        except Exception as exc:
            # 主进程处理阶段异常：按文件级失败记录，避免整批 flush 中断
            logs.append(
                {
                    "import_batch_id": batch_id,
                    "import_session_id": session_id,
                    "load_time": ingest_ts,
                    "file_name": Path(source_excel_path).name,
                    "source_excel_file": source_excel_path,
                    "file_hash": parse_result.get("file_hash") if isinstance(parse_result, dict) else None,
                    "status": "失败",
                    "file_blocking": True,
                    "reason": "文件解析异常（主进程处理）",
                    "exception_type": type(exc).__name__,
                    "detail": str(exc),
                    "reject_row_ranges": [],
                    "reject_row_samples": [],
                    "written_parquet_files": [],
                    "written_raw_parquet_files": [],
                }
            )
            fail_count += 1
            total_rows += parse_result.get("rows_loaded", 0) if isinstance(parse_result, dict) else 0
            continue

    if conn is not None:
        status = "success" if fail_count == 0 else "failed"
        conn.execute(
            """
            INSERT OR REPLACE INTO ods_load_log(
                import_batch_id, import_session_id, load_time,
                file_count, total_rows, success_count, fail_count, warn_count,
                parquet_paths, detail_json
            )
            VALUES (
                ?, ?, CURRENT_TIMESTAMP,
                ?, ?, ?, ?, ?,
                ?, ?
            )
            """,
            [
                batch_id,
                session_id,
                file_count,
                total_rows,
                success_count,
                fail_count,
                warn_count,
                json.dumps(written_parquet_paths, ensure_ascii=False),
                json.dumps(logs, ensure_ascii=False),
            ],
        )
        conn.execute(
            """
            UPDATE ods_batch_state
            SET status=?, message=?, updated_at=CURRENT_TIMESTAMP
            WHERE import_batch_id=?
            """,
            [status, f"file_count={file_count}, fail_count={fail_count}, warn_count={warn_count}", batch_id],
        )

    # 主进程在导入结束后补齐 JSON 映射（只补新增 key，不覆盖已有 key）。
    # 这样能避免并发 worker 同时写入同一个 JSON 文件导致损坏。
    if unknown_sheet_mappings:
        try:
            update_sheet_mapping_if_missing(unknown_sheet_mappings)
        except Exception:
            # 不让 JSON 写失败影响核心导入流程
            pass

    # 写 manifest：按 batch_id + table_type 聚合成少量文件（主进程写盘，避免多进程锁/竞争）
    if manifest_by_table_type:
        try:
            manifests_root = Path(ods_dir) / "manifests"
            for table_type, entries in manifest_by_table_type.items():
                out_dir = manifests_root / f"批次={batch_id}" / f"表类型={table_type}"
                out_path = out_dir / f"manifest_{session_id}.json"
                out_dir.mkdir(parents=True, exist_ok=True)

                tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
                if tmp_path.exists():
                    tmp_path.unlink()

                with tmp_path.open("w", encoding="utf-8") as f:
                    json.dump(
                        {
                            "batch_id": batch_id,
                            "import_session_id": session_id,
                            "table_type": table_type,
                            "entries": entries,
                        },
                        f,
                        ensure_ascii=False,
                        indent=2,
                    )
                os.replace(tmp_path, out_path)
        except Exception:
            # manifest 写失败不影响核心导入流程
            pass

    if _WRITE_RAW_PARQUET and manifest_raw_by_table_type:
        try:
            manifests_root = ods_raw_root / "manifests"
            for table_type, entries in manifest_raw_by_table_type.items():
                out_dir = manifests_root / f"批次={batch_id}" / f"表类型={table_type}"
                out_path = out_dir / f"manifest_{session_id}.json"
                out_dir.mkdir(parents=True, exist_ok=True)

                tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
                if tmp_path.exists():
                    tmp_path.unlink()

                with tmp_path.open("w", encoding="utf-8") as f:
                    json.dump(
                        {
                            "batch_id": batch_id,
                            "import_session_id": session_id,
                            "table_type": table_type,
                            "entries": entries,
                        },
                        f,
                        ensure_ascii=False,
                        indent=2,
                    )
                os.replace(tmp_path, out_path)
        except Exception:
            pass
    return logs


def excel_to_ods(excel_path: str, ods_dir: str) -> dict[str, Any]:
    """
    兼容旧入口：单文件导入。
    """
    try:
        batch_id = datetime.now().strftime("%Y%m%d")
        logs = load_excel_batch_to_ods(
            excel_paths=[excel_path],
            ods_dir=ods_dir,
            batch_id=batch_id,
        )
        if not logs:
            return {
                "file_blocking": True,
                "status": "失败",
                "reason": "导入未产生任何日志",
                "exception_type": "ImportNoLogError",
            }
        return logs[0]
    except Exception as exc:
        return {
            "file_blocking": True,
            "status": "失败",
            "reason": "Excel 导入失败",
            "exception_type": type(exc).__name__,
            "detail": str(exc),
        }
