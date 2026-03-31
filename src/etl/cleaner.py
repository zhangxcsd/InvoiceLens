from __future__ import annotations

from typing import Any, Iterable

import re
import glob
from pathlib import Path

from db.duckdb_conn import get_conn
from db.schema_sqlfiles import init_all_tables


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


def run_cleaner(
    *,
    stat_year: int,
    import_batch_id: str,
    ods_parquet_paths: Iterable[str] | None = None,
) -> dict[str, Any]:
    """
    ODS -> DWD 清洗写入：

    - C：ODS 仅保存原始字符串/NULL；金额/日期的强类型解析与“可解析性拒收”在 DWD 完成
    - 生成与 ODS 同形状的拒收摘要：
      - reject_row_ranges: [{seq_no_start, seq_no_end, reason}]
      - reject_row_samples: [{seq_no, sheet, field, reason, exception_type}]

    - 覆盖刷新边界：`stat_year`（必要时叠加 `import_batch_id`）
      - 允许重跑：同一 stat_year 的 DWD/DWS 可重复计算并覆盖写入
      - 禁止跨年误操作：不得执行无过滤的全表 DELETE/UPDATE
    - 去重并入语义：
      - 物理票判重键优先：`sdfphm` > `invoice_code+invoice_no`
      - 写入 DWD 主表/明细表应保证同一 `(stat_year, invoice_key)` 唯一
      - 写入溯源映射表应保证可追溯（保留 `source_excel_file/source_parquet_file/import_batch_id`）
    """
    conn = get_conn()
    init_all_tables(conn)
    # 注册临时 UDF：全角转半角（用于 header_uuid 计算对齐提示词）
    try:
        conn.create_function("fw2hw", _fullwidth_to_halfwidth)
    except Exception:
        # 已存在/不支持时不阻断（后续 SQL 仍可回退为未转换）
        pass

    parquet_list: list[str] = []
    if ods_parquet_paths is not None:
        parquet_list = _as_sql_string_list(ods_parquet_paths)
    if not parquet_list:
        # 兜底：按批次扫描 inv_header ODS 目录
        ods_root = Path(__file__).resolve().parents[2] / "data" / "ods"
        glob_pat = str((ods_root / f"批次={import_batch_id}" / "表类型=inv_header" / "**" / "*.parquet").resolve())
        parquet_list = sorted(glob.glob(glob_pat, recursive=True))

    if not parquet_list:
        return {
            "status": "warning",
            "stage": "cleaner",
            "stat_year": stat_year,
            "import_batch_id": import_batch_id,
            "message": "未提供 ods_parquet_paths，且未能自动定位 ODS Parquet；已跳过 DWD 清洗",
            "rows_scanned": 0,
            "rows_written": 0,
            "rows_rejected": 0,
            "reject_row_ranges": [],
            "reject_row_samples": [],
        }

    # 读取 ODS：以 DuckDB 直接扫 parquet，避免把大表全拉进 Python
    conn.execute("CREATE OR REPLACE TEMP VIEW _ods_hdr AS SELECT * FROM read_parquet(?, union_by_name=true)", [parquet_list])

    # 字段映射（ODS 可能既有中文列，也有标准列 invoice_code/amount 等）
    # 关键：ODS 里已把 'nan' 归一化为 NULL，因此这里以 IS NULL 判断缺失即可
    def col(*names: str) -> str:
        exprs = [f'"{n}"' for n in names if n]
        return f"COALESCE({', '.join(exprs)})" if exprs else "NULL"

    fpdm_expr = col("invoice_code", "发票代码")
    fphm_expr = col("invoice_no", "发票号码")
    sdfphm_expr = col("sdfphm", "数电发票号码")
    xfsbh_expr = col("seller_tax_no", "销方识别号", "销方税号")
    xfmc_expr = col("销方名称")
    gfsbh_expr = col("buyer_tax_no", "购方识别号", "购方税号")
    gfmc_expr = col("购买方名称", "购方名称")
    kpr_expr = col("开票人", "kpr")
    bz_expr = col("备注", "bz")

    kprq_raw_expr = col("invoice_date", "开票日期")
    je_raw_expr = col("amount", "金额", "不含税金额")
    se_raw_expr = col("tax_amount", "税额")
    jshj_raw_expr = col("total_amount", "价税合计", "含税金额")

    # 清洗后的字符串（去货币符号/千分位）
    def clean_money(expr: str) -> str:
        # 去空格/货币符号/逗号
        return f"regexp_replace(regexp_replace(regexp_replace(trim(CAST({expr} AS VARCHAR)), '[￥¥]', ''), ',', ''), '\\\\s+', '')"

    # 日期解析：支持 YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD
    date_str = f"trim(CAST({kprq_raw_expr} AS VARCHAR))"
    date_norm = f"replace({date_str}, '/', '-')"
    date_try = (
        "COALESCE("
        f"try_strptime({date_norm}, '%Y-%m-%d')::DATE,"
        f"try_strptime({date_str}, '%Y%m%d')::DATE"
        ")"
    )

    je_clean = clean_money(je_raw_expr)
    se_clean = clean_money(se_raw_expr)
    jshj_clean = clean_money(jshj_raw_expr)

    je_try = f"TRY_CAST({je_clean} AS DECIMAL(18,2))"
    se_try = f"TRY_CAST({se_clean} AS DECIMAL(18,2))"
    jshj_try = f"TRY_CAST({jshj_clean} AS DECIMAL(18,2))"

    # 拒收逻辑（同形状日志）
    # - 原始值非空但解析结果为 NULL -> 拒收（ParseError）
    # - invoice_date 缺失或解析失败 -> 拒收（DateMissing/DateParseError）
    # - 金额类字段：若原始有值但解析失败 -> 对应字段拒收
    # 说明：如果某些企业导出缺少税额/价税合计，允许为空（不拒收）；但一旦填了就必须可解析
    reject_sql = f"""
    SELECT
      TRY_CAST("序号" AS DOUBLE) AS seq_no_raw,
      {kprq_raw_expr} AS raw_invoice_date,
      {je_raw_expr} AS raw_amount,
      {se_raw_expr} AS raw_tax_amount,
      {jshj_raw_expr} AS raw_total_amount,
      {date_try} AS parsed_date,
      {je_try} AS parsed_je,
      {se_try} AS parsed_se,
      {jshj_try} AS parsed_jshj,
      CASE
        WHEN "序号" IS NULL THEN 'SeqNoMissingError'
        WHEN {kprq_raw_expr} IS NULL THEN 'DateMissingError'
        WHEN {kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL THEN 'DateParseError'
        WHEN {je_raw_expr} IS NOT NULL AND {je_try} IS NULL THEN 'AmountParseError'
        WHEN {se_raw_expr} IS NOT NULL AND {se_try} IS NULL THEN 'TaxAmountParseError'
        WHEN {jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL THEN 'TotalAmountParseError'
        ELSE NULL
      END AS exception_type,
      CASE
        WHEN "序号" IS NULL THEN '序号'
        WHEN {kprq_raw_expr} IS NULL OR ({kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL) THEN 'invoice_date'
        WHEN {je_raw_expr} IS NOT NULL AND {je_try} IS NULL THEN 'amount'
        WHEN {se_raw_expr} IS NOT NULL AND {se_try} IS NULL THEN 'tax_amount'
        WHEN {jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL THEN 'total_amount'
        ELSE NULL
      END AS field,
      CASE
        WHEN "序号" IS NULL THEN '序号缺失/无法定位'
        WHEN {kprq_raw_expr} IS NULL THEN '开票日期缺失'
        WHEN {kprq_raw_expr} IS NOT NULL AND {date_try} IS NULL THEN '开票日期无法解析'
        WHEN {je_raw_expr} IS NOT NULL AND {je_try} IS NULL THEN '金额无法解析'
        WHEN {se_raw_expr} IS NOT NULL AND {se_try} IS NULL THEN '税额无法解析'
        WHEN {jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL THEN '价税合计无法解析'
        ELSE NULL
      END AS reason
    FROM _ods_hdr
    WHERE
      ("序号" IS NULL)
      OR ({kprq_raw_expr} IS NULL)
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
      ("序号" IS NOT NULL)
      AND ({kprq_raw_expr} IS NOT NULL)
      AND ({date_try} IS NOT NULL)
      AND NOT ({je_raw_expr} IS NOT NULL AND {je_try} IS NULL)
      AND NOT ({se_raw_expr} IS NOT NULL AND {se_try} IS NULL)
      AND NOT ({jshj_raw_expr} IS NOT NULL AND {jshj_try} IS NULL)
    """

    # 写入 DWD header（先到先得：主键冲突不覆盖）
    insert_sql = f"""
    INSERT INTO dwd_inv_header (
      header_uuid, stat_year,
      fpdm, fphm, sdfphm,
      xfsbh, xfmc, gfsbh, gfmc,
      kprq, invoice_date,
      je, se, jshj,
      kpr, bz,
      first_import_batch_id, first_import_file
    )
    SELECT
      md5(
        COALESCE(fw2hw(CAST({fpdm_expr} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({fphm_expr} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({sdfphm_expr} AS VARCHAR)), '')
      ) AS header_uuid,
      EXTRACT(year FROM {date_try})::SMALLINT AS stat_year,
      {fpdm_expr} AS fpdm,
      {fphm_expr} AS fphm,
      {sdfphm_expr} AS sdfphm,
      {xfsbh_expr} AS xfsbh,
      {xfmc_expr} AS xfmc,
      {gfsbh_expr} AS gfsbh,
      {gfmc_expr} AS gfmc,
      {kprq_raw_expr} AS kprq,
      {date_try} AS invoice_date,
      {je_try} AS je,
      {se_try} AS se,
      {jshj_try} AS jshj,
      {kpr_expr} AS kpr,
      {bz_expr} AS bz,
      ? AS first_import_batch_id,
      COALESCE("source_excel_file", "source_file", '<unknown>') AS first_import_file
    FROM _ods_hdr
    WHERE {valid_where}
      AND EXTRACT(year FROM {date_try})::INTEGER = ?
    ON CONFLICT DO NOTHING
    """

    before = conn.execute("SELECT COUNT(*) FROM dwd_inv_header WHERE stat_year=?", [stat_year]).fetchone()[0]
    conn.execute(insert_sql, [import_batch_id, stat_year])
    after = conn.execute("SELECT COUNT(*) FROM dwd_inv_header WHERE stat_year=?", [stat_year]).fetchone()[0]
    written = max(0, int(after) - int(before))

    rows_scanned = conn.execute("SELECT COUNT(*) FROM _ods_hdr").fetchone()[0]
    rows_rejected = len(reject_rows)

    status = "success" if rows_rejected == 0 else "warning"
    return {
        "status": status,
        "stage": "cleaner",
        "stat_year": stat_year,
        "import_batch_id": import_batch_id,
        "rows_scanned": int(rows_scanned),
        "rows_written": int(written),
        "rows_rejected": int(rows_rejected),
        "reject_row_ranges": reject_ranges,
        "reject_row_samples": reject_samples,
        "message": "DWD 清洗完成（金额/日期解析与拒收已下沉）",
    }
