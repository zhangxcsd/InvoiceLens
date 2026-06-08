"""系统设置 · 规则阈值 API（读写在 SETTINGS + 本地 overrides JSON）。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_OVERRIDES_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "settings_overrides.json"

# 可在 UI 编辑的阈值项（键 → 元数据）
THRESHOLD_SCHEMA: dict[str, dict[str, Any]] = {
    "min_analysis_subject_invoice_count": {
        "label": "分析主体池最低发票张数",
        "description": "L1 分析主体池：当年发票张数下限（含等于）。影响 DWS 看板主体下拉与进销偏离等页。",
        "type": "int",
        "min": 1,
        "max": 10000,
        "default": 10,
    },
    "cr1_warn": {
        "label": "供应商集中度预警线",
        "description": "Top1 供应商采购占比达到该比例时预警（0~1）。",
        "type": "float",
        "min": 0.0,
        "max": 1.0,
        "default": 0.30,
    },
    "cr1_high": {
        "label": "供应商集中度高风险线",
        "description": "Top1 供应商采购占比达到该比例时标为高风险（0~1）。",
        "type": "float",
        "min": 0.0,
        "max": 1.0,
        "default": 0.50,
    },
    "min_graph_amount": {
        "label": "关联图谱最小金额",
        "description": "关联关系图中纳入边的最小绝对金额（元）。",
        "type": "float",
        "min": 0.0,
        "max": 1e12,
        "default": 10000.0,
    },
}


def _load_base_settings() -> dict[str, Any]:
    try:
        from config.settings import SETTINGS

        return dict(SETTINGS)
    except Exception:  # noqa: BLE001
        return {}


def _load_overrides() -> dict[str, Any]:
    if not _OVERRIDES_PATH.is_file():
        return {}
    try:
        raw = json.loads(_OVERRIDES_PATH.read_text(encoding="utf-8"))
        return dict(raw) if isinstance(raw, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("read settings overrides: %s", exc)
        return {}


def get_effective_settings() -> dict[str, Any]:
    """合并 config/settings.py 与本地 overrides。"""
    merged = _load_base_settings()
    merged.update(_load_overrides())
    return merged


def get_setting(key: str, default: Any = None) -> Any:
    return get_effective_settings().get(key, default)


def _save_overrides(overrides: dict[str, Any]) -> None:
    _OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    _OVERRIDES_PATH.write_text(
        json.dumps(overrides, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _coerce_value(key: str, raw: Any) -> Any | None:
    meta = THRESHOLD_SCHEMA.get(key)
    if not meta:
        return None
    t = meta.get("type")
    try:
        if t == "int":
            v = int(raw)
        elif t == "float":
            v = float(raw)
        else:
            return None
    except (TypeError, ValueError):
        return None
    lo = meta.get("min")
    hi = meta.get("max")
    if lo is not None and v < lo:
        return None
    if hi is not None and v > hi:
        return None
    return v


def api_settings_thresholds_get() -> dict[str, Any]:
    try:
        base = _load_base_settings()
        overrides = _load_overrides()
        effective = get_effective_settings()
        items: list[dict[str, Any]] = []
        for key, meta in THRESHOLD_SCHEMA.items():
            items.append(
                {
                    "key": key,
                    "label": meta["label"],
                    "description": meta.get("description", ""),
                    "type": meta.get("type"),
                    "min": meta.get("min"),
                    "max": meta.get("max"),
                    "default": meta.get("default"),
                    "base_value": base.get(key, meta.get("default")),
                    "override_value": overrides.get(key),
                    "effective_value": effective.get(key, meta.get("default")),
                    "is_overridden": key in overrides,
                }
            )
        return {
            "ok": True,
            "items": items,
            "overrides_path": str(_OVERRIDES_PATH),
            "hint": "修改后写入 data/config/settings_overrides.json；重启服务后仍生效。",
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("settings_thresholds_get")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_settings_thresholds_post(body: dict[str, Any]) -> dict[str, Any]:
    try:
        raw_items = body.get("items") or body.get("thresholds") or body
        if not isinstance(raw_items, dict):
            return {
                "ok": False,
                "error": {"message": "请求体需为 { key: value } 或 { items: { key: value } }", "exception_type": "ValidationError"},
            }
        overrides = _load_overrides()
        updated: dict[str, Any] = {}
        errors: list[str] = []
        reset_keys = body.get("reset_keys") or body.get("resetKeys") or []
        if isinstance(reset_keys, list):
            for k in reset_keys:
                sk = str(k).strip()
                if sk in overrides:
                    del overrides[sk]
                    updated[sk] = "reset"

        for key, raw in raw_items.items():
            sk = str(key).strip()
            if sk not in THRESHOLD_SCHEMA:
                continue
            if raw is None or (isinstance(raw, str) and raw.strip().lower() in ("", "default", "reset")):
                if sk in overrides:
                    del overrides[sk]
                    updated[sk] = "reset"
                continue
            val = _coerce_value(sk, raw)
            if val is None:
                meta = THRESHOLD_SCHEMA[sk]
                errors.append(f"{sk} 无效（范围 {meta.get('min')} ~ {meta.get('max')}）")
                continue
            overrides[sk] = val
            updated[sk] = val

        if errors:
            return {"ok": False, "errors": errors, "updated": updated}

        _save_overrides(overrides)
        return {
            "ok": True,
            "updated": updated,
            "effective": {k: get_setting(k) for k in THRESHOLD_SCHEMA},
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("settings_thresholds_post")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
