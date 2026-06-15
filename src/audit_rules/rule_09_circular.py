"""
RULE-09：关联交易——对开发票。

审计含义：购销双方互为买卖方且双向金额接近，存在对开虚增贸易或循环开票风险。
结果同步写入 dm_circ_inv 供「关联交易 · 对开明细」页展示。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import ABS_NET, FPZT_NORMAL, IS_POSITIVE, entity_filter, flag_detail_json, norm_tax


def _risk_for_ratio(ratio: float, cfg: dict[str, Any]) -> str:
    high_th = float(cfg.get("ratio_high") or 0.8)
    med_th = float(cfg.get("ratio_medium") or 0.5)
    if ratio >= high_th:
        return str(cfg.get("risk_level_high") or "高风险")
    if ratio >= med_th:
        return str(cfg.get("risk_level_medium") or "中风险")
    return str(cfg.get("risk_level_low") or "低风险")


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-09")
    if not cfg.get("enabled", True):
        return []

    min_ratio = float(cfg.get("ratio_medium") or 0.5)
    min_amt = float(cfg.get("min_amount") or 10000)
    ef, ep = entity_filter(entity_id)
    ng = norm_tax("h.gfsbh")
    nx = norm_tax("h.xfsbh")

    rows = conn.execute(
        f"""
        WITH fwd AS (
            SELECT
                {ng} AS a_tax,
                max(trim(COALESCE(h.gfmc, ''))) AS a_name,
                {nx} AS b_tax,
                max(trim(COALESCE(h.xfmc, ''))) AS b_name,
                sum({ABS_NET}) AS amt_a_to_b
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              AND length({ng}) > 0 AND length({nx}) > 0
              {ef}
            GROUP BY a_tax, b_tax
        ),
        rev AS (
            SELECT
                {ng} AS a_tax,
                {nx} AS b_tax,
                sum({ABS_NET}) AS amt_b_to_a
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              AND length({ng}) > 0 AND length({nx}) > 0
              {ef}
            GROUP BY a_tax, b_tax
        )
        SELECT
            f.a_tax, f.a_name, f.b_tax, f.b_name,
            f.amt_a_to_b, coalesce(r.amt_b_to_a, 0) AS amt_b_to_a
        FROM fwd f
        JOIN rev r ON f.a_tax = r.b_tax AND f.b_tax = r.a_tax
        WHERE f.a_tax < f.b_tax
          AND f.amt_a_to_b >= ?
          AND coalesce(r.amt_b_to_a, 0) >= ?
          AND least(f.amt_a_to_b, coalesce(r.amt_b_to_a, 0))
              / nullif(greatest(f.amt_a_to_b, coalesce(r.amt_b_to_a, 0)), 0) >= ?
        ORDER BY least(f.amt_a_to_b, coalesce(r.amt_b_to_a, 0)) DESC
        LIMIT 300
        """,
        [stat_year, *ep, stat_year, *ep, min_amt, min_amt, min_ratio],
    ).fetchall()

    conn.execute("DELETE FROM dm_circ_inv WHERE group_id = ?", [group_id])

    flags: list[AuditFlagRow] = []
    circ_rows: list[tuple[Any, ...]] = []
    for row in rows or []:
        a_tax, a_name, b_tax, b_name, amt_ab, amt_ba = row
        amt_ab_f = float(amt_ab or 0)
        amt_ba_f = float(amt_ba or 0)
        ratio = min(amt_ab_f, amt_ba_f) / max(amt_ab_f, amt_ba_f, 1)
        risk = _risk_for_ratio(ratio, cfg)
        pair_key = f"{a_tax}|{b_tax}"
        digest = hashlib.md5(pair_key.encode()).hexdigest()[:12]
        circ_id = f"CIRC-{stat_year}-{digest}"
        circ_rows.append(
            (circ_id, group_id, a_tax, a_name, b_tax, b_name, amt_ab_f, amt_ba_f, ratio, risk, batch)
        )
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-09-{digest}",
                "rule_id": "RULE-09",
                "risk_level": risk,
                "flag_type": "对开发票",
                "group_id": group_id,
                "entity_id": a_tax,
                "entity_name": a_name or a_tax,
                "seller_name": b_name or b_tax,
                "seller_tax_no": b_tax,
                "amount": min(amt_ab_f, amt_ba_f),
                "invoice_list": json.dumps([], ensure_ascii=False),
                "description": (
                    f"「{a_name or a_tax}」→「{b_name or b_tax}」{amt_ab_f:,.2f} 元，"
                    f"反向 {amt_ba_f:,.2f} 元，双向比值 {ratio:.1%}，存在对开贸易风险。"
                ),
                "suggestion": "建议核查双方合同、物流与资金流水，确认是否存在循环贸易或虚增收入/成本。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    stat_year=stat_year,
                    entity_id=a_tax,
                    party_a_tax=a_tax,
                    party_b_tax=b_tax,
                    counterparty_id=b_tax,
                    counterparty_tax_no=b_tax,
                    amount_a_to_b=amt_ab_f,
                    amount_b_to_a=amt_ba_f,
                    circular_ratio=ratio,
                ),
            }
        )

    if circ_rows:
        conn.executemany(
            """
            INSERT INTO dm_circ_inv (
                circ_id, group_id, party_a_tax, party_a_name, party_b_tax, party_b_name,
                amount_a_to_b, amount_b_to_a, circular_ratio, risk_level, analysis_batch
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (group_id, party_a_tax, party_b_tax, analysis_batch) DO UPDATE SET
                party_a_name = excluded.party_a_name,
                party_b_name = excluded.party_b_name,
                amount_a_to_b = excluded.amount_a_to_b,
                amount_b_to_a = excluded.amount_b_to_a,
                circular_ratio = excluded.circular_ratio,
                risk_level = excluded.risk_level
            """,
            circ_rows,
        )

    return flags
