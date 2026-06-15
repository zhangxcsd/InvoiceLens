"""数据字典（dim_dict）本地 JSON 持久化 — 枚举/码表维护，供前端 CRUD。"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_STORE_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "dim_dict.json"
_DOMAIN_ID_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,63}$", re.I)

_BUILTIN_DOMAINS: list[dict[str, Any]] = [
    {
        "domain_id": "dwd_is_balanced",
        "domain_name": "平账状态",
        "description": "dwd_inv_header.is_balanced 平账校验结果",
        "source_table": "dwd_inv_header",
        "source_column": "is_balanced",
        "built_in": True,
        "entries": [
            {"code": "未校验", "label": "未校验", "sort_order": 1, "enabled": True, "notes": "导入后尚未执行平账校验"},
            {"code": "平账", "label": "平账", "sort_order": 2, "enabled": True, "notes": "主表与明细金额一致"},
            {"code": "不平账", "label": "不平账", "sort_order": 3, "enabled": True, "notes": "主表与明细存在金额差异"},
            {"code": "差异可接受", "label": "差异可接受", "sort_order": 4, "enabled": True, "notes": "差异在容忍阈值内"},
            {"code": "强制通过", "label": "强制通过", "sort_order": 5, "enabled": True, "notes": "人工确认后强制通过"},
        ],
    },
    {
        "domain_id": "dwd_net_calc_status",
        "domain_name": "净额计算状态",
        "description": "dwd_inv_header.net_calc_status 红蓝净额计算进度",
        "source_table": "dwd_inv_header",
        "source_column": "net_calc_status",
        "built_in": True,
        "entries": [
            {"code": "未计算", "label": "未计算", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "蓝票已计算", "label": "蓝票已计算", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "已全额红冲", "label": "已全额红冲", "sort_order": 3, "enabled": True, "notes": ""},
            {"code": "孤立红票", "label": "孤立红票", "sort_order": 4, "enabled": True, "notes": "无对应蓝票的红字发票"},
            {"code": "已作废", "label": "已作废", "sort_order": 5, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "dwd_invoice_dir",
        "domain_name": "发票方向",
        "description": "dwd_inv_map.invoice_dir 相对主体的进销项标签",
        "source_table": "dwd_inv_map",
        "source_column": "invoice_dir",
        "built_in": True,
        "entries": [
            {"code": "进项", "label": "进项", "sort_order": 1, "enabled": True, "notes": "主体取得发票"},
            {"code": "销项", "label": "销项", "sort_order": 2, "enabled": True, "notes": "主体对外开具"},
        ],
    },
    {
        "domain_id": "subject_no_type",
        "domain_name": "主体标识类型",
        "description": "dim_subject_master.subject_no_type",
        "source_table": "dim_subject_master",
        "source_column": "subject_no_type",
        "built_in": True,
        "entries": [
            {"code": "uscc", "label": "统一社会信用代码", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "id_card", "label": "居民身份证", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "taxpayer_id", "label": "纳税人识别号", "sort_order": 3, "enabled": True, "notes": ""},
            {"code": "other", "label": "其他", "sort_order": 4, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "subject_category_domain",
        "domain_name": "主体分域",
        "description": "dim_subject_master.subject_category 组织/自然人分域",
        "source_table": "dim_subject_master",
        "source_column": "subject_category",
        "built_in": True,
        "entries": [
            {"code": "org", "label": "组织主体", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "person", "label": "自然人主体", "sort_order": 2, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "source_status",
        "domain_name": "主体来源状态",
        "description": "dim_subject_master.source_status",
        "source_table": "dim_subject_master",
        "source_column": "source_status",
        "built_in": True,
        "entries": [
            {"code": "single", "label": "单一来源", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "merged", "label": "已归并", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "conflict", "label": "来源冲突", "sort_order": 3, "enabled": True, "notes": ""},
            {"code": "pending", "label": "待处理", "sort_order": 4, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "quality_status",
        "domain_name": "主体质量状态",
        "description": "dim_subject_master.quality_status",
        "source_table": "dim_subject_master",
        "source_column": "quality_status",
        "built_in": True,
        "entries": [
            {"code": "ok", "label": "正常", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "warning", "label": "警告", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "error", "label": "错误", "sort_order": 3, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "first_source_system",
        "domain_name": "主体来源系统",
        "description": "dim_subject_master.first_source_system",
        "source_table": "dim_subject_master",
        "source_column": "first_source_system",
        "built_in": True,
        "entries": [
            {"code": "invoice", "label": "发票导入", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "external", "label": "外部清单", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "manual", "label": "手工维护", "sort_order": 3, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "audit_risk_label",
        "domain_name": "税收分类风险标签",
        "description": "dim_tax_code.audit_risk_label",
        "source_table": "dim_tax_code",
        "source_column": "audit_risk_label",
        "built_in": True,
        "entries": [
            {"code": "NORMAL", "label": "常规", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "HIGH", "label": "高敏感", "sort_order": 2, "enabled": True, "notes": "咨询、会议、餐饮等"},
        ],
    },
    {
        "domain_id": "audit_risk_level",
        "domain_name": "审计疑点风险等级",
        "description": "dm_audit_flag / audit_rules 风险等级文案",
        "source_table": "dm_audit_flag",
        "source_column": "risk_level",
        "built_in": True,
        "entries": [
            {"code": "高风险", "label": "高风险", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "中风险", "label": "中风险", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "低风险", "label": "低风险", "sort_order": 3, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "domestic_overseas",
        "domain_name": "境内/境外",
        "description": "dim_audited_enterprise_registry.domestic_overseas",
        "source_table": "dim_audited_enterprise_registry",
        "source_column": "domestic_overseas",
        "built_in": True,
        "entries": [
            {"code": "境内", "label": "境内", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "境外", "label": "境外", "sort_order": 2, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "finance_import_status",
        "domain_name": "财务导入状态",
        "description": "finance_account_summary.import_status",
        "source_table": "finance_account_summary",
        "source_column": "import_status",
        "built_in": True,
        "entries": [
            {"code": "成功", "label": "成功", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "警告", "label": "警告", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "失败", "label": "失败", "sort_order": 3, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "finance_role_type",
        "domain_name": "财务账表角色",
        "description": "finance_account_summary.role_type 与 DWS 对齐",
        "source_table": "finance_account_summary",
        "source_column": "role_type",
        "built_in": True,
        "entries": [
            {"code": "销项", "label": "销项", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "进项", "label": "进项", "sort_order": 2, "enabled": True, "notes": ""},
        ],
    },
    {
        "domain_id": "scorecard_risk_level",
        "domain_name": "评分卡综合评级",
        "description": "ads_scorecard.risk_level 横向对比与健康分评级",
        "source_table": "ads_scorecard",
        "source_column": "risk_level",
        "built_in": True,
        "entries": [
            {"code": "正常", "label": "正常", "sort_order": 1, "enabled": True, "notes": "得分 ≥80"},
            {"code": "关注", "label": "关注", "sort_order": 2, "enabled": True, "notes": "得分 60~79"},
            {"code": "重点关注", "label": "重点关注", "sort_order": 3, "enabled": True, "notes": "得分 <60"},
        ],
    },
    {
        "domain_id": "roster_data_source",
        "domain_name": "花名册数据来源",
        "description": "dim_enterprise_year_roster.data_source（台账/人工/双来源）",
        "source_table": "dim_enterprise_year_roster",
        "source_column": "data_source",
        "built_in": True,
        "entries": [
            {"code": "registry", "label": "台账同步", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "manual", "label": "人工维护", "sort_order": 2, "enabled": True, "notes": ""},
            {
                "code": "registry+manual",
                "label": "台账+人工",
                "sort_order": 3,
                "enabled": True,
                "notes": "台账与人工均有记录，关键字段可能不一致",
            },
        ],
    },
    {
        "domain_id": "roster_quality_status",
        "domain_name": "花名册数据质量",
        "description": "dim_enterprise_year_roster.quality_status（与主体库 quality_status 分域）",
        "source_table": "dim_enterprise_year_roster",
        "source_column": "quality_status",
        "built_in": True,
        "entries": [
            {"code": "ok", "label": "正常", "sort_order": 1, "enabled": True, "notes": ""},
            {
                "code": "conflict",
                "label": "待核对",
                "sort_order": 2,
                "enabled": True,
                "notes": "台账/人工字段不一致或台账归属数据质量问题，非主体库 source_status",
            },
        ],
    },
    {
        "domain_id": "quality_severity",
        "domain_name": "数据质量严重度",
        "description": "dq_* 域明细 severity 字段（block/warn/info）",
        "source_table": "dq_domain_detail",
        "source_column": "severity",
        "built_in": True,
        "entries": [
            {"code": "block", "label": "阻塞", "sort_order": 1, "enabled": True, "notes": "需优先处理，可能阻断下游分析"},
            {"code": "warn", "label": "警告", "sort_order": 2, "enabled": True, "notes": "存在明显异常，建议复核"},
            {"code": "info", "label": "提示", "sort_order": 3, "enabled": True, "notes": "信息性提示，可择机处理"},
        ],
    },
    {
        "domain_id": "dim_task_run_status",
        "domain_name": "ETL 任务运行状态",
        "description": "ads_etl_task_run_log / 任务链步骤 status",
        "source_table": "ads_etl_task_run_log",
        "source_column": "status",
        "built_in": True,
        "entries": [
            {"code": "success", "label": "成功", "sort_order": 1, "enabled": True, "notes": ""},
            {"code": "failed", "label": "失败", "sort_order": 2, "enabled": True, "notes": ""},
            {"code": "running", "label": "运行中", "sort_order": 3, "enabled": True, "notes": ""},
            {"code": "queued", "label": "排队中", "sort_order": 4, "enabled": True, "notes": ""},
            {"code": "skipped", "label": "已跳过", "sort_order": 5, "enabled": True, "notes": "依赖缺失或策略跳过"},
            {"code": "partial", "label": "部分成功", "sort_order": 6, "enabled": True, "notes": ""},
            {"code": "pending", "label": "待执行", "sort_order": 7, "enabled": True, "notes": ""},
        ],
    },
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _default_store() -> dict[str, Any]:
    return {
        "version": 1,
        "updated_at": _now_iso(),
        "domains": [dict(d) for d in _BUILTIN_DOMAINS],
    }


def _normalize_entry(raw: Any, idx: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    code = str(raw.get("code") or "").strip()
    if not code:
        return None
    label = str(raw.get("label") or code).strip() or code
    sort_raw = raw.get("sort_order", idx + 1)
    try:
        sort_order = int(sort_raw)
    except (TypeError, ValueError):
        sort_order = idx + 1
    notes = str(raw.get("notes") or "").strip()
    return {
        "code": code,
        "label": label,
        "sort_order": sort_order,
        "enabled": bool(raw.get("enabled", True)),
        "notes": notes,
    }


def _normalize_domain(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    domain_id = str(raw.get("domain_id") or "").strip()
    if not domain_id or not _DOMAIN_ID_RE.match(domain_id):
        return None
    domain_name = str(raw.get("domain_name") or domain_id).strip() or domain_id
    description = str(raw.get("description") or "").strip()
    source_table = str(raw.get("source_table") or "").strip()
    source_column = str(raw.get("source_column") or "").strip()
    built_in = bool(raw.get("built_in", False))
    raw_entries = raw.get("entries")
    entries: list[dict[str, Any]] = []
    if isinstance(raw_entries, list):
        seen: set[str] = set()
        for idx, ent in enumerate(raw_entries):
            norm = _normalize_entry(ent, idx)
            if not norm or norm["code"] in seen:
                continue
            seen.add(norm["code"])
            entries.append(norm)
    entries.sort(key=lambda x: (x["sort_order"], x["code"]))
    return {
        "domain_id": domain_id,
        "domain_name": domain_name,
        "description": description,
        "source_table": source_table,
        "source_column": source_column,
        "built_in": built_in,
        "entries": entries,
    }


def _load_store() -> dict[str, Any]:
    if not _STORE_PATH.is_file():
        store = _default_store()
        try:
            _save_store(store)
        except Exception as exc:
            logger.warning("dim_dict seed save failed: %s", exc)
        return store
    try:
        raw = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("invalid root")
        domains_raw = raw.get("domains")
        if not isinstance(domains_raw, list):
            domains_raw = []
        domains: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for item in domains_raw:
            norm = _normalize_domain(item)
            if not norm or norm["domain_id"] in seen_ids:
                continue
            seen_ids.add(norm["domain_id"])
            domains.append(norm)
        if not domains:
            return _default_store()
        return {
            "version": int(raw.get("version") or 1),
            "updated_at": str(raw.get("updated_at") or _now_iso()),
            "domains": domains,
        }
    except Exception as exc:
        logger.warning("dim_dict load failed, using defaults: %s", exc)
        return _default_store()


def _save_store(store: dict[str, Any]) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "version": int(store.get("version") or 1),
        "updated_at": _now_iso(),
        "domains": store.get("domains") or [],
    }
    _STORE_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def get_domain(domain_id: str) -> dict[str, Any] | None:
    """按 domain_id 读取已规范化的域定义。"""
    key = str(domain_id or "").strip()
    if not key:
        return None
    store = _load_store()
    for d in store.get("domains") or []:
        if isinstance(d, dict) and str(d.get("domain_id") or "").strip() == key:
            return d
    builtin = next(
        (d for d in _BUILTIN_DOMAINS if str(d.get("domain_id") or "").strip() == key),
        None,
    )
    return dict(builtin) if builtin else None


def get_domain_codes(domain_id: str, *, enabled_only: bool = True) -> list[str]:
    """返回域内 code 列表（按 sort_order 排序）。"""
    domain = get_domain(domain_id)
    if not domain:
        return []
    entries = domain.get("entries") or []
    codes: list[str] = []
    for ent in entries:
        if not isinstance(ent, dict):
            continue
        if enabled_only and not bool(ent.get("enabled", True)):
            continue
        code = str(ent.get("code") or "").strip()
        if code:
            codes.append(code)
    return codes


def get_domain_label_map(domain_id: str, *, enabled_only: bool = True) -> dict[str, str]:
    """code → label 映射。"""
    domain = get_domain(domain_id)
    if not domain:
        return {}
    out: dict[str, str] = {}
    for ent in domain.get("entries") or []:
        if not isinstance(ent, dict):
            continue
        if enabled_only and not bool(ent.get("enabled", True)):
            continue
        code = str(ent.get("code") or "").strip()
        if not code:
            continue
        label = str(ent.get("label") or code).strip() or code
        out[code] = label
    return out


def get_domain_label(domain_id: str, code: str, *, fallback_to_code: bool = True) -> str:
    """单条 code 的显示名。"""
    key = str(code or "").strip()
    if not key:
        return ""
    label_map = get_domain_label_map(domain_id, enabled_only=False)
    if key in label_map:
        return label_map[key]
    return key if fallback_to_code else ""


def api_dim_dict_get() -> dict[str, Any]:
    try:
        store = _load_store()
        return {
            "ok": True,
            "version": store.get("version"),
            "updated_at": store.get("updated_at"),
            "domains": store.get("domains") or [],
            "store_path": str(_STORE_PATH),
            "hint": "枚举码表维护；修改后写入 data/config/dim_dict.json，供界面展示与后续 ETL 引用对齐。",
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("dim_dict_get")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dim_dict_save(body: dict[str, Any]) -> dict[str, Any]:
    try:
        domains_raw = body.get("domains")
        if not isinstance(domains_raw, list):
            return {
                "ok": False,
                "error": {
                    "message": "请求体需包含 domains 数组",
                    "exception_type": "ValidationError",
                },
            }
        domains: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        errors: list[str] = []
        for idx, item in enumerate(domains_raw):
            norm = _normalize_domain(item)
            if not norm:
                errors.append(f"domains[{idx}] 格式无效或 domain_id 不合规")
                continue
            if norm["domain_id"] in seen_ids:
                errors.append(f"domain_id 重复：{norm['domain_id']}")
                continue
            seen_ids.add(norm["domain_id"])
            domains.append(norm)
        if errors:
            return {"ok": False, "errors": errors}
        store = {
            "version": int(body.get("version") or 1),
            "domains": domains,
        }
        _save_store(store)
        saved = _load_store()
        return {
            "ok": True,
            "message": "数据字典已保存",
            "version": saved.get("version"),
            "updated_at": saved.get("updated_at"),
            "domains": saved.get("domains") or [],
            "store_path": str(_STORE_PATH),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("dim_dict_save")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

