"""
RULE-01：重复开票检测。

审计含义：
- 同一购方+销方+金额（净额）在窗口期内出现多张正常蓝票，存在重复报销或重复入账风险。
- 同购销方同月多张低于阈值的票合计超过阈值，存在化整为零规避审批风险。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import ABS_NET, FPZT_NORMAL, IS_POSITIVE, entity_filter, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-01")
    if not cfg.get("enabled", True):
        return []

    window_days = int(cfg.get("duplicate_window_days") or 30)
    split_threshold = float(cfg.get("split_threshold") or 500000)
    risk = str(cfg.get("risk_level") or "高风险")
    ef, ep = entity_filter(entity_id)
    nx = norm_tax("h.xfsbh")
    ng = norm_tax("h.gfsbh")

    flags: list[AuditFlagRow] = []

    # --- 子规则 A：同窗同金额重复（同购销方同金额，首末开票日相差不超过窗口） ---
    dup_rows = conn.execute(
        f"""
        WITH base AS (
            SELECT
                h.header_uuid,
                h.invoice_date,
                {ng} AS buyer_id,
                max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
                {nx} AS seller_id,
                max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
                round({ABS_NET}, 2) AS amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              {ef}
            GROUP BY h.header_uuid, h.invoice_date, buyer_id, seller_id, amt
        )
        SELECT
            buyer_id,
            max(buyer_name) AS buyer_name,
            seller_id,
            max(seller_name) AS seller_name,
            amt,
            count(*)::INT AS grp_cnt,
            list(header_uuid) AS inv_uuids
        FROM base
        GROUP BY buyer_id, seller_id, amt
        HAVING count(*) >= 2
           AND date_diff('day', min(invoice_date), max(invoice_date)) <= ?
        ORDER BY grp_cnt DESC
        LIMIT 500
        """,
        [stat_year, *ep, window_days],
    ).fetchall()

    seen: set[str] = set()
    for row in dup_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, amt, grp_cnt, inv_uuids = row
        key = f"{buyer_id}|{seller_id}|{amt}"
        if key in seen:
            continue
        seen.add(key)
        uuids = list(dict.fromkeys(inv_uuids or []))[:50]
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-01-{digest}",
                "rule_id": "RULE-01",
                "risk_level": risk,
                "flag_type": "重复开票",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(amt or 0),
                "invoice_list": json.dumps(uuids, ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」向销方「{seller_name or seller_id}」"
                    f"在 {window_days} 天内出现 {int(grp_cnt or 0)} 张金额均为 {float(amt or 0):,.2f} 元的正常发票，"
                    "存在重复开票或重复入账风险。"
                ),
                "suggestion": "建议核对合同、验收单与入账凭证，确认是否存在重复报销或重复确认成本费用。",
                "analysis_batch": batch,
            }
        )

    # --- 子规则 B：化整为零 ---
    split_rows = conn.execute(
        f"""
        SELECT
            {ng} AS buyer_id,
            max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
            {nx} AS seller_id,
            max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
            h.stat_month,
            sum({ABS_NET}) AS month_total,
            count(*)::INT AS cnt,
            list(h.header_uuid) AS inv_uuids
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND {FPZT_NORMAL}
          AND {IS_POSITIVE}
          AND {ABS_NET} < ?
          {ef}
        GROUP BY buyer_id, seller_id, h.stat_month
        HAVING sum({ABS_NET}) >= ? AND count(*) >= 2
        ORDER BY month_total DESC
        LIMIT 200
        """,
        [stat_year, *ep, split_threshold, split_threshold],
    ).fetchall()

    for row in split_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, month, month_total, cnt, inv_uuids = row
        key = f"split|{buyer_id}|{seller_id}|{month}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        uuids = list(dict.fromkeys(inv_uuids or []))[:50]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-01S-{digest}",
                "rule_id": "RULE-01",
                "risk_level": risk,
                "flag_type": "化整为零",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(month_total or 0),
                "invoice_list": json.dumps(uuids, ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」{stat_year} 年 {int(month or 0)} 月向"
                    f"「{seller_name or seller_id}」取得 {int(cnt or 0)} 张发票，"
                    f"单张均低于 {split_threshold:,.0f} 元但合计 {float(month_total or 0):,.2f} 元，"
                    "存在化整为零规避审批阈值的可能。"
                ),
                "suggestion": "建议合并核查该月全部发票对应的业务合同、付款申请与审批权限。",
                "analysis_batch": batch,
            }
        )

    return flags
