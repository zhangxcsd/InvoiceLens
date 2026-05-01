from __future__ import annotations

from typing import Any, Iterable

import hashlib
import logging
import re
from pathlib import Path
from uuid import uuid4
import yaml
from functools import lru_cache

from config.dwd_mapping_loader import load_merged_dwd_mapping, ods_candidates_for_dwd_column
from src.etl.dwd_shared_logic_line import (
    build_create_ods_logic_line_view_sql,
    sql_amount_dq_vs_inv_detail,
    sql_detail_uuid_expr,
    sql_header_uuid_expr,
    sql_spc_inv_positive_linecount_mismatch,
)
from db.duckdb_conn import get_conn
from db.schema_sqlfiles import (
    ensure_ods_inv_views_materialized,
    force_remount_ods_inv_core_views,
    init_all_tables,
)

logger = logging.getLogger(__name__)
_RED_BZ_RULES_PATH = Path("config/red_invoice_bz_rules.yaml")


@lru_cache(maxsize=1)
def _load_red_invoice_bz_rules() -> list[dict[str, Any]]:
    """
    从文本配置加载红票备注匹配规则，避免每次细调都要改 Python 代码。
    返回结构：[{name, mode, pattern}]；加载失败时回退到内置规则。
    """
    fallback: list[dict[str, Any]] = [
        {"name": "positive_code_number", "mode": "fpdm_fphm", "pattern": r"对应正数发票代码\s*[:：]\s*(\d+)\s*号码\s*[:：]\s*(\d+)"},
        {"name": "positive_code_invoice_number", "mode": "fpdm_fphm", "pattern": r"对应正数发票代码\s*[:：]\s*(\d+)\s*发票号码\s*[:：]\s*(\d+)"},
        {"name": "positive_code_number_with_punct", "mode": "fpdm_fphm", "pattern": r"对应正数发票代码\s*([^，,\s:：]+)\s*[，,、]\s*号码\s*([^，,\s]+)"},
        {"name": "blue_digital_ticket_number", "mode": "sdfphm", "pattern": r"被红冲蓝字数电票号码\s*[:：]\s*(\d{10,})"},
        {"name": "blue_digital_invoice_number", "mode": "sdfphm", "pattern": r"被红冲蓝字数电发票号码\s*[:：]\s*(\d{10,})"},
        {"name": "positive_invoice_number_only", "mode": "sdfphm", "pattern": r"对应正数发票号码\s*[:：]\s*(\d{10,})"},
        {"name": "blue_number_then_code", "mode": "fphm_fpdm", "pattern": r"被红冲蓝字发票号码\s*[:：]\s*(\d+)\s+被红冲蓝字发票代码\s*[:：]\s*(\d+)"},
        {"name": "blue_code_then_number", "mode": "fpdm_fphm", "pattern": r"被红冲蓝字发票代码\s*[:：]\s*(\d+)\s+被红冲蓝字发票号码\s*[:：]\s*(\d+)"},
    ]
    try:
        if not _RED_BZ_RULES_PATH.exists():
            return fallback
        doc = yaml.safe_load(_RED_BZ_RULES_PATH.read_text(encoding="utf-8")) or {}
        raw_rules = doc.get("rules")
        if not isinstance(raw_rules, list):
            return fallback
        rules: list[dict[str, Any]] = []
        for r in raw_rules:
            if not isinstance(r, dict):
                continue
            if r.get("enabled", True) is False:
                continue
            mode = str(r.get("mode") or "").strip()
            pat = str(r.get("pattern") or "").strip()
            if mode not in {"fpdm_fphm", "fphm_fpdm", "sdfphm"} or not pat:
                continue
            rules.append({"name": str(r.get("name") or ""), "mode": mode, "pattern": pat})
        return rules or fallback
    except Exception as exc:
        logger.warning("加载红票备注规则失败，回退内置规则：%s", exc)
        return fallback


def sql_spc_money_coalesce_from_ods_dtl(
    try_je: str,
    try_se: str,
    try_jshj: str,
    fpdm_spc_sql: str,
    fphm_spc_sql: str,
    sdfphm_spc_sql: str,
    fpdm_dtl_sql: str,
    fphm_dtl_sql: str,
    sdfphm_dtl_sql: str,
    je_dtl_sql: str,
    se_dtl_sql: str,
    jshj_dtl_sql: str,
) -> tuple[str, str, str]:
    """
    专项 je/se/jshj：COALESCE(本 sheet ODS 金额 TRY, `_ods_dtl_logic` 同 detail_uuid 行上的金额)。

    `_ods_dtl_logic` 与写入 `dwd_inv_detail` 的源一致（信息汇总等 inv 明细 ODS），金额解析式与
    `INSERT INTO dwd_inv_detail` 中的 `je_try_d` / `se_try_d` / `jshj_try_d` 相同；建筑等专项 sheet 可无标准 amount 列。
    """
    u_outer = sql_detail_uuid_expr(fpdm_spc_sql, fphm_spc_sql, sdfphm_spc_sql)
    u_odt = sql_detail_uuid_expr(fpdm_dtl_sql, fphm_dtl_sql, sdfphm_dtl_sql, "odt.logic_line_no")

    def one(tj: str, dtl_money_sql: str) -> str:
        return (
            f"COALESCE({tj}, (SELECT {dtl_money_sql} FROM _ods_dtl_logic AS odt "
            f"WHERE {u_odt} = {u_outer} LIMIT 1))"
        )

    return (one(try_je, je_dtl_sql), one(try_se, se_dtl_sql), one(try_jshj, jshj_dtl_sql))


def sql_update_spc_money_from_inv_detail(spc_table: str) -> str:
    """
    将专项表上仍为 NULL 的 je/se/jshj 从 dwd_inv_detail 回填（同 detail_uuid + 同批同年）。
    dwd_inv_detail 金额同源为信息汇总等 ODS→DWD 结果；与 INSERT 内 `_ods_dtl_logic` 补数一致，用于历史行或二次对齐。
    """
    return f"""
    UPDATE {spc_table} AS s
    SET
      je = COALESCE(s.je, d.je),
      se = COALESCE(s.se, d.se),
      jshj = COALESCE(s.jshj, d.jshj)
    FROM dwd_inv_detail AS d
    WHERE s.import_batch_id = ?
      AND s.stat_year = ?
      AND d.detail_uuid = s.detail_uuid
      AND d.import_batch_id = s.import_batch_id
      AND d.stat_year = s.stat_year
      AND (s.je IS NULL OR s.se IS NULL OR s.jshj IS NULL)
    """


def _parse_tax_rate_to_decimal(v: object) -> float | None:
    """
    将税率字符串解析为小数（0.13 表示 13%）。

    支持：
    - "13%" -> 0.13
    - "0.13" -> 0.13
    - "13" -> 0.13（按 0-100 视为百分数）
    - "免税"/"零税率" -> 0.0
    失败返回 None（由下游决定是否置 0 或拒收）。
    """
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    s = s.replace("％", "%")
    if s in {"免税", "零税率", "免征税", "不征税"}:
        return 0.0
    try:
        if s.endswith("%"):
            x = float(s[:-1].strip())
            return x / 100.0
        x = float(s)
        # 约定：1 < x <= 100 视为百分数
        if 1.0 < x <= 100.0:
            return x / 100.0
        return x
    except Exception:
        return None


def _fullwidth_to_halfwidth(s: str | None) -> str | None:
    """
    全角转半角（对齐提示词口径）：
    - 全角空格 U+3000 -> 半角空格 U+0020
    - 全角 ASCII 区间 U+FF01..U+FF5E -> 减去 0xFEE0
    """
    if s is None:
        return None
    out_chars: list[str] = []
    for ch in str(s):
        code = ord(ch)
        if code == 0x3000:
            out_chars.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:
            out_chars.append(chr(code - 0xFEE0))
        else:
            out_chars.append(ch)
    return "".join(out_chars)


def _header_uuid_md5(fpdm: str, fphm: str, sdfphm: str) -> str:
    """与 DWD 写入一致：md5(fw2hw(fpdm)||fw2hw(fphm)||fw2hw(sdfphm))，十六进制小写。"""
    a = (_fullwidth_to_halfwidth((fpdm or "").strip()) or "") or ""
    b = (_fullwidth_to_halfwidth((fphm or "").strip()) or "") or ""
    c = (_fullwidth_to_halfwidth((sdfphm or "").strip()) or "") or ""
    return hashlib.md5(f"{a}{b}{c}".encode("utf-8")).hexdigest()


def _bz_target_blue_header_uuid(bz: str | None) -> str | None:
    """
    从备注中解析被红冲蓝票的代码/号码/数电号码，返回目标蓝票 header_uuid（MD5 十六进制）。
    未识别返回 None。与 SQL 侧 md5(fw2hw||fw2hw||fw2hw) 对齐。
    """
    if bz is None:
        return None
    s = str(bz)
    for rule in _load_red_invoice_bz_rules():
        try:
            m = re.search(str(rule["pattern"]), s)
        except re.error:
            continue
        if not m:
            continue
        mode = str(rule["mode"])
        if mode == "sdfphm":
            v = (m.group(1) or "").strip()
            if v:
                return _header_uuid_md5("", "", v)
        elif mode == "fpdm_fphm":
            fpdm = (m.group(1) or "").strip()
            fphm = (m.group(2) or "").strip()
            if fpdm and fphm:
                return _header_uuid_md5(fpdm, fphm, "")
        elif mode == "fphm_fpdm":
            fphm = (m.group(1) or "").strip()
            fpdm = (m.group(2) or "").strip()
            if fpdm and fphm:
                return _header_uuid_md5(fpdm, fphm, "")
    return None


def parse_red_bz_debug(bz: str | None) -> dict[str, Any]:
    """
    备注规则调试：返回命中规则、提取值、推导出的蓝票 header_uuid。
    用于 API/前端快速验规则，不影响主链路口径。
    """
    s = "" if bz is None else str(bz)
    for rule in _load_red_invoice_bz_rules():
        pat = str(rule.get("pattern") or "")
        mode = str(rule.get("mode") or "")
        name = str(rule.get("name") or "")
        try:
            m = re.search(pat, s)
        except re.error as exc:
            return {
                "ok": False,
                "matched": False,
                "rule_name": name,
                "mode": mode,
                "pattern": pat,
                "error": f"正则无效: {type(exc).__name__}: {exc}",
            }
        if not m:
            continue
        groups = [str(g or "").strip() for g in m.groups()]
        target = None
        if mode == "sdfphm" and len(groups) >= 1 and groups[0]:
            target = _header_uuid_md5("", "", groups[0])
        elif mode == "fpdm_fphm" and len(groups) >= 2 and groups[0] and groups[1]:
            target = _header_uuid_md5(groups[0], groups[1], "")
        elif mode == "fphm_fpdm" and len(groups) >= 2 and groups[0] and groups[1]:
            target = _header_uuid_md5(groups[1], groups[0], "")
        return {
            "ok": True,
            "matched": target is not None,
            "rule_name": name,
            "mode": mode,
            "pattern": pat,
            "groups": groups,
            "target_blue_header_uuid": target,
            "matched_text": m.group(0),
        }
    return {
        "ok": True,
        "matched": False,
        "rule_name": None,
        "mode": None,
        "pattern": None,
        "groups": [],
        "target_blue_header_uuid": None,
        "matched_text": None,
    }


def _bz_blue_uuid_from_bz_udf(v: object) -> str | None:
    """DuckDB UDF：入参可为 NULL，无匹配返回 NULL。"""
    if v is None:
        return None
    return _bz_target_blue_header_uuid(str(v))


def _register_dwd_scalar_udfs(conn: Any) -> None:
    """
    DuckDB 1.x：默认 null_handling=DEFAULT 时，Python UDF 对传入行不得返回 None。
    parse_tax_rate_to_decimal / bz_blue_uuid_from_bz 等会返回 None，须使用 SPECIAL。
    """
    try:
        from duckdb.func import FunctionNullHandling
        from duckdb.sqltypes import DOUBLE, VARCHAR
    except Exception:
        for udf_name, udf_fn in (
            ("fw2hw", _fullwidth_to_halfwidth),
            ("parse_tax_rate_to_decimal", _parse_tax_rate_to_decimal),
            ("bz_blue_uuid_from_bz", _bz_blue_uuid_from_bz_udf),
        ):
            try:
                conn.create_function(udf_name, udf_fn)
            except Exception:
                pass
        return

    nh = FunctionNullHandling.SPECIAL
    for udf_name, udf_fn, params, ret_t in (
        ("fw2hw", _fullwidth_to_halfwidth, [VARCHAR], VARCHAR),
        ("parse_tax_rate_to_decimal", _parse_tax_rate_to_decimal, [VARCHAR], DOUBLE),
        ("bz_blue_uuid_from_bz", _bz_blue_uuid_from_bz_udf, [VARCHAR], VARCHAR),
    ):
        try:
            conn.create_function(
                udf_name,
                udf_fn,
                parameters=params,
                return_type=ret_t,
                null_handling=nh,
            )
        except Exception:
            try:
                conn.create_function(udf_name, udf_fn)
            except Exception:
                pass


