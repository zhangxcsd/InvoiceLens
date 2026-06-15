"""字段映射模板持久化（本地 JSON + 内置 default 来自 field_mapping.yaml）。"""

from __future__ import annotations

import io
import json
import logging
import re
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

# ---------------------------------------------------------------------------
# 模板包 ZIP 格式（最小约定，便于跨环境分享字段映射模板）：
#
#   template_package.zip
#   ├── template.json          # 必需（或 field_mapping.json）：name、description、default_fields、sheets
#   ├── manifest.json          # 可选：name、description、version（覆盖/补充 template.json 元数据）
#   └── samples/               # 可选：样例 Excel，仅供参考/下载，不会自动导入 ODS
#       └── *.xlsx
#
# 导入策略：默认「导入为新模板」；若 manifest 含 template_id 且本地已存在，
# 须显式 overwrite=true 才会覆盖（内置 builtin_default 不可覆盖）。
# ---------------------------------------------------------------------------

_ZIP_MAX_BYTES = 20 * 1024 * 1024
_ZIP_MAX_MEMBERS = 128
_ZIP_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
_ZIP_MAX_SINGLE_MEMBER_BYTES = 16 * 1024 * 1024
_TEMPLATE_JSON_BASENAMES = frozenset({"template.json", "field_mapping.json"})
_MANIFEST_BASENAME = "manifest.json"

from config.field_mapping import (
    _sanitize_field_entry_block,
    _sanitize_sheets_entry_blocks,
    get_field_mapping_config_info,
    merge_default_field_aliases,
    save_field_mapping_config,
)

logger = logging.getLogger(__name__)

_BUILTIN_TEMPLATE_ID = "builtin_default"
_STORE_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "field_mapping_templates.json"
_SAMPLES_ROOT = Path(__file__).resolve().parents[2] / "data" / "config" / "field_mapping_templates"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _load_store() -> dict[str, Any]:
    if not _STORE_PATH.is_file():
        return {"version": 1, "active_template_id": _BUILTIN_TEMPLATE_ID, "templates": []}
    try:
        raw = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("invalid root")
        templates = raw.get("templates")
        if not isinstance(templates, list):
            templates = []
        active = str(raw.get("active_template_id") or _BUILTIN_TEMPLATE_ID).strip() or _BUILTIN_TEMPLATE_ID
        return {"version": int(raw.get("version") or 1), "active_template_id": active, "templates": templates}
    except Exception as exc:
        logger.warning("field mapping templates load failed: %s", exc)
        return {"version": 1, "active_template_id": _BUILTIN_TEMPLATE_ID, "templates": []}


def _save_store(store: dict[str, Any]) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STORE_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _builtin_template_payload() -> dict[str, Any]:
    cfg, source = get_field_mapping_config_info()
    default_fields = cfg.get("default_fields") or {}
    sheets = cfg.get("sheets") or {}
    return {
        "template_id": _BUILTIN_TEMPLATE_ID,
        "name": "内置默认映射",
        "description": f"来自 {source} 的运行时字段映射。",
        "default_fields": default_fields,
        "sheets": sheets,
        "is_builtin": True,
        "updated_at": _now_iso(),
        "default_field_count": len(default_fields),
        "sheet_count": len(sheets),
    }


def _template_summary(item: dict[str, Any], *, active_id: str) -> dict[str, Any]:
    tid = str(item.get("template_id") or "").strip()
    default_fields = item.get("default_fields") if isinstance(item.get("default_fields"), dict) else {}
    sheets = item.get("sheets") if isinstance(item.get("sheets"), dict) else {}
    samples = _list_template_samples(tid)
    return {
        "template_id": tid,
        "name": str(item.get("name") or "").strip(),
        "description": str(item.get("description") or "").strip(),
        "is_builtin": bool(item.get("is_builtin")),
        "is_active": tid == active_id,
        "default_field_count": len(default_fields),
        "sheet_count": len(sheets),
        "updated_at": str(item.get("updated_at") or ""),
        "sample_excel_count": len(samples),
    }


def _find_user_template(store: dict[str, Any], template_id: str) -> dict[str, Any] | None:
    tid = str(template_id or "").strip()
    for item in store.get("templates") or []:
        if isinstance(item, dict) and str(item.get("template_id") or "") == tid:
            return item
    return None


