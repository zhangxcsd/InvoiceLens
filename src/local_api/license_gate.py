"""授权门控（override > 签名 .lic > config/settings.py 默认试用）。"""

from __future__ import annotations

import base64
import json
import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "config"
_LICENSE_OVERRIDE_PATH = _DATA_DIR / "license_override.json"
_LICENSE_FILE_PATH = _DATA_DIR / "license.lic"

_LICENSE_KEYS = (
    "tier",
    "customer",
    "expires_at",
    "max_entities",
    "max_invoices",
    "max_years",
    "export_report",
    "cross_group",
)


def _public_key_path() -> Path:
    from src.local_api.bundle_paths import bundle_root

    return bundle_root() / "config" / "license_public.pem"


def _load_base_license() -> dict[str, Any]:
    try:
        from config.settings import LICENSE

        return dict(LICENSE)
    except Exception:  # noqa: BLE001
        return {
            "tier": "trial",
            "export_report": False,
            "max_entities": 3,
        }


def _load_override() -> dict[str, Any]:
    if not _LICENSE_OVERRIDE_PATH.is_file():
        return {}
    try:
        raw = json.loads(_LICENSE_OVERRIDE_PATH.read_text(encoding="utf-8"))
        return dict(raw) if isinstance(raw, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("read license override: %s", exc)
        return {}


def _canonical_payload_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _verify_license_signature(payload: dict[str, Any], signature_b64: str) -> bool:
    pub_path = _public_key_path()
    if not pub_path.is_file():
        logger.warning("license public key missing: %s", pub_path)
        return False
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        public_key = serialization.load_pem_public_key(pub_path.read_bytes())
        sig = base64.b64decode(str(signature_b64).strip())
        public_key.verify(
            sig,
            _canonical_payload_bytes(payload),
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH),
            hashes.SHA256(),
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("license signature verify failed: %s", exc)
        return False


def _load_signed_license_file() -> tuple[dict[str, Any] | None, str | None]:
    """返回 (payload, error_message)。"""
    if not _LICENSE_FILE_PATH.is_file():
        return None, None
    try:
        raw = json.loads(_LICENSE_FILE_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return None, f"授权文件解析失败: {exc}"
    if not isinstance(raw, dict):
        return None, "授权文件格式无效"
    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else raw
    signature = raw.get("signature") or raw.get("sig")
    if not isinstance(payload, dict):
        return None, "授权文件缺少 payload"
    if not signature:
        return None, "授权文件缺少签名"
    if not _verify_license_signature(payload, str(signature)):
        return None, "授权签名验签失败，请确认 .lic 由官方私钥签发且未被篡改"
    parsed, errors = _coerce_license_payload(payload)
    if errors:
        return None, "；".join(errors)
    return parsed, None


def _save_override(override: dict[str, Any]) -> None:
    _LICENSE_OVERRIDE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _LICENSE_OVERRIDE_PATH.write_text(
        json.dumps(override, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def get_license_config() -> dict[str, Any]:
    """优先级：license_override.json > 验签通过的 license.lic > settings.py。"""
    base = _load_base_license()
    override = _load_override()
    if override:
        merged = dict(base)
        merged.update(override)
        return merged
    signed, _err = _load_signed_license_file()
    if signed:
        merged = dict(base)
        merged.update(signed)
        return merged
    return base


def get_license_source() -> str:
    if _load_override():
        return "override"
    signed, err = _load_signed_license_file()
    if signed:
        return "lic"
    if err and _LICENSE_FILE_PATH.is_file():
        return "lic_invalid"
    return "config"


def _parse_expires_at(raw: Any) -> date | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            continue
    return None


def is_license_expired(lic: dict[str, Any] | None = None) -> bool:
    cfg = lic if lic is not None else get_license_config()
    exp = _parse_expires_at(cfg.get("expires_at"))
    if exp is None:
        return False
    return date.today() > exp


def export_denied_error() -> dict[str, Any]:
    lic = get_license_config()
    if is_license_expired(lic):
        return {
            "ok": False,
            "error": {
                "code": "license_expired",
                "message": "授权已过期，报告与发票导出不可用，请更新授权文件。",
            },
        }
    return {
        "ok": False,
        "error": {
            "code": "license_export_denied",
            "message": "试用版不支持报告与发票导出，请联系管理员升级授权。",
        },
    }


def check_export_allowed() -> dict[str, Any] | None:
    lic = get_license_config()
    if is_license_expired(lic):
        return export_denied_error()
    if not bool(lic.get("export_report", False)):
        return export_denied_error()
    return None


def cross_group_denied_error() -> dict[str, Any]:
    lic = get_license_config()
    if is_license_expired(lic):
        return {
            "ok": False,
            "error": {
                "code": "license_expired",
                "message": "授权已过期，主体对比不可用，请更新授权文件。",
            },
        }
    return {
        "ok": False,
        "error": {
            "code": "license_cross_group_denied",
            "message": "当前授权未开通主体对比（cross_group），请升级授权或在「授权管理」导入正式授权。",
        },
    }


def check_cross_group_allowed() -> dict[str, Any] | None:
    lic = get_license_config()
    if is_license_expired(lic):
        return cross_group_denied_error()
    if not bool(lic.get("cross_group", False)):
        return cross_group_denied_error()
    return None


def _quota_denied(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def _count_dwd_invoices(conn: Any) -> int:
    try:
        return int(conn.execute("SELECT COUNT(*)::BIGINT FROM dwd_inv_header").fetchone()[0] or 0)
    except Exception:
        return 0


def _distinct_dwd_stat_years(conn: Any) -> set[int]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM ads_scorecard WHERE stat_year IS NOT NULL",
    ):
        try:
            for (yv,) in conn.execute(sql).fetchall() or []:
                if yv is not None:
                    yi = int(yv)
                    if 1990 <= yi <= 2100:
                        years.add(yi)
        except Exception:
            continue
    return years


def check_invoice_quota(conn: Any | None = None) -> dict[str, Any] | None:
    lic = get_license_config()
    if is_license_expired(lic):
        return _quota_denied("license_expired", "授权已过期，无法继续导入，请更新授权文件。")
    max_inv = lic.get("max_invoices")
    if not isinstance(max_inv, int) or max_inv <= 0:
        return None
    current = _count_dwd_invoices(conn) if conn is not None else 0
    if current >= max_inv:
        return _quota_denied(
            "license_invoice_cap_denied",
            f"当前库内发票约 {current:,} 张，已达授权上限 {max_inv:,} 张，无法继续导入。请升级授权或清理历史数据。",
        )
    return None


def check_year_quota_for_build(conn: Any, stat_year: int | None) -> dict[str, Any] | None:
    lic = get_license_config()
    if is_license_expired(lic):
        return _quota_denied("license_expired", "授权已过期，无法继续加工，请更新授权文件。")
    max_y = lic.get("max_years")
    if not isinstance(max_y, int) or max_y <= 0:
        return None
    years = _distinct_dwd_stat_years(conn)
    if stat_year is not None and stat_year not in years:
        if len(years) >= max_y:
            return _quota_denied(
                "license_year_cap_denied",
                f"授权最多支持 {max_y} 个统计年度，当前已有 {len(years)} 个年度，无法新增 {stat_year} 年数据。请升级授权。",
            )
    return None


def compare_entity_cap(lic: dict[str, Any] | None = None) -> int | None:
    """返回对比页主体上限；None 或 <=0 表示不截断。"""
    cfg = lic if lic is not None else get_license_config()
    max_ent = cfg.get("max_entities")
    if isinstance(max_ent, int) and max_ent > 0:
        return max_ent
    return None


def license_gate_http_status(payload: dict[str, Any]) -> int:
    err_code = (payload.get("error") or {}).get("code")
    if err_code in {
        "license_export_denied",
        "license_cross_group_denied",
        "license_expired",
        "license_invoice_cap_denied",
        "license_year_cap_denied",
        "license_invalid",
    }:
        return 403
    return 200 if payload.get("ok") else 400


def _coerce_license_payload(raw: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    out: dict[str, Any] = {}
    for key in _LICENSE_KEYS:
        if key not in raw:
            continue
        val = raw[key]
        if key == "export_report" or key == "cross_group":
            out[key] = bool(val)
        elif key in {"max_entities", "max_invoices", "max_years"}:
            try:
                n = int(val)
                # -1 表示不限制（与门控 check_* 中 <=0 语义一致）；0 同样视为不限制
                if n < -1:
                    errors.append(f"{key} 无效（-1 或 0 表示不限制）")
                else:
                    out[key] = n
            except (TypeError, ValueError):
                errors.append(f"{key} 需为整数")
        elif key == "expires_at":
            s = str(val).strip()
            if s and _parse_expires_at(s) is None:
                errors.append("expires_at 格式无效（期望 YYYY-MM-DD）")
            else:
                out[key] = s
        else:
            s = str(val).strip()
            if s:
                out[key] = s
    return out, errors


def api_settings_license() -> dict[str, Any]:
    lic = get_license_config()
    export_ok = bool(lic.get("export_report", False)) and not is_license_expired(lic)
    tier = str(lic.get("tier") or "trial")
    expired = is_license_expired(lic)
    override = _load_override()
    source = get_license_source()
    signed_err: str | None = None
    if source == "lic_invalid":
        _, signed_err = _load_signed_license_file()
    return {
        "ok": True,
        "tier": tier,
        "customer": lic.get("customer"),
        "expires_at": lic.get("expires_at"),
        "export_report": export_ok,
        "max_entities": lic.get("max_entities"),
        "max_invoices": lic.get("max_invoices"),
        "max_years": lic.get("max_years"),
        "cross_group": bool(lic.get("cross_group", False)),
        "is_expired": expired,
        "is_overridden": bool(override),
        "override_path": str(_LICENSE_OVERRIDE_PATH),
        "lic_path": str(_LICENSE_FILE_PATH),
        "source": source,
        "lic_error": signed_err,
        "gates": {
            "export_report": export_ok,
            "cross_group": bool(lic.get("cross_group", False)) and not expired,
        },
        "trial_hint": None
        if export_ok
        else ("授权已过期，请导入新授权文件。" if expired else "当前为试用版：报告生成与发票导出已受限，升级授权后可解锁。"),
    }


def api_settings_license_post(body: dict[str, Any]) -> dict[str, Any]:
    try:
        if body.get("reset") or body.get("action") == "reset":
            if _LICENSE_OVERRIDE_PATH.is_file():
                _LICENSE_OVERRIDE_PATH.unlink(missing_ok=True)
            return {"ok": True, "action": "reset", "license": api_settings_license()}

        raw = body.get("license") if isinstance(body.get("license"), dict) else body
        if not isinstance(raw, dict):
            return {
                "ok": False,
                "error": {"message": "请求体需为授权字段对象或 { license: {...} }", "exception_type": "ValidationError"},
            }

        parsed, errors = _coerce_license_payload(raw)
        if errors:
            return {"ok": False, "errors": errors}

        if not parsed:
            return {"ok": False, "error": {"message": "未提供可识别的授权字段", "exception_type": "ValidationError"}}

        override = _load_override()
        override.update(parsed)
        _save_override(override)

        try:
            from src.local_api.users_api import append_audit_log

            append_audit_log(
                action="license_update",
                username=str(body.get("actor") or body.get("username") or "system"),
                detail={"updated_keys": sorted(parsed.keys())},
            )
        except Exception:  # noqa: BLE001
            pass

        return {"ok": True, "updated": parsed, "license": api_settings_license()}
    except Exception as exc:  # noqa: BLE001
        logger.exception("settings_license_post")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
