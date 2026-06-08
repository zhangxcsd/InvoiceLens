"""审计规则注册表（RULE-01~10）。"""

from __future__ import annotations

from typing import Any, Callable

from src.audit.types import AuditFlagRow, RuleContext

RuleRunner = Callable[[Any, RuleContext], list[AuditFlagRow]]


def _import_runners() -> dict[str, RuleRunner]:
    from src.audit_rules import (
        rule_01_duplicate,
        rule_02_abnormal_date,
        rule_03_red_offset,
        rule_04_status_anomaly,
        rule_05_tax_rate,
        rule_06_amount_outlier,
        rule_07_freq_spike,
        rule_08_price_consistency,
        rule_09_circular,
        rule_10_internal,
    )

    return {
        "RULE-01": rule_01_duplicate.run_rule,
        "RULE-02": rule_02_abnormal_date.run_rule,
        "RULE-03": rule_03_red_offset.run_rule,
        "RULE-04": rule_04_status_anomaly.run_rule,
        "RULE-05": rule_05_tax_rate.run_rule,
        "RULE-06": rule_06_amount_outlier.run_rule,
        "RULE-07": rule_07_freq_spike.run_rule,
        "RULE-08": rule_08_price_consistency.run_rule,
        "RULE-09": rule_09_circular.run_rule,
        "RULE-10": rule_10_internal.run_rule,
    }


def all_rule_ids() -> list[str]:
    return list(_import_runners().keys())


def get_runner(rule_id: str) -> RuleRunner | None:
    return _import_runners().get(rule_id)
