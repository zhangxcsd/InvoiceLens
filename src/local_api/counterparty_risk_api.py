"""对手风险聚合 API（dm_audit_flag + dws_trade_sum）。"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

_RULE_WEIGHTS: dict[str, float] = {
    "RULE-01": 1.0,
    "RULE-02": 1.2,
    "RULE-03": 1.5,
    "RULE-04": 1.0,
    "RULE-06": 1.3,
    "RULE-08": 1.4,
    "RULE-09": 1.6,
    "RULE-10": 1.5,
}


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    from datetime import date

    d = date.today().year if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _norm_entity(v: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(v or "").strip()).upper()


def _counterparty_from_detail(detail_json: str | None) -> str:
    if not detail_json:
        return ""
    try:
        obj = json.loads(detail_json)
        for key in ("counterparty_id", "seller_tax_no", "xfsbh", "party_b_tax", "supplier_id"):
            v = obj.get(key)
            if v:
                return _norm_entity(str(v))
    except (json.JSONDecodeError, TypeError):
        pass
    return ""


def api_dws_counterparty_risk_list(
    conn: Any,
    *,
    stat_year: str | None,
    entity_id: str | None = None,
    limit: int = 30,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        eid = _norm_entity(entity_id)
        if not eid:
            return {
                "ok": False,
                "error": {
                    "message": "对手风险聚合需指定主体（entity_id 税号）",
                    "exception_type": "ValidationError",
                },
            }
        lim = max(1, min(int(limit or 30), 200))
        off = max(0, int(offset or 0))
        group_id = f"Y{y}"

        flag_rows = conn.execute(
            """
            -- 审计含义：抽取疑点 detail_json 中的对手税号并按规则计数
            SELECT rule_id, detail_json, amount
            FROM dm_audit_flag
            WHERE group_id = ?
              AND upper(regexp_replace(trim(coalesce(entity_id, '')), '[\\s-]+', '', 'g')) = ?
            """,
            [group_id, eid],
        ).fetchall()

        cp_flags: dict[str, dict[str, Any]] = {}
        for rule_id, detail_json, amount in flag_rows or []:
            cp = _counterparty_from_detail(str(detail_json or ""))
            if not cp:
                continue
            slot = cp_flags.setdefault(
                cp,
                {"flag_count": 0, "pending_count": 0, "amount_sum": 0.0, "by_rule": {}},
            )
            slot["flag_count"] += 1
            slot["amount_sum"] += float(amount or 0)
            rid = str(rule_id or "")
            slot["by_rule"][rid] = int(slot["by_rule"].get(rid, 0)) + 1

        trade_rows = conn.execute(
            """
            SELECT counterparty_id, max(counterparty_name), sum(abs(total_amount))
            FROM dws_trade_sum
            WHERE stat_year = ? AND entity_id = ? AND length(counterparty_id) > 0
            GROUP BY counterparty_id
            """,
            [y, eid],
        ).fetchall()
        trade_map = {
            str(r[0] or ""): {"name": str(r[1] or r[0] or ""), "trade_amount": float(r[2] or 0)}
            for r in trade_rows or []
        }

        all_cps = set(cp_flags.keys()) | set(trade_map.keys())
        scored: list[dict[str, Any]] = []
        for cp in all_cps:
            flags = cp_flags.get(cp, {"flag_count": 0, "amount_sum": 0.0, "by_rule": {}})
            trade = trade_map.get(cp, {"name": cp, "trade_amount": 0.0})
            score = 0.0
            for rid, cnt in (flags.get("by_rule") or {}).items():
                score += cnt * _RULE_WEIGHTS.get(rid, 1.0)
            scored.append(
                {
                    "counterparty_id": cp,
                    "counterparty_name": trade.get("name") or cp,
                    "trade_amount": round(float(trade.get("trade_amount") or 0), 2),
                    "flag_count": int(flags.get("flag_count") or 0),
                    "amount_sum": round(float(flags.get("amount_sum") or 0), 2),
                    "by_rule": flags.get("by_rule") or {},
                    "risk_score": round(score, 2),
                }
            )

        scored.sort(key=lambda x: (-x["risk_score"], -x["trade_amount"], x["counterparty_id"]))
        total = len(scored)
        page = scored[off : off + lim]

        return {
            "ok": True,
            "stat_year": str(y),
            "entity_id": eid,
            "rows": page,
            "total": total,
            "limit": lim,
            "offset": off,
            "hint": None if total > 0 else f"{y} 年度该主体暂无对手交易或疑点关联数据。",
        }
    except Exception as exc:
        logger.exception("dws_counterparty_risk_list")
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}
