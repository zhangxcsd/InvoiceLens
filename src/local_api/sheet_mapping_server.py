from __future__ import annotations

import errno
import json
import os
from datetime import date, datetime, time
from decimal import Decimal
import re
import tempfile
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import yaml

from config.field_mapping import get_field_mapping_config_info, save_field_mapping_config
from src.ingestion.excel_to_ods import load_excel_batch_to_ods
from src.local_api.listen_port_probe import assert_listen_port_free_or_exit
from src.local_api.multipart_form import MultipartForm, parse_multipart_form_data
from src.services.header_coverage import analyze_excel_path


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _default_ods_dir() -> str:
    """ODS Parquet 根目录：优先环境变量 INVOICELENS_ODS_DIR，否则 data/ods。"""
    env = (os.getenv("INVOICELENS_ODS_DIR") or "").strip()
    if env:
        return env
    return str(_project_root() / "data" / "ods")


def _read_sheet_mapping_yaml() -> dict[str, str]:
    p = _project_root() / "config" / "sheet_mapping.yaml"
    if not p.exists():
        return {}
    raw = p.read_text(encoding="utf-8")
    loaded = yaml.safe_load(raw)
    if isinstance(loaded, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in loaded.items()):
        return dict(loaded)
    return {}


def _risk_rules_path() -> Path:
    return _project_root() / "config" / "dim_tax_code_risk_rules.yaml"


def _subject_category_rules_path() -> Path:
    new_path = _project_root() / "config" / "subject_category_rules.yaml"
    old_path = _project_root() / "config" / "subject_category.yaml"
    return new_path if new_path.exists() or not old_path.exists() else old_path


_SUBJECT_REGISTER_AUTHORITIES = {"机构编制", "民政", "工商", "其他"}


def _normalize_register_authority(value: Any) -> str:
    v = str(value or "").strip()
    if not v:
        return "其他"
    return v if v in _SUBJECT_REGISTER_AUTHORITIES else "其他"


def _normalize_non_negative_int(value: Any, default: int = 0) -> int:
    try:
        n = int(str(value).strip())
    except Exception:
        return default
    return n if n >= 0 else default


def _first_present(obj: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in obj:
            return obj.get(k)
    return None


def _read_dim_tax_risk_rules_yaml_text() -> str:
    p = _risk_rules_path()
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8")


def _save_dim_tax_risk_rules_yaml_text(yaml_text: str) -> Path:
    p = _risk_rules_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # 先做 YAML 语法校验，避免写入损坏配置
    loaded = yaml.safe_load(yaml_text) if yaml_text.strip() else {}
    if loaded is None:
        loaded = {}
    if not isinstance(loaded, dict):
        raise ValueError("YAML 顶层必须为对象（mapping）")
    p.write_text(yaml_text, encoding="utf-8")
    return p


def _read_subject_category_rules() -> dict[str, Any]:
    p = _subject_category_rules_path()
    if not p.exists():
        return {"standard_version": "GB32100-2015", "categories": []}
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError("subject_category_rules.yaml 顶层必须是对象")
    cats = raw.get("categories")
    if cats is None:
        raw["categories"] = []
    elif not isinstance(cats, list):
        raise ValueError("subject_category_rules.yaml.categories 必须为数组")
    else:
        normalized: list[dict[str, Any]] = []
        for idx, it in enumerate(cats):
            if not isinstance(it, dict):
                raise ValueError(f"subject_category_rules.yaml.categories[{idx}] 必须为对象")
            normalized.append(
                {
                    "category_code": str(it.get("category_code") or "").strip(),
                    "category_name": str(it.get("category_name") or "").strip(),
                    "gb_code": str(it.get("gb_code") or "").strip(),
                    "register_authority": _normalize_register_authority(it.get("register_authority")),
                    "legal_form": str(it.get("legal_form") or "").strip(),
                    "invoice_scene": str(it.get("invoice_scene") or "").strip(),
                    "default_risk_focus": str(it.get("default_risk_focus") or "").strip(),
                    "coverage_count": _normalize_non_negative_int(it.get("coverage_count"), 0),
                    "enabled": bool(it.get("enabled", True)),
                }
            )
        raw["categories"] = normalized
    return raw


def _save_subject_category_rules(data: dict[str, Any]) -> Path:
    if not isinstance(data, dict):
        raise ValueError("请求体必须为对象")
    categories = data.get("categories")
    if not isinstance(categories, list):
        # 兼容旧前端请求体：rows
        categories = data.get("rows")
    if not isinstance(categories, list):
        raise ValueError("categories 必须为数组")
    seen: set[str] = set()
    norm_categories: list[dict[str, Any]] = []
    for idx, it in enumerate(categories):
        if not isinstance(it, dict):
            raise ValueError(f"categories[{idx}] 必须为对象")
        # 兼容 snake_case + camelCase
        code = str(_first_present(it, "category_code", "categoryCode") or "").strip()
        name = str(_first_present(it, "category_name", "categoryName") or "").strip()
        if not code:
            raise ValueError(f"categories[{idx}] 缺少 category_code")
        if code in seen:
            raise ValueError(f"category_code 重复：{code}")
        if not name:
            raise ValueError(f"categories[{idx}] 缺少 category_name")
        register_authority = _normalize_register_authority(
            _first_present(it, "register_authority", "registerAuthority")
        )
        seen.add(code)
        norm_categories.append(
            {
                "category_code": code,
                "category_name": name,
                "gb_code": str(_first_present(it, "gb_code", "gbCode") or "").strip(),
                "register_authority": register_authority,
                "legal_form": str(_first_present(it, "legal_form", "legalForm") or "").strip(),
                "invoice_scene": str(_first_present(it, "invoice_scene", "invoiceScene") or "").strip(),
                "default_risk_focus": str(
                    _first_present(it, "default_risk_focus", "defaultRiskFocus") or ""
                ).strip(),
                "enabled": bool(_first_present(it, "enabled") if "enabled" in it else True),
            }
        )
    payload = {
        "standard_version": str(data.get("standard_version") or "GB32100-2015").strip() or "GB32100-2015",
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "categories": norm_categories,
    }
    p = _subject_category_rules_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    txt = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
    p.write_text(txt, encoding="utf-8")
    return p


def _json_default(o: Any) -> Any:
    """DuckDB 行中常见 Decimal / 日期等，标准 json 无法序列化。"""
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, date):
        return o.isoformat()
    if isinstance(o, time):
        return o.isoformat()
    if isinstance(o, (bytes, bytearray)):
        return o.decode("utf-8", errors="replace")
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def _json(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, default=_json_default).encode("utf-8")


def _parse_mb_env(name: str, default: int, *, cap: int) -> int:
    try:
        v = int((os.getenv(name) or str(default)).strip())
    except Exception:
        v = default
    if v < 1:
        v = 1
    return min(v, cap)


def _max_upload_mb() -> int:
    """与前端 VITE_MAX_IMPORT_FILE_MB 默认口径对齐：单文件落盘上限。"""
    return _parse_mb_env("INVOICELENS_MAX_UPLOAD_MB", 200, cap=2048)


def _max_upload_bytes() -> int:
    return _max_upload_mb() * 1024 * 1024


def _effective_max_upload_bytes(client_field: str) -> int:
    """
    客户端可在 multipart 中传 client_max_upload_mb（整数 MB），用于在服务端硬顶内收紧单文件限制；
    未传或无效时使用环境变量 INVOICELENS_MAX_UPLOAD_MB。
    """
    ceiling_mb = _max_upload_mb()
    try:
        v = int(str(client_field or "").strip())
    except Exception:
        v = 0
    if v <= 0:
        eff_mb = ceiling_mb
    else:
        eff_mb = min(v, ceiling_mb)
    return max(1, eff_mb) * 1024 * 1024


def _effective_multipart_body_bytes(*, for_batch: bool) -> int:
    """
    单次 multipart 请求体字节上限。
    - 未设置 INVOICELENS_MAX_MULTIPART_BODY_MB：分文件请求用「单文件上限+32MB」；旧版整批上传用 2048MB。
    - 已设置环境变量：两种请求共用该值（字节由 MB 换算）。
    """
    raw = os.getenv("INVOICELENS_MAX_MULTIPART_BODY_MB")
    if raw is not None and str(raw).strip() != "":
        return _parse_mb_env("INVOICELENS_MAX_MULTIPART_BODY_MB", 512, cap=8192) * 1024 * 1024
    if for_batch:
        return 2048 * 1024 * 1024
    return min(8192 * 1024 * 1024, max(64 * 1024 * 1024, (_max_upload_mb() + 32) * 1024 * 1024))


def _cleanup_partial_upload(upload_root: Path, excel_paths: list[str]) -> None:
    for p in excel_paths:
        try:
            Path(p).unlink(missing_ok=True)
        except Exception:
            pass
    try:
        if upload_root.exists():
            shutil.rmtree(upload_root, ignore_errors=True)
    except Exception:
        pass


def _parse_multipart_fields(
    handler: BaseHTTPRequestHandler,
    *,
    for_batch: bool = False,
) -> tuple[MultipartForm | None, dict[str, Any] | None]:
    ctype = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in ctype.lower():
        return None, {"ok": False, "error": {"message": "Content-Type 须为 multipart/form-data"}}
    try:
        clen = int(handler.headers.get("Content-Length") or "0")
    except Exception:
        clen = 0
    if clen <= 0:
        return None, {"ok": False, "error": {"message": "缺少 Content-Length 或正文为空"}}
    max_body = _effective_multipart_body_bytes(for_batch=for_batch)
    limit_mb = max_body // (1024 * 1024)
    if clen > max_body:
        return None, {
            "ok": False,
            "error": {
                "message": (
                    f"单次上传请求体超过上限 {limit_mb}MB（≈{clen // (1024 * 1024)}MB）；"
                    f"可调大 INVOICELENS_MAX_MULTIPART_BODY_MB"
                ),
            },
        }
    try:
        body = handler.rfile.read(clen)
        if len(body) != clen:
            return None, {"ok": False, "error": {"message": "请求体读取不完整"}}
        fs = parse_multipart_form_data(ctype, body)
    except Exception as exc:
        return None, {
            "ok": False,
            "error": {
                "message": "multipart 解析失败",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }
    return fs, None


def _multipart_first_field(fs: MultipartForm, name: str) -> str:
    if name not in fs:
        return ""
    item = fs[name]
    if isinstance(item, list):
        item = item[0]
    val = getattr(item, "value", None)
    if val is None:
        return ""
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="replace")
    return str(val)


def _parse_bool_like(raw: str | None, default: bool = False) -> bool:
    if raw is None:
        return default
    v = str(raw).strip().lower()
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _multipart_file_items(fs: MultipartForm) -> list[Any]:
    file_items: list[Any] = []
    if getattr(fs, "list", None):
        for item in fs.list:
            fn = getattr(item, "filename", None)
            if fn and getattr(item, "name", None) == "files":
                file_items.append(item)
    return file_items


def _multipart_first_uploaded_file(fs: MultipartForm) -> tuple[bytes | None, str]:
    """取 multipart 中第一个上传文件；字段名支持 file（与 dim-tax 一致）或 files。"""
    if not getattr(fs, "list", None):
        return None, ""
    for item in fs.list:
        fn = getattr(item, "filename", None)
        nm = getattr(item, "name", None)
        if not fn or nm not in {"file", "files"}:
            continue
        rawv = getattr(item, "value", b"")
        body = rawv if isinstance(rawv, bytes) else bytes(rawv)
        return body, str(fn)
    return None, ""


def _norm_target_keys_tuple(v: list[str] | None) -> tuple[str, ...]:
    if not v:
        return ()
    return tuple(sorted(str(x).strip() for x in v if str(x).strip()))