def _resolve_template(template_id: str) -> dict[str, Any] | None:
    tid = str(template_id or "").strip()
    if not tid or tid == _BUILTIN_TEMPLATE_ID:
        return _builtin_template_payload()
    store = _load_store()
    item = _find_user_template(store, tid)
    if not item:
        return None
    default_fields = item.get("default_fields") if isinstance(item.get("default_fields"), dict) else {}
    sheets = item.get("sheets") if isinstance(item.get("sheets"), dict) else {}
    return {
        "template_id": tid,
        "name": str(item.get("name") or "").strip(),
        "description": str(item.get("description") or "").strip(),
        "default_fields": default_fields,
        "sheets": sheets,
        "is_builtin": False,
        "updated_at": str(item.get("updated_at") or _now_iso()),
        "default_field_count": len(default_fields),
        "sheet_count": len(sheets),
    }


def _api_entries_to_alias_map(entries: Any) -> dict[str, list[str]]:
    if not isinstance(entries, dict):
        return {}
    out: dict[str, list[str]] = {}
    for k, v in entries.items():
        if not isinstance(k, str) or not k.strip():
            continue
        key = k.strip()
        aliases_raw: Any = v
        if isinstance(v, dict):
            aliases_raw = v.get("aliases")
        if not isinstance(aliases_raw, list):
            out[key] = []
            continue
        aliases: list[str] = []
        for x in aliases_raw:
            if x is None:
                continue
            sx = str(x).strip()
            if sx:
                aliases.append(sx)
        out[key] = aliases
    return out


def get_active_field_mapping_template_id() -> str:
    store = _load_store()
    return str(store.get("active_template_id") or _BUILTIN_TEMPLATE_ID)


def resolve_import_field_mapping_template(template_id: str | None = None) -> dict[str, Any]:
    """
    解析导入应使用的字段映射模板（显式 template_id 或当前激活模板）。
    返回运行时别名表 + 会话可追溯元数据。
    """
    active_id = get_active_field_mapping_template_id()
    tid = str(template_id or "").strip() or active_id
    tpl = _resolve_template(tid)
    if not tpl:
        tpl = _builtin_template_payload()
        tid = _BUILTIN_TEMPLATE_ID

    default_entries = tpl.get("default_fields") if isinstance(tpl.get("default_fields"), dict) else {}
    sheets_entries = tpl.get("sheets") if isinstance(tpl.get("sheets"), dict) else {}
    default_aliases = merge_default_field_aliases(_api_entries_to_alias_map(default_entries))

    sheet_overrides: dict[str, dict[str, list[str]]] = {}
    for sk, block in sheets_entries.items():
        if not isinstance(sk, str) or not sk.strip():
            continue
        if isinstance(block, dict):
            sheet_overrides[sk.strip()] = _api_entries_to_alias_map(block)

    return {
        "template_id": tid,
        "template_name": str(tpl.get("name") or "").strip(),
        "template_updated_at": str(tpl.get("updated_at") or ""),
        "is_builtin": bool(tpl.get("is_builtin")),
        "is_active": tid == active_id,
        "default_field_aliases": default_aliases,
        "sheet_overrides": sheet_overrides,
    }


def field_mapping_template_meta_payload(resolved: dict[str, Any]) -> dict[str, str]:
    return {
        "template_id": str(resolved.get("template_id") or ""),
        "template_name": str(resolved.get("template_name") or ""),
        "template_updated_at": str(resolved.get("template_updated_at") or ""),
    }


def _validate_mapping_body(default_fields: Any, sheets: Any) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, dict[str, Any]]], str | None]:
    default_entries, derr = _sanitize_field_entry_block(default_fields, label="default_fields")
    if derr:
        return {}, {}, derr
    if not default_entries:
        return {}, {}, "default_fields 不能为空"
    sheets_map, serr = _sanitize_sheets_entry_blocks(sheets if sheets is not None else {})
    if serr:
        return {}, {}, serr
    return default_entries, sheets_map or {}, None


def _safe_zip_arcname(name: str) -> bool:
    """拒绝绝对路径与 path traversal（../）。"""
    raw = str(name or "").replace("\\", "/").strip()
    if not raw or raw.startswith("/"):
        return False
    parts = PurePosixPath(raw).parts
    if any(p in ("", ".", "..") for p in parts):
        return False
    return True


def _read_zip_member_text(zf: zipfile.ZipFile, info: zipfile.ZipInfo, *, max_bytes: int) -> str | None:
    try:
        size = int(info.file_size or 0)
        if size <= 0 or size > max_bytes:
            return None
        with zf.open(info) as src:
            raw = src.read(max_bytes + 1)
        if len(raw) > max_bytes:
            return None
        return raw.decode("utf-8-sig")
    except Exception:
        return None


