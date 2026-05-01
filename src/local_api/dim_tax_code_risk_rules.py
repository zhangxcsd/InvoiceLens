"""
从 config/dim_tax_code_risk_rules.yaml 加载 dim_tax_code.audit_risk_label 规则。
无配置文件或解析失败时使用内置安全默认（等价于仅 NORMAL）。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_CFG_PATH = Path(__file__).resolve().parents[2] / "config" / "dim_tax_code_risk_rules.yaml"
_cfg_cache: dict[str, Any] | None = None
_cfg_mtime: float | None = None


def _default_config() -> dict[str, Any]:
    return {
        "version": 0,
        "description": "内置默认（未找到 YAML）",
        "default_label": "NORMAL",
        "rules": [],
    }


def load_dim_tax_code_risk_config(*, force_reload: bool = False) -> dict[str, Any]:
    """读取 YAML；不存在则返回内置默认。按文件 mtime 做进程内缓存。"""
    global _cfg_cache, _cfg_mtime
    if not _CFG_PATH.is_file():
        return _default_config()
    try:
        mt = _CFG_PATH.stat().st_mtime
    except OSError:
        return _default_config()
    if not force_reload and _cfg_cache is not None and _cfg_mtime == mt:
        return _cfg_cache
    try:
        raw = _CFG_PATH.read_text(encoding="utf-8")
        data = yaml.safe_load(raw) or {}
        if not isinstance(data, dict):
            data = {}
        data.setdefault("default_label", "NORMAL")
        data.setdefault("rules", [])
        _cfg_cache = data
        _cfg_mtime = mt
        return data
    except Exception as exc:
        logger.warning("读取 dim_tax_code_risk_rules.yaml 失败，使用默认 NORMAL：%s", exc)
        return _default_config()


def invalidate_risk_config_cache() -> None:
    global _cfg_cache, _cfg_mtime
    _cfg_cache = None
    _cfg_mtime = None


def _norm_label(v: Any) -> str:
    s = str(v or "NORMAL").strip().upper()
    return s if s in {"NORMAL", "HIGH"} else "NORMAL"


def _match_one_condition(cond: Any, ctx: dict[str, str]) -> bool:
    if not isinstance(cond, dict):
        return False
    typ = str(cond.get("type") or "").strip().lower()
    if typ == "field_contains":
        field = str(cond.get("field") or "").strip()
        blob = str(ctx.get(field) or "")
        if not blob:
            return False
        for kw in cond.get("keywords") or []:
            k = str(kw).strip()
            if k and k in blob:
                return True
        return False
    if typ == "tax_code_prefix":
        code = str(ctx.get("tax_code") or "")
        for px in cond.get("prefixes") or []:
            p = str(px).strip()
            if p and code.startswith(p):
                return True
        return False
    return False


def audit_risk_label_for_row(
    *,
    tax_code: str,
    goods_name: str | None,
    goods_short_name: str | None,
    full_path: str | None,
    cfg: dict[str, Any] | None = None,
) -> str:
    """按 YAML 规则计算单行风险标签。"""
    c = cfg if cfg is not None else load_dim_tax_code_risk_config()
    default_lab = _norm_label(c.get("default_label"))
    ctx = {
        "tax_code": tax_code or "",
        "goods_name": goods_name or "",
        "goods_short_name": goods_short_name or "",
        "full_path": full_path or "",
    }
    for rule in c.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        if rule.get("enabled") is False:
            continue
        match_any = rule.get("match_any") or []
        if not match_any:
            continue
        if any(_match_one_condition(x, ctx) for x in match_any):
            return _norm_label(rule.get("label"))
    return default_lab
