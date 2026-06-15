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
    "max_graph_nodes": {
        "label": "关联图谱最大节点数",
        "description": "超过该节点数时 API 返回 truncated，前端显示降级提示而非渲染大图。",
        "type": "int",
        "min": 10,
        "max": 500,
        "default": 50,
    },
    "tax_in_out_deviation_threshold_pct": {
        "label": "进销偏离占比差阈值（百分点）",
        "description": "单档税率进项与销项占比差超过该值（百分点）时标红并写入审计疑点。",
        "type": "float",
        "min": 0.0,
        "max": 100.0,
        "default": 10.0,
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
        try:
            from src.local_api.users_api import append_audit_log

            append_audit_log(
                action="settings_thresholds_update",
                username=str(body.get("actor") or body.get("username") or "system"),
                detail={"updated": updated},
            )
        except Exception:  # noqa: BLE001
            pass
        return {
            "ok": True,
            "updated": updated,
            "effective": {k: get_setting(k) for k in THRESHOLD_SCHEMA},
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("settings_thresholds_post")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


# ---------------------------------------------------------------------------
# 实例配置（本地 JSON 持久化）
# ---------------------------------------------------------------------------

_INSTANCE_CONFIG_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "instance_config.json"

INSTANCE_CONFIG_SCHEMA: dict[str, dict[str, Any]] = {
    "display_name": {
        "label": "应用显示名称",
        "type": "str",
        "max_len": 120,
        "default": "InvoiceLens",
    },
    "instance_id": {
        "label": "实例标识",
        "type": "str",
        "max_len": 64,
        "default": "local",
    },
    "default_stat_year": {
        "label": "默认统计年度",
        "type": "int",
        "min": 1990,
        "max": 2100,
        "default": None,
        "nullable": True,
    },
    "scope_root_id": {
        "label": "审计范围根节点",
        "type": "str",
        "max_len": 64,
        "default": "",
    },
    "notes": {
        "label": "备注",
        "type": "str",
        "max_len": 500,
        "default": "",
    },
}


def _load_scope_defaults() -> dict[str, Any]:
    try:
        from config.settings import SCOPE

        return dict(SCOPE) if isinstance(SCOPE, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _load_instance_overrides() -> dict[str, Any]:
    if not _INSTANCE_CONFIG_PATH.is_file():
        return {}
    try:
        raw = json.loads(_INSTANCE_CONFIG_PATH.read_text(encoding="utf-8"))
        return dict(raw) if isinstance(raw, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("read instance config: %s", exc)
        return {}


def _save_instance_overrides(data: dict[str, Any]) -> None:
    _INSTANCE_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _INSTANCE_CONFIG_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _default_instance_config() -> dict[str, Any]:
    scope = _load_scope_defaults()
    return {
        "display_name": str(scope.get("instance_name") or "InvoiceLens"),
        "instance_id": str(scope.get("scope_sys_id") or "local"),
        "default_stat_year": None,
        "scope_root_id": str(scope.get("scope_root_id") or ""),
        "notes": "",
    }


def get_effective_instance_config() -> dict[str, Any]:
    base = _default_instance_config()
    overrides = _load_instance_overrides()
    for key in INSTANCE_CONFIG_SCHEMA:
        if key in overrides:
            base[key] = overrides[key]
    return base


def _coerce_instance_value(key: str, raw: Any) -> tuple[Any | None, str | None]:
    meta = INSTANCE_CONFIG_SCHEMA.get(key)
    if not meta:
        return None, f"未知字段 {key}"
    t = meta.get("type")
    if t == "str":
        if raw is None:
            s = ""
        else:
            s = str(raw).strip()
        max_len = meta.get("max_len")
        if max_len is not None and len(s) > int(max_len):
            return None, f"{meta['label']} 过长（上限 {max_len} 字符）"
        return s, None
    if t == "int":
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            if meta.get("nullable"):
                return None, None
            return meta.get("default"), None
        try:
            v = int(raw)
        except (TypeError, ValueError):
            return None, f"{meta['label']} 须为整数"
        lo = meta.get("min")
        hi = meta.get("max")
        if lo is not None and v < lo:
            return None, f"{meta['label']} 不能小于 {lo}"
        if hi is not None and v > hi:
            return None, f"{meta['label']} 不能大于 {hi}"
        return v, None
    return None, f"不支持的类型 {t}"


def _system_info() -> dict[str, Any]:
    root = Path(__file__).resolve().parents[2]
    try:
        from config.build_meta import read_build_meta

        build_meta = read_build_meta()
    except Exception:  # noqa: BLE001
        build_meta = {"app_version": "dev", "build_time": None}
    try:
        from db.duckdb_conn import DB_PATH

        db_path = str(DB_PATH)
    except Exception:  # noqa: BLE001
        db_path = str(root / "data" / "database" / "warehouse.duckdb")
    try:
        from config.field_mapping import get_field_mapping_yaml_path

        fm_path = str(get_field_mapping_yaml_path())
    except Exception:  # noqa: BLE001
        fm_path = str(root / "config" / "field_mapping.yaml")
    return {
        "project_root": str(root),
        "config_dir": str(root / "data" / "config"),
        "db_path": db_path,
        "field_mapping_path": fm_path,
        "app_version": build_meta.get("app_version") or "dev",
        "build_time": build_meta.get("build_time"),
    }


def api_settings_instance_get() -> dict[str, Any]:
    try:
        effective = get_effective_instance_config()
        overrides = _load_instance_overrides()
        items: list[dict[str, Any]] = []
        for key, meta in INSTANCE_CONFIG_SCHEMA.items():
            items.append(
                {
                    "key": key,
                    "label": meta["label"],
                    "type": meta.get("type"),
                    "default": meta.get("default"),
                    "effective_value": effective.get(key),
                    "is_overridden": key in overrides,
                }
            )
        return {
            "ok": True,
            "config": effective,
            "items": items,
            "system": _system_info(),
            "store_path": str(_INSTANCE_CONFIG_PATH),
            "hint": "修改后写入 data/config/instance_config.json；重启服务后仍生效。",
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("settings_instance_get")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_settings_instance_post(body: dict[str, Any]) -> dict[str, Any]:
    try:
        raw_cfg = body.get("config") if isinstance(body.get("config"), dict) else body
        if not isinstance(raw_cfg, dict):
            return {
                "ok": False,
                "error": {
                    "message": "请求体需为 { config: { ... } } 或直接字段对象",
                    "exception_type": "ValidationError",
                },
            }
        overrides = _load_instance_overrides()
        updated: dict[str, Any] = {}
        errors: list[str] = []
        reset_keys = body.get("reset_keys") or body.get("resetKeys") or []
        if isinstance(reset_keys, list):
            for k in reset_keys:
                sk = str(k).strip()
                if sk in overrides:
                    del overrides[sk]
                    updated[sk] = "reset"

        for key, raw in raw_cfg.items():
            sk = str(key).strip()
            if sk not in INSTANCE_CONFIG_SCHEMA:
                continue
            if raw is None or (isinstance(raw, str) and raw.strip().lower() in ("", "default", "reset")):
                if sk in overrides:
                    del overrides[sk]
                    updated[sk] = "reset"
                continue
            val, err = _coerce_instance_value(sk, raw)
            if err:
                errors.append(err)
                continue
            overrides[sk] = val
            updated[sk] = val

        if errors:
            return {"ok": False, "errors": errors, "updated": updated}

        _save_instance_overrides(overrides)
        try:
            from src.local_api.users_api import append_audit_log

            append_audit_log(
                action="settings_instance_update",
                username=str(body.get("actor") or body.get("username") or "system"),
                detail={"updated": updated},
            )
        except Exception:  # noqa: BLE001
            pass
        return {
            "ok": True,
            "updated": updated,
            "config": get_effective_instance_config(),
            "system": _system_info(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("settings_instance_post")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