def _pick_template_json_member(infos: list[zipfile.ZipInfo]) -> zipfile.ZipInfo | None:
    candidates: list[tuple[int, str, zipfile.ZipInfo]] = []
    for info in infos:
        if info.is_dir():
            continue
        arc = info.filename.replace("\\", "/")
        if not _safe_zip_arcname(arc):
            continue
        base = PurePosixPath(arc).name.lower()
        if base not in _TEMPLATE_JSON_BASENAMES:
            continue
        depth = len(PurePosixPath(arc).parts)
        candidates.append((depth, arc, info))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], x[1]))
    return candidates[0][2]


def _find_manifest_json(zf: zipfile.ZipFile, infos: list[zipfile.ZipInfo]) -> dict[str, Any] | None:
    for info in infos:
        if info.is_dir():
            continue
        arc = info.filename.replace("\\", "/")
        if not _safe_zip_arcname(arc):
            continue
        if PurePosixPath(arc).name.lower() != _MANIFEST_BASENAME:
            continue
        text = _read_zip_member_text(zf, info, max_bytes=256 * 1024)
        if not text:
            continue
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return None


def _count_sample_excel_members(infos: list[zipfile.ZipInfo]) -> int:
    return len(_iter_sample_excel_infos(infos))


def _iter_sample_excel_infos(infos: list[zipfile.ZipInfo]) -> list[zipfile.ZipInfo]:
    out: list[zipfile.ZipInfo] = []
    for info in infos:
        if info.is_dir():
            continue
        arc = info.filename.replace("\\", "/")
        if not _safe_zip_arcname(arc):
            continue
        parts = PurePosixPath(arc).parts
        if not parts or parts[0].lower() != "samples":
            continue
        lower = parts[-1].lower()
        if lower.endswith(".xlsx") or lower.endswith(".xls"):
            out.append(info)
    return out


def _safe_template_id_for_path(template_id: str) -> str | None:
    tid = str(template_id or "").strip()
    if not tid or not re.match(r"^[\w\-]+$", tid):
        return None
    return tid


def _template_samples_dir(template_id: str) -> Path | None:
    tid = _safe_template_id_for_path(template_id)
    if not tid or tid == _BUILTIN_TEMPLATE_ID:
        return None
    return _SAMPLES_ROOT / tid / "samples"


def _clear_template_samples(template_id: str) -> None:
    root = _template_samples_dir(template_id)
    if root is None:
        return
    parent = root.parent
    try:
        if parent.is_dir():
            shutil.rmtree(parent, ignore_errors=True)
    except Exception as exc:
        logger.warning("clear template samples failed for %s: %s", template_id, exc)


def _persist_samples_from_zip_bytes(
    zip_bytes: bytes,
    template_id: str,
    *,
    replace: bool,
) -> tuple[int, list[str], list[str]]:
    """从模板包 ZIP 提取 samples/ 下 Excel 到磁盘。返回 (count, filenames, read_errors)。"""
    samples_dir = _template_samples_dir(template_id)
    if samples_dir is None:
        return 0, [], []

    if replace:
        _clear_template_samples(template_id)

    saved: list[str] = []
    errors: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            file_infos = [i for i in zf.infolist() if not i.is_dir()]
            for info in _iter_sample_excel_infos(file_infos):
                arc = info.filename.replace("\\", "/")
                base_name = PurePosixPath(arc).name
                if not base_name or base_name.startswith("."):
                    errors.append(f"{arc}：非法文件名")
                    continue
                size = int(info.file_size or 0)
                if size <= 0 or size > _ZIP_MAX_SINGLE_MEMBER_BYTES:
                    errors.append(f"{arc}：文件大小无效或超限")
                    continue
                try:
                    with zf.open(info) as src:
                        data = src.read(_ZIP_MAX_SINGLE_MEMBER_BYTES + 1)
                    if len(data) > _ZIP_MAX_SINGLE_MEMBER_BYTES:
                        errors.append(f"{arc}：解压后超限")
                        continue
                    lower = base_name.lower()
                    if lower.endswith(".xlsx") and data[:2] != b"PK":
                        errors.append(f"{arc}：非有效 xlsx（ZIP 头缺失）")
                        continue
                except Exception as exc:
                    errors.append(f"{arc}：读取失败（{type(exc).__name__}）")
                    continue

                samples_dir.mkdir(parents=True, exist_ok=True)
                dest = samples_dir / base_name
                # 防 path traversal：dest 必须在 samples_dir 内
                try:
                    dest.resolve().relative_to(samples_dir.resolve())
                except ValueError:
                    errors.append(f"{arc}：目标路径非法")
                    continue
                try:
                    dest.write_bytes(data)
                    saved.append(base_name)
                except Exception as exc:
                    errors.append(f"{arc}：写入失败（{type(exc).__name__}）")
    except zipfile.BadZipFile:
        errors.append("无效的 ZIP 文件")
    except Exception as exc:
        logger.exception("persist_samples_from_zip")
        errors.append(f"样例持久化失败：{type(exc).__name__}")

    return len(saved), saved, errors


