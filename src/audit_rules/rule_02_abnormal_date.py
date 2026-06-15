"""
RULE-02：异常开票日期。

审计含义：
- 大额周末开票：非工作日取得大额进项，可能与虚假贸易或体外循环相关。
- 年末突击：供应商集中年末开票，存在调节利润或突击确认成本风险。
- 未来日期：开票日期晚于系统当前日，属于明显数据异常。
- 法定节假日：可选依赖 chinese_calendar；未安装时跳过该子规则。
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any

from src.audit.config_loader import rule_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules._sql_common import ABS_NET, FPZT_NORMAL, IS_POSITIVE, entity_filter, norm_tax


def _holiday_dates(stat_year: int) -> set[date]:
    try:
        import chinese_calendar as cc  # type: ignore
    except ImportError:
        return set()
    out: set[date] = set()
    for m in range(1, 13):
        for d in range(1, 32):
            try:
                dt = date(stat_year, m, d)
            except ValueError:
                continue
            try:
                if cc.is_holiday(dt):
                    out.add(dt)
            except Exception:
                continue
    return out


def run_rule(conn: Any, context: RuleContext) -> list[AuditFlagRow]:
    stat_year = int(context["stat_year"])
    entity_id = context.get("entity_id")
    group_id = str(context["group_id"])
    batch = str(context["analysis_batch"])
    cfg = rule_config("RULE-02")
    if not cfg.get("enabled", True):
        return []

    weekend_amt = float(cfg.get("weekend_large_amount") or 100000)
    yearend_ratio = float(cfg.get("yearend_month_ratio") or 0.5)
    ef, ep = entity_filter(entity_id)
    nx = norm_tax("h.xfsbh")
    ng = norm_tax("h.gfsbh")
    flags: list[AuditFlagRow] = []
    today = date.today()

    # 周末大额
    wk_rows = conn.execute(
        f"""
        SELECT
            h.header_uuid,
            h.invoice_date,
            {ng} AS buyer_id,
            trim(COALESCE(h.gfmc, '')) AS buyer_name,
            {nx} AS seller_id,
            trim(COALESCE(h.xfmc, '')) AS seller_name,
            {ABS_NET} AS amt
        FROM dwd_inv_header h
        WHERE h.stat_year = ?
          AND {FPZT_NORMAL}
          AND {IS_POSITIVE}
          AND {ABS_NET} >= ?
          AND dayofweek(h.invoice_date) IN (0, 6)
          {ef}
        ORDER BY amt DESC
        LIMIT 300
        """,
        [stat_year, *ep, weekend_amt],
    ).fetchall()

    for row in wk_rows or []:
        hid, inv_date, buyer_id, buyer_name, seller_id, seller_name, amt = row
        digest = hashlib.md5(str(hid).encode()).hexdigest()[:10]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-02W-{digest}",
                "rule_id": "RULE-02",
                "risk_level": str(cfg.get("risk_level_weekend") or "中风险"),
                "flag_type": "大额周末开票",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(amt or 0),
                "invoice_list": json.dumps([str(hid)], ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」于周末（{inv_date}）取得销方"
                    f"「{seller_name or seller_id}」开具的 {float(amt or 0):,.2f} 元发票，"
                    "非工作日大额开票需关注业务真实性。"
                ),
                "suggestion": "建议核查对应合同、物流/验收记录及付款审批时间链。",
                "analysis_batch": batch,
                "detail_json": json.dumps(
                    {
                        "invoice_date": str(inv_date),
                        "date_from": str(inv_date),
                        "date_to": str(inv_date),
                    },
                    ensure_ascii=False,
                ),
            }
        )

    # 年末突击（按购方+销方）
    ye_rows = conn.execute(
        f"""
        WITH sup AS (
            SELECT
                {ng} AS buyer_id,
                max(trim(COALESCE(h.gfmc, ''))) AS buyer_name,
                {nx} AS seller_id,
                max(trim(COALESCE(h.xfmc, ''))) AS seller_name,
                sum(CASE WHEN h.stat_month IN (11, 12) THEN {ABS_NET} ELSE 0 END) AS q4_amt,
                sum({ABS_NET}) AS year_amt,
                list(CASE WHEN h.stat_month IN (11, 12) THEN h.header_uuid END) AS q4_uuids
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              {ef}
            GROUP BY buyer_id, seller_id
            HAVING sum({ABS_NET}) > 0
               AND sum(CASE WHEN h.stat_month IN (11, 12) THEN {ABS_NET} ELSE 0 END)
                   / nullif(sum({ABS_NET}), 0) >= ?
        )
        SELECT buyer_id, buyer_name, seller_id, seller_name, q4_amt, year_amt, q4_uuids
        FROM sup
        ORDER BY q4_amt / nullif(year_amt, 0) DESC
        LIMIT 200
        """,
        [stat_year, *ep, yearend_ratio],
    ).fetchall()

    for row in ye_rows or []:
        buyer_id, buyer_name, seller_id, seller_name, q4_amt, year_amt, q4_uuids = row
        ratio = float(q4_amt or 0) / float(year_amt or 1)
        key = f"ye|{buyer_id}|{seller_id}"
        digest = hashlib.md5(key.encode()).hexdigest()[:10]
        uuids = [str(u) for u in (q4_uuids or []) if u][:50]
        flags.append(
            {
                "flag_id": f"FP-{stat_year}-02Y-{digest}",
                "rule_id": "RULE-02",
                "risk_level": str(cfg.get("risk_level_yearend") or "中风险"),
                "flag_type": "年末突击开票",
                "group_id": group_id,
                "entity_id": buyer_id or None,
                "entity_name": buyer_name or buyer_id,
                "seller_name": seller_name or seller_id,
                "seller_tax_no": seller_id,
                "amount": float(q4_amt or 0),
                "invoice_list": json.dumps(uuids, ensure_ascii=False),
                "description": (
                    f"购方「{buyer_name or buyer_id}」向「{seller_name or seller_id}」"
                    f"{stat_year} 年 11–12 月开票 {float(q4_amt or 0):,.2f} 元，"
                    f"占全年 {ratio:.1%}（阈值 {yearend_ratio:.0%}），存在年末集中确认成本风险。"
                ),
                "suggestion": "建议比对全年采购计划、入库验收与跨期费用归属。",
                "analysis_batch": batch,
                "detail_json": json.dumps(
                    {
                        "date_from": f"{stat_year}-11-01",
                        "date_to": f"{stat_year}-12-31",
                    },
                    ensure_ascii=False,
                ),
            }
        )

    # 未来日期
    if stat_year >= today.year:
        fut_rows = conn.execute(
            f"""
            SELECT
                h.header_uuid, h.invoice_date,
                {ng} AS buyer_id, trim(COALESCE(h.gfmc, '')) AS buyer_name,
                {nx} AS seller_id, trim(COALESCE(h.xfmc, '')) AS seller_name,
                {ABS_NET} AS amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND h.invoice_date > ?
              {ef}
            LIMIT 200
            """,
            [stat_year, *ep, today],
        ).fetchall()
        for row in fut_rows or []:
            hid, inv_date, buyer_id, buyer_name, seller_id, seller_name, amt = row
            digest = hashlib.md5(str(hid).encode()).hexdigest()[:10]
            flags.append(
                {
                    "flag_id": f"FP-{stat_year}-02F-{digest}",
                    "rule_id": "RULE-02",
                    "risk_level": str(cfg.get("risk_level_future") or "高风险"),
                    "flag_type": "未来开票日期",
                    "group_id": group_id,
                    "entity_id": buyer_id or None,
                    "entity_name": buyer_name or buyer_id,
                    "seller_name": seller_name or seller_id,
                    "seller_tax_no": seller_id,
                    "amount": float(amt or 0),
                    "invoice_list": json.dumps([str(hid)], ensure_ascii=False),
                    "description": (
                        f"发票开票日期 {inv_date} 晚于当前日期 {today}，"
                        f"购方「{buyer_name or buyer_id}」/销方「{seller_name or seller_id}」，"
                        "属于明显数据异常。"
                    ),
                    "suggestion": "建议回溯源 Excel 与税控导出时间戳，确认是否为导入错误或伪造票。",
                    "analysis_batch": batch,
                    "detail_json": json.dumps(
                        {
                            "invoice_date": str(inv_date),
                            "date_from": str(inv_date),
                            "date_to": str(inv_date),
                        },
                        ensure_ascii=False,
                    ),
                }
            )

    # 法定节假日（可选）
    holidays = _holiday_dates(stat_year)
    if holidays:
        hol_rows = conn.execute(
            f"""
            SELECT
                h.header_uuid, h.invoice_date,
                {ng} AS buyer_id, trim(COALESCE(h.gfmc, '')) AS buyer_name,
                {nx} AS seller_id, trim(COALESCE(h.xfmc, '')) AS seller_name,
                {ABS_NET} AS amt
            FROM dwd_inv_header h
            WHERE h.stat_year = ?
              AND {FPZT_NORMAL}
              AND {IS_POSITIVE}
              AND {ABS_NET} >= ?
              {ef}
            LIMIT 2000
            """,
            [stat_year, *ep, weekend_amt / 2],
        ).fetchall()
        for row in hol_rows or []:
            hid, inv_date, buyer_id, buyer_name, seller_id, seller_name, amt = row
            if inv_date not in holidays:
                continue
            digest = hashlib.md5(str(hid).encode()).hexdigest()[:10]
            flags.append(
                {
                    "flag_id": f"FP-{stat_year}-02H-{digest}",
                    "rule_id": "RULE-02",
                    "risk_level": str(cfg.get("risk_level_holiday") or "中风险"),
                    "flag_type": "法定节假日开票",
                    "group_id": group_id,
                    "entity_id": buyer_id or None,
                    "entity_name": buyer_name or buyer_id,
                    "seller_name": seller_name or seller_id,
                    "seller_tax_no": seller_id,
                    "amount": float(amt or 0),
                    "invoice_list": json.dumps([str(hid)], ensure_ascii=False),
                    "description": (
                        f"购方「{buyer_name or buyer_id}」于法定节假日 {inv_date} 取得"
                        f" {float(amt or 0):,.2f} 元发票（销方「{seller_name or seller_id}」）。"
                    ),
                    "suggestion": "建议核实是否为真实业务发生，排除虚假贸易可能。",
                    "analysis_batch": batch,
                    "detail_json": json.dumps(
                        {
                            "invoice_date": str(inv_date),
                            "date_from": str(inv_date),
                            "date_to": str(inv_date),
                        },
                        ensure_ascii=False,
                    ),
                }
            )

    return flags
