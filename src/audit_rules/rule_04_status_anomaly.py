"""
RULE-04：发票状态异常。

审计含义：
- 主体作废率过高：整体发票质量差或存在大量无效凭证入账风险。
- 供应商作废率集中：特定供应商作废占比异常，可能存在虚假贸易后作废冲销。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import IS_CANCEL, entity_filter, flag_detail_json, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-04")
    if not cfg.get("enabled", True):
        return []

    warn_rate = float(cfg.get("void_rate_warn") or 0.05)
    high_rate = float(cfg.get("void_rate_high") or 0.10)
    sup_rate = float(cfg.get("supplier_void_rate") or 0.30)
    ef, ep = entity_filter(entity_id)
    ng = norm_tax("h.gfsbh")
    nx = norm_tax("h.xfsbh")
    flags: list[AuditFlagRow] = []

    # 购方主体作废率
    entity_rows = conn.execute(
        f"""
        SELECT
            {ng} AS buyer_id,
            max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
            count(*)::INT AS total_cnt,
            sum(CASE WHEN {IS_CANCEL} THEN 1 ELSE 0 END)::INT AS void_cnt
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND length({ng}) > 0
          {ef}
        GROUP BY buyer_id
        HAVING count(*) >= 10
           AND sum(CASE WHEN {IS_CANCEL} THEN 1 ELSE 0 END)::DOUBLE / count(*) >= ?
        ORDER BY void_cnt DESC
        LIMIT 100
        """,
        [stat_year, *ep, warn_rate],
    ).fetchall()

    for row in entity_rows or []:
        buyer_id, buyer_name, total_cnt, void_cnt = row
        rate = float(void_cnt or 0) / float(total_cnt or 1)
        risk = str(cfg.get("risk_level_high") or "高风险") if rate >= high_rate else str(
            cfg.get("risk_level_warn") or "中风险"
        )
        digest = hashlib.md5(f"ent|{buyer_id}".encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-04E-{digest}",
                "rule_id": "RULE-04",
                "risk_level": risk,
                "flag_type": "主体作废率异常",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": None,
                "seller_tax_no": None,
                "amount": None,
                "invoice_list": json.dumps([], ensure_ascii=False),
                "description": (
                    f"购方主体「{buyer_name or buyer_id}」{stat_year} 年共 {int(total_cnt or 0)} 张发票，"
                    f"作废/异常状态 {int(void_cnt or 0)} 张，作废率 {rate:.1%}。"
                ),
                "suggestion": "建议排查作废原因分类（误开、退货、违规冲销），并核对作废票是否仍被用于入账。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    void_rate=rate,
                    void_count=int(void_cnt or 0),
                    total_count=int(total_cnt or 0),
                ),
            }
        )

    # 供应商维度作废率（购方视角）
    sup_rows = conn.execute(
        f"""
        SELECT
            {ng} AS buyer_id,
            max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
            {nx} AS seller_id,
            max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
            count(*)::INT AS total_cnt,
            sum(CASE WHEN {IS_CANCEL} THEN 1 ELSE 0 END)::INT AS void_cnt
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND length({ng}) > 0
          AND length({nx}) > 0
          {ef}
        GROUP BY buyer_id, seller_id
        HAVING count(*) >= 5
           AND sum(CASE WHEN {IS_CANCEL} THEN 1 ELSE 0 END)::DOUBLE / count(*) >= ?
        ORDER BY void_cnt DESC
        LIMIT 200
        """,
        [stat_year, *ep, sup_rate],
    ).fetchall()

    for row in sup_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, total_cnt, void_cnt = row
        rate = float(void_cnt or 0) / float(total_cnt or 1)
        key = f"sup|{buyer_id}|{seller_id}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-04S-{digest}",
                "rule_id": "RULE-04",
                "risk_level": str(cfg.get("risk_level_supplier") or "中风险"),
                "flag_type": "供应商作废率异常",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": None,
                "invoice_list": json.dumps([], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」从供应商「{seller_name or seller_id}」"
                    f"取得 {int(total_cnt or 0)} 张发票，其中作废 {int(void_cnt or 0)} 张，"
                    f"作废率 {rate:.1%}（阈值 {sup_rate:.0%}）。"
                ),
                "suggestion": "建议重点核查该供应商交易真实性及作废票的会计处理。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    void_rate=rate,
                    void_count=int(void_cnt or 0),
                    total_count=int(total_cnt or 0),
                ),
            }
        )

    return flags