def _list_template_samples(template_id: str) -> list[dict[str, Any]]:
    samples_dir = _template_samples_dir(template_id)
    if samples_dir is None or not samples_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    try:
        for p in sorted(samples_dir.iterdir()):
            if not p.is_file():
                continue
            lower = p.name.lower()
            if not (lower.endswith(".xlsx") or lower.endswith(".xls")):
                continue
            try:
                st = p.stat()
                out.append(
                    {
                        "filename": p.name,
                        "size_bytes": int(st.st_size),
                        "updated_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
                        .replace(microsecond=0)
                        .isoformat()
                        .replace("+00:00", "Z"),
                    }
                )
            except Exception:
                out.append({"filename": p.name, "size_bytes": 0, "updated_at": ""})
    except Exception as exc:
        logger.warning("list template samples failed for %s: %s", template_id, exc)
    return out


def _append_samples_to_export_zip(zf: zipfile.ZipFile, template_id: str) -> int:
    samples_dir = _template_samples_dir(template_id)
    if samples_dir is None or not samples_dir.is_dir():
        return 0
    n = 0
    for p in sorted(samples_dir.iterdir()):
        if not p.is_file():
            continue
        lower = p.name.lower()
        if not (lower.endswith(".xlsx") or lower.endswith(".xls")):
            continue
        try:
            data = p.read_bytes()
            if len(data) > _ZIP_MAX_SINGLE_MEMBER_BYTES:
                logger.warning("skip oversized sample on export: %s", p.name)
                continue
            zf.writestr(f"samples/{p.name}", data)
            n += 1
        except Exception as exc:
            logger.warning("export sample %s failed: %s", p.name, exc)
    return n


def _parse_template_package_zip(zip_bytes: bytes) -> tuple[dict[str, Any] | None, str | None]:
    if not zip_bytes:
        return None, "ZIP 文件为空"
    if len(zip_bytes) > _ZIP_MAX_BYTES:
        return None, f"ZIP 超过上限 {_ZIP_MAX_BYTES // (1024 * 1024)}MB"
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            file_infos = [i for i in zf.infolist() if not i.is_dir()]
            if len(file_infos) > _ZIP_MAX_MEMBERS:
                return None, f"ZIP 成员过多（>{_ZIP_MAX_MEMBERS}）"

            total_uncompressed = 0
            for info in file_infos:
                if not _safe_zip_arcname(info.filename):
                    return None, f"非法 ZIP 路径：{info.filename}"
                size = int(info.file_size or 0)
                total_uncompressed += size
                if total_uncompressed > _ZIP_MAX_UNCOMPRESSED_BYTES:
                    return None, "ZIP 解压总量超限（疑似解压炸弹）"
                if size > _ZIP_MAX_SINGLE_MEMBER_BYTES:
                    return None, f"ZIP 成员过大：{info.filename}"

            tpl_info = _pick_template_json_member(file_infos)
            if tpl_info is None:
                return None, "ZIP 中缺少 template.json 或 field_mapping.json"

            tpl_text = _read_zip_member_text(zf, tpl_info, max_bytes=_ZIP_MAX_SINGLE_MEMBER_BYTES)
            if not tpl_text:
                return None, "无法读取模板 JSON"
            try:
                tpl_body = json.loads(tpl_text)
            except Exception as exc:
                return None, f"模板 JSON 解析失败：{exc}"
            if not isinstance(tpl_body, dict):
                return None, "模板 JSON 须为对象"

            manifest = _find_manifest_json(zf, file_infos) or {}
            manifest_template_id = str(manifest.get("template_id") or "").strip()
            name = str(tpl_body.get("name") or manifest.get("name") or "").strip()
            description = str(tpl_body.get("description") or manifest.get("description") or "").strip()
            default_entries, sheets_entries, verr = _validate_mapping_body(
                tpl_body.get("default_fields"),
                tpl_body.get("sheets"),
            )
            if verr:
                return None, verr
            if not name:
                return None, "模板名称不能为空（请在 template.json 或 manifest.json 中提供 name）"
            if len(name) > 120:
                return None, "模板名称过长（上限 120 字符）"

            sample_count = _count_sample_excel_members(file_infos)
            sample_read_errors = _validate_sample_excel_members(zf, file_infos)
            return {
                "name": name,
                "description": description,
                "default_fields": default_entries,
                "sheets": sheets_entries,
                "manifest_version": str(manifest.get("version") or "").strip(),
                "manifest_template_id": manifest_template_id,
                "sample_excel_count": sample_count,
                "sample_read_errors": sample_read_errors,
                "source_arcname": tpl_info.filename.replace("\\", "/"),
            }, None
    except zipfile.BadZipFile:
        return None, "无效的 ZIP 文件"
    except Exception as exc:
        logger.exception("parse_template_package_zip")
        return None, f"ZIP 解析失败：{exc}"


