"""报告模板管理（本地 JSON 持久化）。"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_TEMPLATES_PATH = Path(__file__).resolve().parents[2] / "config" / "report_templates.json"

_DEFAULT_CHAPTERS = [
    {"id": "overview", "label": "第一章 数据概览", "default": True},
    {"id": "structure", "label": "第二章 发票结构分析", "default": True},
    {"id": "supplier", "label": "第三章 供应商分析", "default": True},
    {"id": "audit_flags", "label": "第四章 审计疑点清单", "default": True},
    {"id": "flags_track", "label": "附录 已确认疑点摘要", "default": True},
    {"id": "related", "label": "第五章 关联交易分析", "default": True},
    {"id": "compare", "label": "第六章 子公司横向对比", "default": True},
    {"id": "supplier_new", "label": "专题 新增供应商", "default": False},
    {"id": "trade_relationships", "label": "专题 往来关系摘要", "default": False},
    {"id": "tax_in_out_deviation", "label": "专题 进销偏离分析", "default": False},
    {"id": "finance_reconcile", "label": "专题 财务账票核对差异", "default": False},
    {"id": "goods_category", "label": "专题 品类结构分析", "default": False},
    {"id": "red_offset_analysis", "label": "专题 红冲/作废分析", "default": False},
    {"id": "counterparty_risk", "label": "专题 对手风险聚合", "default": False},
    {"id": "invoice_timing", "label": "专题 开票时间行为", "default": False},
    {"id": "year_over_year", "label": "专题 跨年结构对比", "default": False},
]

_BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "template_id": "builtin_full",
        "name": "完整审计报告",
        "title_template": "{year}年度发票数据审计分析报告",
        "description": "包含全部六章，适用于年度综合审计交付。",
        "chapters": {c["id"]: True for c in _DEFAULT_CHAPTERS},
        "is_builtin": True,
        "updated_at": "2026-01-01T00:00:00Z",
    },
    {
        "template_id": "builtin_flags",
        "name": "疑点专项报告",
        "title_template": "{year}年度发票审计疑点专项报告",
        "description": "聚焦疑点清单与关联交易，适用于风险复核场景。",
        "chapters": {
            "overview": True,
            "structure": False,
            "supplier": False,
            "audit_flags": True,
            "related": True,
            "compare": False,
        },
        "is_builtin": True,
        "updated_at": "2026-01-01T00:00:00Z",
    },
    {
        "template_id": "builtin_compare",
        "name": "子公司对比简报",
        "title_template": "{year}年度子公司发票数据对比简报",
        "description": "概览 + 供应商 + 子公司横向对比，适用于集团内部分析。",
        "chapters": {
            "overview": True,
            "structure": False,
            "supplier": True,
            "audit_flags": False,
            "related": False,
            "compare": True,
        },
        "is_builtin": True,
        "updated_at": "2026-01-01T00:00:00Z",
    },
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _ensure_file() -> None:
    if _TEMPLATES_PATH.is_file():
        return
    _TEMPLATES_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "templates": _BUILTIN_TEMPLATES}
    _TEMPLATES_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_store() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_TEMPLATES_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("invalid root")
        templates = raw.get("templates")
        if not isinstance(templates, list):
            templates = []
        return {"version": int(raw.get("version") or 1), "templates": templates}
    except Exception as exc:
        logger.warning("report templates load failed, reset to builtin: %s", exc)
        return {"version": 1, "templates": list(_BUILTIN_TEMPLATES)}


def _save_store(store: dict[str, Any]) -> None:
    _TEMPLATES_PATH.parent.mkdir(parents=True, exist_ok=True)
    _TEMPLATES_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def _valid_chapters(raw: Any) -> dict[str, bool]:
    out: dict[str, bool] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            out[str(k)] = bool(v)
    return out


def _normalize_template(item: dict[str, Any]) -> dict[str, Any]:
    tid = str(item.get("template_id") or "").strip()
    name = str(item.get("name") or "").strip()
    if not tid or not name:
        raise ValueError("template_id 与 name 不能为空")
    chapters = _valid_chapters(item.get("chapters"))
    if not chapters:
        chapters = {c["id"]: c.get("default", True) for c in _DEFAULT_CHAPTERS}
    return {
        "template_id": tid,
        "name": name,
        "title_template": str(item.get("title_template") or "{year}年度发票数据审计分析报告").strip(),
        "description": str(item.get("description") or "").strip(),
        "chapters": chapters,
        "is_builtin": bool(item.get("is_builtin")),
        "updated_at": str(item.get("updated_at") or _now_iso()),
    }


def api_report_templates_list() -> dict[str, Any]:
    try:
        store = _load_store()
        templates: list[dict[str, Any]] = []
        for item in store.get("templates") or []:
            if not isinstance(item, dict):
                continue
            try:
                templates.append(_normalize_template(item))
            except Exception:
                continue
        return {
            "ok": True,
            "templates": templates,
            "chapter_defs": _DEFAULT_CHAPTERS,
            "store_path": str(_TEMPLATES_PATH),
        }
    except Exception as exc:
        logger.exception("report_templates_list")
        return {"ok": False, "templates": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_template_get(template_id: str) -> dict[str, Any]:
    try:
        tid = str(template_id or "").strip()
        store = _load_store()
        for item in store.get("templates") or []:
            if isinstance(item, dict) and str(item.get("template_id") or "") == tid:
                return {"ok": True, "template": _normalize_template(item)}
        return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_template_save(body: dict[str, Any]) -> dict[str, Any]:
    try:
        store = _load_store()
        templates: list[dict[str, Any]] = [
            t for t in (store.get("templates") or []) if isinstance(t, dict)
        ]
        raw_id = str(body.get("template_id") or "").strip()
        is_new = not raw_id
        tid = raw_id or f"tpl_{uuid.uuid4().hex[:10]}"
        name = str(body.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": {"code": "name_required", "message": "模板名称不能为空"}}

        chapters = _valid_chapters(body.get("chapters"))
        if not chapters:
            chapters = {c["id"]: c.get("default", True) for c in _DEFAULT_CHAPTERS}

        entry = {
            "template_id": tid,
            "name": name,
            "title_template": str(body.get("title_template") or "{year}年度发票数据审计分析报告").strip(),
            "description": str(body.get("description") or "").strip(),
            "chapters": chapters,
            "is_builtin": False,
            "updated_at": _now_iso(),
        }

        replaced = False
        for i, item in enumerate(templates):
            if str(item.get("template_id") or "") == tid:
                if bool(item.get("is_builtin")):
                    return {"ok": False, "error": {"code": "builtin_readonly", "message": "内置模板不可修改"}}
                templates[i] = entry
                replaced = True
                break
        if not replaced:
            if is_new:
                templates.append(entry)
            else:
                return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}

        store["templates"] = templates
        _save_store(store)
        return {"ok": True, "template": entry, "created": is_new and not replaced}
    except Exception as exc:
        logger.exception("report_template_save")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_template_delete(template_id: str) -> dict[str, Any]:
    try:
        tid = str(template_id or "").strip()
        if not tid or not re.match(r"^[\w\-]+$", tid):
            return {"ok": False, "error": {"code": "invalid_id", "message": "非法 template_id"}}
        store = _load_store()
        kept: list[dict[str, Any]] = []
        deleted = False
        for item in store.get("templates") or []:
            if not isinstance(item, dict):
                continue
            if str(item.get("template_id") or "") == tid:
                if bool(item.get("is_builtin")):
                    return {"ok": False, "error": {"code": "builtin_readonly", "message": "内置模板不可删除"}}
                deleted = True
                continue
            kept.append(item)
        if not deleted:
            return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}
        store["templates"] = kept
        _save_store(store)
        return {"ok": True, "template_id": tid}
    except Exception as exc:
        logger.exception("report_template_delete")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
