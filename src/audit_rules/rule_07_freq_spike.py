"""
RULE-07：开票频率突变。

审计含义：某月开票张数远高于该供应商月均水平，可能存在集中开票或异常贸易频率。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import FPZT_NORMAL, IS_POSITIVE, entity_filter, flag_detail_json, month_date_bounds, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-07")
    if not cfg.get("enabled", True):
        return []

    multiplier = float(cfg.get("monthly_multiplier") or 3.0)
    min_avg = float(cfg.get("min_monthly_avg") or 1.0)
    risk = str(cfg.get("risk_level") or "中风险")
    ef, ep = entity_filter(entity_id)
    ng = norm_tax("h.gfsbh")
    nx = norm_tax("h.xfsbh")

    rows = conn.execute(
        f"""
        WITH monthly AS (
            SELECT
                {ng} AS buyer_id,
                max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
                {nx} AS seller_id,
                max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
                h.stat_month,
                count(*)::INT AS month_cnt,
                list(h.header_uuid) AS uuids
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              {ef}
            GROUP BY buyer_id, seller_id, h.stat_month
        ),
        avg_m AS (
            SELECT buyer_id, seller_id,
                   avg(month_cnt::DOUBLE) AS avg_cnt
            FROM monthly
            GROUP BY buyer_id, seller_id
            HAVING avg(month_cnt::DOUBLE) >= ?
        )
        SELECT m.buyer_id, m.buyer_name, m.seller_id, m.seller_name,
               m.stat_month, m.month_cnt, a.avg_cnt, m.uuids
        FROM monthly m
        JOIN avg_m a ON m.buyer_id = a.buyer_id AND m.seller_id = a.seller_id
        WHERE m.month_cnt >= a.avg_cnt * ?
        ORDER BY m.month_cnt / nullif(a.avg_cnt, 0) DESC
        LIMIT 200
        """,
        [stat_year, *ep, min_avg, multiplier],
    ).fetchall()

    flags: list[AuditFlagRow] = []
    for row in rows or []:
        buyer_id, buyer_name, seller_id, seller_name, month, month_cnt, avg_cnt, uuids = row
        key = f"freq|{buyer_id}|{seller_id}|{month}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        ratio = float(month_cnt or 0) / float(avg_cnt or 1)
        month_i = int(month or 0)
        date_from, date_to = month_date_bounds(stat_year, month_i) if month_i else (None, None)
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-07-{digest}",
                "rule_id": "RULE-07",
                "risk_level": risk,
                "flag_type": "开票频率突变",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": None,
                "invoice_list": json.dumps([str(u) for u in (uuids or []) if u][:30], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」{stat_year} 年 {int(month or 0)} 月从"
                    f"「{seller_name or seller_id}」取得 {int(month_cnt or 0)} 张发票，"
                    f"为月均 {float(avg_cnt or 0):.1f} 张的 {ratio:.1f} 倍（阈值 {multiplier} 倍）。"
                ),
                "suggestion": "建议核查该月业务背景，是否存在集中验收、预开票或贸易频率异常。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    stat_year=stat_year,
                    stat_month=month_i or None,
                    date_from=date_from,
                    date_to=date_to,
                    seller_tax_no=seller_id,
                    month_count=int(month_cnt or 0),
                    avg_month_count=float(avg_cnt or 0),
                ),
            }
        )
    return flags
