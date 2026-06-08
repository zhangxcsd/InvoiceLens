"""加载 config/audit_rules.yaml。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml


def _rules_path() -> Path:
    return Path(__file__).resolve().parents[2] / "config" / "audit_rules.yaml"


@lru_cache(maxsize=1)
def load_audit_rules_config() -> dict[str, Any]:
    path = _rules_path()
    if not path.is_file():
        return {"defaults": {}, "rules": {}}
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        return {"defaults": {}, "rules": {}}
    return data


def rule_config(rule_id: str) -> dict[str, Any]:
    cfg = load_audit_rules_config()
    rules = cfg.get("rules") if isinstance(cfg.get("rules"), dict) else {}
    block = rules.get(rule_id) if isinstance(rules, dict) else None
    return dict(block) if isinstance(block, dict) else {}


def is_rule_enabled(rule_id: str) -> bool:
    rc = rule_config(rule_id)
    return bool(rc.get("enabled", True))


def group_id_for_year(stat_year: int) -> str:
    cfg = load_audit_rules_config()
    defaults = cfg.get("defaults") if isinstance(cfg.get("defaults"), dict) else {}
    prefix = str(defaults.get("group_id_prefix") or "Y")
    return f"{prefix}{stat_year}"


def invalidate_audit_rules_cache() -> None:
    load_audit_rules_config.cache_clear()


def save_audit_rules_config(data: dict[str, Any]) -> None:
    path = _rules_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False, default_flow_style=False)
    invalidate_audit_rules_cache()


def audit_rules_yaml_text() -> tuple[str, str]:
    path = _rules_path()
    if not path.is_file():
        return "", str(path)
    return path.read_text(encoding="utf-8"), str(path)
