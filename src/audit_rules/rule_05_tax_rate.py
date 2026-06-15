"""
RULE-05：税率与品类不匹配。

审计含义：
- 货物名称关键词与税率偏离预置对照表：可能存在错误开票或虚增进项抵扣风险。
- 同一供应商同一品类跨月使用不同税率：税率适用不一致，需核实税收分类编码。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import entity_filter, flag_detail_json, norm_tax


def _category_case_sql(category_map: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in category_map:
        kws = item.get("keywords") if isinstance(item.get("keywords"), list) else []
        rate = float(item.get("expected_rate") or 0)
        if not kws:
            continue
        cond = " OR ".join(
            f"lower(coalesce(d.hwlwmc, '')) LIKE '%{str(kw).lower().replace(chr(39), '')}%'" for kw in kws
        )
        parts.append(f"WHEN ({cond}) THEN {rate}")
    if not parts:
        return "NULL"
    return "CASE " + " ".join(parts) + " ELSE NULL END"


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-05")
    if not cfg.get("enabled", True):
        return []

    category_map = cfg.get("category_tax_map") if isinstance(cfg.get("category_tax_map"), list) else []
    if not category_map:
        return []

    tolerance = 0.005
    expected_expr = _category_case_sql(category_map)
    ef, ep = entity_filter(entity_id, xfs_col="d.xfsbh", gfs_col="d.gfsbh")
    nx = norm_tax("d.xfsbh")
    ng = norm_tax("d.gfsbh")
    flags: list[AuditFlagRow] = []

    # 品类税率偏离
    mismatch_rows = conn.execute(
        f"""
        WITH tagged AS (
            SELECT
                d.header_uuid,
                d.detail_uuid,
                {ng} AS buyer_id,
                trim(COALESCE(d.gfmc, '')) AS buyer_name,
                {nx} AS seller_id,
                trim(COALESCE(d.xfmc, '')) AS seller_name,
                trim(COALESCE(d.hwlwmc, '')) AS goods_name,
                d.slv_num,
                {expected_expr} AS expected_rate,
                abs(coalesce(d.je, 0)) AS line_amt
            FROM dwd_inv_detail d
            WHERE d.stat_year = ?
              AND d.logic_line_no > 0
              AND coalesce(d.slv_num, 0) > 0
              {ef}
        )
        SELECT buyer_id, buyer_name, seller_id, seller_name, goods_name, slv_num, expected_rate,
               header_uuid, detail_uuid, line_amt
        FROM tagged
        WHERE expected_rate IS NOT NULL
          AND abs(slv_num - expected_rate) > ?
        ORDER BY line_amt DESC
        LIMIT 400
        """,
        [stat_year, *ep, tolerance],
    ).fetchall()

    for row in mismatch_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, goods_name, slv_num, expected_rate, hid, did, line_amt = row
        digest = hashlib.md5(str(did).encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-05M-{digest}",
                "rule_id": "RULE-05",
                "risk_level": str(cfg.get("risk_level_mismatch") or "中风险"),
                "flag_type": "税率品类不匹配",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(line_amt or 0),
                "invoice_list": json.dumps([str(hid)], ensure_ascii=False),
                "description": (
                    f"明细「{goods_name}」税率 {float(slv_num or 0):.2%}，"
                    f"与预置品类期望税率 {float(expected_rate or 0):.2%} 不符；"
                    f"购方「{buyer_name or buyer_id}」/销方「{seller_name or seller_id}」。"
                ),
                "suggestion": "建议核对税收分类编码与适用税率政策，排除错误开票或不当抵扣。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    goods_name=goods_name,
                    slv_num=float(slv_num or 0),
                    expected_rate=float(expected_rate or 0),
                    header_uuid=str(hid),
                    detail_uuid=str(did),
                ),
            }
        )

    # 同供应商同品类跨月税率不一致
    inconsistent_rows = conn.execute(
        f"""
        WITH tagged AS (
            SELECT
                {ng} AS buyer_id,
                max(trim(COALESCE(d.gfmc, ''))) AS buyer_name,
                {nx} AS seller_id,
                max(trim(COALESCE(d.xfmc, ''))) AS seller_name,
                lower(trim(coalesce(d.hwlwmc, ''))) AS goods_key,
                d.stat_month,
                d.slv_num,
                list(d.header_uuid) AS uuids
            FROM dwd_inv_detail d
            WHERE d.stat_year = ?
              AND d.logic_line_no > 0
              AND coalesce(d.slv_num, 0) > 0
              AND length(trim(coalesce(d.hwlwmc, ''))) > 0
              {ef}
            GROUP BY buyer_id, seller_id, goods_key, d.stat_month, d.slv_num
        ),
        agg AS (
            SELECT
                buyer_id, buyer_name, seller_id, seller_name, goods_key,
                count(DISTINCT slv_num)::INT AS rate_cnt,
                list(DISTINCT slv_num) AS rates,
                list_distinct(flatten(list(uuids))) AS uuids
            FROM tagged
            GROUP BY buyer_id, buyer_name, seller_id, seller_name, goods_key
            HAVING count(DISTINCT slv_num) >= 2
        )
        SELECT buyer_id, buyer_name, seller_id, seller_name, goods_key, rate_cnt, rates, uuids
        FROM agg
        LIMIT 200
        """,
        [stat_year, *ep],
    ).fetchall()

    for row in inconsistent_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, goods_key, rate_cnt, rates, uuids = row
        key = f"inc|{buyer_id}|{seller_id}|{goods_key}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        rate_str = ", ".join(f"{float(r or 0):.2%}" for r in (rates or []))
        flat_uuids = [str(u) for u in (uuids or []) if u][:30]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-05I-{digest}",
                "rule_id": "RULE-05",
                "risk_level": str(cfg.get("risk_level_inconsistent") or "中风险"),
                "flag_type": "同品类税率不一致",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": None,
                "invoice_list": json.dumps(flat_uuids, ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」从「{seller_name or seller_id}」"
                    f"采购同类货物「{goods_key}」出现 {int(rate_cnt or 0)} 种不同税率（{rate_str}）。"
                ),
                "suggestion": "建议按货物清单核对税收分类编码变更记录及开票口径是否统一。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    goods_name=goods_key,
                    rate_count=int(rate_cnt or 0),
                ),
            }
        )

    return flags
