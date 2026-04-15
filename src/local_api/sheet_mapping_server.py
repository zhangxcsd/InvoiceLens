from __future__ import annotations

import errno
import json
import os
import re
import tempfile
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

import yaml

from config.field_mapping import get_field_mapping_config_info, save_field_mapping_config
from src.ingestion.excel_to_ods import load_excel_batch_to_ods
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


def _json(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


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


def _norm_target_keys_tuple(v: list[str] | None) -> tuple[str, ...]:
    if not v:
        return ()
    return tuple(sorted(str(x).strip() for x in v if str(x).strip()))


class Handler(BaseHTTPRequestHandler):
    server_version = "InvoiceLensLocalAPI/0.1"

    def _send(self, status: int, body: dict, *, cors: bool = True) -> None:
        data = _json(body)
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if cors:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
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

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path == "" or path == "/health":
            self._send(200, {"ok": True})
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

        self._send(404, {"ok": False, "error": {"message": "Not Found"}}, cors=True)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
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
            payload = _sessions.start_import_after_uploads(sid)
            self._send(200 if payload.get("ok") else 400, payload)
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
                from src.local_api.dwd_build import build_dwd_for_batch

                payload = build_dwd_for_batch(
                    import_batch_id=bid,
                    stat_year=stat_year,
                    incremental=incremental,
                    import_session_ids=import_session_ids,
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
                err = (payload.get("error") or {}) if isinstance(payload.get("error"), dict) else {}
                ec = str(err.get("code") or "")
                code = 400 if ec in {"no_ods_batch", "stat_year_required", "invalid_stat_year"} else 500
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
        self._send(404, {"ok": False, "error": {"message": "Not Found"}}, cors=True)


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
                self._pending_uploads[session_id] = {
                    "batch_id": batch_id,
                    "ods_dir": ods_dir,
                    "target_sheet_keys": target_sheet_keys,
                    "target_tuple": t_tuple,
                    "fail_policy": fail_policy,
                    "force_reimport": force_reimport,
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

    def start_import_after_uploads(self, session_id: str) -> dict:
        session_id = (session_id or "").strip()
        if not session_id:
            return {"ok": False, "error": {"message": "缺少 import_session_id"}}

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
            path_labels_list: list[str] = list(pend["path_labels"])
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
            ),
            daemon=True,
        )
        t.start()
        return {"ok": True, "import_session_id": session_id, "saved_paths": excel_paths}

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
    ) -> None:
        ok_files = 0
        fail_files = 0
        skip_files = 0

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
            },
        )

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
            },
        )
        self._finish(session_id)


_sessions = _SessionStore()

def main() -> int:
    host = (os.getenv("INVOICELENS_LOCAL_API_HOST") or "127.0.0.1").strip()
    port = int((os.getenv("INVOICELENS_LOCAL_API_PORT") or "8765").strip())
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[InvoiceLensLocalAPI] listening on http://{host}:{port}")  # noqa: T201
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