def _compress_seq_values(seq_values: list[int]) -> list[tuple[int, int]]:
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


def _build_reject_summary(
    reject_rows: list[dict[str, Any]],
    *,
    sheet: str,
    sample_limit: int = 20,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not reject_rows:
        return [], []

    samples: list[dict[str, Any]] = []
    reason_to_seqs: dict[str, list[int]] = {}

    for row in reject_rows[:sample_limit]:
        samples.append(
            {
                "seq_no": row.get("seq_no"),
                "sheet": sheet,
                "field": row.get("field", "unknown_field"),
                "reason": row.get("reason", "RowValidationError"),
                "exception_type": row.get("exception_type", "RowValidationError"),
            }
        )

    for row in reject_rows:
        seq_no = row.get("seq_no")
        if seq_no is None:
            continue
        reason = row.get("reason", "RowValidationError")
        reason_to_seqs.setdefault(reason, []).append(int(seq_no))

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


def _as_sql_string_list(paths: Iterable[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        s = str(p).strip()
        if not s:
            continue
        out.append(s)
    return out


def _sql_string_literal(s: str) -> str:
    """生成 SQL 单引号字符串字面量（' → ''）。DuckDB 的 CREATE VIEW 等语句不支持 ? 预编译参数。"""
    return "'" + str(s).replace("'", "''") + "'"


def _sql_quoted_identifier(name: str) -> str:
    """双引号标识符（" → ""）。"""
    return '"' + str(name).replace('"', '""') + '"'


def _view_column_names(conn: Any, view_name: str) -> set[str]:
    rows = conn.execute(f"DESCRIBE {view_name}").fetchall()
    return {str(r[0]) for r in rows}


def _pick_first_column(cols: set[str], candidates: tuple[str, ...]) -> str | None:
    lower = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand in cols:
            return cand
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def _sql_invoice_date_try_expr(kprq_raw_sql: str) -> str:
    """
    将 ODS 开票日期列解析为 DATE：
    - 字符串：YYYY-MM-DD / YYYYMMDD / 含时间等（try_strptime）
    - Parquet 强类型：DATE、TIMESTAMP
    - Excel 序列号纯数字串（与 invoice_date_parse.parse_invoice_date_raw 一致，原点 1899-12-30）

    kprq_raw_sql：列引用或 SQL 表达式（如 \"kprq\"、CAST(NULL AS VARCHAR)）。
    """
    date_str = f"trim(CAST(({kprq_raw_sql}) AS VARCHAR))"
    date_norm = f"replace({date_str}, '/', '-')"
    excel_date = (
        f"CASE WHEN TRY_CAST({date_str} AS DOUBLE) IS NOT NULL "
        f"AND TRY_CAST({date_str} AS DOUBLE) >= 1000 AND TRY_CAST({date_str} AS DOUBLE) <= 100000 "
        f"THEN CAST((CAST('1899-12-30' AS DATE) + (CAST(FLOOR(TRY_CAST({date_str} AS DOUBLE)) AS BIGINT) * INTERVAL '1 day')) AS DATE) "
        f"ELSE CAST(NULL AS DATE) END"
    )
    parts = [
        f"try_strptime({date_norm}, '%Y-%m-%d')::DATE",
        f"try_strptime({date_str}, '%Y%m%d')::DATE",
        f"try_strptime({date_str}, '%Y-%m-%d %H:%M:%S')::DATE",
        f"try_strptime({date_str}, '%Y/%m/%d %H:%M:%S')::DATE",
        f"TRY_CAST(({kprq_raw_sql}) AS DATE)",
        f"CAST(TRY_CAST(({kprq_raw_sql}) AS TIMESTAMP) AS DATE)",
        excel_date,
    ]
    return "COALESCE(" + ", ".join(parts) + ")"


def _sql_invoice_time_try_expr(kprq_raw_sql: str) -> str:
    """
    从 kprq 解析 TIME（与 `_sql_invoice_date_try_expr` 同源字段）：
    - 字符串中含日期+时间时取时分秒；仅日期、无时间成分时为 NULL（不写入 00:00:00）
    - TIMESTAMP / 含 'T' 的 ISO 串在有可辨时间成分时解析
    """
    date_str = f"trim(CAST(({kprq_raw_sql}) AS VARCHAR))"
    date_norm = f"replace({date_str}, '/', '-')"
    ts1 = f"try_strptime({date_norm}, '%Y-%m-%d %H:%M:%S')"
    ts2 = f"try_strptime({date_str}, '%Y/%m/%d %H:%M:%S')"
    ts3 = f"try_strptime({date_norm}, '%Y-%m-%d %H:%M')"
    ts4 = f"try_strptime({date_norm}, '%Y-%m-%dT%H:%M:%S')"
    ts_cast = f"TRY_CAST(({kprq_raw_sql}) AS TIMESTAMP)"
    # 纯日期串经 TRY_CAST 常成午夜：仅当原串显式含时间分隔（空格/T 后有时分）时才采纳
    has_time_sep = (
        f"(strpos({date_str}, ':') > 0 AND (strpos({date_str}, ' ') > 0 OR strpos({date_str}, 'T') > 0))"
    )
    ts_from_cast = f"CASE WHEN {has_time_sep} THEN CAST({ts_cast} AS TIME) ELSE CAST(NULL AS TIME) END"
    parts = [
        f"CAST(({ts1}) AS TIME)",
        f"CAST(({ts2}) AS TIME)",
        f"CAST(({ts3}) AS TIME)",
        f"CAST(({ts4}) AS TIME)",
        ts_from_cast,
    ]
    return "COALESCE(" + ", ".join(parts) + ")"


def _sql_hhmm_try_expr(raw_sql: str) -> str:
    """
    将时间字符串标准化为 HH:MM（VARCHAR）：
    - 原值为空 -> NULL
    - 可解析（HH:MM[:SS] 或可转 TIME）-> HH:MM
    - 非空但解析失败 -> '00:00'
    """
    raw = f"trim(CAST(({raw_sql}) AS VARCHAR))"
    hhmm = (
        "COALESCE("
        f"substr(CAST(try_strptime({raw}, '%H:%M:%S') AS VARCHAR), 12, 5),"
        f"substr(CAST(try_strptime({raw}, '%H:%M') AS VARCHAR), 12, 5),"
        f"substr(CAST(TRY_CAST(({raw_sql}) AS TIME) AS VARCHAR), 1, 5)"
        ")"
    )
    return f"CASE WHEN ({raw_sql}) IS NULL OR {raw} = '' THEN NULL ELSE COALESCE({hhmm}, '00:00') END"


def run_cleaner(
    *,
    stat_year: int,
    import_batch_id: str,
    import_session_ids: list[str] | None = None,
    ods_parquet_paths: Iterable[str] | None = None,
) -> dict[str, Any]:
    """
    ODS -> DWD 清洗写入：

    - C：ODS 仅保存原始字符串/NULL；金额/日期的强类型解析与“可解析性拒收”在 DWD 完成
    - 生成与 ODS 同形状的拒收摘要：
      - reject_row_ranges: [{seq_no_start, seq_no_end, reason}]
      - reject_row_samples: [{seq_no, sheet, field, reason, exception_type}]
    - 数据质量报告（专项）：`dq_*_linecount_mismatch`、`dq_*_amount_vs_inv_detail`（按 detail_uuid 对照
      `dwd_inv_detail`，仅返回列表、不改写数据；详见 `dwd_shared_logic_line`）

    - `import_session_ids`：非 None 时仅处理这些会话的 ODS 行（与 batch_id 组合）；空列表则跳过写入。
    - 覆盖刷新边界：`stat_year`（必要时叠加 `import_batch_id` / import_session）
      - 允许重跑：同一 stat_year 的 DWD/DWS 可重复计算并覆盖写入
      - 禁止跨年误操作：不得执行无过滤的全表 DELETE/UPDATE
    - 去重并入语义：
      - 物理票判重键优先：`sdfphm` > `invoice_code+invoice_no`
      - 写入 DWD 主表/明细表应保证同一 `(stat_year, invoice_key)` 唯一
      - 写入溯源映射表应保证可追溯（保留 `source_excel_file/source_parquet_file/import_batch_id`）
    """
    conn = get_conn()
    init_all_tables(conn)
    ensure_ods_inv_views_materialized(conn)

    if import_session_ids is not None and len(import_session_ids) == 0:
        return {
            "status": "success",
            "stage": "cleaner",
            "stat_year": stat_year,
            "import_batch_id": import_batch_id,
            "dwd_build_id": None,
            "rows_scanned_header": 0,
            "rows_written_header": 0,
            "rows_scanned_detail": 0,
            "rows_written_detail": 0,
            "rows_rejected": 0,
            "reject_row_ranges": [],
            "reject_row_samples": [],
            "dq_spc_passenger_linecount_mismatch": [],
            "dq_spc_freight_linecount_mismatch": [],
            "dq_spc_vehicle_sales_linecount_mismatch": [],
            "dq_spc_construction_linecount_mismatch": [],
            "dq_spc_estate_lease_linecount_mismatch": [],
            "dq_spc_transport_passenger_amount_vs_inv_detail": [],
            "dq_spc_transport_freight_amount_vs_inv_detail": [],
            "dq_spc_vehicle_sales_amount_vs_inv_detail": [],
            "dq_spc_construction_service_amount_vs_inv_detail": [],
            "dq_spc_estate_lease_amount_vs_inv_detail": [],
            "message": "import_session_ids 为空列表，已跳过本 stat_year 写入",
        }

    _register_dwd_scalar_udfs(conn)

    # DWD 构建批次标识（用于血缘字段 dwd_build_id）
    dwd_build_id = uuid4().hex

    # 读取 ODS：优先使用 ods.sql 中的视图（带 hive 分区列），避免直接 read_parquet 丢失 ods_file_seq/批次等
    # 注意：DuckDB 对 CREATE OR REPLACE VIEW … 不支持预编译参数 ?，须内联字面量。
    _bid_lit = _sql_string_literal(import_batch_id)
    _sess_filter = ""
    if import_session_ids is not None:
        _sid_vals = [str(s).strip() for s in import_session_ids if str(s).strip()]
        if _sid_vals:
            _in_list = ", ".join(_sql_string_literal(s) for s in _sid_vals)
            _needle_conds = " OR ".join(
                f"strpos(CAST(source_parquet_file AS VARCHAR), {_sql_string_literal(f'会话={s}')}) > 0"
                for s in _sid_vals
            )
            # 兼容旧 ODS：部分历史行 import_session_id 为空，按 source_parquet_file 血缘兜底会话筛选。
            _sess_filter = (
                " AND ("
                f"import_session_id IN ({_in_list})"
                " OR ("
                "  (import_session_id IS NULL OR trim(CAST(import_session_id AS VARCHAR)) = '')"
                f"  AND ({_needle_conds})"
                " )"
                ")"
            )
        else:
            _sess_filter = " AND 1=0"
    hdr_sql = f"""
        CREATE OR REPLACE TEMP VIEW _ods_hdr AS
        SELECT *
        FROM ods_inv_header
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    dtl_sql = f"""
        CREATE OR REPLACE TEMP VIEW _ods_dtl AS
        SELECT *
        FROM ods_inv_detail
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    try:
        conn.execute(hdr_sql)
        conn.execute(dtl_sql)
    except Exception as exc:
        msg = str(exc)
        if "batch_id" in msg and (
            "__placeholder__" in msg
            or ("Referenced column" in msg and "not found" in msg)
        ):
            logger.warning(
                "创建 _ods_hdr/_ods_dtl 失败（疑似 ODS 仍为占位视图），尝试强制重挂 ods_inv_*: %s",
                exc,
            )
            force_remount_ods_inv_core_views(conn)
            ensure_ods_inv_views_materialized(conn)
            conn.execute(hdr_sql)
            conn.execute(dtl_sql)
        else:
            raise

    # 字段映射：DuckDB 对 COALESCE("a","b") 会校验 **所有** 列名，缺列即 Binder 报错。
    # 因此只绑定 ODS 中实际存在的列（按候选顺序取第一个）。
    hdr_cols = _view_column_names(conn, "_ods_hdr")
    dtl_cols = _view_column_names(conn, "_ods_dtl")
    merged_map = load_merged_dwd_mapping()

    def _col_bind(cols: set[str], *candidates: str) -> str:
        name = _pick_first_column(cols, tuple(candidates))
        return _sql_quoted_identifier(name) if name else "CAST(NULL AS VARCHAR)"

    def col_h_bind(dwd_col: str) -> str:
        cands = ods_candidates_for_dwd_column(merged_map, "dwd_inv_header", dwd_col)
        if cands is None:
            raise RuntimeError(
                f"dwd_mapping 缺少 ODS 列绑定：dwd_inv_header.{dwd_col}（需要 source.ods_fields）"
            )
        return _col_bind(hdr_cols, *cands)

    def col_d_bind(dwd_col: str) -> str:
        cands = ods_candidates_for_dwd_column(merged_map, "dwd_inv_detail", dwd_col)
        if cands is None:
            raise RuntimeError(
                f"dwd_mapping 缺少 ODS 列绑定：dwd_inv_detail.{dwd_col}（需要 source.ods_fields）"
            )
        return _col_bind(dtl_cols, *cands)

    seq_cands = ods_candidates_for_dwd_column(merged_map, "dwd_inv_detail", "logic_line_no")
    if not seq_cands:
        seq_cands = ("seq_no", "序号")
    hdr_seq_col = _pick_first_column(hdr_cols, seq_cands)
    dtl_seq_col = _pick_first_column(dtl_cols, seq_cands)

    fpdm_expr = col_h_bind("fpdm")
    fphm_expr = col_h_bind("fphm")
    sdfphm_expr = col_h_bind("sdfphm")
    xfsbh_expr = col_h_bind("xfsbh")
    xfmc_expr = col_h_bind("xfmc")
    gfsbh_expr = col_h_bind("gfsbh")
    gfmc_expr = col_h_bind("gfmc")
    kpr_expr = col_h_bind("kpr")
    bz_expr = col_h_bind("bz")
    fply_expr = col_h_bind("fply")
    fppz_expr = col_h_bind("fppz")
    fpzt_expr = col_h_bind("fpzt")
    sfzsfp_expr = col_h_bind("sfzsfp")
    fpfxdj_expr = col_h_bind("fpfxdj")

    kprq_raw_expr = col_h_bind("kprq")
    je_raw_expr = col_h_bind("je")
    se_raw_expr = col_h_bind("se")
    jshj_raw_expr = col_h_bind("jshj")

    # 清洗后的字符串（去货币符号/千分位）
    def clean_money(expr: str) -> str:
        # 去空格/货币符号/逗号
        return f"regexp_replace(regexp_replace(regexp_replace(trim(CAST({expr} AS VARCHAR)), '[￥¥]', ''), ',', ''), '\\\\s+', '')"

    # 日期解析：字符串 + DATE/TIMESTAMP + Excel 序列号（ODS 常为 dtype=str 的纯数字）
    date_try = _sql_invoice_date_try_expr(kprq_raw_expr)
    time_try = _sql_invoice_time_try_expr(kprq_raw_expr)

    je_clean = clean_money(je_raw_expr)
    se_clean = clean_money(se_raw_expr)
    jshj_clean = clean_money(jshj_raw_expr)

    je_try = f"TRY_CAST({je_clean} AS DECIMAL(18,2))"
    se_try = f"TRY_CAST({se_clean} AS DECIMAL(18,2))"
    jshj_try = f"TRY_CAST({jshj_clean} AS DECIMAL(18,2))"

    def spc_money_try_expr(ods_cols: set[str], dwd_table: str, dwd_col: str) -> str:
        """
        专项表 je/se/jshj 的 ODS 侧 TRY 片段（供 `spc_dwd_je_se_jshj_exprs` 组合使用）：
        按 dwd_mapping 的 source.ods_fields 选 ODS 列，再经 clean_money 与 TRY_CAST；无列时为 NULL。
        """
        cands = ods_candidates_for_dwd_column(merged_map, dwd_table, dwd_col)
        if not cands:
            fallback: dict[str, tuple[str, ...]] = {
                "je": ("amount", "金额"),
                "se": ("tax_amount", "税额"),
                "jshj": ("total_amount", "价税合计"),
            }
            cands = fallback.get(dwd_col, (dwd_col,))
        raw = _col_bind(ods_cols, *cands)
        cleaned = clean_money(raw)
        return f"TRY_CAST({cleaned} AS DECIMAL(18,2))"

    hdr_seq_sql = _sql_quoted_identifier(hdr_seq_col) if hdr_seq_col else None
    # 主表：无「序号」列时（部分导出模板）不据此拒收
    seq_raw_sel = f"TRY_CAST({hdr_seq_sql} AS DOUBLE)" if hdr_seq_sql else "CAST(1.0 AS DOUBLE)"
    exc_when_seq = (
        f"        WHEN {hdr_seq_sql} IS NULL THEN 'SeqNoMissingError'\n"
        if hdr_seq_sql
        else ""
    )
    fld_when_seq = f"        WHEN {hdr_seq_sql} IS NULL THEN '序号'\n" if hdr_seq_sql else ""
    rsn_when_seq = (
        f"        WHEN {hdr_seq_sql} IS NULL THEN '序号缺失/无法定位'\n" if hdr_seq_sql else ""
    )
    rej_or_seq_line = f"      ({hdr_seq_sql} IS NULL)\n      OR " if hdr_seq_sql else "      FALSE OR "
    seq_valid = f"({hdr_seq_sql} IS NOT NULL)" if hdr_seq_sql else "TRUE"

    # 拒收逻辑（同形状日志）
    # - 原始值非空但解析结果为 NULL -> 拒收（ParseError）
    # - kprq（开票日期原值）缺失或解析失败 -> 拒收（DateMissing/DateParseError）
    # - 金额类字段：若原始有值但解析失败 -> 对应字段拒收
    # 说明：如果某些企业导出缺少税额/价税合计，允许为空（不拒收）；但一旦填了就必须可解析
    reject_sql = f"""
    SELECT
      {seq_raw_sel} AS seq_no_raw,
      {kprq_raw_expr} AS raw_kprq,
      {je_raw_expr} AS raw_amount,
      {se_raw_expr} AS raw_tax_amount,
      {jshj_raw_expr} AS raw_total_amount,
      {date_try} AS parsed_date,
      {je_try} AS parsed_je,
      {se_try} AS parsed_se,
      {jshj_try} AS parsed_jshj,
      CASE
{exc_when_seq}        WHEN {kprq_raw_expr} IS NULL THEN 'DateMissingError'
        WHEN {kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL THEN 'DateParseError'
        WHEN {je_raw_expr} IS NOT NULL AND {je_try} IS NULL THEN 'AmountParseError'
        WHEN {se_raw_expr} IS NOT NULL AND {se_try} IS NULL THEN 'TaxAmountParseError'
        WHEN {jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL THEN 'TotalAmountParseError'
        ELSE NULL
      END AS exception_type,
      CASE
{fld_when_seq}        WHEN {kprq_raw_expr} IS NULL OR ({kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL) THEN 'kprq'
        WHEN {je_raw_expr} IS NOT NULL AND {je_try} IS NULL THEN 'amount'
        WHEN {se_raw_expr} IS NOT NULL AND {se_try} IS NULL THEN 'tax_amount'
        WHEN {jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL THEN 'total_amount'
        ELSE NULL
      END AS field,
      CASE
{rsn_when_seq}        WHEN {kprq_raw_expr} IS NULL THEN '开票日期缺失'
        WHEN {kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL THEN '开票日期无法解析'
        WHEN {je_raw_expr} IS NOT NULL AND {je_try} IS NULL THEN '金额无法解析'
        WHEN {se_raw_expr} IS NOT NULL AND {se_try} IS NULL THEN '税额无法解析'
        WHEN {jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL THEN '价税合计无法解析'
        ELSE NULL
      END AS reason
    FROM _ods_hdr
    WHERE
{rej_or_seq_line}({kprq_raw_expr} IS NULL)
      OR ({kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL)
      OR ({je_raw_expr} IS NOT NULL AND {je_try} IS NULL)
      OR ({se_raw_expr} IS NOT NULL AND {se_try} IS NULL)
      OR ({jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL)
    """

    rej = conn.execute(reject_sql).fetchall()
    reject_rows: list[dict[str, Any]] = []
    for seq_no_raw, *_rest, exception_type, field, reason in rej:
        seq_no = None
        try:
            if seq_no_raw is not None:
                seq_no = int(seq_no_raw)
        except Exception:
            seq_no = None
        reject_rows.append(
            {
                "seq_no": seq_no,
                "field": field,
                "reason": reason,
                "exception_type": exception_type,
            }
        )

    reject_ranges, reject_samples = _build_reject_summary(reject_rows, sheet="inv_header")

    # 有效行：排除拒收行（解析失败/缺失）
    # 注意：这里以同一套条件判定 valid，避免 Python 再做二次过滤
    valid_where = f"""
      {seq_valid}
      AND ({kprq_raw_expr} IS NOT NULL)
      AND ({date_try} IS NOT NULL)
      AND NOT ({je_raw_expr} IS NOT NULL AND {je_try} IS NULL)
      AND NOT ({se_raw_expr} IS NOT NULL AND {se_try} IS NULL)
      AND NOT ({jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL)
    """

    # 写入 DWD header（先到先得：主键冲突不覆盖）
    insert_hdr_sql = f"""
    INSERT INTO dwd_inv_header (
      header_uuid, stat_year, stat_month,
      fpdm, fphm, sdfphm,
      xfsbh, xfmc, gfsbh, gfmc,
      kprq, invoice_date, invoice_time,
      je, se, jshj,
      fply, fppz, fpzt, sfzsfp, fpfxdj,
      kpr, bz,
      import_batch_id, import_session_id, ods_file_seq,
      source_excel_file, source_parquet_file, source_sheet, ingest_ts,
      dwd_build_ts, dwd_build_id,
      first_import_batch_id, first_import_file
    )
    SELECT
      md5(
        COALESCE(fw2hw(CAST({fpdm_expr} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({fphm_expr} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({sdfphm_expr} AS VARCHAR)), '')
      ) AS header_uuid,
      EXTRACT(year FROM {date_try})::SMALLINT AS stat_year,
      EXTRACT(month FROM {date_try})::SMALLINT AS stat_month,
      {fpdm_expr} AS fpdm,
      {fphm_expr} AS fphm,
      {sdfphm_expr} AS sdfphm,
      {xfsbh_expr} AS xfsbh,
      {xfmc_expr} AS xfmc,
      {gfsbh_expr} AS gfsbh,
      {gfmc_expr} AS gfmc,
      {kprq_raw_expr} AS kprq,
      CAST({date_try} AS DATE) AS invoice_date,
      {time_try} AS invoice_time,
      {je_try} AS je,
      {se_try} AS se,
      {jshj_try} AS jshj,
      NULLIF(trim(CAST({fply_expr} AS VARCHAR)), '') AS fply,
      NULLIF(trim(CAST({fppz_expr} AS VARCHAR)), '') AS fppz,
      NULLIF(trim(CAST({fpzt_expr} AS VARCHAR)), '') AS fpzt,
      NULLIF(trim(CAST({sfzsfp_expr} AS VARCHAR)), '') AS sfzsfp,
      NULLIF(trim(CAST({fpfxdj_expr} AS VARCHAR)), '') AS fpfxdj,
      {kpr_expr} AS kpr,
      {bz_expr} AS bz,
      ? AS import_batch_id,
      CAST("import_session_id" AS VARCHAR) AS import_session_id,
      TRY_CAST("ods_file_seq" AS INTEGER) AS ods_file_seq,
      "source_excel_file" AS source_excel_file,
      "source_parquet_file" AS source_parquet_file,
      "source_sheet" AS source_sheet,
      TRY_CAST("ingest_ts" AS TIMESTAMP) AS ingest_ts,
      CURRENT_TIMESTAMP AS dwd_build_ts,
      ? AS dwd_build_id,
      ? AS first_import_batch_id,
      COALESCE(NULLIF(TRIM(CAST("source_excel_file" AS VARCHAR)), ''), '<unknown>') AS first_import_file
    FROM _ods_hdr
    WHERE {valid_where}
      AND EXTRACT(year FROM {date_try})::INTEGER = ?
    ON CONFLICT DO NOTHING
    """

    before_hdr = conn.execute("SELECT COUNT(*) FROM dwd_inv_header WHERE stat_year=?", [stat_year]).fetchone()[0]
    conn.execute(insert_hdr_sql, [import_batch_id, dwd_build_id, import_batch_id, stat_year])
    after_hdr = conn.execute("SELECT COUNT(*) FROM dwd_inv_header WHERE stat_year=?", [stat_year]).fetchone()[0]
    written_hdr = max(0, int(after_hdr) - int(before_hdr))

    rows_scanned_hdr = conn.execute("SELECT COUNT(*) FROM _ods_hdr").fetchone()[0]
    rows_rejected = len(reject_rows)

    # 写入 DWD detail（暂不做行级拒收；以日期可解析与序号可定位为最低门槛）
    # logic_line_no：与 `src.etl.dwd_shared_logic_line.build_create_ods_logic_line_view_sql` 一致：
    #   「同一发票键 _hdr_k + 同一 _scope_k」分区，ODS 序号排序、同键去重、详见销货清单类汇总参考行=0。
    # source_scope_key = md5(import_session_id || normalized(source_excel_file) || source_sheet)；
    #   其中 normalized(source_excel_file) 仅做小写与路径分隔符归一（\ -> /）。
    #   目的：最大限度避免不同来源文件/目录的明细共享编号；source_parquet_file 仅作血缘，不参与编号分区。
    #   汇总参考行（短语见 dwd_goods_summary_phrases）仅在**同 source_scope_key** 内判断。
    # detail_uuid：MD5(规范化票键 || logic_line_no)，**不含 source_sheet**；同票同一整数 logic_line_no 全库仅一条明细。
    #   多 sheet 视为重复导出时，后写入的同键行 INSERT ON CONFLICT DO NOTHING 丢弃，血缘保留先写入行（与 dwd_inv_header 先到先得一致）。
    #   详见 docs/dwd_inv_detail_multi_sheet_dedup.md
    if dtl_seq_col:
        seq_expr = _sql_quoted_identifier(dtl_seq_col)
        dtl_src_for_logic = "_ods_dtl"
        ord_key_sql = f"TRY_CAST({seq_expr} AS DOUBLE)"
    else:
        seq_expr = "__dtl_inner.__line_no"
        dtl_src_for_logic = """(
      SELECT *, CAST(row_number() OVER () AS INTEGER) AS __line_no
      FROM _ods_dtl
    ) __dtl_inner"""
        ord_key_sql = "CAST(__dtl_inner.__line_no AS DOUBLE)"
    goods_name_expr = col_d_bind("hwlwmc")
    spec_model_expr = col_d_bind("ggxh")
    unit_expr = col_d_bind("dw")
    qty_raw_expr = col_d_bind("sl")
    unit_price_raw_expr = col_d_bind("dj")
    tax_code_expr = col_d_bind("ssflbm")
    tax_rate_expr = col_d_bind("slv")
    special_business_type_expr = col_d_bind("special_business_type")
    remark_expr = col_d_bind("bz")

    fpdm_d = col_d_bind("fpdm")
    fphm_d = col_d_bind("fphm")
    sdfphm_d = col_d_bind("sdfphm")
    xfsbh_d = col_d_bind("xfsbh")
    xfmc_d = col_d_bind("xfmc")
    gfsbh_d = col_d_bind("gfsbh")
    gfmc_d = col_d_bind("gfmc")
    kpr_d = col_d_bind("kpr")
    fply_d = col_d_bind("fply")
    fppz_d = col_d_bind("fppz")
    fpzt_d = col_d_bind("fpzt")
    sfzsfp_d = col_d_bind("sfzsfp")
    fpfxdj_d = col_d_bind("fpfxdj")

    kprq_raw_d = col_d_bind("kprq")
    je_raw_d = col_d_bind("je")
    se_raw_d = col_d_bind("se")
    jshj_raw_d = col_d_bind("jshj")

    date_try_d = _sql_invoice_date_try_expr(kprq_raw_d)
    je_clean_d = clean_money(je_raw_d)
    se_clean_d = clean_money(se_raw_d)
    jshj_clean_d = clean_money(jshj_raw_d)
    je_try_d = f"TRY_CAST({je_clean_d} AS DECIMAL(18,2))"
    se_try_d = f"TRY_CAST({se_clean_d} AS DECIMAL(18,2))"
    jshj_try_d = f"TRY_CAST({jshj_clean_d} AS DECIMAL(18,2))"

    qty_try = f"TRY_CAST(trim(CAST({qty_raw_expr} AS VARCHAR)) AS DECIMAL(18,8))"
    unit_price_try = f"TRY_CAST(trim(CAST({unit_price_raw_expr} AS VARCHAR)) AS DECIMAL(18,8))"

    hdr_k_detail = (
        "md5("
        "COALESCE(fw2hw(CAST(" + fpdm_d + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + fphm_d + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + sdfphm_d + " AS VARCHAR)), ''))"
    )

    goods_lower_dtl_sql = f"LOWER(COALESCE(CAST({goods_name_expr} AS VARCHAR), ''))"
    ods_dtl_logic_view = build_create_ods_logic_line_view_sql(
        "_ods_dtl_logic",
        dtl_src_for_logic,
        hdr_k_detail,
        ord_key_sql,
        goods_lower_dtl_sql,
    )
    conn.execute(ods_dtl_logic_view)

    def spc_dwd_je_se_jshj_exprs(
        ods_cols: set[str],
        dwd_table: str,
        fpdm_sql: str,
        fphm_sql: str,
        sdfphm_sql: str,
    ) -> tuple[str, str, str]:
        """
        各专项表写入 dwd_spc_* 时共用的 je/se/jshj SQL 片段：
        先按本 sheet ODS + dwd_mapping 做金额 TRY；若为 NULL 则从 `_ods_dtl_logic`（信息汇总等 inv 明细 ODS）
        按与 `dwd_inv_detail` 相同的 detail_uuid 取数，解析式与 `INSERT dwd_inv_detail` 一致。
        """
        t_je = spc_money_try_expr(ods_cols, dwd_table, "je")
        t_se = spc_money_try_expr(ods_cols, dwd_table, "se")
        t_jshj = spc_money_try_expr(ods_cols, dwd_table, "jshj")
        return sql_spc_money_coalesce_from_ods_dtl(
            t_je,
            t_se,
            t_jshj,
            fpdm_sql,
            fphm_sql,
            sdfphm_sql,
            fpdm_d,
            fphm_d,
            sdfphm_d,
            je_try_d,
            se_try_d,
            jshj_try_d,
        )

    insert_dtl_sql = f"""
    INSERT INTO dwd_inv_detail (
      detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
      fpdm, fphm, sdfphm, kprq, invoice_date,
      special_business_type,
      xfsbh, xfmc, gfsbh, gfmc, fply, fppz, fpzt, sfzsfp, fpfxdj, kpr, bz,
      ssflbm, hwlwmc, ggxh, dw, sl, dj, je, slv, slv_num, se, jshj,
      import_batch_id, import_session_id, ods_file_seq,
      source_excel_file, source_parquet_file, source_sheet, ingest_ts,
      dwd_build_ts, dwd_build_id
    )
    SELECT
      md5(
        COALESCE(fw2hw(CAST({fpdm_d} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({fphm_d} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({sdfphm_d} AS VARCHAR)), '')
        || COALESCE(CAST(logic_line_no AS VARCHAR), '')
      ) AS detail_uuid,
      md5(
        COALESCE(fw2hw(CAST({fpdm_d} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({fphm_d} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({sdfphm_d} AS VARCHAR)), '')
      ) AS header_uuid,
      EXTRACT(year FROM {date_try_d})::SMALLINT AS stat_year,
      EXTRACT(month FROM {date_try_d})::SMALLINT AS stat_month,
      logic_line_no,
      {fpdm_d} AS fpdm,
      {fphm_d} AS fphm,
      {sdfphm_d} AS sdfphm,
      {kprq_raw_d} AS kprq,
      CAST({date_try_d} AS DATE) AS invoice_date,
      {special_business_type_expr} AS special_business_type,
      {xfsbh_d} AS xfsbh,
      {xfmc_d} AS xfmc,
      {gfsbh_d} AS gfsbh,
      {gfmc_d} AS gfmc,
      NULLIF(trim(CAST({fply_d} AS VARCHAR)), '') AS fply,
      NULLIF(trim(CAST({fppz_d} AS VARCHAR)), '') AS fppz,
      NULLIF(trim(CAST({fpzt_d} AS VARCHAR)), '') AS fpzt,
      NULLIF(trim(CAST({sfzsfp_d} AS VARCHAR)), '') AS sfzsfp,
      NULLIF(trim(CAST({fpfxdj_d} AS VARCHAR)), '') AS fpfxdj,
      {kpr_d} AS kpr,
      {remark_expr} AS bz,
      {tax_code_expr} AS ssflbm,
      {goods_name_expr} AS hwlwmc,
      {spec_model_expr} AS ggxh,
      {unit_expr} AS dw,
      {qty_try} AS sl,
      {unit_price_try} AS dj,
      {je_try_d} AS je,
      CAST({tax_rate_expr} AS VARCHAR) AS slv,
      TRY_CAST(parse_tax_rate_to_decimal({tax_rate_expr}) AS DECIMAL(10,6)) AS slv_num,
      {se_try_d} AS se,
      {jshj_try_d} AS jshj,
      ? AS import_batch_id,
      CAST("import_session_id" AS VARCHAR) AS import_session_id,
      TRY_CAST("ods_file_seq" AS INTEGER) AS ods_file_seq,
      "source_excel_file" AS source_excel_file,
      "source_parquet_file" AS source_parquet_file,
      "source_sheet" AS source_sheet,
      TRY_CAST("ingest_ts" AS TIMESTAMP) AS ingest_ts,
      CURRENT_TIMESTAMP AS dwd_build_ts,
      ? AS dwd_build_id
    FROM _ods_dtl_logic
    WHERE
      _ord_key IS NOT NULL
      AND {kprq_raw_d} IS NOT NULL
      AND {date_try_d} IS NOT NULL
      AND EXTRACT(year FROM {date_try_d})::INTEGER = ?
    ON CONFLICT DO NOTHING
    """

    before_dtl = conn.execute("SELECT COUNT(*) FROM dwd_inv_detail WHERE stat_year=?", [stat_year]).fetchone()[0]
    conn.execute(insert_dtl_sql, [import_batch_id, dwd_build_id, stat_year])
    after_dtl = conn.execute("SELECT COUNT(*) FROM dwd_inv_detail WHERE stat_year=?", [stat_year]).fetchone()[0]
    written_dtl = max(0, int(after_dtl) - int(before_dtl))
    rows_scanned_dtl = conn.execute("SELECT COUNT(*) FROM _ods_dtl").fetchone()[0]

    # ------------------------------------------------------------------
    # 专项运输：客运 / 货运 DWD
    # 规则要点：
    # - logic_line_no / detail_uuid：与 dwd_inv_detail 同一套生成逻辑（见 dwd_shared_logic_line）
    # - trip_date 仅允许来自 ODS 出行相关字段，不回落到 kprq
    # - trip_time：NULL 保持 NULL；非空解析失败写 00:00；解析成功统一 HH:MM
    # - is_business_in_scope：invoice_status='正常' 且 is_positive_invoice='是'
    # ------------------------------------------------------------------
    conn.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _ods_spc_passenger_raw AS
        SELECT *, 'spc_passenger_transport' AS __table_type FROM ods_spc_passenger_transport
        WHERE batch_id = {_bid_lit}{_sess_filter}
        UNION ALL BY NAME
        SELECT *, 'spc_rail_eticket' AS __table_type FROM ods_spc_rail_eticket
        WHERE batch_id = {_bid_lit}{_sess_filter}
        UNION ALL BY NAME
        SELECT *, 'spc_air_transport' AS __table_type FROM ods_spc_air_transport
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    )
    conn.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _ods_spc_freight_raw AS
        SELECT *, 'spc_freight' AS __table_type FROM ods_spc_freight
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    )

    p_cols = _view_column_names(conn, "_ods_spc_passenger_raw")
    f_cols = _view_column_names(conn, "_ods_spc_freight_raw")

    p_fpdm = _col_bind(p_cols, "invoice_code", "发票代码")
    p_fphm = _col_bind(p_cols, "invoice_no", "发票号码")
    p_sdfphm = _col_bind(p_cols, "sdfphm", "数电发票号码")
    p_kprq = _col_bind(p_cols, "kprq", "开票日期", "发票日期")
    p_fppz = _col_bind(p_cols, "invoice_type", "发票票种")
    p_status = _col_bind(p_cols, "invoice_status", "发票状态")
    p_positive = _col_bind(p_cols, "is_positive_invoice", "是否正数发票")
    p_remark = _col_bind(p_cols, "remark", "备注")
    p_xfsbh = _col_bind(p_cols, "xfsbh", "seller_tax_no", "销方识别号", "销方税号")
    p_xfmc = _col_bind(p_cols, "xfmc", "seller_name", "销方名称")
    p_gfsbh = _col_bind(p_cols, "gfsbh", "buyer_tax_no", "购买方识别号", "购买方税号", "购方税号")
    p_gfmc = _col_bind(p_cols, "gfmc", "buyer_name", "购买方名称", "购方名称")
    p_je_fin, p_se_fin, p_jshj_fin = spc_dwd_je_se_jshj_exprs(
        p_cols, "dwd_spc_transport_passenger", p_fpdm, p_fphm, p_sdfphm
    )
    p_passenger_name = _col_bind(p_cols, "passenger_name", "旅客姓名")
    p_id_no = _col_bind(p_cols, "traveler_id_no", "有效身份证号")
    p_trip_date_raw = _col_bind(p_cols, "trip_date", "出行日期", "日期", "rail_journey_date")
    p_trip_time_raw = _col_bind(p_cols, "rail_journey_time", "时间")
    p_departure = _col_bind(p_cols, "departure_place", "出发地")
    p_arrival = _col_bind(p_cols, "arrival_place", "到达地")
    p_service_class = _col_bind(p_cols, "service_class", "等级")
    p_trip_no = _col_bind(p_cols, "train_or_flight_no", "出行车次", "hang_ban_hao", "航班号")
    p_trip_date = _sql_invoice_date_try_expr(p_trip_date_raw)
    p_invoice_date = _sql_invoice_date_try_expr(p_kprq)
    p_trip_time = _sql_hhmm_try_expr(p_trip_time_raw)

    p_seq_col = _pick_first_column(p_cols, tuple(seq_cands) if seq_cands else ("seq_no", "序号"))
    if p_seq_col:
        p_src_for_logic = "_ods_spc_passenger_raw"
        p_ord_key_sql = f"TRY_CAST({_sql_quoted_identifier(p_seq_col)} AS DOUBLE)"
    else:
        p_src_for_logic = """(
      SELECT *, CAST(row_number() OVER () AS INTEGER) AS __spc_p_line
      FROM _ods_spc_passenger_raw
    ) __spc_p_inner"""
        p_ord_key_sql = "CAST(__spc_p_inner.__spc_p_line AS DOUBLE)"
    hdr_k_passenger = (
        "md5("
        "COALESCE(fw2hw(CAST(" + p_fpdm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + p_fphm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + p_sdfphm + " AS VARCHAR)), ''))"
    )
    p_hwlwmc = _col_bind(p_cols, "hwlwmc", "货物名称")
    p_goods_lower_sql = (
        "LOWER(COALESCE("
        "NULLIF(TRIM(CAST(" + p_hwlwmc + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + p_remark + " AS VARCHAR)), ''), "
        "''))"
    )
    conn.execute(
        build_create_ods_logic_line_view_sql(
            "_ods_spc_passenger_logic",
            p_src_for_logic,
            hdr_k_passenger,
            p_ord_key_sql,
            p_goods_lower_sql,
        )
    )

    before_spc_p = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_transport_passenger WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    conn.execute(
        f"""
        INSERT INTO dwd_spc_transport_passenger (
          detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
          fpdm, fphm, sdfphm, kprq, invoice_date, fppz, invoice_status, is_positive_invoice, remark, je, se, jshj,
          xfsbh, xfmc, gfsbh, gfmc,
          passenger_name, traveler_id_no, trip_date, trip_time, departure_place, arrival_place, transport_means_type, service_class, trip_no,
          source_table_type, source_scope_key, is_business_in_scope,
          import_batch_id, import_session_id, ods_file_seq, source_excel_file, source_parquet_file, source_sheet, ingest_ts, dwd_build_ts, dwd_build_id
        )
        SELECT
          {sql_detail_uuid_expr(p_fpdm, p_fphm, p_sdfphm)} AS detail_uuid,
          {sql_header_uuid_expr(p_fpdm, p_fphm, p_sdfphm)} AS header_uuid,
          EXTRACT(year FROM {p_invoice_date})::SMALLINT AS stat_year,
          EXTRACT(month FROM {p_invoice_date})::SMALLINT AS stat_month,
          logic_line_no,
          {p_fpdm}, {p_fphm}, {p_sdfphm},
          {p_kprq},
          CAST({p_invoice_date} AS DATE),
          NULLIF(trim(CAST({p_fppz} AS VARCHAR)), ''),
          NULLIF(trim(CAST({p_status} AS VARCHAR)), ''),
          NULLIF(trim(CAST({p_positive} AS VARCHAR)), ''),
          {p_remark},
          {p_je_fin},
          {p_se_fin},
          {p_jshj_fin},
          {p_xfsbh},
          {p_xfmc},
          {p_gfsbh},
          {p_gfmc},
          {p_passenger_name},
          {p_id_no},
          CAST({p_trip_date} AS DATE),
          {p_trip_time},
          {p_departure},
          {p_arrival},
          CASE
            WHEN __table_type = 'spc_rail_eticket' THEN '铁路'
            WHEN __table_type = 'spc_air_transport' THEN '航空'
            ELSE '其他'
          END AS transport_means_type,
          {p_service_class},
          {p_trip_no},
          __table_type AS source_table_type,
          CAST(_scope_k AS VARCHAR) AS source_scope_key,
          (
            NULLIF(trim(CAST({p_status} AS VARCHAR)), '') = '正常'
            AND NULLIF(trim(CAST({p_positive} AS VARCHAR)), '') = '是'
          ) AS is_business_in_scope,
          ?,
          CAST(import_session_id AS VARCHAR),
          TRY_CAST(ods_file_seq AS INTEGER),
          CAST(source_excel_file AS VARCHAR),
          CAST(source_parquet_file AS VARCHAR),
          CAST(source_sheet AS VARCHAR),
          TRY_CAST(ingest_ts AS TIMESTAMP),
          CURRENT_TIMESTAMP,
          ?
        FROM _ods_spc_passenger_logic
        WHERE _ord_key IS NOT NULL
          AND {p_invoice_date} IS NOT NULL
          AND EXTRACT(year FROM {p_invoice_date})::INTEGER = ?
        ON CONFLICT DO NOTHING
        """,
        [import_batch_id, dwd_build_id, stat_year],
    )
    after_spc_p = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_transport_passenger WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    written_spc_p = max(0, int(after_spc_p) - int(before_spc_p))
    rows_scanned_spc_p = conn.execute("SELECT COUNT(*) FROM _ods_spc_passenger_raw").fetchone()[0]

    f_fpdm = _col_bind(f_cols, "invoice_code", "发票代码")
    f_fphm = _col_bind(f_cols, "invoice_no", "发票号码")
    f_sdfphm = _col_bind(f_cols, "sdfphm", "数电发票号码")
    f_kprq = _col_bind(f_cols, "kprq", "开票日期", "发票日期")
    f_fppz = _col_bind(f_cols, "invoice_type", "发票票种")
    f_status = _col_bind(f_cols, "invoice_status", "发票状态")
    f_positive = _col_bind(f_cols, "is_positive_invoice", "是否正数发票")
    f_remark = _col_bind(f_cols, "remark", "备注")
    f_xfsbh = _col_bind(f_cols, "xfsbh", "seller_tax_no", "销方识别号", "销方税号")
    f_xfmc = _col_bind(f_cols, "xfmc", "seller_name", "销方名称")
    f_gfsbh = _col_bind(f_cols, "gfsbh", "buyer_tax_no", "购买方识别号", "购买方税号", "购方税号")
    f_gfmc = _col_bind(f_cols, "gfmc", "buyer_name", "购买方名称", "购方名称")
    f_je_fin, f_se_fin, f_jshj_fin = spc_dwd_je_se_jshj_exprs(
        f_cols, "dwd_spc_transport_freight", f_fpdm, f_fphm, f_sdfphm
    )
    f_cargo = _col_bind(f_cols, "cargo_name", "货物名称")
    f_departure = _col_bind(f_cols, "shipping_origin", "departure_place", "起运地")
    f_arrival = _col_bind(f_cols, "arrival_place", "到达地")
    f_means_plate_no = _col_bind(
        f_cols,
        "transport_means_plate_no",
        "运输工具牌号",
        "vehicle_plate_no",
        "车牌照号",
        "license_plate_no",
        "车牌号",
    )
    f_means_type = _col_bind(
        f_cols,
        "transport_means_type",
        "运输工具种类",
        "transport_tool_type",
        "交通工具类型",
    )
    f_invoice_date = _sql_invoice_date_try_expr(f_kprq)

    f_seq_col = _pick_first_column(f_cols, tuple(seq_cands) if seq_cands else ("seq_no", "序号"))
    if f_seq_col:
        f_src_for_logic = "_ods_spc_freight_raw"
        f_ord_key_sql = f"TRY_CAST({_sql_quoted_identifier(f_seq_col)} AS DOUBLE)"
    else:
        f_src_for_logic = """(
      SELECT *, CAST(row_number() OVER () AS INTEGER) AS __spc_f_line
      FROM _ods_spc_freight_raw
    ) __spc_f_inner"""
        f_ord_key_sql = "CAST(__spc_f_inner.__spc_f_line AS DOUBLE)"
    hdr_k_freight = (
        "md5("
        "COALESCE(fw2hw(CAST(" + f_fpdm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + f_fphm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + f_sdfphm + " AS VARCHAR)), ''))"
    )
    f_hwlwmc = _col_bind(f_cols, "hwlwmc", "货物名称")
    f_goods_lower_sql = (
        "LOWER(COALESCE("
        "NULLIF(TRIM(CAST(" + f_cargo + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + f_hwlwmc + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + f_remark + " AS VARCHAR)), ''), "
        "''))"
    )
    conn.execute(
        build_create_ods_logic_line_view_sql(
            "_ods_spc_freight_logic",
            f_src_for_logic,
            hdr_k_freight,
            f_ord_key_sql,
            f_goods_lower_sql,
        )
    )

    before_spc_f = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_transport_freight WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    conn.execute(
        f"""
        INSERT INTO dwd_spc_transport_freight (
          detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
          fpdm, fphm, sdfphm, kprq, invoice_date, fppz, invoice_status, is_positive_invoice, remark, je, se, jshj,
          xfsbh, xfmc, gfsbh, gfmc,
          cargo_name, departure_place, arrival_place, transport_means_plate_no, transport_means_type,
          source_table_type, source_scope_key, is_business_in_scope,
          import_batch_id, import_session_id, ods_file_seq, source_excel_file, source_parquet_file, source_sheet, ingest_ts, dwd_build_ts, dwd_build_id
        )
        SELECT
          {sql_detail_uuid_expr(f_fpdm, f_fphm, f_sdfphm)} AS detail_uuid,
          {sql_header_uuid_expr(f_fpdm, f_fphm, f_sdfphm)} AS header_uuid,
          EXTRACT(year FROM {f_invoice_date})::SMALLINT AS stat_year,
          EXTRACT(month FROM {f_invoice_date})::SMALLINT AS stat_month,
          logic_line_no,
          {f_fpdm}, {f_fphm}, {f_sdfphm},
          {f_kprq},
          CAST({f_invoice_date} AS DATE),
          NULLIF(trim(CAST({f_fppz} AS VARCHAR)), ''),
          NULLIF(trim(CAST({f_status} AS VARCHAR)), ''),
          NULLIF(trim(CAST({f_positive} AS VARCHAR)), ''),
          {f_remark},
          {f_je_fin},
          {f_se_fin},
          {f_jshj_fin},
          {f_xfsbh},
          {f_xfmc},
          {f_gfsbh},
          {f_gfmc},
          {f_cargo},
          {f_departure},
          {f_arrival},
          {f_means_plate_no},
          {f_means_type},
          __table_type AS source_table_type,
          CAST(_scope_k AS VARCHAR) AS source_scope_key,
          (
            NULLIF(trim(CAST({f_status} AS VARCHAR)), '') = '正常'
            AND NULLIF(trim(CAST({f_positive} AS VARCHAR)), '') = '是'
          ) AS is_business_in_scope,
          ?,
          CAST(import_session_id AS VARCHAR),
          TRY_CAST(ods_file_seq AS INTEGER),
          CAST(source_excel_file AS VARCHAR),
          CAST(source_parquet_file AS VARCHAR),
          CAST(source_sheet AS VARCHAR),
          TRY_CAST(ingest_ts AS TIMESTAMP),
          CURRENT_TIMESTAMP,
          ?
        FROM _ods_spc_freight_logic
        WHERE _ord_key IS NOT NULL
          AND {f_invoice_date} IS NOT NULL
          AND EXTRACT(year FROM {f_invoice_date})::INTEGER = ?
        ON CONFLICT DO NOTHING
        """,
        [import_batch_id, dwd_build_id, stat_year],
    )
    after_spc_f = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_transport_freight WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    written_spc_f = max(0, int(after_spc_f) - int(before_spc_f))
    rows_scanned_spc_f = conn.execute("SELECT COUNT(*) FROM _ods_spc_freight_raw").fetchone()[0]

    # ------------------------------------------------------------------
    # 专项：机动车销售（新车 + 二手车合并落盘；logic_line_no / detail_uuid 与 inv_detail 同源）
    # trade_org_*：经营/拍卖单位 与 二手车市场（及对应税号）非空合并
    # ------------------------------------------------------------------
    conn.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _ods_spc_vehicle_sales_raw AS
        SELECT *, 'spc_vehicle' AS __table_type FROM ods_spc_vehicle
        WHERE batch_id = {_bid_lit}{_sess_filter}
        UNION ALL BY NAME
        SELECT *, 'spc_used_vehicle' AS __table_type FROM ods_spc_used_vehicle
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    )
    v_cols = _view_column_names(conn, "_ods_spc_vehicle_sales_raw")
    v_fpdm = _col_bind(v_cols, "invoice_code", "发票代码")
    v_fphm = _col_bind(v_cols, "invoice_no", "发票号码")
    v_sdfphm = _col_bind(v_cols, "sdfphm", "数电发票号码")
    v_kprq = _col_bind(v_cols, "kprq", "开票日期", "发票日期")
    v_fppz = _col_bind(v_cols, "invoice_type", "发票票种")
    v_status = _col_bind(v_cols, "invoice_status", "发票状态")
    v_positive = _col_bind(v_cols, "is_positive_invoice", "是否正数发票")
    v_remark = _col_bind(v_cols, "remark", "备注")
    v_xfsbh = _col_bind(v_cols, "xfsbh", "seller_tax_no", "销方识别号", "销方税号")
    v_xfmc = _col_bind(v_cols, "xfmc", "seller_name", "销方名称")
    v_gfsbh = _col_bind(v_cols, "gfsbh", "buyer_tax_no", "购买方识别号", "购买方税号", "购方税号")
    v_gfmc = _col_bind(v_cols, "gfmc", "buyer_name", "购买方名称", "购方名称")
    v_je_fin, v_se_fin, v_jshj_fin = spc_dwd_je_se_jshj_exprs(
        v_cols, "dwd_spc_vehicle_sales", v_fpdm, v_fphm, v_sdfphm
    )
    v_invoice_date = _sql_invoice_date_try_expr(v_kprq)
    v_seq_col = _pick_first_column(v_cols, tuple(seq_cands) if seq_cands else ("seq_no", "序号"))
    if v_seq_col:
        v_src_for_logic = "_ods_spc_vehicle_sales_raw"
        v_ord_key_sql = f"TRY_CAST({_sql_quoted_identifier(v_seq_col)} AS DOUBLE)"
    else:
        v_src_for_logic = """(
      SELECT *, CAST(row_number() OVER () AS INTEGER) AS __spc_vs_line
      FROM _ods_spc_vehicle_sales_raw
    ) __spc_vs_inner"""
        v_ord_key_sql = "CAST(__spc_vs_inner.__spc_vs_line AS DOUBLE)"
    hdr_k_vehicle = (
        "md5("
        "COALESCE(fw2hw(CAST(" + v_fpdm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + v_fphm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + v_sdfphm + " AS VARCHAR)), ''))"
    )
    v_goods_nm = _col_bind(v_cols, "goods_name", "货物或应税劳务名称", "hwlwmc", "货物名称")
    v_goods_lower_sql = (
        "LOWER(COALESCE("
        "NULLIF(TRIM(CAST(" + v_goods_nm + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + v_remark + " AS VARCHAR)), ''), ''))"
    )
    conn.execute(
        build_create_ods_logic_line_view_sql(
            "_ods_spc_vehicle_sales_logic",
            v_src_for_logic,
            hdr_k_vehicle,
            v_ord_key_sql,
            v_goods_lower_sql,
        )
    )
    v_auc = _col_bind(v_cols, "auction_operator", "经营/拍卖单位")
    v_auc_tax = _col_bind(v_cols, "auction_operator_tax_no", "经营/拍卖单位纳税人识别号")
    v_mkt = _col_bind(v_cols, "used_vehicle_market", "二手车市场")
    v_mkt_tax = _col_bind(v_cols, "used_vehicle_market_tax_no", "二手车市场纳税人识别号")
    v_trade_org_name_sql = (
        "NULLIF(TRIM(CAST(COALESCE("
        "NULLIF(TRIM(CAST(" + v_auc + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + v_mkt + " AS VARCHAR)), '')) AS VARCHAR)), '')"
    )
    v_trade_org_tax_sql = (
        "NULLIF(TRIM(CAST(COALESCE("
        "NULLIF(TRIM(CAST(" + v_auc_tax + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + v_mkt_tax + " AS VARCHAR)), '')) AS VARCHAR)), '')"
    )
    v_vin = _col_bind(v_cols, "vin_chassis", "车辆识别代号/车架号")
    v_engine = _col_bind(v_cols, "engine_no", "发动机号码")
    v_cert = _col_bind(v_cols, "vehicle_certificate_no", "合格证号")
    v_comm = _col_bind(v_cols, "commodity_inspection_no", "商检号码", "商检单号")
    v_origin = _col_bind(v_cols, "place_of_origin", "产地")
    v_plate = _col_bind(v_cols, "vehicle_plate_no", "车牌照号", "车牌号")
    v_reg = _col_bind(v_cols, "registration_cert_no", "登记证号")
    v_transfer = _col_bind(v_cols, "transfer_dmv_office", "转入地车辆管理所名称")
    v_buy_addr = _col_bind(v_cols, "buyer_address", "购买方地址")
    v_buy_phone = _col_bind(v_cols, "buyer_phone", "购买方联系电话")

    before_spc_vs = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_vehicle_sales WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    conn.execute(
        f"""
        INSERT INTO dwd_spc_vehicle_sales (
          detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
          fpdm, fphm, sdfphm, kprq, invoice_date, fppz, invoice_status, is_positive_invoice, remark, je, se, jshj,
          xfsbh, xfmc, gfsbh, gfmc,
          source_table_type, trade_org_name, trade_org_tax_no,
          vin_chassis, engine_no, vehicle_certificate_no, commodity_inspection_no, place_of_origin,
          vehicle_plate_no, registration_cert_no, transfer_dmv_office, buyer_address, buyer_phone,
          source_scope_key, is_business_in_scope,
          import_batch_id, import_session_id, ods_file_seq, source_excel_file, source_parquet_file, source_sheet, ingest_ts, dwd_build_ts, dwd_build_id
        )
        SELECT
          {sql_detail_uuid_expr(v_fpdm, v_fphm, v_sdfphm)} AS detail_uuid,
          {sql_header_uuid_expr(v_fpdm, v_fphm, v_sdfphm)} AS header_uuid,
          EXTRACT(year FROM {v_invoice_date})::SMALLINT AS stat_year,
          EXTRACT(month FROM {v_invoice_date})::SMALLINT AS stat_month,
          logic_line_no,
          {v_fpdm}, {v_fphm}, {v_sdfphm},
          {v_kprq},
          CAST({v_invoice_date} AS DATE),
          NULLIF(trim(CAST({v_fppz} AS VARCHAR)), ''),
          NULLIF(trim(CAST({v_status} AS VARCHAR)), ''),
          NULLIF(trim(CAST({v_positive} AS VARCHAR)), ''),
          {v_remark},
          {v_je_fin},
          {v_se_fin},
          {v_jshj_fin},
          {v_xfsbh},
          {v_xfmc},
          {v_gfsbh},
          {v_gfmc},
          __table_type AS source_table_type,
          {v_trade_org_name_sql} AS trade_org_name,
          {v_trade_org_tax_sql} AS trade_org_tax_no,
          {v_vin},
          {v_engine},
          {v_cert},
          {v_comm},
          {v_origin},
          {v_plate},
          {v_reg},
          {v_transfer},
          {v_buy_addr},
          {v_buy_phone},
          CAST(_scope_k AS VARCHAR) AS source_scope_key,
          (
            NULLIF(trim(CAST({v_status} AS VARCHAR)), '') = '正常'
            AND NULLIF(trim(CAST({v_positive} AS VARCHAR)), '') = '是'
          ) AS is_business_in_scope,
          ?,
          CAST(import_session_id AS VARCHAR),
          TRY_CAST(ods_file_seq AS INTEGER),
          CAST(source_excel_file AS VARCHAR),
          CAST(source_parquet_file AS VARCHAR),
          CAST(source_sheet AS VARCHAR),
          TRY_CAST(ingest_ts AS TIMESTAMP),
          CURRENT_TIMESTAMP,
          ?
        FROM _ods_spc_vehicle_sales_logic
        WHERE _ord_key IS NOT NULL
          AND {v_invoice_date} IS NOT NULL
          AND EXTRACT(year FROM {v_invoice_date})::INTEGER = ?
        ON CONFLICT DO NOTHING
        """,
        [import_batch_id, dwd_build_id, stat_year],
    )
    after_spc_vs = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_vehicle_sales WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    written_spc_vs = max(0, int(after_spc_vs) - int(before_spc_vs))
    rows_scanned_spc_vs = conn.execute("SELECT COUNT(*) FROM _ods_spc_vehicle_sales_raw").fetchone()[0]

    # ------------------------------------------------------------------
    # 专项：建筑服务
    # ------------------------------------------------------------------
    conn.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _ods_spc_construction_raw AS
        SELECT *, 'spc_construction' AS __table_type FROM ods_spc_construction
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    )
    c_cols = _view_column_names(conn, "_ods_spc_construction_raw")
    c_fpdm = _col_bind(c_cols, "invoice_code", "发票代码")
    c_fphm = _col_bind(c_cols, "invoice_no", "发票号码")
    c_sdfphm = _col_bind(c_cols, "sdfphm", "数电发票号码")
    c_kprq = _col_bind(c_cols, "kprq", "开票日期", "发票日期")
    c_fppz = _col_bind(c_cols, "invoice_type", "发票票种")
    c_status = _col_bind(c_cols, "invoice_status", "发票状态")
    c_positive = _col_bind(c_cols, "is_positive_invoice", "是否正数发票")
    c_remark = _col_bind(c_cols, "remark", "备注")
    c_xfsbh = _col_bind(c_cols, "xfsbh", "seller_tax_no", "销方识别号", "销方税号")
    c_xfmc = _col_bind(c_cols, "xfmc", "seller_name", "销方名称")
    c_gfsbh = _col_bind(c_cols, "gfsbh", "buyer_tax_no", "购买方识别号", "购买方税号", "购方税号")
    c_gfmc = _col_bind(c_cols, "gfmc", "buyer_name", "购买方名称", "购方名称")
    c_je_fin, c_se_fin, c_jshj_fin = spc_dwd_je_se_jshj_exprs(
        c_cols, "dwd_spc_construction_service", c_fpdm, c_fphm, c_sdfphm
    )
    c_invoice_date = _sql_invoice_date_try_expr(c_kprq)
    c_seq_col = _pick_first_column(c_cols, tuple(seq_cands) if seq_cands else ("seq_no", "序号"))
    if c_seq_col:
        c_src_for_logic = "_ods_spc_construction_raw"
        c_ord_key_sql = f"TRY_CAST({_sql_quoted_identifier(c_seq_col)} AS DOUBLE)"
    else:
        c_src_for_logic = """(
      SELECT *, CAST(row_number() OVER () AS INTEGER) AS __spc_cs_line
      FROM _ods_spc_construction_raw
    ) __spc_cs_inner"""
        c_ord_key_sql = "CAST(__spc_cs_inner.__spc_cs_line AS DOUBLE)"
    hdr_k_construction = (
        "md5("
        "COALESCE(fw2hw(CAST(" + c_fpdm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + c_fphm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + c_sdfphm + " AS VARCHAR)), ''))"
    )
    c_goods_nm = _col_bind(c_cols, "goods_name", "货物或应税劳务名称", "hwlwmc", "货物名称")
    c_goods_lower_sql = (
        "LOWER(COALESCE("
        "NULLIF(TRIM(CAST(" + c_goods_nm + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + c_remark + " AS VARCHAR)), ''), ''))"
    )
    conn.execute(
        build_create_ods_logic_line_view_sql(
            "_ods_spc_construction_logic",
            c_src_for_logic,
            hdr_k_construction,
            c_ord_key_sql,
            c_goods_lower_sql,
        )
    )
    c_proj = _col_bind(c_cols, "construction_project_name", "建筑项目名称")
    c_loc = _col_bind(c_cols, "construction_service_location", "建筑服务发生地")
    c_cross = _col_bind(c_cols, "cross_region_tax_mgmt_no", "跨区域涉税事项报验管理编号")

    before_spc_cs = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_construction_service WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    conn.execute(
        f"""
        INSERT INTO dwd_spc_construction_service (
          detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
          fpdm, fphm, sdfphm, kprq, invoice_date, fppz, invoice_status, is_positive_invoice, remark, je, se, jshj,
          xfsbh, xfmc, gfsbh, gfmc,
          construction_project_name, construction_service_location, cross_region_tax_mgmt_no,
          source_table_type, source_scope_key, is_business_in_scope,
          import_batch_id, import_session_id, ods_file_seq, source_excel_file, source_parquet_file, source_sheet, ingest_ts, dwd_build_ts, dwd_build_id
        )
        SELECT
          {sql_detail_uuid_expr(c_fpdm, c_fphm, c_sdfphm)} AS detail_uuid,
          {sql_header_uuid_expr(c_fpdm, c_fphm, c_sdfphm)} AS header_uuid,
          EXTRACT(year FROM {c_invoice_date})::SMALLINT AS stat_year,
          EXTRACT(month FROM {c_invoice_date})::SMALLINT AS stat_month,
          logic_line_no,
          {c_fpdm}, {c_fphm}, {c_sdfphm},
          {c_kprq},
          CAST({c_invoice_date} AS DATE),
          NULLIF(trim(CAST({c_fppz} AS VARCHAR)), ''),
          NULLIF(trim(CAST({c_status} AS VARCHAR)), ''),
          NULLIF(trim(CAST({c_positive} AS VARCHAR)), ''),
          {c_remark},
          {c_je_fin},
          {c_se_fin},
          {c_jshj_fin},
          {c_xfsbh},
          {c_xfmc},
          {c_gfsbh},
          {c_gfmc},
          {c_proj},
          {c_loc},
          {c_cross},
          __table_type AS source_table_type,
          CAST(_scope_k AS VARCHAR) AS source_scope_key,
          (
            NULLIF(trim(CAST({c_status} AS VARCHAR)), '') = '正常'
            AND NULLIF(trim(CAST({c_positive} AS VARCHAR)), '') = '是'
          ) AS is_business_in_scope,
          ?,
          CAST(import_session_id AS VARCHAR),
          TRY_CAST(ods_file_seq AS INTEGER),
          CAST(source_excel_file AS VARCHAR),
          CAST(source_parquet_file AS VARCHAR),
          CAST(source_sheet AS VARCHAR),
          TRY_CAST(ingest_ts AS TIMESTAMP),
          CURRENT_TIMESTAMP,
          ?
        FROM _ods_spc_construction_logic
        WHERE _ord_key IS NOT NULL
          AND {c_invoice_date} IS NOT NULL
          AND EXTRACT(year FROM {c_invoice_date})::INTEGER = ?
        ON CONFLICT DO NOTHING
        """,
        [import_batch_id, dwd_build_id, stat_year],
    )
    after_spc_cs = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_construction_service WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    written_spc_cs = max(0, int(after_spc_cs) - int(before_spc_cs))
    rows_scanned_spc_cs = conn.execute("SELECT COUNT(*) FROM _ods_spc_construction_raw").fetchone()[0]

    # ------------------------------------------------------------------
    # 专项：不动产经营租赁
    # ------------------------------------------------------------------
    conn.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _ods_spc_estate_lease_raw AS
        SELECT *, 'spc_estate_lease' AS __table_type FROM ods_spc_estate_lease
        WHERE batch_id = {_bid_lit}{_sess_filter}
        """
    )
    e_cols = _view_column_names(conn, "_ods_spc_estate_lease_raw")
    e_fpdm = _col_bind(e_cols, "invoice_code", "发票代码")
    e_fphm = _col_bind(e_cols, "invoice_no", "发票号码")
    e_sdfphm = _col_bind(e_cols, "sdfphm", "数电发票号码")
    e_kprq = _col_bind(e_cols, "kprq", "开票日期", "发票日期")
    e_fppz = _col_bind(e_cols, "invoice_type", "发票票种")
    e_status = _col_bind(e_cols, "invoice_status", "发票状态")
    e_positive = _col_bind(e_cols, "is_positive_invoice", "是否正数发票")
    e_remark = _col_bind(e_cols, "remark", "备注")
    e_xfsbh = _col_bind(e_cols, "xfsbh", "seller_tax_no", "销方识别号", "销方税号")
    e_xfmc = _col_bind(e_cols, "xfmc", "seller_name", "销方名称")
    e_gfsbh = _col_bind(e_cols, "gfsbh", "buyer_tax_no", "购买方识别号", "购买方税号", "购方税号")
    e_gfmc = _col_bind(e_cols, "gfmc", "buyer_name", "购买方名称", "购方名称")
    e_je_fin, e_se_fin, e_jshj_fin = spc_dwd_je_se_jshj_exprs(
        e_cols, "dwd_spc_estate_lease", e_fpdm, e_fphm, e_sdfphm
    )
    e_invoice_date = _sql_invoice_date_try_expr(e_kprq)
    e_seq_col = _pick_first_column(e_cols, tuple(seq_cands) if seq_cands else ("seq_no", "序号"))
    if e_seq_col:
        e_src_for_logic = "_ods_spc_estate_lease_raw"
        e_ord_key_sql = f"TRY_CAST({_sql_quoted_identifier(e_seq_col)} AS DOUBLE)"
    else:
        e_src_for_logic = """(
      SELECT *, CAST(row_number() OVER () AS INTEGER) AS __spc_el_line
      FROM _ods_spc_estate_lease_raw
    ) __spc_el_inner"""
        e_ord_key_sql = "CAST(__spc_el_inner.__spc_el_line AS DOUBLE)"
    hdr_k_estate = (
        "md5("
        "COALESCE(fw2hw(CAST(" + e_fpdm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + e_fphm + " AS VARCHAR)), '')"
        "|| COALESCE(fw2hw(CAST(" + e_sdfphm + " AS VARCHAR)), ''))"
    )
    e_goods_nm = _col_bind(e_cols, "goods_name", "货物或应税劳务名称", "hwlwmc", "货物名称")
    e_goods_lower_sql = (
        "LOWER(COALESCE("
        "NULLIF(TRIM(CAST(" + e_goods_nm + " AS VARCHAR)), ''), "
        "NULLIF(TRIM(CAST(" + e_remark + " AS VARCHAR)), ''), ''))"
    )
    conn.execute(
        build_create_ods_logic_line_view_sql(
            "_ods_spc_estate_lease_logic",
            e_src_for_logic,
            hdr_k_estate,
            e_ord_key_sql,
            e_goods_lower_sql,
        )
    )
    e_plate = _col_bind(e_cols, "license_plate_no", "车牌号")
    e_title = _col_bind(e_cols, "property_title_cert_no", "产权证书/不动产权证号")

    before_spc_el = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_estate_lease WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    conn.execute(
        f"""
        INSERT INTO dwd_spc_estate_lease (
          detail_uuid, header_uuid, stat_year, stat_month, logic_line_no,
          fpdm, fphm, sdfphm, kprq, invoice_date, fppz, invoice_status, is_positive_invoice, remark, je, se, jshj,
          xfsbh, xfmc, gfsbh, gfmc,
          license_plate_no, property_title_cert_no,
          source_table_type, source_scope_key, is_business_in_scope,
          import_batch_id, import_session_id, ods_file_seq, source_excel_file, source_parquet_file, source_sheet, ingest_ts, dwd_build_ts, dwd_build_id
        )
        SELECT
          {sql_detail_uuid_expr(e_fpdm, e_fphm, e_sdfphm)} AS detail_uuid,
          {sql_header_uuid_expr(e_fpdm, e_fphm, e_sdfphm)} AS header_uuid,
          EXTRACT(year FROM {e_invoice_date})::SMALLINT AS stat_year,
          EXTRACT(month FROM {e_invoice_date})::SMALLINT AS stat_month,
          logic_line_no,
          {e_fpdm}, {e_fphm}, {e_sdfphm},
          {e_kprq},
          CAST({e_invoice_date} AS DATE),
          NULLIF(trim(CAST({e_fppz} AS VARCHAR)), ''),
          NULLIF(trim(CAST({e_status} AS VARCHAR)), ''),
          NULLIF(trim(CAST({e_positive} AS VARCHAR)), ''),
          {e_remark},
          {e_je_fin},
          {e_se_fin},
          {e_jshj_fin},
          {e_xfsbh},
          {e_xfmc},
          {e_gfsbh},
          {e_gfmc},
          {e_plate},
          {e_title},
          __table_type AS source_table_type,
          CAST(_scope_k AS VARCHAR) AS source_scope_key,
          (
            NULLIF(trim(CAST({e_status} AS VARCHAR)), '') = '正常'
            AND NULLIF(trim(CAST({e_positive} AS VARCHAR)), '') = '是'
          ) AS is_business_in_scope,
          ?,
          CAST(import_session_id AS VARCHAR),
          TRY_CAST(ods_file_seq AS INTEGER),
          CAST(source_excel_file AS VARCHAR),
          CAST(source_parquet_file AS VARCHAR),
          CAST(source_sheet AS VARCHAR),
          TRY_CAST(ingest_ts AS TIMESTAMP),
          CURRENT_TIMESTAMP,
          ?
        FROM _ods_spc_estate_lease_logic
        WHERE _ord_key IS NOT NULL
          AND {e_invoice_date} IS NOT NULL
          AND EXTRACT(year FROM {e_invoice_date})::INTEGER = ?
        ON CONFLICT DO NOTHING
        """,
        [import_batch_id, dwd_build_id, stat_year],
    )
    after_spc_el = conn.execute(
        "SELECT COUNT(*) FROM dwd_spc_estate_lease WHERE stat_year=?",
        [stat_year],
    ).fetchone()[0]
    written_spc_el = max(0, int(after_spc_el) - int(before_spc_el))
    rows_scanned_spc_el = conn.execute("SELECT COUNT(*) FROM _ods_spc_estate_lease_raw").fetchone()[0]

    # 专项 je/se/jshj：与 INSERT 内 COALESCE 一致，再从 dwd_inv_detail 回填仍为 NULL 的单元
    # （ODS 专项 sheet 常无标准 amount 列；历史行若 INSERT 子查询未命中，此处可补齐）
    _spc_money_bf = [import_batch_id, stat_year]
    for _spc_tbl in (
        "dwd_spc_transport_passenger",
        "dwd_spc_transport_freight",
        "dwd_spc_vehicle_sales",
        "dwd_spc_construction_service",
        "dwd_spc_estate_lease",
    ):
        conn.execute(sql_update_spc_money_from_inv_detail(_spc_tbl), _spc_money_bf)

    # 数据质量：同票同 source_scope_key 下「logic_line_no>0」行数，专项 vs dwd_inv_detail（见 dwd_shared_logic_line）
    _dq_keys = (
        "header_uuid",
        "source_scope_key",
        "inv_detail_positive_lines",
        "spc_positive_lines",
    )
    # dtl / spc 两个子查询各绑定 stat_year、import_batch_id（见 dwd_shared_logic_line）
    _dq_linecount_params = [stat_year, import_batch_id, stat_year, import_batch_id]
    dq_spc_passenger_linecount_mismatch = [
        dict(zip(_dq_keys, row))
        for row in conn.execute(
            sql_spc_inv_positive_linecount_mismatch("dwd_spc_transport_passenger"),
            _dq_linecount_params,
        ).fetchall()
    ]
    dq_spc_freight_linecount_mismatch = [
        dict(zip(_dq_keys, row))
        for row in conn.execute(
            sql_spc_inv_positive_linecount_mismatch("dwd_spc_transport_freight"),
            _dq_linecount_params,
        ).fetchall()
    ]
    dq_spc_vehicle_sales_linecount_mismatch = [
        dict(zip(_dq_keys, row))
        for row in conn.execute(
            sql_spc_inv_positive_linecount_mismatch("dwd_spc_vehicle_sales"),
            _dq_linecount_params,
        ).fetchall()
    ]
    dq_spc_construction_linecount_mismatch = [
        dict(zip(_dq_keys, row))
        for row in conn.execute(
            sql_spc_inv_positive_linecount_mismatch("dwd_spc_construction_service"),
            _dq_linecount_params,
        ).fetchall()
    ]
    dq_spc_estate_lease_linecount_mismatch = [
        dict(zip(_dq_keys, row))
        for row in conn.execute(
            sql_spc_inv_positive_linecount_mismatch("dwd_spc_estate_lease"),
            _dq_linecount_params,
        ).fetchall()
    ]

    # 数据质量报告：按 detail_uuid 与 dwd_inv_detail 对照金额/是否存在（仅透出，不改写；见 sql_amount_dq_vs_inv_detail）
    _amt_dq_keys = (
        "detail_uuid",
        "header_uuid",
        "spc_logic_line_no",
        "spc_je",
        "inv_je",
        "spc_se",
        "inv_se",
        "spc_jshj",
        "inv_jshj",
        "dq_issue",
    )
    dq_spc_transport_passenger_amount_vs_inv_detail = [
        dict(zip(_amt_dq_keys, row))
        for row in conn.execute(
            sql_amount_dq_vs_inv_detail("dwd_spc_transport_passenger"),
            [stat_year, import_batch_id],
        ).fetchall()
    ]
    dq_spc_transport_freight_amount_vs_inv_detail = [
        dict(zip(_amt_dq_keys, row))
        for row in conn.execute(
            sql_amount_dq_vs_inv_detail("dwd_spc_transport_freight"),
            [stat_year, import_batch_id],
        ).fetchall()
    ]
    dq_spc_vehicle_sales_amount_vs_inv_detail = [
        dict(zip(_amt_dq_keys, row))
        for row in conn.execute(
            sql_amount_dq_vs_inv_detail("dwd_spc_vehicle_sales"),
            [stat_year, import_batch_id],
        ).fetchall()
    ]
    dq_spc_construction_service_amount_vs_inv_detail = [
        dict(zip(_amt_dq_keys, row))
        for row in conn.execute(
            sql_amount_dq_vs_inv_detail("dwd_spc_construction_service"),
            [stat_year, import_batch_id],
        ).fetchall()
    ]
    dq_spc_estate_lease_amount_vs_inv_detail = [
        dict(zip(_amt_dq_keys, row))
        for row in conn.execute(
            sql_amount_dq_vs_inv_detail("dwd_spc_estate_lease"),
            [stat_year, import_batch_id],
        ).fetchall()
    ]

    # ------------------------------------------------------------------
    # 导入后回填：平账（C 层 post_aggregate）
    # 仅更新本次构建写入的 header 行（按 dwd_build_id 限定），避免重跑污染历史行。
    # ------------------------------------------------------------------
    conn.execute(
        """
        WITH dtl_sum AS (
          SELECT
            header_uuid,
            SUM(jshj) AS detail_total_amount
          FROM dwd_inv_detail
          WHERE stat_year = ?
            AND import_batch_id = ?
            AND logic_line_no > 0
          GROUP BY header_uuid
        )
        UPDATE dwd_inv_header h
        SET
          detail_total_amount = s.detail_total_amount,
          balance_diff = h.jshj - s.detail_total_amount,
          is_balanced = CASE
            WHEN h.jshj IS NULL OR s.detail_total_amount IS NULL THEN '未校验'
            WHEN abs(h.jshj - s.detail_total_amount) <= COALESCE(h.balance_tolerance, 0.10) THEN '平账'
            ELSE '不平账'
          END,
          balance_check_time = CURRENT_TIMESTAMP
        FROM dtl_sum s
        WHERE h.header_uuid = s.header_uuid
          AND h.stat_year = ?
          AND h.dwd_build_id = ?
        """,
        [stat_year, import_batch_id, stat_year, dwd_build_id],
    )

    # ------------------------------------------------------------------
    # 导入后回填：红蓝关联（C 层 post_etl）
    # - 仅「发票状态视为正常」的红票参与关联与汇总：显式「正常」或 fpzt 为 NULL/空白（空仍属数据质量异常，可单独统计；计算口径视同正常）；已作废等不参与。
    # - 备注解析：_bz_target_blue_header_uuid（UDF bz_blue_uuid_from_bz），反查键为 header_uuid（可跨年）。
    # - 红票关联成功后 net_calc_status=「蓝票已计算」；红票不写 net_je/net_se/net_jshj。
    # - 蓝票：跨 stat_year 汇总「正常」红票的 je/se/jshj 计入 net_* 与 red_*。
    # ------------------------------------------------------------------
    conn.execute(
        """
        UPDATE dwd_inv_header AS h
        SET related_blue_invoice_uuid = b.header_uuid
        FROM dwd_inv_header AS b
        WHERE h.stat_year = ?
          AND h.import_batch_id = ?
          AND h.dwd_build_id = ?
          AND coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') = '正常'
          AND bz_blue_uuid_from_bz(h.bz) IS NOT NULL
          AND b.header_uuid = bz_blue_uuid_from_bz(h.bz)
        """,
        [stat_year, import_batch_id, dwd_build_id],
    )
    conn.execute(
        """
        UPDATE dwd_inv_header
        SET is_orphan_red = FALSE,
            net_calc_status = '蓝票已计算',
            net_calc_time = CURRENT_TIMESTAMP
        WHERE stat_year = ?
          AND import_batch_id = ?
          AND dwd_build_id = ?
          AND related_blue_invoice_uuid IS NOT NULL
          AND coalesce(nullif(trim(cast(fpzt AS VARCHAR)), ''), '正常') = '正常'
        """,
        [stat_year, import_batch_id, dwd_build_id],
    )
    conn.execute(
        """
        UPDATE dwd_inv_header AS h
        SET is_orphan_red = TRUE,
            net_calc_status = '孤立红票'
        WHERE h.stat_year = ?
          AND h.import_batch_id = ?
          AND h.dwd_build_id = ?
          AND coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') = '正常'
          AND h.related_blue_invoice_uuid IS NULL
          AND bz_blue_uuid_from_bz(h.bz) IS NOT NULL
        """,
        [stat_year, import_batch_id, dwd_build_id],
    )
    conn.execute(
        """
        UPDATE dwd_inv_header AS b
        SET
          red_invoice_count = CAST(agg.n AS INTEGER),
          red_offset_jshj = agg.sum_jshj,
          net_je = COALESCE(b.je, 0) + agg.sum_je,
          net_se = COALESCE(b.se, 0) + agg.sum_se,
          net_jshj = COALESCE(b.jshj, 0) + agg.sum_jshj,
          is_fully_reversed = (
            b.jshj IS NOT NULL
            AND ABS(b.jshj + agg.sum_jshj) <= COALESCE(b.balance_tolerance, 0.10)
          ),
          net_calc_time = CURRENT_TIMESTAMP,
          net_calc_status = CASE
            WHEN b.net_calc_status = '已作废' THEN b.net_calc_status
            WHEN b.jshj IS NOT NULL
                 AND ABS(b.jshj + agg.sum_jshj) <= COALESCE(b.balance_tolerance, 0.10) THEN '已全额红冲'
            WHEN agg.n > 0 THEN '蓝票已计算'
            ELSE COALESCE(b.net_calc_status, '未计算')
          END
        FROM (
          SELECT
            related_blue_invoice_uuid AS blue_h,
            COUNT(*) AS n,
            COALESCE(SUM(je), 0) AS sum_je,
            COALESCE(SUM(se), 0) AS sum_se,
            COALESCE(SUM(jshj), 0) AS sum_jshj
          FROM dwd_inv_header
          WHERE related_blue_invoice_uuid IS NOT NULL
            AND coalesce(nullif(trim(cast(fpzt AS VARCHAR)), ''), '正常') = '正常'
          GROUP BY related_blue_invoice_uuid
        ) AS agg
        WHERE b.header_uuid = agg.blue_h
          AND b.header_uuid IN (
            SELECT DISTINCT r.related_blue_invoice_uuid
            FROM dwd_inv_header AS r
            WHERE r.stat_year = ?
              AND r.import_batch_id = ?
              AND r.dwd_build_id = ?
              AND r.related_blue_invoice_uuid IS NOT NULL
              AND coalesce(nullif(trim(cast(r.fpzt AS VARCHAR)), ''), '正常') = '正常'
          )
        """,
        [stat_year, import_batch_id, dwd_build_id],
    )

    status = "success" if rows_rejected == 0 else "warning"
    return {
        "status": status,
        "stage": "cleaner",
        "stat_year": stat_year,
        "import_batch_id": import_batch_id,
        "dwd_build_id": dwd_build_id,
        "rows_scanned_header": int(rows_scanned_hdr),
        "rows_written_header": int(written_hdr),
        "rows_scanned_detail": int(rows_scanned_dtl),
        "rows_written_detail": int(written_dtl),
        "rows_scanned_spc_transport_passenger": int(rows_scanned_spc_p),
        "rows_written_spc_transport_passenger": int(written_spc_p),
        "rows_scanned_spc_transport_freight": int(rows_scanned_spc_f),
        "rows_written_spc_transport_freight": int(written_spc_f),
        "rows_scanned_spc_vehicle_sales": int(rows_scanned_spc_vs),
        "rows_written_spc_vehicle_sales": int(written_spc_vs),
        "rows_scanned_spc_construction_service": int(rows_scanned_spc_cs),
        "rows_written_spc_construction_service": int(written_spc_cs),
        "rows_scanned_spc_estate_lease": int(rows_scanned_spc_el),
        "rows_written_spc_estate_lease": int(written_spc_el),
        "rows_rejected": int(rows_rejected),
        "reject_row_ranges": reject_ranges,
        "reject_row_samples": reject_samples,
        "dq_spc_passenger_linecount_mismatch": dq_spc_passenger_linecount_mismatch,
        "dq_spc_freight_linecount_mismatch": dq_spc_freight_linecount_mismatch,
        "dq_spc_vehicle_sales_linecount_mismatch": dq_spc_vehicle_sales_linecount_mismatch,
        "dq_spc_construction_linecount_mismatch": dq_spc_construction_linecount_mismatch,
        "dq_spc_estate_lease_linecount_mismatch": dq_spc_estate_lease_linecount_mismatch,
        "dq_spc_transport_passenger_amount_vs_inv_detail": dq_spc_transport_passenger_amount_vs_inv_detail,
        "dq_spc_transport_freight_amount_vs_inv_detail": dq_spc_transport_freight_amount_vs_inv_detail,
        "dq_spc_vehicle_sales_amount_vs_inv_detail": dq_spc_vehicle_sales_amount_vs_inv_detail,
        "dq_spc_construction_service_amount_vs_inv_detail": dq_spc_construction_service_amount_vs_inv_detail,
        "dq_spc_estate_lease_amount_vs_inv_detail": dq_spc_estate_lease_amount_vs_inv_detail,
        "message": "DWD 清洗完成（header/detail/专项运输/机动车/建筑服务/不动产租赁落盘；金额/日期解析与拒收已下沉）",
    }