def _validate_sample_excel_members(zf: zipfile.ZipFile, infos: list[zipfile.ZipInfo]) -> list[str]:
    """轻量校验 samples/ 下 Excel 可读性（不导入 ODS，仅记录警告）。"""
    errors: list[str] = []
    for info in infos:
        if info.is_dir():
            continue
        arc = info.filename.replace("\\", "/")
        if not _safe_zip_arcname(arc):
            continue
        parts = PurePosixPath(arc).parts
        if not parts or parts[0].lower() != "samples":
            continue
        lower = parts[-1].lower()
        if not (lower.endswith(".xlsx") or lower.endswith(".xls")):
            continue
        try:
            with zf.open(info) as src:
                head = src.read(4)
            if lower.endswith(".xlsx") and head[:2] != b"PK":
                errors.append(f"{arc}：非有效 xlsx（ZIP 头缺失）")
        except Exception as exc:
            errors.append(f"{arc}：读取失败（{type(exc).__name__}）")
    return errors


def _append_imported_template(entry: dict[str, Any]) -> dict[str, Any]:
    store = _load_store()
    templates = [t for t in (store.get("templates") or []) if isinstance(t, dict)]
    templates.append(entry)
    store["templates"] = templates
    _save_store(store)
    return entry


def _upsert_imported_template(entry: dict[str, Any], *, overwrite: bool) -> tuple[dict[str, Any], bool, str | None]:
    """写入模板；overwrite 时替换同 id 条目。返回 (entry, created, error_message)。"""
    tid = str(entry.get("template_id") or "").strip()
    if not tid:
        return entry, False, "template_id 不能为空"
    if tid == _BUILTIN_TEMPLATE_ID:
        return entry, False, "内置模板不可覆盖"

    store = _load_store()
    templates = [t for t in (store.get("templates") or []) if isinstance(t, dict)]
    existing_idx = next(
        (i for i, t in enumerate(templates) if str(t.get("template_id") or "") == tid),
        None,
    )
    if existing_idx is not None:
        if not overwrite:
            existing = templates[existing_idx]
            return existing, False, None
        templates[existing_idx] = entry
        store["templates"] = templates
        _save_store(store)
        return entry, False, None

    templates.append(entry)
    store["templates"] = templates
    _save_store(store)
    return entry, True, None


