"""审计疑点规则统一类型。"""

from __future__ import annotations

from typing import Any, TypedDict


class AuditFlagRow(TypedDict, total=False):
    """审计疑点行：规则写入字段与列表 API 返回字段的并集。

    ``invoice_list`` 仅规则落库时使用（写入 dm_audit_flag），列表 API 不返回该列；
    前端展示请使用 ``detail_json`` 或专用导出接口。
    """

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
    detail_json: str | None
    is_confirmed: bool
    confirm_note: str | None
    created_at: str | None


RuleContext = dict[str, Any]
