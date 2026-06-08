"""审计疑点规则统一类型。"""

from __future__ import annotations

from typing import Any, TypedDict


class AuditFlagRow(TypedDict, total=False):
    flag_id: str
    rule_id: str
    risk_level: str
    flag_type: str
    group_id: str
    entity_id: str | None
    entity_name: str | None
    seller_name: str | None
    seller_tax_no: str | None
    amount: float | None
    invoice_list: str | None
    description: str
    suggestion: str
    analysis_batch: str


RuleContext = dict[str, Any]
