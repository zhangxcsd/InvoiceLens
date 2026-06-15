"""审计规则引擎：编排 RULE-01~05 并写入 dm_audit_flag。"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Callable

from src.audit.config_loader import group_id_for_year, is_rule_enabled, load_audit_rules_config
from src.audit.types import AuditFlagRow, RuleContext
from src.audit_rules.registry import all_rule_ids, get_runner

logger = logging.getLogger(__name__)

AUTOMATION_TASK_CODE = "dm.audit_flag.scan"
TASK_DISPLAY_NAME = "审计疑点扫描（RULE-01~10）"

ProgressFn = Callable[[str, str], None] | None


def _make_batch_id(prefix: str = "audit") -> str:
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def _insert_flags(conn: Any, flags: list[AuditFlagRow]) -> int:
    if not flags:
        return 0
    conn.executemany(
        """
        INSERT INTO dm_audit_flag (
            flag_id, rule_id, risk_level, flag_type, group_id,
            entity_id, entity_name, seller_name, seller_tax_no,
            amount, invoice_list, description, suggestion, analysis_batch, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (flag_id) DO UPDATE SET
            risk_level = excluded.risk_level,
            flag_type = excluded.flag_type,
            entity_name = excluded.entity_name,
            seller_name = excluded.seller_name,
            seller_tax_no = excluded.seller_tax_no,
            amount = excluded.amount,
            invoice_list = excluded.invoice_list,
            description = excluded.description,
            suggestion = excluded.suggestion,
            analysis_batch = excluded.analysis_batch,
            detail_json = excluded.detail_json
        """,
        [
            (
                f["flag_id"],
                f["rule_id"],
                f["risk_level"],
                f["flag_type"],
                f["group_id"],
                f.get("entity_id"),
                f.get("entity_name"),
                f.get("seller_name"),
                f.get("seller_tax_no"),
                f.get("amount"),
                f.get("invoice_list"),
                f.get("description"),
                f.get("suggestion"),
                f["analysis_batch"],
                f.get("detail_json"),
            )
            for f in flags
        ],
    )
    return len(flags)


def run_audit_scan(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str | None = None,
    rule_ids: list[str] | None = None,
    dry_run: bool = False,
    analysis_batch: str | None = None,
    replace_existing: bool = True,
    on_progress: ProgressFn = None,
) -> dict[str, Any]:
    """
    对指定 stat_year 运行审计规则，结果写入 dm_audit_flag。

    group_id 口径：Y{stat_year}（见 config/audit_rules.yaml）。
    """
    group_id = group_id_for_year(stat_year)
    batch = analysis_batch or _make_batch_id()
    selected = rule_ids or all_rule_ids()
    selected = [r for r in selected if r in all_rule_ids()]

    ctx: RuleContext = {
        "stat_year": stat_year,
        "entity_id": entity_id,
        "group_id": group_id,
        "analysis_batch": batch,
        "config": load_audit_rules_config(),
    }

    all_flags: list[AuditFlagRow] = []
    rule_stats: list[dict[str, Any]] = []

    for rule_id in selected:
        if not is_rule_enabled(rule_id):
            rule_stats.append({"rule_id": rule_id, "skipped": True, "reason": "disabled", "flag_count": 0})
            continue
        runner = get_runner(rule_id)
        if runner is None:
            rule_stats.append({"rule_id": rule_id, "skipped": True, "reason": "not_found", "flag_count": 0})
            continue
        if on_progress:
            on_progress("rule_start", rule_id)
        try:
            flags = runner(conn, ctx)
        except Exception as exc:
            logger.exception("规则 %s 执行失败", rule_id)
            rule_stats.append(
                {
                    "rule_id": rule_id,
                    "ok": False,
                    "error": str(exc),
                    "exception_type": type(exc).__name__,
                    "flag_count": 0,
                }
            )
            continue
        all_flags.extend(flags)
        rule_stats.append({"rule_id": rule_id, "ok": True, "flag_count": len(flags)})
        if on_progress:
            on_progress("rule_done", f"{rule_id}:{len(flags)}")

    inserted = 0
    if not dry_run:
        if replace_existing and selected:
            placeholders = ", ".join("?" for _ in selected)
            # 仅删除未确认疑点，保留已跟踪/已结案记录
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE group_id = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                """,
                [group_id, *selected],
            )
        inserted = _insert_flags(conn, all_flags)

    risk_counts: dict[str, int] = {}
    for f in all_flags:
        rl = str(f.get("risk_level") or "")
        risk_counts[rl] = risk_counts.get(rl, 0) + 1

    return {
        "ok": True,
        "dry_run": dry_run,
        "stat_year": stat_year,
        "group_id": group_id,
        "analysis_batch": batch,
        "rule_ids": selected,
        "flag_count": len(all_flags),
        "inserted": inserted,
        "risk_counts": risk_counts,
        "rule_stats": rule_stats,
    }