def api_field_mapping_template_preview_zip(
    zip_bytes: bytes,
    *,
    filename: str = "",
) -> dict[str, Any]:
    """预览 ZIP 导入：解析元数据并检测 template_id 冲突。"""
    try:
        parsed, perr = _parse_template_package_zip(zip_bytes)
        if perr or not parsed:
            return {"ok": False, "error": {"code": "invalid_zip", "message": perr or "ZIP 无效"}}

        manifest_tid = str(parsed.get("manifest_template_id") or "").strip()
        conflict: dict[str, Any] | None = None
        if manifest_tid and manifest_tid != _BUILTIN_TEMPLATE_ID:
            existing = _resolve_template(manifest_tid)
            if existing and not existing.get("is_builtin"):
                conflict = {
                    "template_id": manifest_tid,
                    "existing_name": str(existing.get("name") or ""),
                    "import_name": str(parsed.get("name") or ""),
                }

        return {
            "ok": True,
            "preview": {
                "name": str(parsed.get("name") or ""),
                "description": str(parsed.get("description") or ""),
                "manifest_template_id": manifest_tid or None,
                "manifest_version": str(parsed.get("manifest_version") or ""),
                "sample_excel_count": int(parsed.get("sample_excel_count") or 0),
                "sample_read_errors": parsed.get("sample_read_errors") or [],
                "source_filename": str(filename or "").strip(),
                "has_conflict": conflict is not None,
                "conflict": conflict,
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_template_preview_zip")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _safe_export_filename(name: str, *, suffix: str = ".zip") -> str:
    base = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", str(name or "").strip()).strip("._") or "field_mapping_template"
    if not base.lower().endswith(suffix):
        base = f"{base}{suffix}"
    return base[:120]


def api_field_mapping_template_import_zip(
    zip_bytes: bytes,
    *,
    filename: str = "",
    name_override: str = "",
    overwrite: bool = False,
    activate: bool = False,
) -> dict[str, Any]:
    """从模板包 ZIP 导入自定义模板；manifest 含 template_id 且本地已存在时需 overwrite。"""
    try:
        parsed, perr = _parse_template_package_zip(zip_bytes)
        if perr or not parsed:
            return {"ok": False, "error": {"code": "invalid_zip", "message": perr or "ZIP 无效"}}

        name = str(name_override or parsed.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": {"code": "name_required", "message": "模板名称不能为空"}}
        if len(name) > 120:
            return {"ok": False, "error": {"code": "name_too_long", "message": "模板名称过长（上限 120 字符）"}}

        manifest_tid = str(parsed.get("manifest_template_id") or "").strip()
        use_overwrite = bool(overwrite)
        if manifest_tid and manifest_tid != _BUILTIN_TEMPLATE_ID:
            existing = _resolve_template(manifest_tid)
            if existing and not existing.get("is_builtin"):
                if not use_overwrite:
                    return {
                        "ok": False,
                        "error": {
                            "code": "template_id_conflict",
                            "message": f"模板 ID「{manifest_tid}」已存在（{existing.get('name')}），请确认覆盖后重试",
                            "template_id": manifest_tid,
                            "existing_name": str(existing.get("name") or ""),
                        },
                    }
                tid = manifest_tid
            else:
                tid = manifest_tid if manifest_tid else f"fm_tpl_{uuid.uuid4().hex[:10]}"
        else:
            tid = f"fm_tpl_{uuid.uuid4().hex[:10]}"

        entry = {
            "template_id": tid,
            "name": name,
            "description": str(parsed.get("description") or "").strip(),
            "default_fields": parsed.get("default_fields") or {},
            "sheets": parsed.get("sheets") or {},
            "is_builtin": False,
            "updated_at": _now_iso(),
        }
        saved, created, uerr = _upsert_imported_template(entry, overwrite=use_overwrite)
        if uerr:
            return {"ok": False, "error": {"code": "upsert_failed", "message": uerr}}

        persisted_n, persisted_names, persist_errors = _persist_samples_from_zip_bytes(
            zip_bytes,
            tid,
            replace=use_overwrite or created,
        )
        sample_errors = list(parsed.get("sample_read_errors") or [])
        sample_errors.extend(persist_errors)

        activated = False
        if activate:
            act = api_field_mapping_template_activate({"template_id": tid})
            activated = bool(act.get("ok"))
            if not activated:
                logger.warning("import activate failed: %s", act.get("error"))

        store = _load_store()
        active_id = str(store.get("active_template_id") or _BUILTIN_TEMPLATE_ID)
        summary = _template_summary(saved, active_id=active_id)
        return {
            "ok": True,
            "created": created,
            "overwritten": not created and use_overwrite,
            "activated": activated,
            "template_id": tid,
            "template": saved,
            "summary": summary,
            "import_meta": {
                "source_filename": str(filename or "").strip(),
                "source_arcname": str(parsed.get("source_arcname") or ""),
                "manifest_version": str(parsed.get("manifest_version") or ""),
                "manifest_template_id": manifest_tid or None,
                "sample_excel_count": int(parsed.get("sample_excel_count") or 0),
                "sample_persisted_count": persisted_n,
                "sample_persisted_files": persisted_names,
                "sample_read_errors": sample_errors,
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_template_import_zip")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_field_mapping_template_export_zip(
    template_id: str,
) -> tuple[int, bytes | dict[str, Any], str, str]:
    """导出模板为 ZIP：(status, body_or_error, content_type, download_name)。"""
    try:
        tpl = _resolve_template(template_id)
        if not tpl:
            return 404, {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}, "", ""

        manifest = {
            "name": str(tpl.get("name") or "").strip(),
            "description": str(tpl.get("description") or "").strip(),
            "version": "1.0",
            "exported_at": _now_iso(),
            "template_id": str(tpl.get("template_id") or ""),
            "format": "invoicelens-field-mapping-template-v1",
        }
        template_json = {
            "name": manifest["name"],
            "description": manifest["description"],
            "default_fields": tpl.get("default_fields") or {},
            "sheets": tpl.get("sheets") or {},
        }
        tid = str(tpl.get("template_id") or "")
        disk_samples = _list_template_samples(tid)
        if disk_samples:
            manifest["sample_excel_count"] = len(disk_samples)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                "template.json",
                json.dumps(template_json, ensure_ascii=False, indent=2) + "\n",
            )
            zf.writestr(
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            )
            readme = (
                "InvoiceLens 字段映射模板包\n"
                "必需：template.json（default_fields + sheets）\n"
                "可选：manifest.json；samples/ 下可放样例 Excel（仅供参考，不会自动导入 ODS）。\n"
            )
            zf.writestr("README.txt", readme)
            _append_samples_to_export_zip(zf, tid)

        fname = _safe_export_filename(manifest["name"] or template_id)
        return 200, buf.getvalue(), "application/zip", fname
    except Exception as exc:
        logger.exception("field_mapping_template_export_zip")
        return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""


def api_field_mapping_template_sample_download(
    template_id: str,
    filename: str,
) -> tuple[int, bytes | dict[str, Any], str, str]:
    """下载模板已持久化的样例 Excel：(status, body_or_error, content_type, download_name)。"""
    try:
        tid = _safe_template_id_for_path(template_id)
        if not tid or tid == _BUILTIN_TEMPLATE_ID:
            return 404, {"ok": False, "error": {"code": "not_found", "message": "模板不存在或无样例"}}, "", ""
        tpl = _resolve_template(tid)
        if not tpl:
            return 404, {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}, "", ""

        raw_name = PurePosixPath(str(filename or "").replace("\\", "/")).name
        if not raw_name or raw_name.startswith("."):
            return 400, {"ok": False, "error": {"code": "invalid_filename", "message": "非法文件名"}}, "", ""
        lower = raw_name.lower()
        if not (lower.endswith(".xlsx") or lower.endswith(".xls")):
            return 400, {"ok": False, "error": {"code": "invalid_filename", "message": "仅支持 .xlsx/.xls"}}, "", ""

        samples_dir = _template_samples_dir(tid)
        if samples_dir is None or not samples_dir.is_dir():
            return 404, {"ok": False, "error": {"code": "not_found", "message": "样例不存在"}}, "", ""

        target = samples_dir / raw_name
        try:
            target.resolve().relative_to(samples_dir.resolve())
        except ValueError:
            return 400, {"ok": False, "error": {"code": "invalid_filename", "message": "非法文件名"}}, "", ""
        if not target.is_file():
            return 404, {"ok": False, "error": {"code": "not_found", "message": "样例不存在"}}, "", ""

        try:
            data = target.read_bytes()
        except Exception as exc:
            return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""

        ctype = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if lower.endswith(".xlsx")
            else "application/vnd.ms-excel"
        )
        return 200, data, ctype, raw_name
    except Exception as exc:
        logger.exception("field_mapping_template_sample_download")
        return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""


def api_field_mapping_templates_list() -> dict[str, Any]:
    try:
        store = _load_store()
        active_id = str(store.get("active_template_id") or _BUILTIN_TEMPLATE_ID)
        templates: list[dict[str, Any]] = []
        builtin = _builtin_template_payload()
        templates.append({**_template_summary(builtin, active_id=active_id), "is_builtin": True})
        for item in store.get("templates") or []:
            if not isinstance(item, dict):
                continue
            tid = str(item.get("template_id") or "").strip()
            if not tid or tid == _BUILTIN_TEMPLATE_ID:
                continue
            templates.append(_template_summary(item, active_id=active_id))
        return {
            "ok": True,
            "templates": templates,
            "active_template_id": active_id,
            "store_path": str(_STORE_PATH),
            "builtin_template_id": _BUILTIN_TEMPLATE_ID,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_templates_list")
        return {"ok": False, "templates": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_field_mapping_template_get(template_id: str) -> dict[str, Any]:
    try:
        tpl = _resolve_template(template_id)
        if not tpl:
            return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}
        store = _load_store()
        active_id = str(store.get("active_template_id") or _BUILTIN_TEMPLATE_ID)
        tpl["is_active"] = tpl["template_id"] == active_id
        tpl["samples"] = _list_template_samples(str(tpl.get("template_id") or ""))
        tpl["sample_excel_count"] = len(tpl["samples"])
        return {"ok": True, "template": tpl}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_field_mapping_template_create(body: dict[str, Any]) -> dict[str, Any]:
    try:
        name = str(body.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": {"code": "name_required", "message": "模板名称不能为空"}}
        if len(name) > 120:
            return {"ok": False, "error": {"code": "name_too_long", "message": "模板名称过长（上限 120 字符）"}}

        source_id = str(body.get("source_template_id") or body.get("copy_from") or _BUILTIN_TEMPLATE_ID).strip()
        source = _resolve_template(source_id)
        if not source:
            return {"ok": False, "error": {"code": "source_not_found", "message": "源模板不存在"}}

        tid = f"fm_tpl_{uuid.uuid4().hex[:10]}"
        entry = {
            "template_id": tid,
            "name": name,
            "description": str(body.get("description") or "").strip(),
            "default_fields": source.get("default_fields") or {},
            "sheets": source.get("sheets") or {},
            "is_builtin": False,
            "updated_at": _now_iso(),
        }

        store = _load_store()
        templates = [t for t in (store.get("templates") or []) if isinstance(t, dict)]
        templates.append(entry)
        store["templates"] = templates
        _save_store(store)
        return {"ok": True, "template": entry, "created": True}
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_template_create")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_field_mapping_template_save(body: dict[str, Any]) -> dict[str, Any]:
    try:
        tid = str(body.get("template_id") or "").strip()
        if not tid:
            return {"ok": False, "error": {"code": "id_required", "message": "template_id 不能为空"}}
        if tid == _BUILTIN_TEMPLATE_ID:
            return {"ok": False, "error": {"code": "builtin_readonly", "message": "内置模板不可修改"}}

        name = str(body.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": {"code": "name_required", "message": "模板名称不能为空"}}

        default_fields = body.get("default_fields")
        sheets = body.get("sheets")
        if default_fields is None:
            existing = _resolve_template(tid)
            if not existing:
                return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}
            default_fields = existing.get("default_fields")
            if sheets is None:
                sheets = existing.get("sheets")

        default_entries, sheets_entries, verr = _validate_mapping_body(default_fields, sheets)
        if verr:
            return {"ok": False, "error": {"code": "validation_error", "message": verr}}

        store = _load_store()
        templates = [t for t in (store.get("templates") or []) if isinstance(t, dict)]
        replaced = False
        entry = {
            "template_id": tid,
            "name": name,
            "description": str(body.get("description") or "").strip(),
            "default_fields": default_entries,
            "sheets": sheets_entries,
            "is_builtin": False,
            "updated_at": _now_iso(),
        }
        for i, item in enumerate(templates):
            if str(item.get("template_id") or "") == tid:
                templates[i] = entry
                replaced = True
                break
        if not replaced:
            return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}

        store["templates"] = templates
        _save_store(store)
        return {"ok": True, "template": entry}
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_template_save")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_field_mapping_template_delete(template_id: str) -> dict[str, Any]:
    try:
        tid = str(template_id or "").strip()
        if not tid or not re.match(r"^[\w\-]+$", tid):
            return {"ok": False, "error": {"code": "invalid_id", "message": "非法 template_id"}}
        if tid == _BUILTIN_TEMPLATE_ID:
            return {"ok": False, "error": {"code": "builtin_readonly", "message": "内置模板不可删除"}}

        store = _load_store()
        kept: list[dict[str, Any]] = []
        deleted = False
        for item in store.get("templates") or []:
            if not isinstance(item, dict):
                continue
            if str(item.get("template_id") or "") == tid:
                deleted = True
                continue
            kept.append(item)
        if not deleted:
            return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}

        if str(store.get("active_template_id") or "") == tid:
            store["active_template_id"] = _BUILTIN_TEMPLATE_ID
        store["templates"] = kept
        _save_store(store)
        _clear_template_samples(tid)
        return {"ok": True, "template_id": tid}
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_template_delete")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_field_mapping_template_activate(body: dict[str, Any]) -> dict[str, Any]:
    try:
        tid = str(body.get("template_id") or "").strip()
        if not tid:
            return {"ok": False, "error": {"code": "id_required", "message": "template_id 不能为空"}}

        tpl = _resolve_template(tid)
        if not tpl:
            return {"ok": False, "error": {"code": "not_found", "message": "模板不存在"}}

        applied_path = "config/field_mapping.yaml (unchanged)"
        if tid != _BUILTIN_TEMPLATE_ID:
            ok, msg = save_field_mapping_config(tpl.get("default_fields"), tpl.get("sheets"))
            if not ok:
                return {"ok": False, "error": {"code": "apply_failed", "message": msg}}
            applied_path = msg

        store = _load_store()
        store["active_template_id"] = tid
        _save_store(store)
        return {
            "ok": True,
            "active_template_id": tid,
            "applied_path": applied_path,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("field_mapping_template_activate")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
