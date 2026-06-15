"""
RULE-10：集团内部交易（花名册成员互开）。

审计含义：购销双方均为当年企业花名册成员，属于集团内部交易，需关注是否完整披露与定价公允。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import ABS_NET, FPZT_NORMAL, IS_POSITIVE, flag_detail_json, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-10")
    if not cfg.get("enabled", True):
        return []

    min_amt = float(cfg.get("min_amount") or 10000)
    risk = str(cfg.get("risk_level") or "中风险")
    use_roster = bool(cfg.get("use_enterprise_year_roster", True))
    ng = norm_tax("h.gfsbh")
    nx = norm_tax("h.xfsbh")
    norm_ent = norm_tax("r.enterprise_id")

    entity_clause = ""
    entity_params: list[Any] = []
    if entity_id:
        import re

        raw = re.sub(r"[\s-]+", "", str(entity_id).strip()).upper()
        if raw:
            entity_clause = f" AND ({ng} = ? OR {nx} = ?)"
            entity_params = [raw, raw]

    roster_sql = f"""
        WITH roster AS (
            SELECT DISTINCT {norm_ent} AS tax, max(trim(COALESCE(r.enterprise_name, ''))) AS name
            FROM dim_enterprise_year_roster r
            WHERE r.stat_year = ? AND length({norm_ent}) > 0
            GROUP BY 1
        ),
        internal_inv AS (
            SELECT
                {ng} AS buyer_id,
                max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
                {nx} AS seller_id,
                max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
                sum({ABS_NET}) AS total_amt,
                count(*)::INT AS cnt,
                list(h.header_uuid) AS uuids
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              {entity_clause}
            GROUP BY buyer_id, seller_id
        )
        SELECT i.buyer_id, i.buyer_name, i.seller_id, i.seller_name, i.total_amt, i.cnt, i.uuids
        FROM internal_inv i
        JOIN roster rb ON i.buyer_id = rb.tax
        JOIN roster rs ON i.seller_id = rs.tax
        WHERE i.buyer_id <> i.seller_id
          AND i.total_amt >= ?
        ORDER BY i.total_amt DESC
        LIMIT 300
    """

    if not use_roster:
        return []

    try:
        roster_cnt = conn.execute(
            "SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_roster WHERE stat_year = ?",
            [stat_year],
        ).fetchone()[0]
        if int(roster_cnt or 0) == 0:
            return []
    except Exception:
        return []

    rows = conn.execute(
        roster_sql,
        [stat_year, stat_year, *entity_params, min_amt],
    ).fetchall()

    flags: list[AuditFlagRow] = []
    for row in rows or []:
        buyer_id, buyer_name, seller_id, seller_name, total_amt, cnt, uuids = row
        key = f"int|{buyer_id}|{seller_id}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-10-{digest}",
                "rule_id": "RULE-10",
                "risk_level": risk,
                "flag_type": "集团内部互开",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(total_amt or 0),
                "invoice_list": json.dumps([str(u) for u in (uuids or []) if u][:30], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」与销方「{seller_name or seller_id}」"
                    f"均为 {stat_year} 年花名册成员，内部开票 {int(cnt or 0)} 张、"
                    f"合计 {float(total_amt or 0):,.2f} 元，需关注内部交易披露与定价公允。"
                ),
                "suggestion": "建议对照内部关联交易台账、合并抵消分录及Transfer Pricing政策。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    stat_year=stat_year,
                    entity_id=buyer_id,
                    buyer_tax_no=buyer_id,
                    seller_tax_no=seller_id,
                    counterparty_id=seller_id,
                    counterparty_tax_no=seller_id,
                    invoice_count=int(cnt or 0),
                ),
            }
        )
    return flags
