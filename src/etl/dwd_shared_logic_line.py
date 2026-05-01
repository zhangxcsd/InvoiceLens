"""
DWD 共享：logic_line_no 生成与专项/明细对齐。

- 与 dwd_inv_detail 的 `_ods_dtl_logic` 语义一致：分区 `_hdr_k` + `_scope_k`，
  同作用域去重、详见销货清单类汇总参考行 logic_line_no=0，其余行 1..n。
- detail_uuid / header_uuid 的 MD5 输入与 `dwd_inv_detail` 写入一致（不含 source_sheet）。
- 数据质量 SQL：同票同 source_scope_key 下比较「logic_line_no>0」行数（专项 vs 明细）；
  以及按 detail_uuid 与 dwd_inv_detail 对照金额（仅报告）；专项 je/se/jshj 落盘时 COALESCE 本 sheet ODS 金额与 `_ods_dtl_logic` 同 UUID 行（信息汇总同源，见 `cleaner.sql_spc_money_coalesce_from_ods_dtl`）。
"""

from __future__ import annotations

from typing import Iterable

from config.dwd_goods_summary_phrases import DWD_GOODS_SUMMARY_PHRASES


def sql_goods_lc_summary_see_det(goods_lc_sql_ident: str, phrases: Iterable[str]) -> str:
    """已 LOWER 的货物/摘要匹配列上，子串命中任一短语 → DuckDB 布尔表达式；无短语时为 FALSE。"""
    parts: list[str] = []
    for p in phrases:
        if not p or not str(p).strip():
            continue
        esc = str(p).strip().replace("'", "''")
        parts.append(f"{goods_lc_sql_ident} LIKE '%{esc}%'")
    if not parts:
        return "FALSE"
    return "(" + " OR ".join(parts) + ")"


def sql_scope_k_expr() -> str:
    """与 cleaner 中 `_scope_k` / 专项 `source_scope_key` 一致（import_session + 归一文件路径 + sheet）。"""
    return """md5(
          COALESCE(TRIM(CAST("import_session_id" AS VARCHAR)), '')
          || '|'
          || COALESCE(
               LOWER(REPLACE(TRIM(CAST("source_excel_file" AS VARCHAR)), '\\\\', '/')),
               ''
             )
          || '|'
          || LOWER(TRIM(COALESCE(CAST("source_sheet" AS VARCHAR), '')))
        )"""


