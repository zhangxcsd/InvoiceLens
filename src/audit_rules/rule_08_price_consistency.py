"""
RULE-08：价格一致性核查。

审计含义：同一品类、同一季度不同供应商单价离散度过高，可能存在高价采购或价格操纵。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import entity_filter, flag_detail_json, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-08")
    if not cfg.get("enabled", True):
        return []

    dispersion = float(cfg.get("price_dispersion") or 0.2)
    min_suppliers = int(cfg.get("min_suppliers") or 2)
    risk = str(cfg.get("risk_level") or "低风险")
    ef, ep = entity_filter(entity_id, xfs_col="d.xfsbh", gfs_col="d.gfsbh")

    rows = conn.execute(
        f"""
        WITH lines AS (
            SELECT
                {norm_tax('d.gfsbh')} AS buyer_id,
                trim(COALESCE(d.gfmc, '')) AS buyer_name,
                {norm_tax('d.xfsbh')} AS seller_id,
                trim(COALESCE(d.xfmc, '')) AS seller_name,
                lower(trim(coalesce(d.hwlwmc, ''))) AS goods_key,
                ((d.stat_month - 1) / 3 + 1)::INT AS quarter,
                CASE WHEN coalesce(d.sl, 0) > 0 THEN abs(coalesce(d.je, 0)) / d.sl ELSE NULL END AS unit_price,
                d.header_uuid
            FROM dwd_inv_detail d
            WHERE d.stat_year = ?
              AND d.logic_line_no > 0
              AND coalesce(d.sl, 0) > 0
              AND length(trim(coalesce(d.hwlwmc, ''))) > 0
              {ef}
        ),
        sup_prices AS (
            SELECT buyer_id, goods_key, quarter, seller_id,
                   max(buyer_name) AS buyer_name,
                   max(seller_name) AS seller_name,
                   avg(unit_price) AS avg_unit_price,
                   list(header_uuid) AS uuids
            FROM lines
            WHERE unit_price IS NOT NULL AND unit_price > 0
            GROUP BY buyer_id, goods_key, quarter, seller_id
        ),
        bucket AS (
            SELECT buyer_id, goods_key, quarter,
                   max(buyer_name) AS buyer_name,
                   count(DISTINCT seller_id)::INT AS sup_cnt,
                   min(avg_unit_price) AS min_p,
                   max(avg_unit_price) AS max_p,
                   (max(avg_unit_price) - min(avg_unit_price)) / nullif(min(avg_unit_price), 0) AS disp
            FROM sup_prices
            GROUP BY buyer_id, goods_key, quarter
            HAVING count(DISTINCT seller_id) >= ?
               AND min(avg_unit_price) > 0
               AND (max(avg_unit_price) - min(avg_unit_price)) / nullif(min(avg_unit_price), 0) >= ?
        )
        SELECT b.buyer_id, b.buyer_name, b.goods_key, b.quarter, b.sup_cnt, b.min_p, b.max_p, b.disp,
               s.seller_id, s.seller_name, s.avg_unit_price, s.uuids
        FROM bucket b
        JOIN sup_prices s
          ON b.buyer_id = s.buyer_id AND b.goods_key = s.goods_key AND b.quarter = s.quarter
        WHERE s.avg_unit_price = b.max_p
        ORDER BY b.disp DESC
        LIMIT 200
        """,
        [stat_year, *ep, min_suppliers, dispersion],
    ).fetchall()

    flags: list[AuditFlagRow] = []
    seen: set[str] = set()
    for row in rows or []:
        buyer_id, buyer_name, goods_key, quarter, sup_cnt, min_p, max_p, disp, seller_id, seller_name, avg_p, uuids = row
        key = f"{buyer_id}|{goods_key}|{quarter}"
        if key in seen:
            continue
        seen.add(key)
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-08-{digest}",
                "rule_id": "RULE-08",
                "risk_level": risk,
                "flag_type": "价格离散偏高",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(avg_p or 0),
                "invoice_list": json.dumps([str(u) for u in (uuids or []) if u][:20], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」Q{int(quarter or 0)} 对品类「{goods_key}」"
                    f"有 {int(sup_cnt or 0)} 家供应商，单价离散度 {float(disp or 0):.1%}（阈值 {dispersion:.0%}）；"
                    f"高价供应商「{seller_name or seller_id}」均价 {float(avg_p or 0):,.4f}，"
                    f"最低均价 {float(min_p or 0):,.4f}。"
                ),
                "suggestion": "建议开展同品类询比价复核，关注高价供应商采购审批与合同条款。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    goods_key=goods_key,
                    quarter=int(quarter or 0) or None,
                    dispersion=float(disp or 0),
                    supplier_count=int(sup_cnt or 0),
                ),
            }
        )
    return flags
