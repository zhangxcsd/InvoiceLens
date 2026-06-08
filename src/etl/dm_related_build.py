"""
关联交易 · 疑似通道公司检测（dm_shell_co）。

审计含义：集团成员向非成员供应商付款后，该供应商高比例对外转出，可能存在通道公司。
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from src.audit.config_loader import rule_config

logger = logging.getLogger(__name__)


def refresh_shell_co(
    conn: Any,
    *,
    stat_year: int,
    group_id: str,
    analysis_batch: str,
) -> int:
    cfg = rule_config("RULE-SHELL")
    if not cfg.get("enabled", True):
        conn.execute("DELETE FROM dm_shell_co WHERE group_id = ?", [group_id])
        return 0

    min_amt = float(cfg.get("min_amount") or 500000)
    ratio_th = float(cfg.get("passthrough_ratio") or 0.6)
    risk = str(cfg.get("risk_level") or "中风险")
    norm_ent = "upper(regexp_replace(trim(COALESCE(r.enterprise_id, '')), '[\\s-]+', '', 'g'))"
    norm_xfs = "upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))"
    norm_gfs = "upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))"
    net = "COALESCE(h.net_jshj, h.jshj, 0)"
    fpzt_ok = "coalesce(nullif(trim(cast(h.fpzt AS VARCHAR)), ''), '正常') = '正常'"

    try:
        roster_cnt = int(
            conn.execute(
                "SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_roster WHERE stat_year = ?",
                [stat_year],
            ).fetchone()[0]
            or 0
        )
        if roster_cnt == 0:
            conn.execute("DELETE FROM dm_shell_co WHERE group_id = ?", [group_id])
            return 0
    except Exception:
        logger.exception("检查花名册失败")
        return 0

    conn.execute("DELETE FROM dm_shell_co WHERE group_id = ?", [group_id])

    rows = conn.execute(
        f"""
        WITH roster AS (
            SELECT DISTINCT {norm_ent} AS tax,
                   max(trim(COALESCE(r.enterprise_name, ''))) AS name
            FROM dim_enterprise_year_roster r
            WHERE r.stat_year = ? AND length({norm_ent}) > 0
            GROUP BY 1
        ),
        member_buy AS (
            SELECT
                {norm_gfs} AS member_tax,
                max(trim(COALESCE(h.gfmc, ''))) AS member_name,
                {norm_xfs} AS inter_tax,
                max(trim(COALESCE(h.xfmc, ''))) AS inter_name,
                sum({net}) AS amt_in
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {fpzt_ok}
              AND {net} > 0
            GROUP BY member_tax, inter_tax
        ),
        inter_out AS (
            SELECT
                {norm_xfs} AS inter_tax,
                {norm_gfs} AS target_tax,
                max(trim(COALESCE(h.gfmc, ''))) AS target_name,
                sum({net}) AS amt_out
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {fpzt_ok}
              AND {net} > 0
            GROUP BY inter_tax, target_tax
        )
        SELECT
            mb.member_tax, mb.member_name, mb.inter_tax, mb.inter_name,
            io.target_tax, io.target_name,
            mb.amt_in, io.amt_out,
            io.amt_out / nullif(mb.amt_in, 0) AS passthrough
        FROM member_buy mb
        JOIN roster rm ON mb.member_tax = rm.tax
        LEFT JOIN roster ri ON mb.inter_tax = ri.tax
        JOIN inter_out io ON mb.inter_tax = io.inter_tax
        WHERE ri.tax IS NULL
          AND mb.amt_in >= ?
          AND io.amt_out / nullif(mb.amt_in, 0) >= ?
          AND mb.inter_tax <> io.target_tax
        ORDER BY passthrough DESC, mb.amt_in DESC
        LIMIT 300
        """,
        [stat_year, stat_year, stat_year, min_amt, ratio_th],
    ).fetchall()

    insert_rows: list[tuple[Any, ...]] = []
    for row in rows or []:
        member_tax, member_name, inter_tax, inter_name, target_tax, target_name, amt_in, amt_out, passthrough = row
        key = f"{member_tax}|{inter_tax}|{target_tax}"
        digest = hashlib.md5(key.encode()).hexdigest()[:12]
        insert_rows.append(
            (
                f"SHELL-{stat_year}-{digest}",
                group_id,
                member_tax,
                member_name,
                inter_tax,
                inter_name,
                target_tax,
                target_name,
                float(amt_in or 0),
                float(amt_out or 0),
                float(passthrough or 0),
                risk,
                analysis_batch,
            )
        )

    if insert_rows:
        conn.executemany(
            """
            INSERT INTO dm_shell_co (
                shell_id, group_id, group_member_tax, group_member_name,
                intermediary_tax, intermediary_name, final_target_tax, final_target_name,
                amount_in, amount_out, passthrough_ratio, risk_level, analysis_batch
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            insert_rows,
        )
    return len(insert_rows)