def build_create_ods_logic_line_view_sql(
    view_name: str,
    from_src_sql: str,
    hdr_k_sql: str,
    ord_key_sql: str,
    goods_lower_sql: str,
    phrases: Iterable[str] | None = None,
) -> str:
    """
    生成 `CREATE OR REPLACE TEMP VIEW {view_name} AS ...`，输出列含 `logic_line_no`、`_scope_k` 等。

    `from_src_sql` 为 FROM 子句内源，如 `_ods_dtl` 或带别名的子查询；源上须有标准血缘列名。
    """
    phr = phrases if phrases is not None else DWD_GOODS_SUMMARY_PHRASES
    see_det_sql = sql_goods_lc_summary_see_det("_goods_lc", phr)
    scope_k = sql_scope_k_expr()
    return f"""
    CREATE OR REPLACE TEMP VIEW {view_name} AS
    WITH raw_base AS (
      SELECT
        *,
        {hdr_k_sql} AS _hdr_k,
        {ord_key_sql} AS _ord_key,
        {goods_lower_sql} AS _goods_lc,
        LOWER(TRIM(COALESCE(CAST("source_sheet" AS VARCHAR), ''))) AS _sheet_k,
        {scope_k} AS _scope_k
      FROM {from_src_sql}
    ),
    base AS (
      SELECT * EXCLUDE (_dup_rn) FROM (
        SELECT
          rb.*,
          ROW_NUMBER() OVER (
            PARTITION BY rb._hdr_k, rb._scope_k, rb._ord_key
            ORDER BY TRY_CAST(rb.ods_file_seq AS INTEGER) ASC NULLS LAST,
                     CAST(rb.source_parquet_file AS VARCHAR) ASC NULLS LAST
          ) AS _dup_rn
        FROM raw_base rb
      ) t
      WHERE _dup_rn = 1
    ),
    mk AS (
      SELECT
        *,
        {see_det_sql} AS _see_det,
        COUNT(*) OVER (PARTITION BY _hdr_k, _scope_k) AS _lines_in_inv
      FROM base
    ),
    mk2 AS (
      SELECT
        *,
        SUM(CASE WHEN _see_det THEN 1 ELSE 0 END) OVER (
          PARTITION BY _hdr_k, _scope_k
          ORDER BY _ord_key ASC NULLS LAST, TRY_CAST(ods_file_seq AS INTEGER) ASC NULLS LAST
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS _see_cum
      FROM mk
    ),
    mk3 AS (
      SELECT
        *,
        (_see_det AND _lines_in_inv >= 2 AND _see_cum = 1) AS _is_sum_ref
      FROM mk2
    ),
    fin AS (
      SELECT
        *,
        CASE
          WHEN _is_sum_ref THEN 0
          ELSE CAST(
            SUM(CASE WHEN NOT _is_sum_ref THEN 1 ELSE 0 END) OVER (
              PARTITION BY _hdr_k, _scope_k
              ORDER BY _ord_key ASC NULLS LAST, TRY_CAST(ods_file_seq AS INTEGER) ASC NULLS LAST
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS INTEGER
          )
        END AS logic_line_no
      FROM mk3
    )
    SELECT * FROM fin
    """


def sql_detail_uuid_expr(
    fpdm_sql: str,
    fphm_sql: str,
    sdfphm_sql: str,
    logic_line_sql: str = "logic_line_no",
) -> str:
    """与 `dwd_inv_detail` 写入一致：MD5(fw2hw 票键 || logic_line_no)。

    logic_line_sql：默认 `logic_line_no`；在 `_ods_dtl_logic AS odt` 子查询中可传 `odt.logic_line_no`。
    """
    return f"""md5(
        COALESCE(fw2hw(CAST({fpdm_sql} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({fphm_sql} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({sdfphm_sql} AS VARCHAR)), '')
        || COALESCE(CAST({logic_line_sql} AS VARCHAR), '')
      )"""


def sql_header_uuid_expr(fpdm_sql: str, fphm_sql: str, sdfphm_sql: str) -> str:
    """与 `dwd_inv_header` / 明细 `header_uuid` 一致。"""
    return f"""md5(
        COALESCE(fw2hw(CAST({fpdm_sql} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({fphm_sql} AS VARCHAR)), '')
        || COALESCE(fw2hw(CAST({sdfphm_sql} AS VARCHAR)), '')
      )"""


def sql_source_scope_key_from_dwd_detail_cols() -> str:
    """从 `dwd_inv_detail` 已落盘列重算 source_scope_key（与 `_scope_k` 一致）。"""
    return """md5(
      COALESCE(TRIM(CAST(import_session_id AS VARCHAR)), '')
      || '|'
      || COALESCE(LOWER(REPLACE(TRIM(CAST(source_excel_file AS VARCHAR)), '\\\\', '/')), '')
      || '|'
      || LOWER(TRIM(COALESCE(CAST(source_sheet AS VARCHAR), '')))
    )"""


