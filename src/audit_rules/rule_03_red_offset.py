"""
RULE-03：红冲发票异常。

审计含义：
- 红冲后短期内同购销方同金额再开票：可能掩盖真实交易或调节期间利润。
- 跨年红冲：原票与红票不在同一年度，影响期间归属。
- 红冲比例过高：供应商红冲占开票比重异常。
- 孤立红票：无法关联蓝票的红字发票，溯源困难。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import ABS_NET, FPZT_NORMAL, entity_filter, flag_detail_json, norm_tax


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-03")
    if not cfg.get("enabled", True):
        return []

    window = int(cfg.get("reissue_window_days") or 30)
    red_ratio = float(cfg.get("red_ratio_threshold") or 0.2)
    ef, ep = entity_filter(entity_id)
    ef_r, ep_r = entity_filter(entity_id, xfs_col="r.xfsbh", gfs_col="r.gfsbh")
    nx = norm_tax("h.xfsbh")
    ng = norm_tax("h.gfsbh")
    flags: list[AuditFlagRow] = []

    # 红冲后再开
    reissue_rows = conn.execute(
        f"""
        WITH reds AS (
            SELECT
                h.header_uuid AS red_uuid,
                h.invoice_date AS red_date,
                {ng} AS buyer_id,
                trim(COALESCE(h.gfmc, '')) AS buyer_name,
                {nx} AS seller_id,
                trim(COALESCE(h.xfmc, '')) AS seller_name,
                round(abs({ABS_NET}), 2) AS amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {ABS_NET} < 0
              {ef}
        )
        SELECT DISTINCT
            r.red_uuid, r.red_date, r.buyer_id, r.buyer_name, r.seller_id, r.seller_name, r.amt,
            b.header_uuid AS blue_uuid, b.invoice_date AS blue_date
        FROM reds r
        JOIN dwd_inv_header b
          ON {norm_tax('b.xfsbh')} = r.seller_id
         AND {norm_tax('b.gfsbh')} = r.buyer_id
         AND round(abs(COALESCE(b.net_jshj, b.jshj, 0)), 2) = r.amt
         AND b.stat_year = ?
         AND coalesce(nullif(trim(cast(b.fpzt AS VARCHAR)), ''), '正常') = '正常'
         AND COALESCE(b.net_jshj, b.jshj, 0) > 0
         AND abs(date_diff('day', r.red_date, b.invoice_date)) <= ?
         AND b.invoice_date >= r.red_date
        LIMIT 300
        """,
        [stat_year, *ep, stat_year, window],
    ).fetchall()

    seen_re: set[str] = set()
    for row in reissue_rows or []:
        red_uuid, red_date, buyer_id, buyer_name, seller_id, seller_name, amt, blue_uuid, blue_date = row
        key = f"{red_uuid}|{blue_uuid}"
        if key in seen_re:
            continue
        seen_re.add(key)
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-03R-{digest}",
                "rule_id": "RULE-03",
                "risk_level": str(cfg.get("risk_level_reissue") or "高风险"),
                "flag_type": "红冲后再开票",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(amt or 0),
                "invoice_list": json.dumps([str(red_uuid), str(blue_uuid)], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」对销方「{seller_name or seller_id}」"
                    f"于 {red_date} 红冲 {float(amt or 0):,.2f} 元后，"
                    f"在 {window} 天内于 {blue_date} 再次开具同金额蓝票，需关注是否调节期间或重复入账。"
                ),
                "suggestion": "建议调取红冲申请、原业务合同及两次入账凭证，核对业务实质是否一致。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    red_date=str(red_date),
                    blue_date=str(blue_date),
                    date_from=str(red_date),
                    date_to=str(blue_date),
                    red_header_uuid=str(red_uuid),
                    blue_header_uuid=str(blue_uuid),
                ),
            }
        )

    # 跨年红冲（红票关联蓝票年度不同）
    cross_rows = conn.execute(
        f"""
        SELECT
            r.header_uuid AS red_uuid,
            r.stat_year AS red_year,
            b.header_uuid AS blue_uuid,
            b.stat_year AS blue_year,
            {ng.replace('h.', 'r.')} AS buyer_id,
            trim(COALESCE(r.gfmc, '')) AS buyer_name,
            {nx.replace('h.', 'r.')} AS seller_id,
            trim(COALESCE(r.xfmc, '')) AS seller_name,
            abs(COALESCE(r.net_jshj, r.jshj, 0)) AS amt
        FROM dwd_inv_header r
        JOIN dwd_inv_header b ON b.header_uuid = r.related_blue_invoice_uuid
        WHERE r.stat_year = ?
          AND r.related_blue_invoice_uuid IS NOT NULL
          AND r.stat_year <> b.stat_year
          {ef_r}
        LIMIT 200
        """,
        [stat_year, *ep_r],
    ).fetchall()

    for row in cross_rows or []:
        red_uuid, red_year, blue_uuid, blue_year, buyer_id, buyer_name, seller_id, seller_name, amt = row
        digest = hashlib.md5(str(red_uuid).encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-03C-{digest}",
                "rule_id": "RULE-03",
                "risk_level": str(cfg.get("risk_level_cross_year") or "中风险"),
                "flag_type": "跨年红冲",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(amt or 0),
                "invoice_list": json.dumps([str(red_uuid), str(blue_uuid)], ensure_ascii=False),
                "description": (
                    f"红票（{red_year} 年）关联蓝票（{blue_year} 年）跨自然年红冲，"
                    f"购方「{buyer_name or buyer_id}」/销方「{seller_name or seller_id}」，"
                    "可能影响各期成本费用归属。"
                ),
                "suggestion": "建议核对红冲原因说明及跨期账务调整依据。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    red_year=int(red_year or 0) or None,
                    blue_year=int(blue_year or 0) or None,
                    red_header_uuid=str(red_uuid),
                    blue_header_uuid=str(blue_uuid),
                ),
            }
        )

    # 供应商红冲比例
    ratio_rows = conn.execute(
        f"""
        SELECT
            {ng} AS buyer_id,
            max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
            {nx} AS seller_id,
            max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
            sum(CASE WHEN COALESCE(h.net_jshj, h.jshj, 0) < 0 THEN abs(COALESCE(h.net_jshj, h.jshj, 0)) ELSE 0 END) AS red_amt,
            sum(CASE WHEN COALESCE(h.net_jshj, h.jshj, 0) > 0 THEN COALESCE(h.net_jshj, h.jshj, 0) ELSE 0 END) AS blue_amt
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND {FPZT_NORMAL}
          {ef}
        GROUP BY buyer_id, seller_id
        HAVING sum(CASE WHEN COALESCE(h.net_jshj, h.jshj, 0) > 0 THEN COALESCE(h.net_jshj, h.jshj, 0) ELSE 0 END) > 0
           AND sum(CASE WHEN COALESCE(h.net_jshj, h.jshj, 0) < 0 THEN abs(COALESCE(h.net_jshj, h.jshj, 0)) ELSE 0 END)
               / nullif(sum(CASE WHEN COALESCE(h.net_jshj, h.jshj, 0) > 0 THEN COALESCE(h.net_jshj, h.jshj, 0) ELSE 0 END), 0) >= ?
        ORDER BY red_amt / nullif(blue_amt, 0) DESC
        LIMIT 200
        """,
        [stat_year, *ep, red_ratio],
    ).fetchall()

    for row in ratio_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, red_amt, blue_amt = row
        ratio = float(red_amt or 0) / float(blue_amt or 1)
        key = f"ratio|{buyer_id}|{seller_id}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-03P-{digest}",
                "rule_id": "RULE-03",
                "risk_level": str(cfg.get("risk_level_ratio") or "中风险"),
                "flag_type": "红冲比例异常",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(red_amt or 0),
                "invoice_list": json.dumps([], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」对供应商「{seller_name or seller_id}」"
                    f"{stat_year} 年红冲金额 {float(red_amt or 0):,.2f} 元，"
                    f"占蓝票金额 {float(blue_amt or 0):,.2f} 元的 {ratio:.1%}（阈值 {red_ratio:.0%}）。"
                ),
                "suggestion": "建议了解频繁红冲原因，关注是否存在价格调整、退货未及时处理或虚开发票后冲回。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    red_amount=float(red_amt or 0),
                    blue_amount=float(blue_amt or 0),
                    red_ratio=ratio,
                ),
            }
        )

    # 孤立红票
    orphan_rows = conn.execute(
        f"""
        SELECT
            h.header_uuid,
            {ng} AS buyer_id,
            trim(COALESCE(h.gfmc, '')) AS buyer_name,
            {nx} AS seller_id,
            trim(COALESCE(h.xfmc, '')) AS seller_name,
            abs(COALESCE(h.net_jshj, h.jshj, 0)) AS amt
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND COALESCE(h.is_orphan_red, FALSE)
          {ef}
        LIMIT 200
        """,
        [stat_year, *ep],
    ).fetchall()

    for row in orphan_rows or []:
        hid, buyer_id, buyer_name, seller_id, seller_name, amt = row
        digest = hashlib.md5(str(hid).encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-03O-{digest}",
                "rule_id": "RULE-03",
                "risk_level": str(cfg.get("risk_level_orphan") or "高风险"),
                "flag_type": "孤立红票",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(amt or 0),
                "invoice_list": json.dumps([str(hid)], ensure_ascii=False),
                "description": (
                    f"孤立红字发票（无法关联蓝票），购方「{buyer_name or buyer_id}」/"
                    f"销方「{seller_name or seller_id}」，金额 {float(amt or 0):,.2f} 元。"
                ),
                "suggestion": "建议从税控系统导出原蓝票信息或查阅备注字段，补全红蓝关联后再复核净额。",
                "analysis_batch": batch,
                "detail_json": flag_detail_json(
                    seller_tax_no=seller_id,
                    header_uuid=str(hid),
                    fpzt="红字",
                ),
            }
        )

    return flags