class Handler(BaseHTTPRequestHandler):
    server_version = "InvoiceLensLocalAPI/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        """避免 stderr 句柄异常导致请求响应中断。"""
        try:
            super().log_message(fmt, *args)
        except Exception:
            return

    def _send(self, status: int, body: dict, *, cors: bool = True) -> None:
        data = _json(body)
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if cors:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Token")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # 浏览器取消请求、切换路由、StrictMode 重复请求等导致对端先关连接
            return
        except OSError as exc:
            if getattr(exc, "winerror", None) in (10053, 10054):
                return
            if exc.errno in {errno.EPIPE, errno.ECONNRESET}:
                return
            raise

    @staticmethod
    def _attachment_content_disposition(filename: str) -> str:
        """RFC 5987：非 ASCII 文件名用 filename*，避免 HTTP 头 latin-1 编码失败。"""
        name = (filename or "download").replace('"', "").replace("\\", "")
        if name.isascii():
            return f'attachment; filename="{name}"'
        path = Path(name)
        ext = path.suffix
        ascii_stem = "".join(
            ch for ch in path.stem if ch.isascii() and ch not in {'"', "\\"}
        ).strip("._")
        ascii_fallback = f"{ascii_stem or 'download'}{ext or '.bin'}"
        encoded = quote(name, safe="")
        return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded}'

    def _send_file(
        self,
        status: int,
        data: bytes,
        *,
        content_type: str,
        filename: str,
        cors: bool = True,
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", self._attachment_content_disposition(filename))
            if cors:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Token")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except OSError as exc:
            if getattr(exc, "winerror", None) in (10053, 10054):
                return
            if exc.errno in {errno.EPIPE, errno.ECONNRESET}:
                return
            raise

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Token")
        self.end_headers()

    def _read_json(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except Exception:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def _gate_api(self, path: str, method: str) -> bool:
        """鉴权门控：/api/* 除登录与健康检查外须有效会话。"""
        if not path.startswith("/api/"):
            return True
        from src.local_api.auth_session import check_api_access

        ok, status, payload = check_api_access(path, method, self.headers)
        if ok:
            return True
        self._send(status, payload, cors=True)
        return False

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path == "/health":
            self._send(200, {"ok": True})
            return

        if path.startswith("/api/") and not self._gate_api(path, "GET"):
            return

        if path == "/api/import-limits":
            self._send(
                200,
                {
                    "ok": True,
                    "max_upload_mb": _max_upload_mb(),
                },
            )
            return

        if path == "/api/sheet-mapping":
            qs = parse_qs(parsed.query or "")
            include_table_type = (qs.get("include_table_type", ["1"])[0] or "1").strip() not in {"0", "false"}
            try:
                mapping = _read_sheet_mapping_yaml()
                # 与 config/sheet_mapping.yaml 中条目顺序一致（勿按拼音/字母重排）
                keys = list(mapping.keys())
                if include_table_type:
                    options = [{"sheet_key": k, "table_type": mapping[k]} for k in keys]
                else:
                    options = [{"sheet_key": k} for k in keys]
                self._send(
                    200,
                    {
                        "ok": True,
                        "source": "config/sheet_mapping.yaml",
                        "options": options,
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": "读取 sheet_mapping.yaml 失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/field-mapping/templates/list":
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_templates_list

                self._send(200, api_field_mapping_templates_list())
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/get":
            qs = parse_qs(parsed.query or "")
            template_id = (qs.get("template_id") or qs.get("id") or [""])[0]
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_get

                payload = api_field_mapping_template_get(str(template_id))
                self._send(200 if payload.get("ok") else 404, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/export-zip":
            qs = parse_qs(parsed.query or "")
            template_id = (qs.get("template_id") or qs.get("id") or [""])[0]
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_export_zip

                status, payload, ctype, fname = api_field_mapping_template_export_zip(str(template_id))
                if isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "template.zip")
                else:
                    self._send(status if status >= 400 else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/sample-download":
            qs = parse_qs(parsed.query or "")
            template_id = (qs.get("template_id") or qs.get("id") or [""])[0]
            filename = (qs.get("filename") or qs.get("name") or [""])[0]
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_sample_download

                status, payload, ctype, fname = api_field_mapping_template_sample_download(
                    str(template_id),
                    str(filename),
                )
                if isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "sample.xlsx")
                else:
                    self._send(status if status >= 400 else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping":
            try:
                cfg, source = get_field_mapping_config_info()
                default_fields = cfg.get("default_fields") or {}
                sheets = cfg.get("sheets") or {}
                self._send(
                    200,
                    {
                        "ok": True,
                        "source": source,
                        # 兼容旧前端：fields 仍表示 default_fields
                        "fields": default_fields,
                        "default_fields": default_fields,
                        "sheets": sheets,
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": "读取字段映射失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim-tax-code/risk-rules":
            try:
                raw = _read_dim_tax_risk_rules_yaml_text()
                self._send(
                    200,
                    {
                        "ok": True,
                        "source": str(_risk_rules_path()),
                        "yaml_text": raw,
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": "读取敏感类目规则失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-category/rules":
            try:
                payload = _read_subject_category_rules()
                categories = (
                    payload.get("categories") if isinstance(payload.get("categories"), list) else []
                )
                try:
                    from db.duckdb_conn import get_conn
                    from db.schema_sqlfiles import init_all_tables
                    from src.local_api.subject_library import (
                        apply_subject_category_coverage_counts,
                        query_subject_category_coverage_counts,
                    )

                    conn = get_conn()
                    init_all_tables(conn)
                    apply_subject_category_coverage_counts(
                        categories,
                        query_subject_category_coverage_counts(conn),
                    )
                except Exception:
                    for it in categories:
                        if isinstance(it, dict):
                            it["coverage_count"] = 0
                self._send(
                    200,
                    {
                        "ok": True,
                        "source": str(_subject_category_rules_path()),
                        "standard_version": str(payload.get("standard_version") or "GB32100-2015"),
                        "updated_at": str(payload.get("updated_at") or ""),
                        "categories": categories,
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": "读取主体类别规则失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-category/recompute/latest":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables

                conn = get_conn()
                init_all_tables(conn)
                latest = conn.execute(
                    """
                    SELECT
                        snapshot_id,
                        subject_build_run_id,
                        MAX(created_at) AS created_at
                    FROM dim_subject_category_snapshot
                    GROUP BY snapshot_id, subject_build_run_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ).fetchone()
                if not latest:
                    self._send(
                        200,
                        {
                            "ok": True,
                            "latest": None,
                            "message": "暂无主体重算记录",
                        },
                    )
                    return
                snapshot_id = str(latest[0] or "")
                run_id = str(latest[1] or "")
                created_at = latest[2].isoformat() if latest[2] is not None else ""

                cat_agg = conn.execute(
                    """
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN org_category IS NOT NULL AND org_category <> '' THEN 1 ELSE 0 END) AS matched,
                        SUM(CASE WHEN infer_needs_review THEN 1 ELSE 0 END) AS needs_review,
                        SUM(CASE WHEN category_status_note = 'category_disabled_at_run' THEN 1 ELSE 0 END) AS disabled_blocked
                    FROM dim_subject_category_snapshot
                    WHERE snapshot_id = ?
                    """,
                    [snapshot_id],
                ).fetchone()
                cat_by_code = conn.execute(
                    """
                    SELECT
                        COALESCE(org_category, 'UNCLASSIFIED') AS org_category,
                        COUNT(*) AS cnt
                    FROM dim_subject_category_snapshot
                    WHERE snapshot_id = ?
                    GROUP BY 1
                    ORDER BY cnt DESC, org_category ASC
                    """,
                    [snapshot_id],
                ).fetchall()
                from src.local_api.subject_library import get_org_category_display_names

                _org_cat_names = get_org_category_display_names()
                rel_agg = conn.execute(
                    """
                    SELECT
                        COUNT(*) AS relation_total,
                        COALESCE(SUM(trade_invoice_count), 0) AS trade_invoice_count_sum,
                        COALESCE(SUM(trade_amount_jshj), 0) AS trade_amount_jshj_sum
                    FROM dim_subject_relation_snapshot
                    WHERE snapshot_id = ?
                    """,
                    [snapshot_id],
                ).fetchone()

                self._send(
                    200,
                    {
                        "ok": True,
                        "latest": {
                            "run_id": run_id,
                            "snapshot_id": snapshot_id,
                            "created_at": created_at,
                            "category_summary": {
                                "total": int(cat_agg[0] or 0),
                                "matched": int(cat_agg[1] or 0),
                                "needs_review": int(cat_agg[2] or 0),
                                "disabled_blocked": int(cat_agg[3] or 0),
                                "by_org_category": [
                                    {
                                        "org_category": str(r[0] or "UNCLASSIFIED"),
                                        "org_category_display_name": (
                                            ""
                                            if str(r[0] or "") == "UNCLASSIFIED"
                                            else _org_cat_names.get(str(r[0] or "").strip(), "")
                                        ),
                                        "count": int(r[1] or 0),
                                    }
                                    for r in cat_by_code
                                ],
                            },
                            "relation_summary": {
                                "relation_total": int(rel_agg[0] or 0),
                                "trade_invoice_count_sum": int(rel_agg[1] or 0),
                                "trade_amount_jshj_sum": float(rel_agg[2] or 0),
                            },
                        },
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取主体重算最新摘要失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-library/summary":
            qs = parse_qs(parsed.query or "")
            subject_type = (qs.get("subject_type", ["all"])[0] or "all").strip()
            source_type = (qs.get("source_type", ["all"])[0] or "all").strip()
            keyword = (qs.get("keyword", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library import api_subject_library_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_subject_library_summary(
                    conn,
                    subject_type=subject_type,
                    source_type=source_type,
                    keyword=keyword,
                )
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取主体库汇总失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-library/org-category-options":
            try:
                from src.local_api.subject_library import api_subject_library_org_category_options

                payload = api_subject_library_org_category_options()
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    200,
                    {
                        "ok": False,
                        "categories": [],
                        "error": {
                            "message": f"读取主体类别选项失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-library/rows":
            qs = parse_qs(parsed.query or "")
            keyword = (qs.get("keyword", [""])[0] or "").strip()
            subject_type = (qs.get("subject_type", ["all"])[0] or "all").strip()
            source_type = (qs.get("source_type", ["all"])[0] or "all").strip()
            subject_category = (qs.get("subject_category", ["all"])[0] or "all").strip()
            rename_signal = (qs.get("rename_signal", ["all"])[0] or "all").strip()
            category_review = (qs.get("category_review", ["all"])[0] or "all").strip()
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            try:
                limit = int((qs.get("limit", ["50"])[0] or "50").strip() or "50")
            except Exception:
                limit = 50
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except Exception:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library import api_subject_library_rows

                conn = get_conn()
                init_all_tables(conn)
                payload = api_subject_library_rows(
                    conn,
                    keyword=keyword,
                    subject_type=subject_type,
                    source_type=source_type,
                    subject_category=subject_category,
                    rename_signal=rename_signal,
                    category_review=category_review,
                    batch_id=batch_id,
                    limit=limit,
                    offset=offset,
                )
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取主体库明细失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-library/rename-rebuild-status":
            qs = parse_qs(parsed.query or "")
            run_id = (qs.get("run_id", [""])[0] or "").strip()
            try:
                from src.local_api.subject_library_rename_build import get_subject_rename_rebuild_status

                payload = get_subject_rename_rebuild_status(run_id)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"查询更名信号重建状态失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            # 始终 200：由 payload.ok 表达业务成败（兼容只认 2xx 的代理与客户端）
            self._send(200, payload, cors=True)
            return

        if path == "/api/subject-library/rename-timeline":
            qs = parse_qs(parsed.query or "")
            subject_id = (qs.get("subject_id", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library import api_subject_library_rename_timeline

                conn = get_conn()
                init_all_tables(conn)
                payload = api_subject_library_rename_timeline(conn, subject_id=subject_id)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"读取更名轨迹失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/subject-library/invoice-headers":
            qs = parse_qs(parsed.query or "")
            subject_id = (qs.get("subject_id", [""])[0] or "").strip()
            try:
                limit = int((qs.get("limit", ["50"])[0] or "50").strip() or "50")
            except Exception:
                limit = 50
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except Exception:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library import api_subject_library_invoice_headers

                conn = get_conn()
                init_all_tables(conn)
                payload = api_subject_library_invoice_headers(
                    conn, subject_id=subject_id, limit=limit, offset=offset
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"读取主体关联发票失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200, payload, cors=True)
            return

        if path == "/api/dim/task-runs":
            qs = parse_qs(parsed.query or "")
            task_code = (qs.get("task_code", [""])[0] or "").strip() or None
            limit_raw = (qs.get("limit", ["20"])[0] or "20").strip()
            try:
                limit = int(limit_raw)
            except Exception:
                limit = 20
            try:
                from src.local_api.dwd_to_dim_build import list_dim_task_runs

                payload = list_dim_task_runs(task_code=task_code, limit=limit)
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": "读取 DWD→DIM 任务运行记录失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/task-status":
            qs = parse_qs(parsed.query or "")
            codes_raw = (qs.get("task_codes", [""])[0] or "").strip()
            task_codes = [c.strip() for c in codes_raw.split(",") if c.strip()] if codes_raw else None
            try:
                from src.local_api.dwd_to_dim_build import summarize_dim_task_status

                self._send(200, summarize_dim_task_status(task_codes=task_codes), cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
            return

        if path == "/api/dim/tasks":
            try:
                from src.local_api.dwd_to_dim_build import list_unified_dim_tasks

                self._send(200, list_unified_dim_tasks(), cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
            return

        if path == "/api/dim/task-run-status":
            qs = parse_qs(parsed.query or "")
            run_id = (qs.get("run_id", [""])[0] or "").strip()
            try:
                from src.local_api.dwd_to_dim_build import get_dim_task_run_status

                payload = get_dim_task_run_status(run_id)
                self._send(200 if payload.get("ok") else 404, payload, cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
            return

        if path == "/api/subject-library/pipeline-status":
            qs = parse_qs(parsed.query or "")
            run_id = (qs.get("run_id", [""])[0] or "").strip()
            try:
                from src.local_api.subject_library_pipeline import get_subject_library_pipeline_status

                payload = get_subject_library_pipeline_status(run_id)
                self._send(200 if payload.get("ok") else 404, payload, cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
            return

        if path.startswith("/api/import-sessions/") and path.endswith("/events"):
            session_id = path.split("/")[3] if len(path.split("/")) >= 4 else ""
            qs = parse_qs(parsed.query or "")
            after = int((qs.get("after_event_id", ["0"])[0] or "0").strip() or 0)
            payload = _sessions.get_events(session_id, after_event_id=after)
            self._send(200 if payload.get("ok") else 404, payload)
            return

        if path == "/api/ods-preview/batches":
            qs = parse_qs(parsed.query or "")
            try:
                lim = int((qs.get("limit", ["80"])[0] or "80").strip() or "80")
            except Exception:
                lim = 80
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.ods_preview import list_ods_preview_batches

                conn = get_conn()
                init_all_tables(conn)
                payload = list_ods_preview_batches(conn, limit=lim)
            except Exception as exc:
                from src.local_api.ods_preview import _effective_ods_dir

                payload = {
                    "ok": False,
                    "ods_dir_hint": _effective_ods_dir(),
                    "error": {
                        "message": f"无法连接或查询 DuckDB（数据预览批次列表）：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/ods-preview/overview":
            qs = parse_qs(parsed.query or "")
            try:
                lim = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except Exception:
                lim = 500
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.ods_preview import list_ods_inventory_overview

                conn = get_conn()
                init_all_tables(conn)
                payload = list_ods_inventory_overview(conn, limit=lim)
            except Exception as exc:
                from src.local_api.ods_preview import _effective_ods_dir

                payload = {
                    "ok": False,
                    "ods_dir_hint": _effective_ods_dir(),
                    "error": {
                        "message": f"无法连接或查询 DuckDB（ODS 库存总览）：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/ods-preview/session-summary":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            try:
                sample_limit = int((qs.get("sample_limit", ["30"])[0] or "30").strip() or "30")
            except Exception:
                sample_limit = 30
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.ods_preview import load_ods_import_session_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = load_ods_import_session_summary(
                    conn,
                    batch_id=batch_id,
                    session_id=session_id,
                    sample_limit=sample_limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法连接或查询 DuckDB（导入会话摘要）：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/ods-preview/session":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            view = (qs.get("view", ["std"])[0] or "std").strip().lower()
            if view not in {"std", "raw"}:
                view = "std"
            meta_only = (qs.get("meta_only", ["0"])[0] or "0").strip().lower() in {"1", "true", "yes"}
            only_table_type = (qs.get("only_table_type", [""])[0] or "").strip()
            include_counts = (qs.get("include_counts", ["0"])[0] or "0").strip().lower() in {
                "1",
                "true",
                "yes",
            }
            try:
                row_limit = int((qs.get("row_limit", ["400"])[0] or "400").strip() or "400")
            except Exception:
                row_limit = 400
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.ods_preview import load_ods_preview_session

                conn = get_conn()
                init_all_tables(conn)
                payload = load_ods_preview_session(
                    conn,
                    batch_id=batch_id,
                    session_id=session_id,
                    row_limit=row_limit,
                    view=view,
                    meta_only=meta_only,
                    only_table_type=only_table_type or None,
                    include_counts=include_counts,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取 ODS 会话预览：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/ods-preview/table-page":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            table_type = (qs.get("table_type", [""])[0] or "").strip()
            view = (qs.get("view", ["std"])[0] or "std").strip().lower()
            if view not in {"std", "raw"}:
                view = "std"
            try:
                limit = int((qs.get("limit", ["200"])[0] or "200").strip() or 200)
            except Exception:
                limit = 200
            cursor_raw = (qs.get("cursor", [""])[0] or "").strip()
            cursor_obj = None
            if cursor_raw:
                try:
                    cursor_obj = json.loads(cursor_raw)
                except Exception:
                    cursor_obj = None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.ods_preview import load_ods_preview_table_page

                conn = get_conn()
                init_all_tables(conn)
                payload = load_ods_preview_table_page(
                    conn,
                    batch_id=batch_id,
                    session_id=session_id,
                    table_type=table_type,
                    limit=limit,
                    cursor=cursor_obj if isinstance(cursor_obj, dict) else None,
                    view=view,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取 ODS 分页预览：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/dwd/build-log":
            qs = parse_qs(parsed.query or "")
            run_id = (qs.get("run_id", [""])[0] or "").strip()
            download = (qs.get("download", ["0"])[0] or "0").strip().lower() in {"1", "true", "yes"}
            try:
                from src.local_api.dwd_build_log import dwd_log_file_path, read_dwd_build_log

                if download:
                    log_path = dwd_log_file_path(run_id)
                    if not log_path.is_file():
                        self._send(404, {"ok": False, "error": {"message": "日志文件不存在", "code": "log_not_found"}}, cors=True)
                        return
                    try:
                        data = log_path.read_bytes()
                    except Exception as exc:
                        self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
                        return
                    fname = f"{run_id}.log" if run_id else "dwd_build.log"
                    self._send_file(200, data, content_type="text/plain; charset=utf-8", filename=fname)
                    return
                payload = read_dwd_build_log(run_id)
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 404, payload, cors=True)
            return

        if path == "/api/dwd-preview/tabs":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dwd_preview import list_dwd_preview_tabs

                conn = get_conn()
                init_all_tables(conn)
                payload = list_dwd_preview_tabs(
                    conn,
                    batch_id=batch_id,
                    session_id=session_id or None,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取 DWD Tab 列表：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/dwd-preview/table-page":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            layer = (qs.get("layer", ["detail"])[0] or "detail").strip().lower()
            dwd_table = (qs.get("dwd_table", [""])[0] or "").strip()
            table_type = (qs.get("table_type", [""])[0] or "").strip()
            try:
                limit = int((qs.get("limit", ["200"])[0] or "200").strip() or "200")
            except Exception:
                limit = 200
            cursor_raw = (qs.get("cursor", [""])[0] or "").strip()
            cursor_obj = None
            if cursor_raw:
                try:
                    cursor_obj = json.loads(cursor_raw)
                except Exception:
                    cursor_obj = None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dwd_preview import load_dwd_preview_table_page

                conn = get_conn()
                init_all_tables(conn)
                payload = load_dwd_preview_table_page(
                    conn,
                    batch_id=batch_id,
                    session_id=session_id or None,
                    layer=layer,
                    dwd_table=dwd_table or None,
                    table_type=table_type or None,
                    limit=limit,
                    cursor=cursor_obj if isinstance(cursor_obj, dict) else None,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取 DWD 分页预览：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/red-invoice-overview":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_red_invoice_quality_overview

                conn = get_conn()
                init_all_tables(conn)
                payload = load_red_invoice_quality_overview(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取红票质量概览：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/red-invoice-details":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            only_unmatched = (qs.get("only_unmatched", ["1"])[0] or "1").strip().lower() not in {"0", "false"}
            try:
                limit = int((qs.get("limit", ["200"])[0] or "200").strip() or "200")
            except Exception:
                limit = 200
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_red_invoice_quality_details

                conn = get_conn()
                init_all_tables(conn)
                payload = load_red_invoice_quality_details(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    only_unmatched=only_unmatched,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取红票质量明细：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/red-invoice-trend":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            stat_year_raw = (qs.get("stat_year", [""])[0] or "").strip()
            stat_year: int | None = None
            if stat_year_raw:
                try:
                    stat_year = int(stat_year_raw)
                except Exception:
                    stat_year = None
            granularity = (qs.get("granularity", ["week"])[0] or "week").strip()
            try:
                limit = int((qs.get("limit", ["12"])[0] or "12").strip() or "12")
            except Exception:
                limit = 12
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_red_invoice_quality_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = load_red_invoice_quality_trend(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    stat_year=stat_year,
                    granularity=granularity,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取红票质量趋势：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/lineage-reject-trend":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            granularity = (qs.get("granularity", ["week"])[0] or "week").strip()
            try:
                limit = int((qs.get("limit", ["12"])[0] or "12").strip() or "12")
            except Exception:
                limit = 12
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_lineage_reject_quality_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = load_lineage_reject_quality_trend(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    granularity=granularity,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取导入拒收趋势：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/dwd-lineage-trend":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            granularity = (qs.get("granularity", ["week"])[0] or "week").strip()
            try:
                limit = int((qs.get("limit", ["12"])[0] or "12").strip() or "12")
            except Exception:
                limit = 12
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_dwd_lineage_quality_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = load_dwd_lineage_quality_trend(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    granularity=granularity,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取 DWD 血缘趋势：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/semantic-trend":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            granularity = (qs.get("granularity", ["week"])[0] or "week").strip()
            try:
                limit = int((qs.get("limit", ["12"])[0] or "12").strip() or "12")
            except Exception:
                limit = 12
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_semantic_quality_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = load_semantic_quality_trend(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    granularity=granularity,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取语义质量趋势：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/domain-trend":
            qs = parse_qs(parsed.query or "")
            domain = (qs.get("domain", [""])[0] or "").strip()
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            granularity = (qs.get("granularity", ["week"])[0] or "week").strip()
            try:
                limit = int((qs.get("limit", ["12"])[0] or "12").strip() or "12")
            except Exception:
                limit = 12
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_structured_dq_domain_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = load_structured_dq_domain_trend(
                    conn,
                    domain=domain,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    granularity=granularity,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取质量域趋势：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/batches":
            qs = parse_qs(parsed.query or "")
            try:
                limit = int((qs.get("limit", ["80"])[0] or "80").strip() or "80")
            except Exception:
                limit = 80
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_quality_import_batches

                conn = get_conn()
                init_all_tables(conn)
                payload = load_quality_import_batches(conn, limit=limit)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "batches": [],
                    "error": {
                        "message": f"无法读取质量批次列表：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/domain-overview":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_dq_domain_overview

                conn = get_conn()
                init_all_tables(conn)
                payload = load_dq_domain_overview(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取质量域概览：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/domain-details":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            domain = (qs.get("domain", ["red_link"])[0] or "red_link").strip()
            only_unmatched = (qs.get("only_unmatched", ["1"])[0] or "1").strip().lower() not in {"0", "false"}
            ticket_key = (qs.get("ticket_key", [""])[0] or "").strip() or None
            source_excel_file = (qs.get("source_excel_file", [""])[0] or "").strip() or None
            source_sheet = (qs.get("source_sheet", [""])[0] or "").strip() or None
            row_kind = (qs.get("row_kind", ["all"])[0] or "all").strip()
            only_missing = (qs.get("only_missing", ["0"])[0] or "0").strip().lower() in {"1", "true"}
            rule_id = (qs.get("rule_id", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["200"])[0] or "200").strip() or "200")
            except Exception:
                limit = 200
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except Exception:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_dq_domain_details

                conn = get_conn()
                init_all_tables(conn)
                payload = load_dq_domain_details(
                    conn,
                    domain=domain,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    only_unmatched=only_unmatched,
                    limit=limit,
                    offset=offset,
                    ticket_key=ticket_key,
                    source_excel_file=source_excel_file,
                    source_sheet=source_sheet,
                    row_kind=row_kind,
                    only_missing=only_missing,
                    rule_id=rule_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取质量域明细：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/quality/health-score":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip()
            session_id = (qs.get("session_id", [""])[0] or "").strip()
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import load_health_score_snapshot

                conn = get_conn()
                init_all_tables(conn)
                payload = load_health_score_snapshot(
                    conn,
                    batch_id=batch_id or None,
                    session_id=session_id or None,
                    stat_year=stat_year,
                    entity_id=entity_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取健康度评价：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload)
            return

        if path == "/api/dim-tax-code/rows":
            qs = parse_qs(parsed.query or "")
            keyword = (qs.get("keyword", [""])[0] or "").strip()
            clean_status = (qs.get("clean_status", ["all"])[0] or "all").strip().lower()
            risk = (qs.get("risk", ["all"])[0] or "all").strip()
            import_batch_id = (qs.get("import_batch_id", [""])[0] or "").strip()
            import_session_id = (qs.get("import_session_id", [""])[0] or "").strip()
            abnormal_only = (qs.get("abnormal_only", ["0"])[0] or "0").strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
            try:
                from src.local_api.dim_tax_code_import import api_list_dim_tax_code_rows

                payload = api_list_dim_tax_code_rows(
                    keyword=keyword,
                    clean_status=clean_status,
                    risk=risk,
                    import_batch_id=import_batch_id,
                    import_session_id=import_session_id,
                    abnormal_only=abnormal_only,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"查询 dim_tax_code 失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload)
            return

        if path == "/api/dim-tax-code/filter-options":
            qs = parse_qs(parsed.query or "")
            import_batch_id = (qs.get("import_batch_id", [""])[0] or "").strip()
            try:
                from src.local_api.dim_tax_code_import import api_list_dim_tax_code_filter_options

                payload = api_list_dim_tax_code_filter_options(import_batch_id=import_batch_id)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"查询 dim_tax_code 筛选项失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload)
            return

        if path == "/api/dim/tax-code/analysis/overview":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            import_batch_id = (qs.get("import_batch_id", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.tax_code_analysis_api import api_tax_code_analysis_overview

                conn = get_conn()
                init_all_tables(conn)
                payload = api_tax_code_analysis_overview(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    import_batch_id=import_batch_id,
                    keyword=keyword,
                    goods_name=goods_name,
                    slv_num=slv_num,
                )
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 500, payload)
            return

        if path == "/api/dim/tax-code/analysis/unmatched":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            import_batch_id = (qs.get("import_batch_id", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            page = (qs.get("page", ["1"])[0] or "1").strip()
            page_size = (qs.get("page_size", ["50"])[0] or "50").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.tax_code_analysis_api import api_tax_code_analysis_unmatched

                conn = get_conn()
                init_all_tables(conn)
                payload = api_tax_code_analysis_unmatched(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    import_batch_id=import_batch_id,
                    keyword=keyword,
                    goods_name=goods_name,
                    slv_num=slv_num,
                    page=int(page) if page.isdigit() else 1,
                    page_size=int(page_size) if page_size.isdigit() else 50,
                )
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 500, payload)
            return

        if path == "/api/dim/tax-code/analysis/enterprise-summary":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            top_category = (qs.get("top_category", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            page = (qs.get("page", ["1"])[0] or "1").strip()
            page_size = (qs.get("page_size", ["50"])[0] or "50").strip()
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.tax_code_analysis_api import api_tax_code_analysis_enterprise_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_tax_code_analysis_enterprise_summary(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    keyword=keyword,
                    top_category=top_category,
                    goods_name=goods_name,
                    slv_num=slv_num,
                    page=int(page) if page.isdigit() else 1,
                    page_size=int(page_size) if page_size.isdigit() else 50,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                )
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 500, payload)
            return

        if path == "/api/dim/enterprise-year-roster/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_meta

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_meta(conn)
                self._send(200, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/enterprise-year-rel/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables, is_core_schema_ready
                from src.local_api.enterprise_year_rel_build import api_dim_enterprise_year_rel_meta

                conn = get_conn()
                try:
                    init_all_tables(conn)
                except Exception:
                    if not is_core_schema_ready(conn):
                        raise
                payload = api_dim_enterprise_year_rel_meta(conn)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"读取企业-年度关系元数据失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return

        if path == "/api/dim/enterprise-year-roster/bootstrap":
            qs = parse_qs(parsed.query or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_bootstrap

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_bootstrap(
                    conn,
                    stat_year=(qs.get("stat_year") or [None])[0],
                    state_investor_kw=(qs.get("state_investor_kw") or [""])[0],
                    enterprise_kw=(qs.get("enterprise_kw") or qs.get("keyword") or [""])[0],
                    limit=int((qs.get("limit") or ["50"])[0] or 50),
                    offset=int((qs.get("offset") or ["0"])[0] or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/enterprise-year-roster/kpi":
            qs = parse_qs(parsed.query or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_kpi

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_kpi(
                    conn,
                    stat_year=(qs.get("stat_year") or [None])[0],
                )
                self._send(200 if payload.get("ok") else 400, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/enterprise-year-roster/summary":
            qs = parse_qs(parsed.query or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_summary(
                    conn,
                    stat_year=(qs.get("stat_year") or [None])[0],
                    state_investor_kw=(qs.get("state_investor_kw") or qs.get("state_investor") or [""])[0],
                )
                self._send(200 if payload.get("ok") else 400, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/enterprise-year-roster/list":
            qs = parse_qs(parsed.query or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_list(
                    conn,
                    stat_year=(qs.get("stat_year") or [None])[0],
                    state_investor=(qs.get("state_investor") or [""])[0],
                    state_investor_code=(qs.get("state_investor_code") or [""])[0],
                    state_investor_kw=(qs.get("state_investor_kw") or [""])[0],
                    enterprise_kw=(qs.get("enterprise_kw") or qs.get("keyword") or [""])[0],
                    quality_status=(qs.get("quality_status") or [""])[0],
                    data_source=(qs.get("data_source") or [""])[0],
                    limit=int((qs.get("limit") or ["50"])[0] or 50),
                    offset=int((qs.get("offset") or ["0"])[0] or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/enterprise-year-roster/consistency":
            qs = parse_qs(parsed.query or "")
            repair_raw = (qs.get("repair") or ["false"])[0]
            repair = str(repair_raw).strip().lower() in ("1", "true", "yes", "on")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_api import api_enterprise_year_roster_consistency

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_consistency(
                    conn,
                    stat_year=(qs.get("stat_year") or [None])[0],
                    repair=repair,
                )
                self._send(200 if payload.get("ok") else 409, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/task-chain/status":
            qs = parse_qs(parsed.query or "")
            run_id = (qs.get("run_id") or [""])[0].strip()
            try:
                from src.local_api.dim_task_chain import get_dim_task_chain_status

                payload = get_dim_task_chain_status(run_id)
                self._send(200 if payload.get("ok") else 404, payload, cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
            return

        if path == "/api/dim/task-chain/runs":
            qs = parse_qs(parsed.query or "")
            raw_limit = (qs.get("limit") or ["20"])[0].strip()
            try:
                limit = int(raw_limit)
            except (TypeError, ValueError):
                limit = 20
            try:
                from src.local_api.dim_task_chain import list_dim_task_chain_runs

                payload = list_dim_task_chain_runs(limit=limit)
                self._send(200, payload, cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc)}}, cors=True)
            return

        if path == "/api/audited-enterprise/registry/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import ensure_audited_enterprise_registry_table
                from src.local_api.audited_enterprise_dims import api_registry_meta

                conn = get_conn()
                ensure_audited_enterprise_registry_table(conn)
                payload = api_registry_meta(conn)
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取台账年度元数据失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/audited-enterprise/registry":
            qs = parse_qs(parsed.query or "")
            snapshot_year = (qs.get("snapshot_year", [""])[0] or "").strip() or None
            state_investor = (qs.get("state_investor", [""])[0] or "").strip()
            enterprise = (qs.get("enterprise", [""])[0] or "").strip()
            try:
                limit = int((qs.get("limit", ["50"])[0] or "50").strip())
            except (TypeError, ValueError):
                limit = 50
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip())
            except (TypeError, ValueError):
                offset = 0
            include_years = (qs.get("include_years", ["1"])[0] or "1").strip().lower() not in (
                "0",
                "false",
                "no",
            )
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import ensure_audited_enterprise_registry_table
                from src.local_api.audited_enterprise_dims import api_registry_list

                conn = get_conn()
                ensure_audited_enterprise_registry_table(conn)
                payload = api_registry_list(
                    conn,
                    snapshot_year=snapshot_year,
                    state_investor_kw=state_investor,
                    enterprise_kw=enterprise,
                    limit=limit,
                    offset=offset,
                    include_years=include_years,
                )
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取管理与产权层级信息失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/audited-enterprise/contribution":
            qs = parse_qs(parsed.query or "")
            snapshot_year = (qs.get("snapshot_year", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_contribution_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_contribution_list(conn, snapshot_year=snapshot_year, keyword=keyword)
                self._send(200, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取出资与股权比例信息失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/audited-enterprise/invoice-link":
            qs = parse_qs(parsed.query or "")
            snapshot_year = (qs.get("snapshot_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_invoice_link import api_audited_enterprise_invoice_link

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audited_enterprise_invoice_link(conn, snapshot_year=snapshot_year)
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取企业→票映射失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/audited-enterprise/invoice-to-enterprise":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            min_raw = (qs.get("min_invoice_count", [""])[0] or "").strip()
            min_invoice_count: int | None = None
            if min_raw.isdigit():
                min_invoice_count = int(min_raw)
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_invoice_to_enterprise import (
                    api_audited_enterprise_invoice_to_enterprise,
                )

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audited_enterprise_invoice_to_enterprise(
                    conn,
                    stat_year=stat_year,
                    min_invoice_count=min_invoice_count,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取票→企业清单失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/caliber-versions":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_caliber_version_api import api_dim_caliber_versions_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dim_caliber_versions_list(conn)
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                )
            return

        if path == "/api/dim/audited-enterprise/relation-tree":
            qs = parse_qs(parsed.query or "")
            snapshot_year = (qs.get("snapshot_year", [""])[0] or "").strip() or None
            mode = (qs.get("mode", ["management"])[0] or "management").strip()
            state_investor = (qs.get("state_investor", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import ensure_audited_enterprise_registry_table, init_all_tables
                from src.local_api.audited_enterprise_relation_api import api_audited_enterprise_relation_tree

                conn = get_conn()
                init_all_tables(conn)
                ensure_audited_enterprise_registry_table(conn)
                payload = api_audited_enterprise_relation_tree(
                    conn,
                    snapshot_year=snapshot_year,
                    mode=mode,
                    state_investor=state_investor,
                    keyword=keyword,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取被审主体关系树失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/audited-enterprise/relation-rows":
            qs = parse_qs(parsed.query or "")
            snapshot_year = (qs.get("snapshot_year", [""])[0] or "").strip() or None
            state_investor = (qs.get("state_investor", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            relation_type = (qs.get("relation_type", [""])[0] or "").strip() or None
            match_status = (qs.get("match_status", [""])[0] or "").strip() or None
            in_analysis_pool_raw = (qs.get("in_analysis_pool", [""])[0] or "").strip().lower()
            in_analysis_pool = in_analysis_pool_raw in {"1", "true", "yes"}
            page_raw = (qs.get("page", ["1"])[0] or "1").strip()
            page_size_raw = (qs.get("page_size", ["50"])[0] or "50").strip()
            sort = (qs.get("sort", [""])[0] or "").strip() or None
            try:
                page = int(page_raw)
            except ValueError:
                page = 1
            try:
                page_size = int(page_size_raw)
            except ValueError:
                page_size = 50
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import ensure_audited_enterprise_registry_table, init_all_tables
                from src.local_api.audited_enterprise_relation_api import api_audited_enterprise_relation_rows

                conn = get_conn()
                init_all_tables(conn)
                ensure_audited_enterprise_registry_table(conn)
                payload = api_audited_enterprise_relation_rows(
                    conn,
                    snapshot_year=snapshot_year,
                    state_investor=state_investor,
                    keyword=keyword,
                    relation_type=relation_type,
                    match_status=match_status,
                    in_analysis_pool=in_analysis_pool if in_analysis_pool_raw else None,
                    page=page,
                    page_size=page_size,
                    sort=sort,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取被审主体关系清单失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/org-sys/list":
            qs = parse_qs(parsed.query or "")
            active_only_raw = (qs.get("active_only", ["false"])[0] or "false").strip().lower()
            active_only = active_only_raw in ("1", "true", "yes")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_sys_api import api_org_sys_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_sys_list(conn, active_only=active_only)
                self._send(200 if payload.get("ok") else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/org-sys/export":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_sys_api import api_org_sys_export

                conn = get_conn()
                init_all_tables(conn)
                status, payload, ctype, fname = api_org_sys_export(conn)
                if isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "监管体系清单.xlsx")
                else:
                    self._send(status if status >= 400 else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/org-hier/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_meta

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_meta(conn)
                self._send(200 if payload.get("ok") else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/org-hier/template-download":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_template_download

                conn = get_conn()
                init_all_tables(conn)
                status, payload, ctype, fname = api_org_hier_template_download(conn)
                if isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "组织维度导入模板.xlsx")
                else:
                    self._send(status if status >= 400 else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/org-hier/tree":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip()
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_tree

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_tree(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    keyword=keyword,
                )
                self._send(200 if payload.get("ok") else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/org-hier/rows":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            diff_only_raw = (qs.get("diff_only", ["false"])[0] or "false").strip().lower()
            diff_only = diff_only_raw in ("1", "true", "yes")
            page_raw = (qs.get("page", ["1"])[0] or "1").strip()
            page_size_raw = (qs.get("page_size", ["50"])[0] or "50").strip()
            sort = (qs.get("sort", [""])[0] or "").strip() or None
            try:
                page = int(page_raw)
            except ValueError:
                page = 1
            try:
                page_size = int(page_size_raw)
            except ValueError:
                page_size = 50
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_rows

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_rows(
                    conn,
                    stat_year=stat_year,
                    keyword=keyword,
                    diff_only=diff_only,
                    page=page,
                    page_size=page_size,
                    sort=sort,
                )
                self._send(200 if payload.get("ok") else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/org-hier/diff-summary":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_diff_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_diff_summary(conn, stat_year=stat_year)
                self._send(200 if payload.get("ok") else 500, payload, cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim/level1-enterprise-year/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_meta

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_meta(conn)
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取年度一级企业元数据失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/level1-enterprise-year/list":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip()
            active_only = (qs.get("active_only", ["0"])[0] or "").strip().lower() in ("1", "true", "yes")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_list(
                    conn, stat_year=stat_year, keyword=keyword, active_only=active_only
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取年度一级企业名单失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/level1-enterprise-year/candidates":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_candidates

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_candidates(conn, stat_year=stat_year)
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取一级企业候选失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/level1-enterprise-year/members":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            level1_enterprise_id = (qs.get("level1_enterprise_id", [""])[0] or "").strip()
            keyword = (qs.get("keyword", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_members

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_members(
                    conn,
                    stat_year=stat_year,
                    level1_enterprise_id=level1_enterprise_id,
                    keyword=keyword,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取一级企业下属成员失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/invoice-coverage/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_coverage_api import api_invoice_coverage_meta

                conn = get_conn()
                init_all_tables(conn)
                payload = api_invoice_coverage_meta(conn)
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取发票报送覆盖元数据失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/invoice-coverage/soe-options":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_coverage_api import api_invoice_coverage_soe_options

                conn = get_conn()
                init_all_tables(conn)
                payload = api_invoice_coverage_soe_options(conn, stat_year=stat_year)
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"读取国家出资企业锚点失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/invoice-coverage/summary":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            soe_anchor_id = (qs.get("soe_anchor_id", [""])[0] or "").strip()
            soe_anchor_kw = (qs.get("soe_anchor_kw", [""])[0] or "").strip()
            level1_group_kw = (qs.get("level1_group_kw", [""])[0] or "").strip()
            enterprise_kw = (qs.get("enterprise_kw", [""])[0] or "").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_coverage_api import api_invoice_coverage_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_invoice_coverage_summary(
                    conn,
                    stat_year=stat_year,
                    soe_anchor_id=soe_anchor_id,
                    soe_anchor_kw=soe_anchor_kw,
                    level1_group_kw=level1_group_kw,
                    enterprise_kw=enterprise_kw,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"汇总发票报送覆盖失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/invoice-coverage/mapping-status":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            enterprise_kw = (qs.get("enterprise_kw", [""])[0] or "").strip()
            match_status = (qs.get("match_status", [""])[0] or "").strip() or "pending"
            lim_raw = (qs.get("limit", [""])[0] or "").strip()
            try:
                lim = int(lim_raw) if lim_raw.isdigit() else 2000
            except Exception:
                lim = 2000
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_coverage_api import api_invoice_coverage_mapping_status

                conn = get_conn()
                init_all_tables(conn)
                payload = api_invoice_coverage_mapping_status(
                    conn,
                    stat_year=stat_year,
                    enterprise_kw=enterprise_kw,
                    match_status=match_status,
                    limit=lim,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"查询票面映射质检失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/invoice-coverage/members":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            list_view = (qs.get("list_view", [""])[0] or "").strip() or "unreported"
            soe_anchor_id = (qs.get("soe_anchor_id", [""])[0] or "").strip()
            soe_anchor_kw = (qs.get("soe_anchor_kw", [""])[0] or "").strip()
            level1_group_kw = (qs.get("level1_group_kw", [""])[0] or "").strip()
            enterprise_kw = (qs.get("enterprise_kw", [""])[0] or "").strip()
            lim_raw = (qs.get("limit", [""])[0] or "").strip()
            try:
                lim = int(lim_raw) if lim_raw.isdigit() else 2000
            except Exception:
                lim = 2000
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_coverage_api import api_invoice_coverage_members

                conn = get_conn()
                init_all_tables(conn)
                payload = api_invoice_coverage_members(
                    conn,
                    stat_year=stat_year,
                    list_view=list_view,
                    soe_anchor_id=soe_anchor_id,
                    soe_anchor_kw=soe_anchor_kw,
                    level1_group_kw=level1_group_kw,
                    enterprise_kw=enterprise_kw,
                    limit=lim,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"查询发票报送覆盖成员失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dws/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_meta

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_dws_meta(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/entity-options":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_entity_options

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_dws_entity_options(conn, stat_year=stat_year))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/analysis-subject/meta":
            qs = parse_qs(parsed.query or "")
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import (
                    _parse_min_invoice_count,
                    api_analysis_subject_meta,
                )

                conn = get_conn()
                init_all_tables(conn)
                self._send(
                    200,
                    api_analysis_subject_meta(
                        conn,
                        min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    ),
                )
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/analysis-subject/options":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            source = (qs.get("source", [""])[0] or "").strip().lower()
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import (
                    _parse_min_invoice_count,
                    api_analysis_scope_entity_options,
                    api_analysis_subject_options,
                )

                conn = get_conn()
                init_all_tables(conn)
                if source in ("org_union", "union", "scope"):
                    payload = api_analysis_scope_entity_options(conn, stat_year=stat_year)
                else:
                    payload = api_analysis_subject_options(
                        conn,
                        stat_year=stat_year,
                        require_buyer=require_buyer,
                        require_both_roles=require_both_roles,
                        min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/analysis-subject/org-members":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            member_source = (qs.get("member_source", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import (
                    _parse_min_invoice_count,
                    api_analysis_org_scope_members,
                )

                conn = get_conn()
                init_all_tables(conn)
                payload = api_analysis_org_scope_members(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    member_source=member_source,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/counterparty/cr-matrix":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            role = (qs.get("role", ["supplier"])[0] or "supplier").strip() or "supplier"
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except ValueError:
                limit = 500
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except ValueError:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.dws_dashboard_api import api_dws_counterparty_cr_matrix

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_counterparty_cr_matrix(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    role=role,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    keyword=keyword,
                    limit=limit,
                    offset=offset,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/counterparty/churn-matrix":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            role = (qs.get("role", ["supplier"])[0] or "supplier").strip() or "supplier"
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            member_source = (qs.get("member_source", [""])[0] or "").strip() or None
            excluded_entity_ids = (qs.get("excluded_entity_ids", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except ValueError:
                limit = 500
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except ValueError:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.dws_dashboard_api import api_dws_counterparty_churn_matrix

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_counterparty_churn_matrix(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    role=role,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    member_source=member_source,
                    excluded_entity_ids=excluded_entity_ids,
                    keyword=keyword,
                    limit=limit,
                    offset=offset,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/counterparty/top-matrix":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            role = (qs.get("role", ["supplier"])[0] or "supplier").strip() or "supplier"
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except ValueError:
                limit = 500
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except ValueError:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.dws_dashboard_api import api_dws_counterparty_top_matrix

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_counterparty_top_matrix(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    role=role,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    keyword=keyword,
                    limit=limit,
                    offset=offset,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/summary":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_summary(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/trend":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_type = (qs.get("role_type", [""])[0] or "").strip() or "all"
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_trend(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_type=role_type,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/tax":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_type = (qs.get("role_type", ["进项"])[0] or "进项").strip()
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_tax

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_tax(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_type=role_type,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/tax-monthly":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_type = (qs.get("role_type", ["进项"])[0] or "进项").strip()
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_tax_monthly

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_tax_monthly(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_type=role_type,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/trade/relationships":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_filter = (qs.get("role_filter", ["all"])[0] or "all").strip()
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            counterparty_id = (qs.get("counterparty_id", [""])[0] or "").strip() or None
            party_a_tax = (qs.get("party_a_tax", [""])[0] or "").strip() or None
            party_b_tax = (qs.get("party_b_tax", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["100"])[0] or "100").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_trade_relationships

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_trade_relationships(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_filter=role_filter,
                    keyword=keyword,
                    counterparty_id=counterparty_id,
                    party_a_tax=party_a_tax,
                    party_b_tax=party_b_tax,
                    limit=int(limit or 100),
                    offset=int(offset or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/tax/in-out-deviation":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_tax_in_out_deviation

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_tax_in_out_deviation(
                    conn, stat_year=stat_year, entity_id=entity_id
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/tax/risk-exposure":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_tax_risk_exposure

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_tax_risk_exposure(conn, stat_year=stat_year, entity_id=entity_id)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/trade/graph":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            min_amount_raw = (qs.get("min_amount", [""])[0] or "").strip()
            min_amount = float(min_amount_raw) if min_amount_raw else None
            counterparty_id = (qs.get("counterparty_id", [""])[0] or "").strip() or None
            party_a_tax = (qs.get("party_a_tax", [""])[0] or "").strip() or None
            party_b_tax = (qs.get("party_b_tax", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_trade_graph

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_trade_graph(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    min_amount=min_amount,
                    counterparty_id=counterparty_id,
                    party_a_tax=party_a_tax,
                    party_b_tax=party_b_tax,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices_meta

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_export_invoices_meta(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices/count":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            fpzt = (qs.get("fpzt", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices_count

                conn = get_conn()
                init_all_tables(conn)
                payload = api_export_invoices_count(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    seller_tax_no=seller_tax_no,
                    date_from=date_from,
                    date_to=date_to,
                    fpzt=fpzt,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/settings/license":
            try:
                from src.local_api.license_gate import api_settings_license

                self._send(200, api_settings_license())
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            fpzt = (qs.get("fpzt", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            fmt = (qs.get("format", ["csv"])[0] or "csv").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices

                conn = get_conn()
                init_all_tables(conn)
                status, body, ctype, fname = api_export_invoices(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    seller_tax_no=seller_tax_no,
                    date_from=date_from,
                    date_to=date_to,
                    fpzt=fpzt,
                    fmt=fmt,
                )
                if ctype and isinstance(body, bytes):
                    self._send_file(status, body, content_type=ctype, filename=fname or "export.csv")
                else:
                    err = body if isinstance(body, dict) else {"ok": False, "error": {"message": "导出失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/supplier/cr":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_supplier_cr

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_supplier_cr(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/supplier/top":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            quarter = (qs.get("quarter", [""])[0] or "").strip() or None
            lim_raw = (qs.get("limit", [""])[0] or "").strip()
            try:
                lim = int(lim_raw) if lim_raw.isdigit() else 20
            except Exception:
                lim = 20
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_supplier_top

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_supplier_top(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    limit=lim,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                    quarter=quarter,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/supplier/churn":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            kind = (qs.get("kind", ["new"])[0] or "new").strip()
            top_only = (qs.get("top_only", ["0"])[0] or "0").strip() in ("1", "true", "yes")
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["50"])[0] or "50").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_supplier_churn

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_supplier_churn(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    kind=kind,
                    top_only=top_only,
                    keyword=keyword,
                    limit=int(limit or 50),
                    offset=int(offset or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/entity-profile":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.entity_profile_api import api_dws_entity_profile

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_entity_profile(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/invoice-detail/list":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["50"])[0] or "50").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_invoice_detail_api import api_dws_invoice_detail_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_invoice_detail_list(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                    seller_tax_no=seller_tax_no,
                    goods_name=goods_name,
                    slv_num=slv_num,
                    limit=int(limit) if limit.isdigit() else 50,
                    offset=int(offset) if offset.isdigit() else 0,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/invoice-detail/export":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_invoice_detail_api import api_dws_invoice_detail_export

                conn = get_conn()
                init_all_tables(conn)
                status, body, ctype, fname = api_dws_invoice_detail_export(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                    seller_tax_no=seller_tax_no,
                    goods_name=goods_name,
                    slv_num=slv_num,
                )
                if isinstance(body, dict):
                    self._send(status, body)
                else:
                    self._send_file(status, body, content_type=ctype, filename=fname or "invoice_detail.csv")
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_meta

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_audit_meta(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/pending-count":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_pending_count

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_audit_pending_count(conn, stat_year=stat_year))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/flags/list":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            risk_level = (qs.get("risk_level", [""])[0] or "").strip() or None
            rule_id = (qs.get("rule_id", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            track_status = (qs.get("track_status", [""])[0] or "").strip() or None
            batch_id = (qs.get("batch_id", [""])[0] or "").strip() or None
            flag_id = (qs.get("flag_id", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["100"])[0] or "100").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_flags_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audit_flags_list(
                    conn,
                    stat_year=stat_year,
                    risk_level=risk_level,
                    rule_id=rule_id,
                    keyword=keyword,
                    track_status=track_status,
                    batch_id=batch_id,
                    flag_id=flag_id,
                    limit=int(limit or 100),
                    offset=int(offset or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/rules/config":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_rules_config_get

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_audit_rules_config_get(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/related/circular":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            risk_level = (qs.get("risk_level", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["100"])[0] or "100").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_related_circular

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audit_related_circular(
                    conn,
                    stat_year=stat_year,
                    risk_level=risk_level,
                    keyword=keyword,
                    limit=int(limit or 100),
                    offset=int(offset or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/related/shell":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["100"])[0] or "100").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_related_shell

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audit_related_shell(
                    conn,
                    stat_year=stat_year,
                    keyword=keyword,
                    limit=int(limit or 100),
                    offset=int(offset or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/compare/meta":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.compare_dashboard_api import api_compare_meta
                from src.local_api.license_gate import license_gate_http_status

                conn = get_conn()
                init_all_tables(conn)
                payload = api_compare_meta(conn, stat_year=stat_year)
                self._send(license_gate_http_status(payload), payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/compare/rank/list":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            risk_level = (qs.get("risk_level", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            soe_anchor_id = (qs.get("soe_anchor_id", [""])[0] or "").strip() or None
            soe_anchor_kw = (qs.get("soe_anchor_kw", [""])[0] or "").strip() or None
            level1_group_kw = (qs.get("level1_group_kw", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["200"])[0] or "200").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.compare_dashboard_api import api_compare_rank_list
                from src.local_api.license_gate import license_gate_http_status

                conn = get_conn()
                init_all_tables(conn)
                payload = api_compare_rank_list(
                    conn,
                    stat_year=stat_year,
                    risk_level=risk_level,
                    keyword=keyword,
                    soe_anchor_id=soe_anchor_id,
                    soe_anchor_kw=soe_anchor_kw,
                    level1_group_kw=level1_group_kw,
                    limit=int(limit or 200),
                    offset=int(offset or 0),
                )
                self._send(license_gate_http_status(payload), payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/compare/charts/series":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            metric = (qs.get("metric", ["amount"])[0] or "amount").strip()
            limit = (qs.get("limit", ["15"])[0] or "15").strip()
            soe_anchor_id = (qs.get("soe_anchor_id", [""])[0] or "").strip() or None
            soe_anchor_kw = (qs.get("soe_anchor_kw", [""])[0] or "").strip() or None
            level1_group_kw = (qs.get("level1_group_kw", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.compare_dashboard_api import api_compare_charts_series
                from src.local_api.license_gate import license_gate_http_status

                conn = get_conn()
                init_all_tables(conn)
                payload = api_compare_charts_series(
                    conn,
                    stat_year=stat_year,
                    metric=metric,
                    limit=int(limit or 15),
                    soe_anchor_id=soe_anchor_id,
                    soe_anchor_kw=soe_anchor_kw,
                    level1_group_kw=level1_group_kw,
                )
                self._send(license_gate_http_status(payload), payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/templates/list":
            try:
                from src.local_api.report_template_api import api_report_templates_list

                self._send(200, api_report_templates_list())
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.report_api import api_report_meta

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_report_meta(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/archive":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            template_keyword = (qs.get("template", [""])[0] or "").strip() or None
            try:
                from src.local_api.report_api import api_report_archive_list

                self._send(
                    200,
                    api_report_archive_list(stat_year=stat_year, template_keyword=template_keyword),
                )
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/download":
            qs = parse_qs(parsed.query or "")
            file_name = (qs.get("file", [""])[0] or "").strip()
            try:
                from src.local_api.report_api import api_report_download_file

                status, body, ctype, dl_name = api_report_download_file(file_name)
                if ctype and isinstance(body, bytes):
                    self._send_file(status, body, content_type=ctype, filename=dl_name or "report.docx")
                else:
                    err = body if isinstance(body, dict) else {"ok": False, "error": {"message": "下载失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/delivery-package/estimate":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year") or [""])[0].strip()
            entity_id = (qs.get("entity_id") or qs.get("subject_id") or [""])[0].strip() or None
            include_invoices = (qs.get("include_invoices") or ["1"])[0].strip().lower() not in ("0", "false", "no")
            include_finance = (qs.get("include_finance") or [""])[0].strip()
            include_data_quality = (qs.get("include_data_quality") or [""])[0].strip()
            chapters_raw = (qs.get("chapters") or [""])[0].strip()
            chapters: dict[str, bool] | None = None
            if chapters_raw:
                try:
                    parsed_ch = json.loads(chapters_raw)
                    if isinstance(parsed_ch, dict):
                        chapters = {str(k): bool(v) for k, v in parsed_ch.items()}
                except Exception:
                    chapters = None
            body: dict[str, Any] = {
                "stat_year": stat_year,
                "entity_id": entity_id,
                "include_invoices": include_invoices,
            }
            if chapters is not None:
                body["chapters"] = chapters
            else:
                if include_finance:
                    body["include_finance"] = include_finance.lower() not in ("0", "false", "no")
                if include_data_quality:
                    body["include_data_quality"] = include_data_quality.lower() not in ("0", "false", "no")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.report_api import estimate_delivery_package

                conn = get_conn()
                init_all_tables(conn)
                payload = estimate_delivery_package(
                    conn,
                    body,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/delivery-packages":
            qs = parse_qs(parsed.query or "")
            raw_limit = (qs.get("limit") or ["20"])[0].strip()
            try:
                limit = int(raw_limit)
            except (TypeError, ValueError):
                limit = 20
            try:
                from src.local_api.report_api import list_delivery_packages

                self._send(200, list_delivery_packages(limit=limit))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/delivery-package/status":
            qs = parse_qs(parsed.query or "")
            run_id = (qs.get("run_id") or qs.get("package_id") or [""])[0].strip()
            try:
                from src.local_api.report_api import get_delivery_package_status

                payload = get_delivery_package_status(run_id)
                self._send(200 if payload.get("ok") else 404, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/delivery-package/download":
            qs = parse_qs(parsed.query or "")
            package_id = (qs.get("package_id") or qs.get("run_id") or [""])[0].strip()
            try:
                from src.local_api.report_api import api_report_delivery_package_download

                status, body, ctype, dl_name = api_report_delivery_package_download(package_id)
                if ctype and isinstance(body, bytes):
                    self._send_file(status, body, content_type=ctype, filename=dl_name or "delivery_package.zip")
                else:
                    err = body if isinstance(body, dict) else {"ok": False, "error": {"message": "下载失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/finance/ledger/batches":
            qs = parse_qs(parsed.query or "")
            try:
                limit = int((qs.get("limit", ["50"])[0] or "50").strip() or "50")
            except Exception:
                limit = 50
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.finance_reconcile_api import api_ledger_batches

                conn = get_conn()
                payload = api_ledger_batches(conn, limit=limit)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "batches": [],
                    "error": {
                        "message": f"无法读取账表批次：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/finance/reconcile/overview":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_year_raw = (qs.get("stat_year", [""])[0] or "").strip()
            stat_year = int(stat_year_raw) if stat_year_raw.isdigit() else None
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.finance_reconcile_api import api_reconcile_overview

                conn = get_conn()
                payload = api_reconcile_overview(
                    conn,
                    batch_id=batch_id,
                    stat_year=stat_year,
                    entity_id=entity_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取核对概览：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/finance/reconcile/diff-summary":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_year_raw = (qs.get("stat_year", [""])[0] or "").strip()
            stat_year = int(stat_year_raw) if stat_year_raw.isdigit() else None
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.finance_reconcile_api import api_reconcile_diff_summary

                conn = get_conn()
                payload = api_reconcile_diff_summary(
                    conn,
                    batch_id=batch_id,
                    stat_year=stat_year,
                    entity_id=entity_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"无法读取差异汇总：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/finance/reconcile/details":
            qs = parse_qs(parsed.query or "")
            batch_id = (qs.get("batch_id", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            diff_type = (qs.get("diff_type", [""])[0] or "").strip() or None
            stat_year_raw = (qs.get("stat_year", [""])[0] or "").strip()
            stat_year = int(stat_year_raw) if stat_year_raw.isdigit() else None
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except Exception:
                offset = 0
            try:
                limit = int((qs.get("limit", ["50"])[0] or "50").strip() or "50")
            except Exception:
                limit = 50
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.finance_reconcile_api import api_reconcile_details

                conn = get_conn()
                payload = api_reconcile_details(
                    conn,
                    batch_id=batch_id,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    diff_type=diff_type,
                    offset=offset,
                    limit=limit,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "total": 0,
                    "rows": [],
                    "error": {
                        "message": f"无法读取核对明细：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/settings/thresholds":
            try:
                from src.local_api.settings_api import api_settings_thresholds_get

                self._send(200, api_settings_thresholds_get(), cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/dim-dict":
            try:
                from src.local_api.dim_dict_api import api_dim_dict_get

                self._send(200, api_dim_dict_get(), cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/settings/instance":
            try:
                from src.local_api.settings_api import api_settings_instance_get

                self._send(200, api_settings_instance_get(), cors=True)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                    cors=True,
                )
            return

        if path == "/api/auth/me":
            try:
                from src.local_api.users_api import api_auth_me

                payload = api_auth_me(self.headers)
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 401, payload, cors=True)
            return

        if path == "/api/users":
            try:
                from src.local_api.users_api import api_users_list

                self._send(200, api_users_list(), cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, cors=True)
            return

        if path == "/api/users/roles":
            try:
                from src.local_api.users_api import api_users_roles

                self._send(200, api_users_roles(), cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, cors=True)
            return

        if path == "/api/audit-log":
            qs = parse_qs(parsed.query or "")
            lim_raw = (qs.get("limit", ["200"])[0] or "200").strip()
            action = (qs.get("action", [""])[0] or "").strip() or None
            username = (qs.get("username", [""])[0] or "").strip() or None
            try:
                limit = int(lim_raw) if lim_raw.isdigit() else 200
            except Exception:
                limit = 200
            try:
                from src.local_api.users_api import api_audit_log_list

                self._send(200, api_audit_log_list(limit=limit, action=action, username=username), cors=True)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, cors=True)
            return

        from src.local_api.dws_dplus_routes import DWS_DPLUS_GET_PATHS, dispatch_dws_dplus_get

        if path in DWS_DPLUS_GET_PATHS:
            qs = parse_qs(parsed.query or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables

                conn = get_conn()
                init_all_tables(conn)
                result = dispatch_dws_dplus_get(path, qs, conn)
                if result:
                    status, payload = result
                    self._send(status, payload)
                    return
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
                return

        if path == "/api/dws/red-offset/export":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            kind = (qs.get("kind", ["all"])[0] or "all").strip() or "all"
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.red_offset_api import export_red_offset_csv_bytes

                conn = get_conn()
                init_all_tables(conn)
                body, exported, total = export_red_offset_csv_bytes(
                    conn, stat_year=stat_year, entity_id=entity_id, kind=kind
                )
                fname = f"red_offset_{stat_year or 'export'}.csv"
                self._send_file(200, body, content_type="text/csv; charset=utf-8", filename=fname)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        try:
            from src.local_api.static_ui import try_serve_static

            static = try_serve_static(path)
            if static is not None:
                status, ctype, data = static
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        except Exception:
            pass

        self._send(404, {"ok": False, "error": {"message": "Not Found"}}, cors=True)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path.startswith("/api/") and not self._gate_api(path, "POST"):
            return
        if path == "/api/dim-tax-code/import":
            ctype = (self.headers.get("Content-Type") or "").lower()
            data_version = ""
            source_path = ""
            strategy = "full_rebuild"
            upload_filename: str | None = None
            file_bytes: bytes | None = None
            if "multipart/form-data" in ctype:
                fs, err = _parse_multipart_fields(self, for_batch=False)
                if err:
                    self._send(400, err)
                    return
                assert fs is not None
                data_version = str(_multipart_first_field(fs, "data_version") or "").strip()
                source_path = str(_multipart_first_field(fs, "source_path") or "").strip()
                strategy = str(_multipart_first_field(fs, "strategy") or "").strip() or "full_rebuild"
                for item in getattr(fs, "list", []) or []:
                    if getattr(item, "name", None) == "file" and getattr(item, "filename", None):
                        upload_filename = str(getattr(item, "filename"))
                        rawv = getattr(item, "value", b"")
                        file_bytes = rawv if isinstance(rawv, bytes) else bytes(rawv)
                        break
            else:
                body = self._read_json()
                data_version = str(body.get("data_version") or "").strip()
                source_path = str(body.get("source_path") or "").strip()
                strategy = str(body.get("strategy") or "").strip() or "full_rebuild"
            if not data_version:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "data_version 不能为空"}},
                )
                return
            if not source_path and not file_bytes:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须填写 source_path 或上传文件（multipart 字段名 file）"}},
                )
                return
            try:
                from src.local_api.dim_tax_code_import import run_dim_tax_code_import

                payload = run_dim_tax_code_import(
                    data_version=data_version,
                    source_path=source_path,
                    strategy=strategy,
                    file_bytes=file_bytes,
                    upload_filename=upload_filename,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "implemented": True,
                    "message": f"dim_tax_code 导入异常：{type(exc).__name__}: {exc}",
                    "error": {"message": str(exc)},
                }
            self._send(200, payload)
            return

        if path == "/api/finance/ledger/import":
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "multipart/form-data" not in ctype:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "Content-Type 须为 multipart/form-data"}},
                    cors=True,
                )
                return
            fs, err = _parse_multipart_fields(self, for_batch=False)
            if err:
                self._send(400, err, cors=True)
                return
            assert fs is not None
            batch_name = str(_multipart_first_field(fs, "batch_name") or "").strip() or None
            stat_year_raw = str(_multipart_first_field(fs, "stat_year") or "").strip()
            default_stat_year = int(stat_year_raw) if stat_year_raw.isdigit() else None
            file_bytes, upload_name = _multipart_first_uploaded_file(fs)
            if not file_bytes:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须上传文件（multipart 字段名 file 或 files）"}},
                    cors=True,
                )
                return
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.finance_reconcile_api import api_ledger_import

                conn = get_conn()
                payload = api_ledger_import(
                    conn,
                    file_bytes=file_bytes,
                    upload_filename=upload_name,
                    batch_name=batch_name,
                    default_stat_year=default_stat_year,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "message": f"账表导入异常：{type(exc).__name__}: {exc}",
                    "error": {
                        "message": str(exc),
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/finance/reconcile/sync-flags":
            body = self._read_json()
            batch_id = str(body.get("batch_id") or "").strip() or None
            entity_id = str(body.get("entity_id") or "").strip() or None
            stat_year_raw = str(body.get("stat_year") or "").strip()
            stat_year = int(stat_year_raw) if stat_year_raw.isdigit() else None
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.finance_reconcile_api import api_reconcile_sync_flags

                conn = get_conn()
                payload = api_reconcile_sync_flags(
                    conn,
                    batch_id=batch_id,
                    stat_year=stat_year,
                    entity_id=entity_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "inserted": 0,
                    "skipped_confirmed": 0,
                    "by_rule": {},
                    "error": {
                        "message": f"同步财务核对疑点失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/quality/semantic/sync-flags":
            body = self._read_json()
            batch_id = str(body.get("batch_id") or "").strip() or None
            stat_year_raw = str(body.get("stat_year") or "").strip()
            stat_year = int(stat_year_raw) if stat_year_raw.isdigit() else None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.data_quality import api_semantic_quality_sync_flags

                conn = get_conn()
                init_all_tables(conn)
                payload = api_semantic_quality_sync_flags(
                    conn,
                    batch_id=batch_id,
                    stat_year=stat_year,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "inserted": 0,
                    "updated": 0,
                    "skipped_confirmed": 0,
                    "by_rule": {},
                    "error": {
                        "message": f"同步语义质量疑点失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/dim/caliber-versions/create-draft":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_caliber_version_api import api_dim_caliber_version_create_draft

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dim_caliber_version_create_draft(conn, body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                )
            return

        if path == "/api/dim/caliber-versions/publish":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_caliber_version_api import api_dim_caliber_version_publish

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dim_caliber_version_publish(conn, body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                )
            return

        if path == "/api/dim/caliber-versions/rollback":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_caliber_version_api import api_dim_caliber_version_rollback

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dim_caliber_version_rollback(conn, body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                )
            return

        if path == "/api/dim/caliber-versions/archive":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_caliber_version_api import api_dim_caliber_version_archive

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dim_caliber_version_archive(conn, body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                )
            return

        if path == "/api/dim/caliber-versions/save-draft":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_caliber_version_api import api_dim_caliber_version_save_draft

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dim_caliber_version_save_draft(conn, body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(
                    500,
                    {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}},
                )
            return

        if path == "/api/dim/tax-code/analysis/sync-flags":
            body = self._read_json()
            stat_year_raw = str(body.get("stat_year") or "").strip()
            if not stat_year_raw.isdigit():
                self._send(
                    400,
                    {"ok": False, "error": {"message": "stat_year 为必填整数参数"}},
                    cors=True,
                )
                return
            entity_id = str(body.get("entity_id") or "").strip() or None
            try:
                min_line_count = int(body.get("min_line_count") or 5)
            except Exception:
                min_line_count = 5
            try:
                min_high_risk_amount = float(body.get("min_high_risk_amount") or 10000)
            except Exception:
                min_high_risk_amount = 10000.0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.tax_code_analysis_api import api_tax_code_sync_flags

                conn = get_conn()
                init_all_tables(conn)
                payload = api_tax_code_sync_flags(
                    conn,
                    stat_year=int(stat_year_raw),
                    entity_id=entity_id,
                    min_line_count=min_line_count,
                    min_high_risk_amount=min_high_risk_amount,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "inserted": 0,
                    "updated": 0,
                    "skipped_confirmed": 0,
                    "by_rule": {},
                    "error": {
                        "message": f"同步税码分析疑点失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 503, payload, cors=True)
            return

        if path == "/api/dim-tax-code/reapply-risk-rules":
            try:
                from src.local_api.dim_tax_code_import import reapply_dim_tax_code_audit_risk_from_yaml

                payload = reapply_dim_tax_code_audit_risk_from_yaml()
            except Exception as exc:
                payload = {
                    "ok": False,
                    "message": f"重算风险标签失败：{type(exc).__name__}: {exc}",
                    "error": {"message": str(exc)},
                }
            self._send(200, payload)
            return

        if path == "/api/dim-tax-code/risk-rules":
            body = self._read_json()
            yaml_text = str(body.get("yaml_text") or "")
            try:
                saved = _save_dim_tax_risk_rules_yaml_text(yaml_text)
                from src.local_api.dim_tax_code_risk_rules import invalidate_risk_config_cache

                invalidate_risk_config_cache()
                self._send(
                    200,
                    {
                        "ok": True,
                        "message": "敏感类目规则已保存",
                        "source": str(saved),
                    },
                )
            except Exception as exc:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {
                            "message": f"保存敏感类目规则失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-category/rules":
            body = self._read_json()
            try:
                saved = _save_subject_category_rules(body)
                self._send(
                    200,
                    {
                        "ok": True,
                        "message": "主体类别规则已保存",
                        "source": str(saved),
                    },
                )
            except Exception as exc:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {
                            "message": f"保存主体类别规则失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-category/recompute":
            import time

            body = self._read_json()
            with_relations = bool(body.get("with_relations", False))
            run_id = str(body.get("run_id") or "").strip() or None
            snapshot_id = str(body.get("snapshot_id") or "").strip() or None
            overwrite_manual_repairs = bool(body.get("overwrite_manual_repairs", False))
            started_ts = time.time()
            try:
                from src.local_api.dim_async_tasks import start_async_subject_category_recompute, want_async_mode

                if want_async_mode(body, default=True):
                    payload = start_async_subject_category_recompute(
                        with_relations=with_relations,
                        overwrite_manual_repairs=overwrite_manual_repairs,
                        run_id=run_id,
                    )
                    self._send(200 if payload.get("ok") else 500, payload, cors=True)
                    return

                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.subject_category.recompute import recompute_org_subject_categories
                from src.subject_category.recompute import recompute_org_subject_categories_and_relations
                from src.local_api.subject_library_task_run import (
                    TASK_CODE_SUBJECT_RECOMPUTE,
                    TASK_NAME_SUBJECT_RECOMPUTE,
                    record_subject_library_task_run,
                )

                conn = get_conn()
                init_all_tables(conn)
                if with_relations:
                    result = recompute_org_subject_categories_and_relations(
                        conn,
                        run_id=run_id,
                        snapshot_id=snapshot_id,
                        overwrite_manual_repairs=overwrite_manual_repairs,
                    )
                else:
                    result = recompute_org_subject_categories(
                        conn,
                        run_id=run_id,
                        snapshot_id=snapshot_id,
                        overwrite_manual_repairs=overwrite_manual_repairs,
                    )
                cat_block = result.get("category") if isinstance(result.get("category"), dict) else result
                ledger_run_id = str(
                    (cat_block or {}).get("run_id") or result.get("run_id") or run_id or f"recompute_{int(started_ts)}"
                )
                record_subject_library_task_run(
                    run_id=ledger_run_id,
                    task_code=TASK_CODE_SUBJECT_RECOMPUTE,
                    task_name=TASK_NAME_SUBJECT_RECOMPUTE,
                    result=result,
                    rows_affected=int((cat_block or {}).get("matched") or 0),
                    params={
                        "with_relations": with_relations,
                        "overwrite_manual_repairs": overwrite_manual_repairs,
                    },
                    started_at_ts=started_ts,
                )
                skip_note = ""
                cat = result.get("category") if isinstance(result.get("category"), dict) else result
                skipped = int((cat or {}).get("manual_repair_skipped") or 0)
                if skipped > 0 and not overwrite_manual_repairs:
                    skip_note = f"；已跳过 {skipped} 条人工修正主体"
                self._send(
                    200,
                    {
                        "ok": True,
                        "message": "主体分类重算完成" + ("（含关联重建）" if with_relations else "") + skip_note,
                        "with_relations": with_relations,
                        "overwrite_manual_repairs": overwrite_manual_repairs,
                        "result": result,
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"主体分类重算失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/subject-library/import-external":
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "multipart/form-data" not in ctype:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "Content-Type 须为 multipart/form-data"}},
                    cors=True,
                )
                return
            fs, err = _parse_multipart_fields(self, for_batch=False)
            if err:
                self._send(400, err, cors=True)
                return
            assert fs is not None
            snapshot_year = str(_multipart_first_field(fs, "snapshot_year") or "").strip()
            file_bytes, upload_name = _multipart_first_uploaded_file(fs)
            if not file_bytes:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {"message": "须上传文件（multipart 字段名 file 或 files）"},
                    },
                    cors=True,
                )
                return
            outer_exc = False
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library_external_import import api_import_external_subjects_from_file

                conn = get_conn()
                init_all_tables(conn)
                payload = api_import_external_subjects_from_file(
                    conn,
                    file_bytes=file_bytes,
                    filename=upload_name or "upload",
                    snapshot_year=snapshot_year,
                )
            except Exception as exc:
                outer_exc = True
                payload = {
                    "ok": False,
                    "file_blocking": True,
                    "error": {
                        "message": f"外部主体导入异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            if payload.get("ok"):
                self._send(200, payload, cors=True)
                return
            self._send(500 if outer_exc else 400, payload, cors=True)
            return

        if path == "/api/subject-library/repair":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library_repair import api_subject_library_repair_from_request

                conn = get_conn()
                init_all_tables(conn)
                payload = api_subject_library_repair_from_request(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"主体数据修复异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/subject-library/ingest-from-dwd":
            import time

            body = self._read_json()
            overwrite_manual_repairs = bool((body or {}).get("overwrite_manual_repairs", False))
            started_ts = time.time()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.subject_library_dwd_ingest import ingest_dim_subject_master_from_dwd
                from src.local_api.subject_library_task_run import (
                    TASK_CODE_SUBJECT_INGEST,
                    TASK_NAME_SUBJECT_INGEST,
                    record_subject_library_task_run,
                )

                conn = get_conn()
                init_all_tables(conn)
                result = ingest_dim_subject_master_from_dwd(
                    conn,
                    overwrite_manual_repairs=overwrite_manual_repairs,
                )
                record_subject_library_task_run(
                    run_id=str(result.get("run_id") or f"ingest_{int(started_ts)}"),
                    task_code=TASK_CODE_SUBJECT_INGEST,
                    task_name=TASK_NAME_SUBJECT_INGEST,
                    result=result,
                    rows_affected=int(result.get("subjects_upserted") or 0),
                    params={"overwrite_manual_repairs": overwrite_manual_repairs},
                    started_at_ts=started_ts,
                )
                if not result.get("ok"):
                    self._send(
                        400,
                        {
                            "ok": False,
                            "error": {
                                "message": str(result.get("error") or "DWD 归集失败"),
                            },
                            "result": result,
                        },
                    )
                    return
                merged = int(result.get("subjects_merged_name_key_into_tax") or 0)
                merge_note = f"；名称键并入税号键 {merged} 条" if merged > 0 else ""
                preserved = int(result.get("manual_repair_preserved") or 0)
                preserve_note = (
                    f"；已保留 {preserved} 条人工修正主体的类别字段"
                    if preserved > 0 and not overwrite_manual_repairs
                    else ""
                )
                self._send(
                    200,
                    {
                        "ok": True,
                        "message": (
                            f"已从 dwd_inv_header 归集 {result.get('subjects_upserted', 0)} 个主体"
                            f"（扫描 {result.get('header_rows_scanned', 0)} 条发票头）{merge_note}{preserve_note}"
                        ),
                        "overwrite_manual_repairs": overwrite_manual_repairs,
                        "result": result,
                    },
                )
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": f"DWD 归集失败：{type(exc).__name__}: {exc}",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
            return

        if path == "/api/dim/task-chain/run":
            body = self._read_json()
            raw_years = (body or {}).get("stat_years") or (body or {}).get("statYears")
            years: list[int] | None = None
            if isinstance(raw_years, list) and raw_years:
                years = []
                for item in raw_years:
                    try:
                        yi = int(str(item).strip())
                    except (TypeError, ValueError):
                        continue
                    if 1990 <= yi <= 2100:
                        years.append(yi)
                years = sorted(set(years)) if years else None
            try:
                from src.local_api.dim_task_chain import start_dim_task_chain

                payload = start_dim_task_chain(
                    stat_years=years,
                    overwrite_manual_repairs=bool((body or {}).get("overwrite_manual_repairs", False)),
                    with_relations=bool((body or {}).get("with_relations", True)),
                    skip_subject_pipeline=bool((body or {}).get("skip_subject_pipeline", False)),
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": f"启动任务链失败：{type(exc).__name__}: {exc}"},
                }
            self._send(200 if payload.get("ok") else 409, payload, cors=True)
            return

        if path == "/api/dim/task-chain/retry-step":
            body = self._read_json()
            run_id = str((body or {}).get("run_id") or (body or {}).get("runId") or "").strip()
            step_id = str((body or {}).get("step_id") or (body or {}).get("stepId") or "").strip()
            continue_chain = (body or {}).get("continue_chain")
            if continue_chain is None:
                continue_chain = (body or {}).get("continueChain")
            if continue_chain is None:
                continue_chain = True
            continue_chain = bool(continue_chain)
            try:
                from src.local_api.dim_task_chain import retry_dim_task_chain_step

                payload = retry_dim_task_chain_step(
                    run_id=run_id,
                    step_id=step_id,
                    continue_chain=continue_chain,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": f"重试步骤失败：{type(exc).__name__}: {exc}"},
                }
            self._send(200 if payload.get("ok") else 409, payload, cors=True)
            return

        if path == "/api/subject-library/pipeline":
            body = self._read_json()
            overwrite_manual_repairs = bool((body or {}).get("overwrite_manual_repairs", False))
            with_relations = bool((body or {}).get("with_relations", True))
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.license_gate import check_year_quota_for_build, license_gate_http_status

                conn = get_conn()
                denied = check_year_quota_for_build(conn, None)
                if denied:
                    self._send(license_gate_http_status(denied), denied, cors=True)
                    return
                from src.local_api.subject_library_pipeline import start_subject_library_pipeline

                payload = start_subject_library_pipeline(
                    overwrite_manual_repairs=overwrite_manual_repairs,
                    with_relations=with_relations,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": f"启动主体库全流程失败：{type(exc).__name__}: {exc}"},
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return

        if path == "/api/subject-library/rebuild-rename-signals":
            body = self._read_json()

            def _rename_rebuild_want_async(b: object) -> bool:
                if not isinstance(b, dict) or "async" not in b:
                    return True
                v = b.get("async")
                if v is False or v == 0:
                    return False
                if isinstance(v, str) and v.strip().lower() in {"0", "false", "no", "off"}:
                    return False
                return True

            try:
                from src.local_api.subject_library_rename_build import start_subject_rename_signal_rebuild

                payload = start_subject_rename_signal_rebuild(async_mode=_rename_rebuild_want_async(body))
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"启动重建更名信号失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            # 始终 200：异步受理与同步失败均用 JSON.ok 区分（避免 202/400 在部分网关下的兼容问题）
            self._send(200, payload, cors=True)
            return

        if path == "/api/quality/red-invoice-parse":
            body = self._read_json()
            bz = body.get("bz")
            try:
                from src.etl.cleaner import parse_red_bz_debug

                payload = parse_red_bz_debug(None if bz is None else str(bz))
            except Exception as exc:
                payload = {
                    "ok": False,
                    "matched": False,
                    "error": {
                        "message": f"备注解析调试失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload)
            return

        if path == "/api/field-mapping/templates/create":
            body = self._read_json()
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_create

                payload = api_field_mapping_template_create(body if isinstance(body, dict) else {})
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/save":
            body = self._read_json()
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_save

                payload = api_field_mapping_template_save(body if isinstance(body, dict) else {})
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/delete":
            body = self._read_json()
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_delete

                tid = str((body or {}).get("template_id") or "").strip()
                payload = api_field_mapping_template_delete(tid)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/activate":
            body = self._read_json()
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_activate

                payload = api_field_mapping_template_activate(body if isinstance(body, dict) else {})
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/import-zip/preview":
            fs, perr = _parse_multipart_fields(self, for_batch=False)
            if perr:
                self._send(400, perr)
                return
            assert fs is not None
            raw, orig_name = _multipart_first_uploaded_file(fs)
            if not raw:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须上传 1 个 .zip（multipart 字段名 file 或 files）"}},
                )
                return
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_preview_zip

                payload = api_field_mapping_template_preview_zip(raw, filename=orig_name)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping/templates/import-zip":
            fs, perr = _parse_multipart_fields(self, for_batch=False)
            if perr:
                self._send(400, perr)
                return
            assert fs is not None
            raw, orig_name = _multipart_first_uploaded_file(fs)
            if not raw:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须上传 1 个 .zip（multipart 字段名 file 或 files）"}},
                )
                return
            name_override = _multipart_first_field(fs, "name").strip()
            overwrite_raw = _multipart_first_field(fs, "overwrite").strip().lower()
            activate_raw = _multipart_first_field(fs, "activate").strip().lower()
            overwrite = overwrite_raw in ("1", "true", "yes", "on")
            activate = activate_raw in ("1", "true", "yes", "on")
            try:
                from src.local_api.field_mapping_template_api import api_field_mapping_template_import_zip

                payload = api_field_mapping_template_import_zip(
                    raw,
                    filename=orig_name,
                    name_override=name_override,
                    overwrite=overwrite,
                    activate=activate,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/field-mapping":
            body = self._read_json()
            defaults = body.get("default_fields")
            if defaults is None:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {"message": "请求体须包含 default_fields（对象）"},
                    },
                )
                return
            sheets_arg = body["sheets"] if "sheets" in body else None
            ok, msg = save_field_mapping_config(defaults, sheets_arg)
            if not ok:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {"message": msg},
                    },
                )
                return
            _, source = get_field_mapping_config_info()
            self._send(
                200,
                {
                    "ok": True,
                    "source": source,
                    "saved_to": msg,
                },
            )
            return
        if path == "/api/ods-preview/delete":
            body = self._read_json()
            scope = str(body.get("scope") or "").strip().lower()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.ods_preview import delete_ods_import_batch, delete_ods_import_session

                conn = get_conn()
                init_all_tables(conn)
                if scope == "batch":
                    payload = delete_ods_import_batch(conn, batch_id=str(body.get("batch_id") or ""))
                elif scope == "session":
                    payload = delete_ods_import_session(
                        conn,
                        batch_id=str(body.get("batch_id") or ""),
                        session_id=str(body.get("session_id") or ""),
                    )
                else:
                    payload = {
                        "ok": False,
                        "error": {"message": "请求体 scope 须为 batch 或 session"},
                    }
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"删除 ODS 数据失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200, payload)
            return
        if path == "/api/dwd-preview/delete":
            body = self._read_json()
            scope = str(body.get("scope") or "").strip().lower()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dwd_preview import delete_dwd_load_batch, delete_dwd_load_session

                conn = get_conn()
                init_all_tables(conn)
                if scope == "batch":
                    payload = delete_dwd_load_batch(conn, batch_id=str(body.get("batch_id") or ""))
                elif scope == "session":
                    payload = delete_dwd_load_session(
                        conn,
                        batch_id=str(body.get("batch_id") or ""),
                        session_id=str(body.get("session_id") or ""),
                    )
                else:
                    payload = {
                        "ok": False,
                        "error": {"message": "请求体 scope 须为 batch 或 session"},
                    }
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"删除 DWD 落库数据失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200, payload)
            return
        if path == "/api/import-sessions":
            body = self._read_json()
            payload = _sessions.create_and_start(body)
            self._send(200 if payload.get("ok") else 400, payload)
            return
        if path == "/api/import-sessions/upload":
            payload = _sessions.create_from_multipart(self)
            self._send(200 if payload.get("ok") else 400, payload)
            return
        if path == "/api/import-sessions/upload-file":
            payload = _sessions.append_import_upload_file(self)
            self._send(200 if payload.get("ok") else 400, payload)
            return
        if path.startswith("/api/import-sessions/") and path.endswith("/start-import"):
            segs = [p for p in path.split("/") if p]
            sid = segs[2] if len(segs) >= 4 and segs[1] == "import-sessions" else ""
            body = self._read_json()
            payload = _sessions.start_import_after_uploads(sid, post_import_opts=body if isinstance(body, dict) else None)
            from src.local_api.license_gate import license_gate_http_status

            status = license_gate_http_status(payload) if not payload.get("ok") else 200
            self._send(status if status != 200 else (200 if payload.get("ok") else 400), payload)
            return
        if path == "/api/header-coverage":
            fs, err = _parse_multipart_fields(self, for_batch=False)
            if err:
                self._send(400, err)
                return
            assert fs is not None
            try:
                tsk = json.loads(_multipart_first_field(fs, "target_sheet_keys") or "[]")
            except Exception:
                tsk = []
            if not isinstance(tsk, list):
                tsk = []
            target_sheet_keys = [str(x).strip() for x in tsk if isinstance(x, str) and str(x).strip()]
            if not target_sheet_keys:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "target_sheet_keys 不能为空（JSON 数组）"}},
                )
                return
            file_items = _multipart_file_items(fs)
            if len(file_items) != 1:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {
                            "message": (
                                f"须上传 1 个 xlsx（multipart 字段名 files，当前 {len(file_items)} 个）"
                            ),
                        },
                    },
                )
                return
            item = file_items[0]
            fp = getattr(item, "file", None)
            try:
                raw = fp.read() if fp is not None else b""
                if not raw and getattr(item, "value", None) is not None:
                    v = item.value
                    raw = v if isinstance(v, bytes) else str(v).encode("utf-8", errors="replace")
            except Exception as exc:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {
                            "message": "读取上传文件失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
                return
            eff_max = _effective_max_upload_bytes(_multipart_first_field(fs, "client_max_upload_mb"))
            if len(raw) > eff_max:
                self._send(
                    400,
                    {
                        "ok": False,
                        "error": {
                            "message": f"文件超过单文件上限 {eff_max // (1024 * 1024)}MB",
                        },
                    },
                )
                return
            tmp_path: str | None = None
            try:
                fd, tmp_path = tempfile.mkstemp(suffix=".xlsx")
                with os.fdopen(fd, "wb") as tmpf:
                    tmpf.write(raw)
                result = analyze_excel_path(Path(tmp_path), target_sheet_keys)
            except Exception as exc:
                self._send(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "message": "表头覆盖分析失败",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    },
                )
                return
            finally:
                if tmp_path:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
            ok = bool(result.get("ok"))
            self._send(200 if ok else 400, result)
            return
        if path == "/api/dwd/build":
            body = self._read_json()
            bid = str(body.get("import_batch_id") or body.get("batch_id") or "").strip()
            raw_sy = body.get("stat_year")
            stat_year: int | None = None
            if raw_sy is not None and str(raw_sy).strip() != "":
                try:
                    stat_year = int(raw_sy)
                except Exception:
                    stat_year = None
            inc_raw = body.get("incremental")
            if inc_raw is None:
                incremental = True
            else:
                incremental = bool(inc_raw)
            if body.get("full_batch") is True:
                incremental = False
            raw_sess = body.get("import_session_ids")
            import_session_ids: list[str] | None = None
            if raw_sess is not None:
                if not isinstance(raw_sess, list):
                    import_session_ids = []
                else:
                    import_session_ids = [str(x).strip() for x in raw_sess if str(x).strip()]
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.license_gate import check_invoice_quota, check_year_quota_for_build, license_gate_http_status
                from src.local_api.dwd_build import build_dwd_for_batch

                conn = get_conn()
                denied = check_invoice_quota(conn) or check_year_quota_for_build(conn, stat_year)
                if denied:
                    self._send(license_gate_http_status(denied), denied)
                    return

                payload = build_dwd_for_batch(
                    import_batch_id=bid,
                    stat_year=stat_year,
                    incremental=incremental,
                    import_session_ids=import_session_ids,
                    rebuild_enterprise_year_rel=bool(body.get("rebuild_enterprise_year_rel")),
                    refresh_dws=bool(body.get("refresh_dws")),
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"DWD 构建异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            if payload.get("ok"):
                code = 200
            else:
                from src.local_api.dwd_build import _http_status_for_dwd_error

                err = (payload.get("error") or {}) if isinstance(payload.get("error"), dict) else {}
                code = _http_status_for_dwd_error(err)
            self._send(code, payload, cors=True)
            return

        if path == "/api/dwd/retry-step":
            body = self._read_json()
            bid = str(body.get("import_batch_id") or body.get("batch_id") or "").strip()
            step_id = str(body.get("step_id") or body.get("stepId") or "").strip()
            raw_sy = body.get("stat_year")
            stat_year: int | None = None
            if raw_sy is not None and str(raw_sy).strip() != "":
                try:
                    stat_year = int(raw_sy)
                except Exception:
                    stat_year = None
            raw_sess = body.get("import_session_ids")
            import_session_ids: list[str] | None = None
            if raw_sess is not None:
                if not isinstance(raw_sess, list):
                    import_session_ids = []
                else:
                    import_session_ids = [str(x).strip() for x in raw_sess if str(x).strip()]
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.license_gate import check_invoice_quota, check_year_quota_for_build, license_gate_http_status
                from src.local_api.dwd_build import _http_status_for_dwd_error, retry_dwd_build_step

                conn = get_conn()
                denied = check_invoice_quota(conn) or check_year_quota_for_build(conn, stat_year)
                if denied:
                    self._send(license_gate_http_status(denied), denied)
                    return

                payload = retry_dwd_build_step(
                    import_batch_id=bid,
                    step_id=step_id,
                    stat_year=stat_year,
                    import_session_ids=import_session_ids,
                    rebuild_enterprise_year_rel=bool(body.get("rebuild_enterprise_year_rel")),
                    refresh_dws=bool(body.get("refresh_dws")),
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"DWD 单步重跑异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            if payload.get("ok"):
                code = 200
            else:
                err = (payload.get("error") or {}) if isinstance(payload.get("error"), dict) else {}
                code = _http_status_for_dwd_error(err)
            self._send(code, payload, cors=True)
            return

        if path == "/api/dwd/rollback":
            body = self._read_json()
            bid = str(body.get("import_batch_id") or body.get("batch_id") or "").strip()
            try:
                from src.local_api.dwd_build import rollback_dwd_batch

                payload = rollback_dwd_batch(import_batch_id=bid)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"DWD 批次回滚异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dws/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_meta

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_dws_meta(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/entity-options":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_entity_options

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_dws_entity_options(conn, stat_year=stat_year))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/analysis-subject/meta":
            qs = parse_qs(parsed.query or "")
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import (
                    _parse_min_invoice_count,
                    api_analysis_subject_meta,
                )

                conn = get_conn()
                init_all_tables(conn)
                self._send(
                    200,
                    api_analysis_subject_meta(
                        conn,
                        min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    ),
                )
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/analysis-subject/options":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            source = (qs.get("source", [""])[0] or "").strip().lower()
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import (
                    _parse_min_invoice_count,
                    api_analysis_scope_entity_options,
                    api_analysis_subject_options,
                )

                conn = get_conn()
                init_all_tables(conn)
                if source in ("org_union", "union", "scope"):
                    payload = api_analysis_scope_entity_options(conn, stat_year=stat_year)
                else:
                    payload = api_analysis_subject_options(
                        conn,
                        stat_year=stat_year,
                        require_buyer=require_buyer,
                        require_both_roles=require_both_roles,
                        min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/analysis-subject/org-members":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            member_source = (qs.get("member_source", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import (
                    _parse_min_invoice_count,
                    api_analysis_org_scope_members,
                )

                conn = get_conn()
                init_all_tables(conn)
                payload = api_analysis_org_scope_members(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    member_source=member_source,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/counterparty/cr-matrix":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            role = (qs.get("role", ["supplier"])[0] or "supplier").strip() or "supplier"
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except ValueError:
                limit = 500
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except ValueError:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.dws_dashboard_api import api_dws_counterparty_cr_matrix

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_counterparty_cr_matrix(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    role=role,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    keyword=keyword,
                    limit=limit,
                    offset=offset,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/counterparty/churn-matrix":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            role = (qs.get("role", ["supplier"])[0] or "supplier").strip() or "supplier"
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            member_source = (qs.get("member_source", [""])[0] or "").strip() or None
            excluded_entity_ids = (qs.get("excluded_entity_ids", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except ValueError:
                limit = 500
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except ValueError:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.dws_dashboard_api import api_dws_counterparty_churn_matrix

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_counterparty_churn_matrix(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    role=role,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    member_source=member_source,
                    excluded_entity_ids=excluded_entity_ids,
                    keyword=keyword,
                    limit=limit,
                    offset=offset,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/counterparty/top-matrix":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            tree = (qs.get("tree", ["mg"])[0] or "mg").strip() or "mg"
            scope_entity_id = (qs.get("scope_entity_id", [""])[0] or "").strip() or None
            role = (qs.get("role", ["supplier"])[0] or "supplier").strip() or "supplier"
            require_buyer = (qs.get("require_buyer", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            require_both_roles = (qs.get("require_both_roles", ["0"])[0] or "0").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            try:
                limit = int((qs.get("limit", ["500"])[0] or "500").strip() or "500")
            except ValueError:
                limit = 500
            try:
                offset = int((qs.get("offset", ["0"])[0] or "0").strip() or "0")
            except ValueError:
                offset = 0
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.dws_dashboard_api import api_dws_counterparty_top_matrix

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_counterparty_top_matrix(
                    conn,
                    stat_year=stat_year,
                    tree=tree,
                    scope_entity_id=scope_entity_id,
                    role=role,
                    require_buyer=require_buyer,
                    require_both_roles=require_both_roles,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                    keyword=keyword,
                    limit=limit,
                    offset=offset,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/summary":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_summary

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_summary(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/trend":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_type = (qs.get("role_type", [""])[0] or "").strip() or "all"
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_trend

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_trend(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_type=role_type,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/tax":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_type = (qs.get("role_type", ["进项"])[0] or "进项").strip()
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_tax

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_tax(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_type=role_type,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/overview/tax-monthly":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_type = (qs.get("role_type", ["进项"])[0] or "进项").strip()
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_overview_tax_monthly

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_overview_tax_monthly(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_type=role_type,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/trade/relationships":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            role_filter = (qs.get("role_filter", ["all"])[0] or "all").strip()
            keyword = (qs.get("keyword", [""])[0] or "").strip() or None
            counterparty_id = (qs.get("counterparty_id", [""])[0] or "").strip() or None
            party_a_tax = (qs.get("party_a_tax", [""])[0] or "").strip() or None
            party_b_tax = (qs.get("party_b_tax", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["100"])[0] or "100").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_trade_relationships

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_trade_relationships(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    role_filter=role_filter,
                    keyword=keyword,
                    counterparty_id=counterparty_id,
                    party_a_tax=party_a_tax,
                    party_b_tax=party_b_tax,
                    limit=int(limit or 100),
                    offset=int(offset or 0),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/tax/in-out-deviation":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_tax_in_out_deviation

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_tax_in_out_deviation(
                    conn, stat_year=stat_year, entity_id=entity_id
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/tax/risk-exposure":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_tax_risk_exposure

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_tax_risk_exposure(conn, stat_year=stat_year, entity_id=entity_id)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/trade/graph":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            min_amount_raw = (qs.get("min_amount", [""])[0] or "").strip()
            min_amount = float(min_amount_raw) if min_amount_raw else None
            counterparty_id = (qs.get("counterparty_id", [""])[0] or "").strip() or None
            party_a_tax = (qs.get("party_a_tax", [""])[0] or "").strip() or None
            party_b_tax = (qs.get("party_b_tax", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_trade_graph

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_trade_graph(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    min_amount=min_amount,
                    counterparty_id=counterparty_id,
                    party_a_tax=party_a_tax,
                    party_b_tax=party_b_tax,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices/meta":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices_meta

                conn = get_conn()
                init_all_tables(conn)
                self._send(200, api_export_invoices_meta(conn))
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices/count":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            fpzt = (qs.get("fpzt", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices_count

                conn = get_conn()
                init_all_tables(conn)
                payload = api_export_invoices_count(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    seller_tax_no=seller_tax_no,
                    date_from=date_from,
                    date_to=date_to,
                    fpzt=fpzt,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            fpzt = (qs.get("fpzt", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            fmt = (qs.get("format", ["csv"])[0] or "csv").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices

                conn = get_conn()
                init_all_tables(conn)
                status, body, ctype, fname = api_export_invoices(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    seller_tax_no=seller_tax_no,
                    date_from=date_from,
                    date_to=date_to,
                    fpzt=fpzt,
                    fmt=fmt,
                )
                if ctype and isinstance(body, bytes):
                    self._send_file(status, body, content_type=ctype, filename=fname or "export.csv")
                else:
                    err = body if isinstance(body, dict) else {"ok": False, "error": {"message": "导出失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/supplier/cr":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_supplier_cr

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_supplier_cr(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/supplier/top":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            quarter = (qs.get("quarter", [""])[0] or "").strip() or None
            lim_raw = (qs.get("limit", [""])[0] or "").strip()
            try:
                lim = int(lim_raw) if lim_raw.isdigit() else 20
            except Exception:
                lim = 20
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_supplier_top

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_supplier_top(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    limit=lim,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                    quarter=quarter,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/entity-profile":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            raw_min_n = (qs.get("min_invoice_count", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.analysis_subject_pool import _parse_min_invoice_count
                from src.local_api.entity_profile_api import api_dws_entity_profile

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_entity_profile(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    min_invoice_count=_parse_min_invoice_count(raw_min_n),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/invoice-detail/list":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            limit = (qs.get("limit", ["50"])[0] or "50").strip()
            offset = (qs.get("offset", ["0"])[0] or "0").strip()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_invoice_detail_api import api_dws_invoice_detail_list

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_invoice_detail_list(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                    seller_tax_no=seller_tax_no,
                    goods_name=goods_name,
                    slv_num=slv_num,
                    limit=int(limit) if limit.isdigit() else 50,
                    offset=int(offset) if offset.isdigit() else 0,
                )
                self._send(200 if payload.get("ok") else 500, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/invoice-detail/export":
            qs = parse_qs(parsed.query or "")
            stat_year = (qs.get("stat_year", [""])[0] or "").strip() or None
            entity_id = (qs.get("entity_id", [""])[0] or "").strip() or None
            stat_month = (qs.get("stat_month", [""])[0] or "").strip() or None
            date_from = (qs.get("date_from", [""])[0] or "").strip() or None
            date_to = (qs.get("date_to", [""])[0] or "").strip() or None
            seller_tax_no = (qs.get("seller_tax_no", [""])[0] or "").strip() or None
            goods_name = (qs.get("goods_name", [""])[0] or "").strip() or None
            slv_num = (qs.get("slv_num", [""])[0] or "").strip() or None
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_invoice_detail_api import api_dws_invoice_detail_export

                conn = get_conn()
                init_all_tables(conn)
                status, body, ctype, fname = api_dws_invoice_detail_export(
                    conn,
                    stat_year=stat_year,
                    entity_id=entity_id,
                    stat_month=stat_month,
                    date_from=date_from,
                    date_to=date_to,
                    seller_tax_no=seller_tax_no,
                    goods_name=goods_name,
                    slv_num=slv_num,
                )
                if isinstance(body, dict):
                    self._send(status, body)
                else:
                    self._send_file(status, body, content_type=ctype, filename=fname or "invoice_detail.csv")
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/rules/validate":
            body = self._read_json()
            yaml_text = str(body.get("yaml_text") or body.get("yaml") or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_rules_config_validate

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audit_rules_config_validate(conn, yaml_text=yaml_text)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/rules/config":
            body = self._read_json()
            yaml_text = str(body.get("yaml_text") or body.get("yaml") or "")
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_rules_config_save

                conn = get_conn()
                init_all_tables(conn)
                payload = api_audit_rules_config_save(conn, yaml_text=yaml_text)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/run":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_run

                conn = get_conn()
                init_all_tables(conn)
                raw_years = body.get("stat_years")
                years_list = raw_years if isinstance(raw_years, list) else None
                payload = api_audit_run(
                    conn,
                    stat_year=str(body.get("stat_year") or "").strip() or None,
                    stat_years=[str(y) for y in years_list] if years_list else None,
                    entity_id=str(body.get("entity_id") or "").strip() or None,
                    rule_ids=body.get("rule_ids") if isinstance(body.get("rule_ids"), list) else None,
                    dry_run=bool(body.get("dry_run")),
                    trigger_source=str(body.get("trigger_source") or "manual_api"),
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/audit/flags/confirm":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audit_flag_api import api_audit_flag_confirm

                conn = get_conn()
                init_all_tables(conn)
                raw_ids = body.get("flag_ids")
                ids_list = raw_ids if isinstance(raw_ids, list) else None
                payload = api_audit_flag_confirm(
                    conn,
                    flag_ids=[str(x) for x in ids_list] if ids_list else None,
                    is_confirmed=bool(body.get("is_confirmed", True)),
                    confirm_note=str(body.get("confirm_note") or "").strip() or None,
                )
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/compare/rebuild":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.compare_dashboard_api import api_compare_rebuild
                from src.local_api.license_gate import license_gate_http_status

                conn = get_conn()
                init_all_tables(conn)
                payload = api_compare_rebuild(conn, body)
                self._send(license_gate_http_status(payload), payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/generate":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.report_api import api_report_generate

                conn = get_conn()
                init_all_tables(conn)
                payload = api_report_generate(conn, body)
                status = 403 if payload.get("error", {}).get("code") == "license_export_denied" else (200 if payload.get("ok") else 400)
                self._send(status, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/delivery-package":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.report_api import api_report_delivery_package

                conn = get_conn()
                init_all_tables(conn)
                status, payload, ctype, fname = api_report_delivery_package(conn, body)
                err_code = payload.get("error", {}).get("code") if isinstance(payload, dict) else None
                if err_code in {"license_export_denied", "license_expired"}:
                    status = 403
                if ctype and isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "delivery_package.zip")
                else:
                    err = payload if isinstance(payload, dict) else {"ok": False, "error": {"message": "下载失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/templates/save":
            body = self._read_json()
            try:
                from src.local_api.report_template_api import api_report_template_save

                payload = api_report_template_save(body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/templates/delete":
            body = self._read_json()
            try:
                from src.local_api.report_template_api import api_report_template_delete

                tid = str(body.get("template_id") or "").strip()
                payload = api_report_template_delete(tid)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/report/archive/batch-download":
            body = self._read_json()
            try:
                from src.local_api.report_api import api_report_archive_batch_download

                names = body.get("file_names") or body.get("fileNames") or []
                if not isinstance(names, list):
                    names = []
                status, payload, ctype, fname = api_report_archive_batch_download([str(x) for x in names])
                if ctype and isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "reports.zip")
                else:
                    err = payload if isinstance(payload, dict) else {"ok": False, "error": {"message": "下载失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/export/invoices":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.invoice_export_api import api_export_invoices

                conn = get_conn()
                init_all_tables(conn)
                status, payload, ctype, fname = api_export_invoices(
                    conn,
                    stat_year=str(body.get("stat_year") or "").strip() or None,
                    entity_id=str(body.get("entity_id") or body.get("entityId") or "").strip() or None,
                    seller_tax_no=str(body.get("seller_tax_no") or body.get("sellerTaxNo") or "").strip() or None,
                    date_from=str(body.get("date_from") or body.get("dateFrom") or "").strip() or None,
                    date_to=str(body.get("date_to") or body.get("dateTo") or "").strip() or None,
                    fpzt=str(body.get("fpzt") or body.get("invoice_status") or "").strip() or None,
                    fmt=str(body.get("format") or "csv").strip(),
                )
                if ctype and isinstance(payload, bytes):
                    self._send_file(status, payload, content_type=ctype, filename=fname or "export.csv")
                else:
                    err = payload if isinstance(payload, dict) else {"ok": False, "error": {"message": "导出失败"}}
                    self._send(status, err)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dws/rebuild":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dws_dashboard_api import api_dws_rebuild

                conn = get_conn()
                init_all_tables(conn)
                payload = api_dws_rebuild(conn, body)
                self._send(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send(500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}})
            return

        if path == "/api/dim/enterprise-year-rel/rebuild":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from src.local_api.enterprise_year_rel_build import (
                    parse_stat_years_request,
                    rebuild_dim_enterprise_year_rel,
                )

                conn = get_conn()
                raw_years = body.get("stat_years")
                parsed = parse_stat_years_request(raw_years)
                dry_run = bool(body.get("dry_run"))
                run_id = str(body.get("run_id") or "").strip() or None
                snap = str(body.get("relation_snapshot_id") or "").strip() or None
                trig = str(body.get("trigger_source") or "").strip() or "manual_api"
                payload = rebuild_dim_enterprise_year_rel(
                    conn,
                    stat_years=parsed,
                    dry_run=dry_run,
                    run_id=run_id,
                    relation_snapshot_id=snap,
                    trigger_source=trig,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"企业-年度关系重算失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            if payload.get("ok") or payload.get("skipped"):
                code = 200
            else:
                err = (payload.get("error") or {}) if isinstance(payload.get("error"), dict) else {}
                if str(err.get("code") or "") == "rel_rebuild_busy" or str(err.get("exception_type") or "") == "ConflictError":
                    code = 409
                else:
                    code = 500
            self._send(code, payload, cors=True)
            return
        if path == "/api/dwd/force-rebuild":
            body = self._read_json()
            bid = str(body.get("import_batch_id") or body.get("batch_id") or "").strip()
            sid = str(body.get("import_session_id") or body.get("session_id") or "").strip()
            raw_sy = body.get("stat_year")
            stat_year: int | None = None
            if raw_sy is not None and str(raw_sy).strip() != "":
                try:
                    stat_year = int(raw_sy)
                except Exception:
                    stat_year = None
            try:
                from src.local_api.dwd_build import force_rebuild_dwd_session

                payload = force_rebuild_dwd_session(
                    import_batch_id=bid,
                    import_session_id=sid,
                    stat_year=stat_year,
                    rebuild_enterprise_year_rel=bool(body.get("rebuild_enterprise_year_rel")),
                    refresh_dws=bool(body.get("refresh_dws")),
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"强制重洗异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            if payload.get("ok"):
                code = 200
            else:
                err = (payload.get("error") or {}) if isinstance(payload.get("error"), dict) else {}
                ec = str(err.get("code") or "")
                code = 400 if ec in {"session_not_found"} else 500
            self._send(code, payload, cors=True)
            return
        if path == "/api/dim/build-enterprise-profile":
            body = self._read_json()
            stat_month = str(body.get("stat_month") or "").strip() or None
            import_batch_id = str(body.get("import_batch_id") or body.get("batch_id") or "").strip() or None
            calc_batch_id = str(body.get("calc_batch_id") or "").strip() or None
            source_scope = str(body.get("source_scope") or "").strip() or None
            subject_category_scope = str(body.get("subject_category_scope") or "").strip() or None
            run_id = str(body.get("run_id") or "").strip() or None
            try:
                from src.local_api.dim_async_tasks import (
                    run_enterprise_profile_sync,
                    start_async_enterprise_profile_build,
                    want_async_mode,
                )

                if want_async_mode(body):
                    payload = start_async_enterprise_profile_build(
                        stat_month=stat_month,
                        import_batch_id=import_batch_id,
                        calc_batch_id=calc_batch_id,
                        source_scope=source_scope,
                        subject_category_scope=subject_category_scope,
                        run_id=run_id,
                    )
                else:
                    payload = run_enterprise_profile_sync(
                        stat_month=stat_month,
                        import_batch_id=import_batch_id,
                        calc_batch_id=calc_batch_id,
                        source_scope=source_scope,
                        subject_category_scope=subject_category_scope,
                        run_id=run_id,
                    )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"DWD→DIM 企业画像构建异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return
        if path == "/api/dim/build-enterprise-master":
            body = self._read_json()
            import_batch_id = str(body.get("import_batch_id") or body.get("batch_id") or "").strip() or None
            subject_category_scope = str(body.get("subject_category_scope") or "").strip() or None
            run_id = str(body.get("run_id") or "").strip() or None
            try:
                from src.local_api.dim_async_tasks import (
                    run_enterprise_master_sync,
                    start_async_enterprise_master_build,
                    want_async_mode,
                )

                if want_async_mode(body):
                    payload = start_async_enterprise_master_build(
                        import_batch_id=import_batch_id,
                        subject_category_scope=subject_category_scope,
                        run_id=run_id,
                    )
                else:
                    payload = run_enterprise_master_sync(
                        import_batch_id=import_batch_id,
                        subject_category_scope=subject_category_scope,
                        run_id=run_id,
                    )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"DWD→DIM 企业主数据构建异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return
        if path == "/api/dim/build-enterprise-mapping":
            body = self._read_json()
            import_batch_id = str(body.get("import_batch_id") or body.get("batch_id") or "").strip() or None
            subject_category_scope = str(body.get("subject_category_scope") or "").strip() or None
            run_id = str(body.get("run_id") or "").strip() or None
            try:
                from src.local_api.dim_async_tasks import (
                    run_enterprise_mapping_sync,
                    start_async_enterprise_mapping_build,
                    want_async_mode,
                )

                if want_async_mode(body):
                    payload = start_async_enterprise_mapping_build(
                        import_batch_id=import_batch_id,
                        subject_category_scope=subject_category_scope,
                        run_id=run_id,
                    )
                else:
                    payload = run_enterprise_mapping_sync(
                        import_batch_id=import_batch_id,
                        subject_category_scope=subject_category_scope,
                        run_id=run_id,
                    )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"DWD→DIM 企业映射构建异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return

        if path == "/api/dim/level1-enterprise-year/upsert":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_upsert

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_upsert(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"保存年度一级企业失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/level1-enterprise-year/delete":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_delete

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_delete(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"删除年度一级企业失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/level1-enterprise-year/import-batch":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_import_batch

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_import_batch(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"批量导入年度一级企业失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/level1-enterprise-year/preview-from-previous":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_preview_from_previous

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_preview_from_previous(
                    conn, body if isinstance(body, dict) else {}
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"预览年度一级企业复制/推导失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/level1-enterprise-year/copy-from-previous":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.level1_enterprise_year_api import api_level1_enterprise_year_copy_from_previous

                conn = get_conn()
                init_all_tables(conn)
                payload = api_level1_enterprise_year_copy_from_previous(
                    conn, body if isinstance(body, dict) else {}
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"从上一年度复制一级企业失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            code = 200 if payload.get("ok") or payload.get("skipped") else 400
            self._send(code, payload, cors=True)
            return

        if path == "/api/dim/enterprise-year-roster/rebuild":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_build import rebuild_enterprise_year_roster_from_registry

                stat_years_raw = body.get("stat_years") if isinstance(body, dict) else None
                stat_years: list[int] | None = None
                if isinstance(stat_years_raw, list) and stat_years_raw:
                    stat_years = []
                    for y in stat_years_raw:
                        try:
                            yi = int(y)
                            if 1990 <= yi <= 2100:
                                stat_years.append(yi)
                        except (TypeError, ValueError):
                            continue
                    if not stat_years:
                        stat_years = None
                replace_years = bool(body.get("replace_years", body.get("replaceYears", True)))
                run_id = str(body.get("run_id") or "").strip() or None
                conn = get_conn()
                init_all_tables(conn)
                payload = rebuild_enterprise_year_roster_from_registry(
                    conn,
                    stat_years=stat_years,
                    replace_years=replace_years,
                    run_id=run_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"企业年度花名册同步失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/enterprise-year-roster/manual/upsert":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_manual import api_enterprise_year_roster_manual_upsert

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_manual_upsert(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"花名册人工保存失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/enterprise-year-roster/manual/delete":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_manual import api_enterprise_year_roster_manual_delete

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_manual_delete(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"花名册删除失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/enterprise-year-roster/copy/preview":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_manual import api_enterprise_year_roster_copy_preview

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_copy_preview(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"花名册复制预览失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/enterprise-year-roster/copy/execute":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.enterprise_year_roster_manual import api_enterprise_year_roster_copy_execute

                conn = get_conn()
                init_all_tables(conn)
                payload = api_enterprise_year_roster_copy_execute(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"花名册复制执行失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/group-enterprise-year/rebuild":
            body = self._read_json()
            try:
                from src.local_api.dim_async_tasks import start_async_group_enterprise_year_build, want_async_mode

                stat_years_raw = body.get("stat_years") if isinstance(body, dict) else None
                stat_years: list[int] | None = None
                if isinstance(stat_years_raw, list) and stat_years_raw:
                    stat_years = []
                    for y in stat_years_raw:
                        try:
                            yi = int(y)
                            if 1990 <= yi <= 2100:
                                stat_years.append(yi)
                        except (TypeError, ValueError):
                            continue
                    if not stat_years:
                        stat_years = None
                replace_years = bool(body.get("replace_years", body.get("replaceYears", True)))
                run_id = str(body.get("run_id") or "").strip() or None

                if want_async_mode(body if isinstance(body, dict) else {}, default=True):
                    payload = start_async_group_enterprise_year_build(
                        stat_years=stat_years,
                        replace_years=replace_years,
                        run_id=run_id,
                    )
                else:
                    from db.duckdb_conn import get_conn
                    from db.schema_sqlfiles import init_all_tables
                    from src.local_api.group_enterprise_year_build import rebuild_group_enterprise_year_from_registry

                    conn = get_conn()
                    init_all_tables(conn)
                    payload = rebuild_group_enterprise_year_from_registry(
                        conn,
                        stat_years=stat_years,
                        replace_years=replace_years,
                        run_id=run_id,
                    )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"集团成员表计算失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/org-hier/import":
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "multipart/form-data" not in ctype:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "Content-Type 须为 multipart/form-data"}},
                    cors=True,
                )
                return
            fs, err = _parse_multipart_fields(self, for_batch=False)
            if err:
                self._send(400, err, cors=True)
                return
            assert fs is not None
            dry_run_raw = str(_multipart_first_field(fs, "dry_run") or "").strip().lower()
            dry_run = dry_run_raw in ("1", "true", "yes")
            run_id = str(_multipart_first_field(fs, "run_id") or "").strip() or None
            file_bytes, upload_name = _multipart_first_uploaded_file(fs)
            if not file_bytes:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须上传文件（multipart 字段名 file 或 files）"}},
                    cors=True,
                )
                return
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_import

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_import(
                    conn,
                    file_bytes=file_bytes,
                    upload_filename=upload_name,
                    dry_run=dry_run,
                    run_id=run_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"组织层级导入失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            code = 200 if payload.get("ok") or payload.get("dry_run") else 400
            self._send(code, payload, cors=True)
            return

        if path == "/api/dim/org-sys/save":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_sys_api import api_org_sys_save

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_sys_save(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": str(exc), "exception_type": type(exc).__name__},
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/org-sys/delete":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_sys_api import api_org_sys_delete

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_sys_delete(conn, body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": str(exc), "exception_type": type(exc).__name__},
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/org-sys/bootstrap-demo":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_sys_api import api_org_sys_bootstrap_demo

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_sys_bootstrap_demo(conn)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": str(exc), "exception_type": type(exc).__name__},
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/org-hier/bootstrap-demo":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_bootstrap_demo

                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_bootstrap_demo(conn)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {"message": str(exc), "exception_type": type(exc).__name__},
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/org-hier/rebuild":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.dim_org_hier_api import api_org_hier_rebuild

                stat_years_raw = body.get("stat_years") if isinstance(body, dict) else None
                stat_years: list[int] | None = None
                if isinstance(stat_years_raw, list) and stat_years_raw:
                    stat_years = []
                    for y in stat_years_raw:
                        try:
                            yi = int(y)
                            if 1990 <= yi <= 2100:
                                stat_years.append(yi)
                        except (TypeError, ValueError):
                            continue
                    if not stat_years:
                        stat_years = None
                dry_run = bool(body.get("dry_run"))
                run_id = str(body.get("run_id") or "").strip() or None
                conn = get_conn()
                init_all_tables(conn)
                payload = api_org_hier_rebuild(
                    conn,
                    stat_years=stat_years,
                    dry_run=dry_run,
                    run_id=run_id,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"组织层级重算失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/audited-enterprise/registry/import-excel":
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "multipart/form-data" not in ctype:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "Content-Type 须为 multipart/form-data"}},
                    cors=True,
                )
                return
            fs, err = _parse_multipart_fields(self, for_batch=False)
            if err:
                self._send(400, err, cors=True)
                return
            assert fs is not None
            file_bytes, upload_name = _multipart_first_uploaded_file(fs)
            if not file_bytes:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须上传文件（multipart 字段名 file 或 files）"}},
                    cors=True,
                )
                return
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_registry_import_excel

                conn = get_conn()
                init_all_tables(conn)
                payload = api_registry_import_excel(
                    conn,
                    file_bytes=file_bytes,
                    upload_filename=upload_name,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"管理与产权 Excel 导入失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                    "imported": 0,
                    "rejected": 0,
                    "reject_row_samples": [],
                    "reject_row_ranges": [],
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/audited-enterprise/contribution/import-excel":
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "multipart/form-data" not in ctype:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "Content-Type 须为 multipart/form-data"}},
                    cors=True,
                )
                return
            fs, err = _parse_multipart_fields(self, for_batch=False)
            if err:
                self._send(400, err, cors=True)
                return
            assert fs is not None
            file_bytes, upload_name = _multipart_first_uploaded_file(fs)
            if not file_bytes:
                self._send(
                    400,
                    {"ok": False, "error": {"message": "须上传文件（multipart 字段名 file 或 files）"}},
                    cors=True,
                )
                return
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_contribution_import_excel

                conn = get_conn()
                init_all_tables(conn)
                payload = api_contribution_import_excel(
                    conn,
                    file_bytes=file_bytes,
                    upload_filename=upload_name,
                )
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"出资股权 Excel 导入失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                    "imported": 0,
                    "rejected": 0,
                    "reject_row_samples": [],
                    "reject_row_ranges": [],
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/audited-enterprise/registry":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_registry_insert

                conn = get_conn()
                init_all_tables(conn)
                payload = api_registry_insert(conn, body)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"保存管理与产权层级信息失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim/audited-enterprise/relation-tree/update-hierarchy":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import ensure_audited_enterprise_registry_table, init_all_tables
                from src.local_api.audited_enterprise_dims import api_registry_update_hierarchy

                conn = get_conn()
                init_all_tables(conn)
                ensure_audited_enterprise_registry_table(conn)
                payload = api_registry_update_hierarchy(conn, body)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"关系树层级回写失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/demo/seed-analysis-data":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.bootstrap.demo_analysis_seed import seed_demo_analysis_data

                conn = get_conn()
                init_all_tables(conn)
                skip_flags = bool(body.get("skip_audit_flags") or body.get("skipAuditFlags"))
                payload = seed_demo_analysis_data(conn, skip_audit_flags=skip_flags)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"演示分析数据种子失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return

        if path == "/api/settings/thresholds":
            body = self._read_json()
            try:
                from src.local_api.settings_api import api_settings_thresholds_post

                payload = api_settings_thresholds_post(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"保存规则阈值失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/dim-dict":
            body = self._read_json()
            try:
                from src.local_api.dim_dict_api import api_dim_dict_save

                payload = api_dim_dict_save(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"保存数据字典失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/settings/instance":
            body = self._read_json()
            try:
                from src.local_api.settings_api import api_settings_instance_post

                payload = api_settings_instance_post(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"保存实例配置失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/settings/license":
            body = self._read_json()
            try:
                from src.local_api.license_gate import api_settings_license_post

                payload = api_settings_license_post(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/auth/logout":
            try:
                from src.local_api.users_api import api_auth_logout

                payload = api_auth_logout(self.headers)
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 401, payload, cors=True)
            return

        if path == "/api/auth/login":
            body = self._read_json()
            try:
                from src.local_api.users_api import api_auth_login

                payload = api_auth_login(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 401, payload, cors=True)
            return

        if path == "/api/users":
            body = self._read_json()
            try:
                from src.local_api.users_api import api_users_create

                payload = api_users_create(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/users/update":
            body = self._read_json()
            try:
                from src.local_api.users_api import api_users_update

                payload = api_users_update(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/users/delete":
            body = self._read_json()
            try:
                from src.local_api.users_api import api_users_delete

                payload = api_users_delete(body if isinstance(body, dict) else {})
            except Exception as exc:
                payload = {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/audited-enterprise/registry/bootstrap-demo":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_registry_bootstrap_demo

                conn = get_conn()
                init_all_tables(conn)
                payload = api_registry_bootstrap_demo(conn)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"加载演示数据失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return

        if path == "/api/audited-enterprise/contribution":
            body = self._read_json()
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_contribution_insert

                conn = get_conn()
                init_all_tables(conn)
                payload = api_contribution_insert(conn, body)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"保存出资与股权比例信息失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 400, payload, cors=True)
            return

        if path == "/api/audited-enterprise/contribution/bootstrap-demo":
            try:
                from db.duckdb_conn import get_conn
                from db.schema_sqlfiles import init_all_tables
                from src.local_api.audited_enterprise_dims import api_contribution_bootstrap_demo

                conn = get_conn()
                init_all_tables(conn)
                payload = api_contribution_bootstrap_demo(conn)
            except Exception as exc:
                payload = {
                    "ok": False,
                    "error": {
                        "message": f"加载演示数据失败：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }
            self._send(200 if payload.get("ok") else 500, payload, cors=True)
            return

        self._send(404, {"ok": False, "error": {"message": "Not Found"}}, cors=True)


def _parse_truthy_flag(raw: Any, *, default: bool = False) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    s = str(raw).strip().lower()
    if s in ("", "0", "false", "no", "off"):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


def _env_truthy_flag(name: str, *, default: bool = False) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _parse_field_mapping_template_id(raw: Any) -> str | None:
    s = str(raw or "").strip()
    return s if s else None


class _SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, dict[str, Any]] = {}
        # 分文件上传未完成、尚未 start-import 的会话（import_session_id -> 元数据）
        self._pending_uploads: dict[str, dict[str, Any]] = {}

    def _new_id(self) -> str:
        """
        导入会话 ID（写入 ods_load_log.import_session_id、manifest_{id}.json 等）。
        - 前缀 s_：session（与其它 ID 区分，非配置项、可演进）
        - 中部：本地可读时间戳（秒级）
        - 尾部：随机 hex，防同一秒内并发冲突
        """
        stamp = time.strftime("%Y%m%d_%H%M%S")
        return f"s_{stamp}_{os.urandom(4).hex()}"

    def create_and_start(self, body: dict) -> dict:
        excel_paths = body.get("excel_paths") or []
        if not isinstance(excel_paths, list) or not all(isinstance(x, str) and x.strip() for x in excel_paths):
            return {"ok": False, "error": {"message": "excel_paths 必须是非空字符串数组"}}

        batch_id = str(body.get("batch_id") or "").strip() or time.strftime("%Y%m%d")
        ods_dir = str(body.get("ods_dir") or "").strip() or _default_ods_dir()
        target_sheet_keys = body.get("target_sheet_keys")
        if target_sheet_keys is not None:
            if not isinstance(target_sheet_keys, list) or not all(isinstance(x, str) for x in target_sheet_keys):
                return {"ok": False, "error": {"message": "target_sheet_keys 必须是字符串数组或不提供"}}
            target_sheet_keys = [x.strip() for x in target_sheet_keys if str(x).strip()]
            if not target_sheet_keys:
                target_sheet_keys = None
        path_labels = body.get("path_labels")
        if path_labels is not None:
            if not isinstance(path_labels, list) or not all(isinstance(x, str) for x in path_labels):
                return {"ok": False, "error": {"message": "path_labels 必须是字符串数组或省略"}}
            if len(path_labels) != len(excel_paths):
                return {"ok": False, "error": {"message": "path_labels 长度须与 excel_paths 一致"}}
        fail_policy = str(body.get("fail_policy") or "skip").strip().lower()
        if fail_policy not in {"stop", "skip"}:
            fail_policy = "skip"
        force_reimport = bool(body.get("force_reimport"))
        field_mapping_template_id = _parse_field_mapping_template_id(
            body.get("field_mapping_template_id") or body.get("template_id")
        )

        session_id = self._new_id()
        self._register_session(session_id)

        t = threading.Thread(
            target=self._run_import,
            args=(
                session_id,
                batch_id,
                ods_dir,
                excel_paths,
                target_sheet_keys,
                fail_policy,
                path_labels,
                force_reimport,
                False,
                False,
                field_mapping_template_id,
            ),
            daemon=True,
        )
        t.start()
        return {"ok": True, "import_session_id": session_id}

    def create_from_multipart(self, handler: BaseHTTPRequestHandler) -> dict:
        fs, err = _parse_multipart_fields(handler, for_batch=True)
        if err:
            return err
        assert fs is not None

        batch_id = str(_multipart_first_field(fs, "batch_id")).strip() or time.strftime("%Y%m%d")
        fail_policy = str(_multipart_first_field(fs, "fail_policy") or "skip").strip().lower()
        if fail_policy not in {"stop", "skip"}:
            fail_policy = "skip"
        force_reimport = _parse_bool_like(_multipart_first_field(fs, "force_reimport"), False)
        ods_dir = str(_multipart_first_field(fs, "ods_dir")).strip() or _default_ods_dir()

        try:
            tsk = json.loads(_multipart_first_field(fs, "target_sheet_keys") or "[]")
        except Exception:
            tsk = []
        if not isinstance(tsk, list):
            tsk = []
        target_sheet_keys = [str(x).strip() for x in tsk if isinstance(x, str) and str(x).strip()]
        if not target_sheet_keys:
            target_sheet_keys = None

        try:
            pl = json.loads(_multipart_first_field(fs, "path_labels") or "[]")
        except Exception:
            pl = []
        path_labels: list[str] | None = [str(x) for x in pl] if isinstance(pl, list) else None

        file_items = _multipart_file_items(fs)

        if not file_items:
            return {"ok": False, "error": {"message": "未找到名为 files 的上传文件"}}

        eff_max_bytes = _effective_max_upload_bytes(_multipart_first_field(fs, "client_max_upload_mb"))
        eff_max_mb = eff_max_bytes // (1024 * 1024)

        session_id = self._new_id()
        upload_root = (
            _project_root()
            / "data"
            / "input_excel"
            / "uploaded"
            / f"批次={batch_id}"
            / f"session={session_id}"
        )
        try:
            upload_root.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            return {
                "ok": False,
                "error": {
                    "message": "无法创建上传目录",
                    "exception_type": type(exc).__name__,
                    "detail": str(exc),
                },
            }

        excel_paths: list[str] = []
        for i, item in enumerate(file_items, start=1):
            raw_name = item.filename or f"file_{i}.xlsx"
            base = Path(raw_name).name
            safe = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", base).strip("._") or "upload.xlsx"
            dest = upload_root / f"{i:03d}_{safe}"
            try:
                fp = getattr(item, "file", None)
                if fp is None:
                    raise RuntimeError("上传项缺少 file 句柄")
                with open(dest, "wb") as out_f:
                    shutil.copyfileobj(fp, out_f, length=1024 * 1024)
                written = dest.stat().st_size
                if written > eff_max_bytes:
                    try:
                        dest.unlink(missing_ok=True)
                    except Exception:
                        pass
                    _cleanup_partial_upload(upload_root, excel_paths)
                    return {
                        "ok": False,
                        "error": {
                            "message": (
                                f"「{base}」超过单文件上限 {eff_max_mb}MB（实际 {written // (1024 * 1024)}MB）；"
                                f"可在界面调低限制或调大服务端 INVOICELENS_MAX_UPLOAD_MB"
                            ),
                        },
                    }
                excel_paths.append(str(dest.resolve()))
            except Exception as exc:
                _cleanup_partial_upload(upload_root, excel_paths)
                return {
                    "ok": False,
                    "error": {
                        "message": f"保存上传文件失败: {base}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }

        if path_labels is not None:
            if len(path_labels) < len(excel_paths):
                path_labels = path_labels + [""] * (len(excel_paths) - len(path_labels))
            else:
                path_labels = path_labels[: len(excel_paths)]

        field_mapping_template_id = _parse_field_mapping_template_id(
            _multipart_first_field(fs, "field_mapping_template_id") or _multipart_first_field(fs, "template_id")
        )

        self._register_session(session_id)
        t = threading.Thread(
            target=self._run_import,
            args=(
                session_id,
                batch_id,
                ods_dir,
                excel_paths,
                target_sheet_keys,
                fail_policy,
                path_labels,
                force_reimport,
                False,
                False,
                field_mapping_template_id,
            ),
            daemon=True,
        )
        t.start()
        return {"ok": True, "import_session_id": session_id, "saved_paths": excel_paths}

    def append_import_upload_file(self, handler: BaseHTTPRequestHandler) -> dict:
        fs, err = _parse_multipart_fields(handler, for_batch=False)
        if err:
            return err
        assert fs is not None

        eff_max_bytes = _effective_max_upload_bytes(_multipart_first_field(fs, "client_max_upload_mb"))
        eff_max_mb = eff_max_bytes // (1024 * 1024)

        sid_in = str(_multipart_first_field(fs, "import_session_id")).strip()
        batch_id = str(_multipart_first_field(fs, "batch_id")).strip() or time.strftime("%Y%m%d")
        fail_policy = str(_multipart_first_field(fs, "fail_policy") or "skip").strip().lower()
        if fail_policy not in {"stop", "skip"}:
            fail_policy = "skip"
        force_reimport = _parse_bool_like(_multipart_first_field(fs, "force_reimport"), False)
        ods_dir = str(_multipart_first_field(fs, "ods_dir")).strip() or _default_ods_dir()

        try:
            tsk = json.loads(_multipart_first_field(fs, "target_sheet_keys") or "[]")
        except Exception:
            tsk = []
        if not isinstance(tsk, list):
            tsk = []
        target_sheet_keys = [str(x).strip() for x in tsk if isinstance(x, str) and str(x).strip()]
        if not target_sheet_keys:
            target_sheet_keys = None
        t_tuple = _norm_target_keys_tuple(target_sheet_keys)

        path_label = str(_multipart_first_field(fs, "path_label"))

        file_items = _multipart_file_items(fs)
        if len(file_items) != 1:
            return {
                "ok": False,
                "error": {
                    "message": f"本接口每次仅上传 1 个文件（当前 {len(file_items)} 个），请分多次请求",
                },
            }

        item = file_items[0]
        session_id = ""
        upload_root: Path | None = None
        excel_paths: list[str] = []
        dest: Path | None = None
        base = ""

        with self._lock:
            if sid_in:
                pend = self._pending_uploads.get(sid_in)
                if not pend:
                    return {"ok": False, "error": {"message": "import_session_id 无效、或已开始导入/已过期"}}
                if pend["batch_id"] != batch_id:
                    return {"ok": False, "error": {"message": "batch_id 与首次上传不一致"}}
                if pend["fail_policy"] != fail_policy:
                    return {"ok": False, "error": {"message": "fail_policy 与首次上传不一致"}}
                if pend["ods_dir"] != ods_dir:
                    return {"ok": False, "error": {"message": "ods_dir 与首次上传不一致"}}
                if pend["target_tuple"] != t_tuple:
                    return {"ok": False, "error": {"message": "target_sheet_keys 与首次上传不一致"}}
                if bool(pend.get("force_reimport")) != bool(force_reimport):
                    return {"ok": False, "error": {"message": "force_reimport 与首次上传不一致"}}
                req_tpl = _parse_field_mapping_template_id(
                    _multipart_first_field(fs, "field_mapping_template_id") or _multipart_first_field(fs, "template_id")
                )
                if req_tpl is not None and req_tpl != pend.get("field_mapping_template_id"):
                    return {"ok": False, "error": {"message": "field_mapping_template_id 与首次上传不一致"}}
                raw_ad = _multipart_first_field(fs, "auto_dwd_after_import")
                if raw_ad not in (None, ""):
                    ad = _parse_truthy_flag(raw_ad, default=bool(pend.get("auto_dwd_after_import")))
                    if ad != bool(pend.get("auto_dwd_after_import")):
                        return {"ok": False, "error": {"message": "auto_dwd_after_import 与首次上传不一致"}}
                raw_rel = _multipart_first_field(fs, "rebuild_enterprise_year_rel")
                if raw_rel not in (None, ""):
                    rel = _parse_truthy_flag(raw_rel, default=bool(pend.get("rebuild_enterprise_year_rel")))
                    if rel != bool(pend.get("rebuild_enterprise_year_rel")):
                        return {"ok": False, "error": {"message": "rebuild_enterprise_year_rel 与首次上传不一致"}}
                session_id = sid_in
                upload_root = pend["upload_root"]
                excel_paths = pend["excel_paths"]
                path_labels_mut: list[str] = pend["path_labels"]
            else:
                session_id = self._new_id()
                upload_root = (
                    _project_root()
                    / "data"
                    / "input_excel"
                    / "uploaded"
                    / f"批次={batch_id}"
                    / f"session={session_id}"
                )
                try:
                    upload_root.mkdir(parents=True, exist_ok=True)
                except Exception as exc:
                    return {
                        "ok": False,
                        "error": {
                            "message": "无法创建上传目录",
                            "exception_type": type(exc).__name__,
                            "detail": str(exc),
                        },
                    }
                excel_paths = []
                path_labels_mut = []
                auto_dwd = _parse_truthy_flag(
                    _multipart_first_field(fs, "auto_dwd_after_import"),
                    default=_env_truthy_flag("INVOICELENS_AUTO_DWD_AFTER_IMPORT", default=False),
                )
                rebuild_rel = _parse_truthy_flag(
                    _multipart_first_field(fs, "rebuild_enterprise_year_rel"),
                    default=_env_truthy_flag("INVOICELENS_REBUILD_ENTERPRISE_YEAR_REL_AFTER_DWD", default=False),
                )
                if rebuild_rel and not auto_dwd:
                    rebuild_rel = False
                field_mapping_template_id = _parse_field_mapping_template_id(
                    _multipart_first_field(fs, "field_mapping_template_id") or _multipart_first_field(fs, "template_id")
                )
                self._pending_uploads[session_id] = {
                    "batch_id": batch_id,
                    "ods_dir": ods_dir,
                    "target_sheet_keys": target_sheet_keys,
                    "target_tuple": t_tuple,
                    "fail_policy": fail_policy,
                    "force_reimport": force_reimport,
                    "auto_dwd_after_import": auto_dwd,
                    "rebuild_enterprise_year_rel": rebuild_rel,
                    "field_mapping_template_id": field_mapping_template_id,
                    "excel_paths": excel_paths,
                    "path_labels": path_labels_mut,
                    "upload_root": upload_root,
                }

            i = len(excel_paths) + 1
            raw_name = item.filename or f"file_{i}.xlsx"
            base = Path(raw_name).name
            safe = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", base).strip("._") or "upload.xlsx"
            dest = upload_root / f"{i:03d}_{safe}"
            try:
                fp = getattr(item, "file", None)
                if fp is None:
                    raise RuntimeError("上传项缺少 file 句柄")
                with open(dest, "wb") as out_f:
                    shutil.copyfileobj(fp, out_f, length=1024 * 1024)
                written = dest.stat().st_size
                if written > eff_max_bytes:
                    try:
                        dest.unlink(missing_ok=True)
                    except Exception:
                        pass
                    _cleanup_partial_upload(upload_root, excel_paths)
                    self._pending_uploads.pop(session_id, None)
                    return {
                        "ok": False,
                        "error": {
                            "message": (
                                f"「{base}」超过单文件上限 {eff_max_mb}MB（实际 {written // (1024 * 1024)}MB）；"
                                f"可在界面调低限制或调大服务端 INVOICELENS_MAX_UPLOAD_MB"
                            ),
                        },
                    }
                excel_paths.append(str(dest.resolve()))
                path_labels_mut.append(path_label)
            except Exception as exc:
                _cleanup_partial_upload(upload_root, excel_paths)
                self._pending_uploads.pop(session_id, None)
                return {
                    "ok": False,
                    "error": {
                        "message": f"保存上传文件失败: {base}",
                        "exception_type": type(exc).__name__,
                        "detail": str(exc),
                    },
                }

        return {
            "ok": True,
            "import_session_id": session_id,
            "uploaded_count": len(excel_paths),
        }

    def start_import_after_uploads(
        self, session_id: str, post_import_opts: dict[str, Any] | None = None
    ) -> dict:
        session_id = (session_id or "").strip()
        if not session_id:
            return {"ok": False, "error": {"message": "缺少 import_session_id"}}

        try:
            from db.duckdb_conn import get_conn
            from src.local_api.license_gate import check_invoice_quota

            conn = get_conn()
            denied = check_invoice_quota(conn)
            if denied:
                return denied
        except Exception:  # noqa: BLE001
            pass

        with self._lock:
            pend = self._pending_uploads.get(session_id)
            if not pend:
                return {"ok": False, "error": {"message": "会话不存在、已开始或已过期"}}
            excel_paths = list(pend["excel_paths"])
            if not excel_paths:
                return {"ok": False, "error": {"message": "尚未上传任何文件"}}
            batch_id = pend["batch_id"]
            ods_dir = pend["ods_dir"]
            target_sheet_keys = pend["target_sheet_keys"]
            fail_policy = pend["fail_policy"]
            force_reimport = bool(pend.get("force_reimport"))
            auto_dwd_after_import = bool(pend.get("auto_dwd_after_import"))
            rebuild_enterprise_year_rel = bool(pend.get("rebuild_enterprise_year_rel"))
            if isinstance(post_import_opts, dict):
                if "auto_dwd_after_import" in post_import_opts:
                    auto_dwd_after_import = _parse_truthy_flag(
                        post_import_opts.get("auto_dwd_after_import"),
                        default=auto_dwd_after_import,
                    )
                if "rebuild_enterprise_year_rel" in post_import_opts:
                    rebuild_enterprise_year_rel = _parse_truthy_flag(
                        post_import_opts.get("rebuild_enterprise_year_rel"),
                        default=rebuild_enterprise_year_rel,
                    )
            if rebuild_enterprise_year_rel and not auto_dwd_after_import:
                rebuild_enterprise_year_rel = False
            path_labels_list: list[str] = list(pend["path_labels"])
            field_mapping_template_id = pend.get("field_mapping_template_id")
            self._pending_uploads.pop(session_id, None)

        path_labels: list[str] | None = path_labels_list
        self._register_session(session_id)
        t = threading.Thread(
            target=self._run_import,
            args=(
                session_id,
                batch_id,
                ods_dir,
                excel_paths,
                target_sheet_keys,
                fail_policy,
                path_labels,
                force_reimport,
                auto_dwd_after_import,
                rebuild_enterprise_year_rel,
                field_mapping_template_id,
            ),
            daemon=True,
        )
        t.start()
        return {
            "ok": True,
            "import_session_id": session_id,
            "saved_paths": excel_paths,
            "auto_dwd_after_import": auto_dwd_after_import,
            "rebuild_enterprise_year_rel": rebuild_enterprise_year_rel,
        }

    def _register_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions[session_id] = {
                "events": [],
                "next_event_id": 1,
                "finished": False,
            }

    def _emit(self, session_id: str, ev_type: str, payload: dict) -> None:
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return
            eid = int(s["next_event_id"])
            s["next_event_id"] = eid + 1
            s["events"].append(
                {
                    "import_session_id": session_id,
                    "event_id": eid,
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "type": ev_type,
                    "payload": payload,
                }
            )
            # 控制内存：最多保留 5000 条事件
            if len(s["events"]) > 5000:
                s["events"] = s["events"][-5000:]

    def _finish(self, session_id: str) -> None:
        with self._lock:
            s = self._sessions.get(session_id)
            if s:
                s["finished"] = True

    def get_events(self, session_id: str, *, after_event_id: int) -> dict:
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return {"ok": False, "error": {"message": "session not found"}}
            events = [e for e in s["events"] if int(e.get("event_id") or 0) > int(after_event_id)]
            next_after = events[-1]["event_id"] if events else after_event_id
            return {"ok": True, "events": events, "next_after_event_id": next_after, "finished": bool(s["finished"])}

    def _run_import(
        self,
        session_id: str,
        batch_id: str,
        ods_dir: str,
        excel_paths: list[str],
        target_sheet_keys: list[str] | None,
        fail_policy: str,
        path_labels: list[str] | None = None,
        force_reimport: bool = False,
        auto_dwd_after_import: bool = False,
        rebuild_enterprise_year_rel: bool = False,
        field_mapping_template_id: str | None = None,
    ) -> None:
        from config.field_mapping import field_mapping_import_context
        from src.local_api.field_mapping_template_api import (
            field_mapping_template_meta_payload,
            resolve_import_field_mapping_template,
        )

        ok_files = 0
        fail_files = 0
        skip_files = 0

        resolved = resolve_import_field_mapping_template(field_mapping_template_id)
        tmpl_meta = field_mapping_template_meta_payload(resolved)

        conn = None
        try:
            from db.duckdb_conn import get_conn
            from db.schema_sqlfiles import init_all_tables

            conn = get_conn()
            init_all_tables(conn)
        except Exception:
            conn = None

        self._emit(
            session_id,
            "session_start",
            {
                "batch_date": batch_id,
                "total_files": len(excel_paths),
                "target_sheet_keys": target_sheet_keys or [],
                "fail_policy": fail_policy,
                "force_reimport": bool(force_reimport),
                "ods_dir": ods_dir,
                "duckdb_attached": conn is not None,
                "import_session_id": session_id,
                "field_mapping_template": tmpl_meta,
            },
        )

        with field_mapping_import_context(
            default_fields=resolved["default_field_aliases"],
            sheet_overrides=resolved["sheet_overrides"],
        ):
            for i, p in enumerate(excel_paths, start=1):
                file_name = Path(p).name
                file_key = p
                path_label: str | None = None
                if path_labels and len(path_labels) >= i:
                    lab = str(path_labels[i - 1]).strip()
                    if lab:
                        path_label = lab
                file_start_payload: dict[str, Any] = {
                    "file_key": file_key,
                    "file_name": file_name,
                    "file_index": i,
                    "total_files": len(excel_paths),
                }
                if path_label:
                    file_start_payload["path_label"] = path_label
                self._emit(session_id, "file_start", file_start_payload)

                try:
                    logs = load_excel_batch_to_ods(
                        excel_paths=[p],
                        ods_dir=ods_dir,
                        batch_id=batch_id,
                        import_workers=1,
                        import_session_id=session_id,
                        target_sheet_keys=target_sheet_keys,
                        conn=conn,
                        force_reimport=bool(force_reimport),
                        force_reason="ui_force_reimport" if force_reimport else None,
                        emit_event=lambda ev_type, payload: self._emit(session_id, str(ev_type), dict(payload or {})),
                        field_mapping_template_meta=tmpl_meta,
                    )
                except Exception as exc:
                    fail_files += 1
                    self._emit(
                        session_id,
                        "file_result",
                        {
                            "file_key": file_key,
                            "file_name": file_name,
                            "file_index": i,
                            "total_files": len(excel_paths),
                            "result": "failed",
                            "reason": f"导入异常：{type(exc).__name__}",
                            "exception_type": type(exc).__name__,
                        },
                    )
                    if fail_policy == "stop":
                        break
                    continue

                log0 = logs[0] if logs else {}
                status = str(log0.get("status") or "")
                file_blocking = bool(log0.get("file_blocking"))
                base_fr = {
                    "file_key": file_key,
                    "file_name": file_name,
                    "file_index": i,
                    "total_files": len(excel_paths),
                }
                if file_blocking or status == "失败":
                    fail_files += 1
                    self._emit(
                        session_id,
                        "file_result",
                        {
                            **base_fr,
                            "result": "failed",
                            "reason": log0.get("reason") or "失败",
                            "exception_type": log0.get("exception_type"),
                            "reject_row_ranges": log0.get("reject_row_ranges") or [],
                            "reject_row_samples": log0.get("reject_row_samples") or [],
                        },
                    )
                    if fail_policy == "stop":
                        break
                elif status == "跳过重复":
                    skip_files += 1
                    self._emit(
                        session_id,
                        "file_result",
                        {
                            **base_fr,
                            "result": "skipped",
                            "reason": "跳过重复",
                        },
                    )
                else:
                    ok_files += 1
                    self._emit(
                        session_id,
                        "file_result",
                        {
                            **base_fr,
                            "result": "success",
                            "rows_loaded": log0.get("rows_loaded"),
                            "rows_written_ods": log0.get("rows_written_ods"),
                            "rows_dropped_within_file": log0.get("rows_dropped_within_file"),
                            "reject_row_ranges": log0.get("reject_row_ranges") or [],
                            "reject_row_samples": log0.get("reject_row_samples") or [],
                        },
                    )

        self._emit(
            session_id,
            "session_end",
            {
                "success_files": ok_files,
                "failed_files": fail_files,
                "skipped_files": skip_files,
                "batch_date": batch_id,
                "ods_dir": ods_dir,
                "import_session_id": session_id,
                "field_mapping_template": tmpl_meta,
            },
        )

        if auto_dwd_after_import and ok_files > 0:
            self._emit(
                session_id,
                "post_dwd_begin",
                {
                    "import_batch_id": batch_id,
                    "import_session_id": session_id,
                    "rebuild_enterprise_year_rel": rebuild_enterprise_year_rel,
                },
            )
            dwd_out: dict[str, Any]
            try:
                from src.local_api.dwd_build import build_dwd_for_batch

                if conn is None:
                    from db.duckdb_conn import get_conn
                    from db.schema_sqlfiles import init_all_tables

                    conn = get_conn()
                    init_all_tables(conn)
                dwd_out = build_dwd_for_batch(
                    import_batch_id=batch_id,
                    import_session_ids=[session_id],
                    incremental=True,
                    rebuild_enterprise_year_rel=rebuild_enterprise_year_rel,
                )
            except Exception as exc:  # noqa: BLE001
                dwd_out = {
                    "ok": False,
                    "error": {
                        "message": f"导入后 DWD 构建异常：{type(exc).__name__}: {exc}",
                        "exception_type": type(exc).__name__,
                    },
                }
            end_payload: dict[str, Any] = {
                "ok": bool(dwd_out.get("ok")),
                "import_batch_id": batch_id,
                "import_session_id": session_id,
                "stat_years_built": dwd_out.get("stat_years_built") or [],
            }
            if dwd_out.get("enterprise_year_rel_rebuild") is not None:
                end_payload["enterprise_year_rel_rebuild"] = dwd_out.get("enterprise_year_rel_rebuild")
            if not dwd_out.get("ok"):
                end_payload["error"] = dwd_out.get("error")
            self._emit(session_id, "post_dwd_end", end_payload)

        self._finish(session_id)


_sessions = _SessionStore()

def main() -> int:
    # Windows 终端默认编码可能是 ANSI/GBK，统一切到 UTF-8 避免中文日志乱码。
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    host = (os.getenv("INVOICELENS_LOCAL_API_HOST") or "127.0.0.1").strip()
    port = int((os.getenv("INVOICELENS_LOCAL_API_PORT") or "8765").strip())
    assert_listen_port_free_or_exit(port)
    conn = None
    try:
        from db.duckdb_conn import get_conn, close_conn, warm_thread_local_connections
        from db.schema_sqlfiles import init_all_tables
        from src.bootstrap.dim_tax_code_seed import ensure_dim_tax_code_seeded

        conn = get_conn()
        init_all_tables(conn)
        seed_ret = ensure_dim_tax_code_seeded(conn)
        print(f"[InvoiceLensLocalAPI] dim_tax_code seed init: {seed_ret}")  # noqa: T201
        warmed = warm_thread_local_connections(count=4)
        print(f"[InvoiceLensLocalAPI] duckdb thread pool warmed: {warmed} connections")  # noqa: T201
    except Exception as exc:
        print(f"[InvoiceLensLocalAPI] bootstrap init warning: {type(exc).__name__}: {exc}")  # noqa: T201
    finally:
        close_conn()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[InvoiceLensLocalAPI] listening on http://{host}:{port}")  # noqa: T201
    print(  # noqa: T201
        "[InvoiceLensLocalAPI] 请保持本窗口运行；关闭后 Vite 的 /api 代理将出现 ECONNREFUSED（浏览器侧常显示为 502）。"
    )
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