def sql_spc_inv_positive_linecount_mismatch(
    spc_table: str,
    *,
    stat_year_placeholder: str = "?",
    import_batch_placeholder: str = "?",
) -> str:
    """
    返回 SELECT：本批本年中，同 (header_uuid, source_scope_key) 下
    `logic_line_no > 0` 行数在专项表与 dwd_inv_detail 不一致的键（含仅一侧有数据）。
    """
    sk = sql_source_scope_key_from_dwd_detail_cols()
    return f"""
    WITH dtl AS (
      SELECT
        header_uuid,
        {sk} AS source_scope_key,
        COUNT(*) FILTER (WHERE logic_line_no > 0) AS n_pos
      FROM dwd_inv_detail
      WHERE stat_year = {stat_year_placeholder}
        AND import_batch_id = {import_batch_placeholder}
      GROUP BY 1, 2
    ),
    spc AS (
      SELECT
        header_uuid,
        source_scope_key,
        COUNT(*) FILTER (WHERE logic_line_no > 0) AS n_pos
      FROM {spc_table}
      WHERE stat_year = {stat_year_placeholder}
        AND import_batch_id = {import_batch_placeholder}
      GROUP BY 1, 2
    ),
    keys AS (
      SELECT header_uuid, source_scope_key FROM dtl
      UNION
      SELECT header_uuid, source_scope_key FROM spc
    )
    SELECT
      k.header_uuid,
      k.source_scope_key,
      COALESCE(d.n_pos, 0) AS inv_detail_positive_lines,
      COALESCE(s.n_pos, 0) AS spc_positive_lines
    FROM keys k
    LEFT JOIN dtl d ON d.header_uuid = k.header_uuid AND d.source_scope_key = k.source_scope_key
    LEFT JOIN spc s ON s.header_uuid = k.header_uuid AND s.source_scope_key = k.source_scope_key
    WHERE COALESCE(d.n_pos, 0) <> COALESCE(s.n_pos, 0)
    """


def sql_amount_dq_vs_inv_detail(
    spc_table: str,
    *,
    tolerance: float = 0.01,
    stat_year_placeholder: str = "?",
    import_batch_placeholder: str = "?",
) -> str:
    """
    数据质量报告用：本批本年中专项表行 LEFT JOIN `dwd_inv_detail`（同 `detail_uuid`）。

    - `dq_issue` = `no_inv_detail_row`：DWD 中不存在同 UUID 的明细行（可能未导入明细或 UUID 未对齐）。
    - `dq_issue` = `amount_mismatch`：明细存在但 `je`/`se`/`jshj` 任一项与专项差绝对值 > `tolerance`（默认分）。
    - 仅 **`s.logic_line_no > 0`** 的专项行参与（与平账口径一致，排除汇总参考行）。

    不修改任何表数据；由 `run_cleaner` 将结果集透出供 UI/日志消费。
    """
    tol = abs(float(tolerance))
    tol_lit = f"{tol:.4f}"
    return f"""
    SELECT
      s.detail_uuid,
      s.header_uuid,
      s.logic_line_no AS spc_logic_line_no,
      s.je AS spc_je,
      d.je AS inv_je,
      s.se AS spc_se,
      d.se AS inv_se,
      s.jshj AS spc_jshj,
      d.jshj AS inv_jshj,
      CASE
        WHEN d.detail_uuid IS NULL THEN 'no_inv_detail_row'
        WHEN ABS(COALESCE(s.je, 0) - COALESCE(d.je, 0)) > {tol_lit}
          OR ABS(COALESCE(s.se, 0) - COALESCE(d.se, 0)) > {tol_lit}
          OR ABS(COALESCE(s.jshj, 0) - COALESCE(d.jshj, 0)) > {tol_lit}
          THEN 'amount_mismatch'
        ELSE NULL
      END AS dq_issue
    FROM {spc_table} s
    LEFT JOIN dwd_inv_detail d ON d.detail_uuid = s.detail_uuid
    WHERE s.stat_year = {stat_year_placeholder}
      AND s.import_batch_id = {import_batch_placeholder}
      AND s.logic_line_no > 0
      AND (
        d.detail_uuid IS NULL
        OR ABS(COALESCE(s.je, 0) - COALESCE(d.je, 0)) > {tol_lit}
        OR ABS(COALESCE(s.se, 0) - COALESCE(d.se, 0)) > {tol_lit}
        OR ABS(COALESCE(s.jshj, 0) - COALESCE(d.jshj, 0)) > {tol_lit}
      )
    """
