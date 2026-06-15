"""
RULE-06：金额异常值（3σ）。

审计含义：单张发票金额显著偏离该购方对某供应商的历史均值，可能存在异常定价或虚假贸易。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import ABS_NET, FPZT_NORMAL, IS_POSITIVE, entity_filter, flag_detail_json, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-06")
    if not cfg.get("enabled", True):
        return []

    min_cnt = int(cfg.get("min_invoice_count") or 5)
    sigma = float(cfg.get("sigma_multiplier") or 3.0)
    risk = str(cfg.get("risk_level") or "中风险")
    ef, ep = entity_filter(entity_id)
    ng = norm_tax("h.xfsbh")
    nx = norm_tax("h.gfsbh")

    rows = conn.execute(
        f"""
        WITH base AS (
            SELECT
                h.header_uuid,
                {ng} AS buyer_id,
                trim(COALESCE(h.gfmc, '')) AS buyer_name,
                {nx} AS seller_id,
                trim(COALESCE(h.xfmc, '')) AS seller_name,
                {ABS_NET} AS amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              {ef}
        ),
        stats AS (
            SELECT
                buyer_id,
                seller_id,
                avg(amt) AS mean_amt,
                stddev_samp(amt) AS std_amt,
                count(*)::INT AS cnt
            FROM base
            GROUP BY buyer_id, seller_id
            HAVING count(*) >= ?
        )
        SELECT
            b.header_uuid, b.buyer_id, b.buyer_name, b.seller_id, b.seller_name, b.amt,
            s.mean_amt, s.std_amt, s.cnt
        FROM base b
        JOIN stats s ON b.buyer_id = s.buyer_id AND b.seller_id = s.seller_id
        WHERE s.std_amt IS NOT NULL AND s.std_amt > 0
          AND abs(b.amt - s.mean_amt) > ? * s.std_amt
        ORDER BY abs(b.amt - s.mean_amt) DESC
        LIMIT 300
        """,
        [stat_year, *ep, min_cnt, sigma],
    ).fetchall()

    flags: list[AuditFlagRow] = []
    for row in rows or []:
        hid, buyer_id, buyer_name, seller_id, seller_name, amt, mean_amt, std_amt, cnt = row
        digest = hashlib.md5(str(hid).encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-06-{digest}",
                "rule_id": "RULE-06",
                "risk_level": risk,
                "flag_type": "金额异常值",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(amt or 0),
                "invoice_list": json.dumps([str(hid)], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」对供应商「{seller_name or seller_id}」"
                    f"单张金额 {float(amt or 0):,.2f} 元，偏离历史均值 {float(mean_amt or 0):,.2f} 元"
                    f"超过 {sigma} 倍标准差（样本 {int(cnt or 0)} 张）。"
                ),
                "suggestion": "建议比对合同单价、采购审批与同类采购历史价格。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    header_uuid=str(hid),
                    mean_amount=float(mean_amt or 0),
                    std_amount=float(std_amt or 0),
                    sample_count=int(cnt or 0),
                ),
            }
        )
    return flags
