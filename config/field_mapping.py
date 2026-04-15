from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

import yaml

_CONFIG_PATH = Path(__file__).with_name("field_mapping.yaml")

_TOP_LEVEL_SKIP = frozenset({"default", "sheets", "sheet_header_slugs"})


def get_field_mapping_yaml_path() -> Path:
    """field_mapping.yaml 绝对路径（供 header 覆盖检查、工具脚本使用）。"""
    return _CONFIG_PATH


# 内置默认：YAML 缺失、损坏或某键为空列表时用于补齐/回退
_DEFAULT_FIELD_MAPPING: dict[str, list[str]] = {
    "invoice_no": ["发票号码", "发票号", "号码"],
    "invoice_code": ["发票代码", "代码"],
    # 数电票关键识别号：用于数电发票逻辑分组与 key 判定
    "sdfphm": ["数电发票号码", "数电票号码", "数电发票号", "数电票号"],
    "kprq": ["开票日期", "日期"],
    "seller_tax_no": [
        "销方税号",
        "销方税务登记号",
        "销售方税号",
        "销售方纳税人识别号",
        "销方纳税人识别号",
        "销售方识别号",
        "销方统一社会信用代码",
        "销售方统一社会信用代码",
        "销货方纳税人识别号",
    ],
    "buyer_tax_no": [
        "购方税号",
        "购方税务登记号",
        "购买方税号",
        "购买方纳税人识别号",
        "购方纳税人识别号",
        "购买方识别号",
        "购方统一社会信用代码",
        "购买方统一社会信用代码",
        "购货方纳税人识别号",
    ],
    "amount": ["金额", "不含税金额"],
    "tax_amount": ["税额"],
    "total_amount": ["价税合计", "含税金额"],
}


def _normalize_sheet_key(s: Any) -> str:
    """与 excel_to_ods._normalize_colname 对齐：去首尾空白并去掉半角空格。"""
    if s is None:
        return ""
    return str(s).strip().replace(" ", "")


def _parse_alias_list(v: Any) -> list[str] | None:
    if not isinstance(v, list):
        return None
    out: list[str] = []
    for x in v:
        if x is None:
            continue
        sx = str(x).strip()
        if sx:
            out.append(sx)
    return out


def _parse_field_value(v: Any) -> tuple[list[str] | None, str | None]:
    """
    解析单个字段定义。
    - 旧式：字段 -> [别名...]
    - 新式：字段 -> { label_zh?: str, aliases: [别名...] }
    返回 (aliases, label_zh)；label_zh 为 None 表示 YAML 未声明（非空字符串）。
    """
    if isinstance(v, list):
        parsed = _parse_alias_list(v)
        return (parsed if parsed is not None else None), None
    if isinstance(v, dict):
        if "aliases" not in v:
            return None, None
        al_raw = v.get("aliases")
        if not isinstance(al_raw, list):
            return None, None
        parsed = _parse_alias_list(al_raw)
        if parsed is None:
            return None, None
        lz_raw = v.get("label_zh")
        lz: str | None = None
        if lz_raw is not None:
            s = str(lz_raw).strip()
            if len(s) > 200:
                return None, None
            lz = s if s else None
        return parsed, lz
    return None, None


def _parse_field_block_to_maps(obj: Any) -> tuple[dict[str, list[str]], dict[str, str]]:
    """解析 default 或单个 sheet 块：得到别名表与显式 label_zh 表。"""
    if not isinstance(obj, dict):
        return {}, {}
    aliases_out: dict[str, list[str]] = {}
    labels_out: dict[str, str] = {}
    for k, v in obj.items():
        if not isinstance(k, str):
            continue
        key = k.strip()
        if not key:
            continue
        al, lz = _parse_field_value(v)
        if al is None:
            continue
        aliases_out[key] = al
        if lz:
            labels_out[key] = lz
    return aliases_out, labels_out


def _build_default_mapping(loaded_default: dict[str, list[str]]) -> dict[str, list[str]]:
    """
    内置别名仅在「YAML default 未声明该字段」时补齐。
    若 YAML 显式写了空列表（含迁移后的 aliases: []），不再注入冗长内置别名，与精简 default 策略一致。
    """
    out: dict[str, list[str]] = {}
    for field, builtin_aliases in _DEFAULT_FIELD_MAPPING.items():
        if field in loaded_default:
            out[field] = list(loaded_default[field])
        else:
            out[field] = list(builtin_aliases)
    for field, aliases in loaded_default.items():
        if field in out:
            continue
        out[field] = list(aliases) if aliases else []
    return out


def _load_field_mapping_config_uncached() -> tuple[
    dict[str, list[str]],
    dict[str, str],
    dict[str, dict[str, list[str]]],
    dict[str, dict[str, str]],
    list[str],
    str,
]:
    """
    返回：
    - default_fields: 标准字段 -> 别名列表（供列推断）
    - default_label_zh: 标准字段 -> 业务含义（仅 YAML 显式声明的键）
    - sheets: Sheet -> 字段 -> 别名列表
    - sheet_label_zh: Sheet -> 字段 -> 业务含义（显式）
    - sheet_header_slug_keys: sheet_header_slugs 下的表头中文键（供 ODS 列预检白名单）
    """
    if not _CONFIG_PATH.exists():
        return dict(_DEFAULT_FIELD_MAPPING), {}, {}, {}, [], "builtin"

    try:
        raw = _CONFIG_PATH.read_text(encoding="utf-8")
        loaded = yaml.safe_load(raw)
    except Exception:
        return dict(_DEFAULT_FIELD_MAPPING), {}, {}, {}, [], "builtin(read_error)"

    if not isinstance(loaded, dict):
        return dict(_DEFAULT_FIELD_MAPPING), {}, {}, {}, [], "builtin(invalid_yaml)"

    sheet_overrides: dict[str, dict[str, list[str]]] = {}
    sheet_label_zh: dict[str, dict[str, str]] = {}
    raw_sheets = loaded.get("sheets")
    if isinstance(raw_sheets, dict):
        for sheet_key, v in raw_sheets.items():
            if not isinstance(sheet_key, str):
                continue
            sk = sheet_key.strip()
            if not sk:
                continue
            if not isinstance(v, dict):
                continue
            sheet_ali, sheet_lab = _parse_field_block_to_maps(v)
            sheet_overrides[sk] = sheet_ali
            if sheet_lab:
                sheet_label_zh[sk] = sheet_lab

    if "default" in loaded:
        loaded_default_ali, loaded_default_labels = _parse_field_block_to_maps(loaded.get("default"))
    else:
        tmp = {k: v for k, v in loaded.items() if k not in _TOP_LEVEL_SKIP}
        loaded_default_ali, loaded_default_labels = _parse_field_block_to_maps(tmp)

    default_fields = _build_default_mapping(loaded_default_ali)
    default_label_zh = {k: v for k, v in loaded_default_labels.items() if k in default_fields and v}

    header_slug_keys: list[str] = []
    sh = loaded.get("sheet_header_slugs")
    if isinstance(sh, dict):
        for k in sh:
            if isinstance(k, str) and k.strip():
                header_slug_keys.append(k.strip())

    return (
        default_fields,
        default_label_zh,
        sheet_overrides,
        sheet_label_zh,
        header_slug_keys,
        "config/field_mapping.yaml",
    )


_cached_default_fields: dict[str, list[str]] | None = None
_cached_default_label_zh: dict[str, str] | None = None
_cached_sheet_overrides: dict[str, dict[str, list[str]]] | None = None
_cached_sheet_label_zh: dict[str, dict[str, str]] | None = None
_cached_sheet_header_slug_keys: list[str] | None = None
_cached_mtime: float | None = None
_last_source: str = "builtin"


def _api_default_entries() -> dict[str, Any]:
    assert _cached_default_fields is not None
    labs = _cached_default_label_zh or {}
    out: dict[str, Any] = {}
    for k, aliases in _cached_default_fields.items():
        out[k] = {
            "label_zh": labs.get(k, ""),
            "aliases": list(aliases),
        }
    return out


def _api_sheets_entries() -> dict[str, Any]:
    assert _cached_sheet_overrides is not None
    slab_all = _cached_sheet_label_zh or {}
    out: dict[str, Any] = {}
    for sk, fmap in _cached_sheet_overrides.items():
        slab = slab_all.get(sk) or {}
        out[sk] = {}
        for fk, aliases in fmap.items():
            out[sk][fk] = {
                "label_zh": slab.get(fk, ""),
                "aliases": list(aliases),
            }
    return out


def get_field_mapping_config_info() -> tuple[dict[str, Any], str]:
    """
    返回给 HTTP 接口/前端的结构：
    {
      default_fields: { field: { label_zh, aliases } },
      sheets: { sheet_key: { field: { label_zh, aliases } } }
    }
    """
    global _cached_default_fields, _cached_default_label_zh
    global _cached_sheet_overrides, _cached_sheet_label_zh, _cached_sheet_header_slug_keys
    global _cached_mtime, _last_source

    try:
        mtime = _CONFIG_PATH.stat().st_mtime if _CONFIG_PATH.exists() else -1.0
    except OSError:
        mtime = -2.0

    if (
        _cached_default_fields is not None
        and _cached_default_label_zh is not None
        and _cached_sheet_overrides is not None
        and _cached_sheet_label_zh is not None
        and _cached_sheet_header_slug_keys is not None
        and _cached_mtime == mtime
    ):
        return (
            {
                "default_fields": _api_default_entries(),
                "sheets": _api_sheets_entries(),
            },
            _last_source,
        )

    df, dl, so, sl, hslug, src = _load_field_mapping_config_uncached()
    _cached_default_fields = df
    _cached_default_label_zh = dl
    _cached_sheet_overrides = so
    _cached_sheet_label_zh = sl
    _cached_sheet_header_slug_keys = hslug
    _cached_mtime = mtime
    _last_source = src
    return (
        {
            "default_fields": _api_default_entries(),
            "sheets": _api_sheets_entries(),
        },
        src,
    )


def get_field_mapping() -> dict[str, list[str]]:
    get_field_mapping_config_info()
    assert _cached_default_fields is not None
    return dict(_cached_default_fields)


def get_sheet_header_slug_label_keys() -> list[str]:
    """
    field_mapping.yaml 顶层 sheet_header_slugs 的键（表头文案），
    与当前 Sheet 的字段别名一并用于 ODS 导入「Excel 列 ⊆ 允许列」预检。
    """
    get_field_mapping_config_info()
    assert _cached_sheet_header_slug_keys is not None
    return list(_cached_sheet_header_slug_keys)


def invalidate_field_mapping_cache() -> None:
    """写回 YAML 后调用，避免同一秒内 mtime 未变等边缘情况仍命中旧缓存。"""
    global _cached_default_fields, _cached_default_label_zh
    global _cached_sheet_overrides, _cached_sheet_label_zh, _cached_sheet_header_slug_keys
    global _cached_mtime
    _cached_default_fields = None
    _cached_default_label_zh = None
    _cached_sheet_overrides = None
    _cached_sheet_label_zh = None
    _cached_sheet_header_slug_keys = None
    _cached_mtime = None


def _sanitize_alias_list(v: Any) -> tuple[list[str] | None, str | None]:
    """返回 (aliases, error_message)；空列表合法。"""
    if not isinstance(v, list):
        return None, "别名须为数组"
    out: list[str] = []
    for x in v:
        if x is None:
            continue
        s = str(x).strip()
        if len(s) > 500:
            return None, "单个别名过长（上限 500 字符）"
        if s:
            out.append(s)
    return out, None


def _sanitize_field_entry_block(
    obj: Any,
    *,
    label: str,
) -> tuple[dict[str, dict[str, Any]] | None, str | None]:
    """default_fields 或单个 sheet 块：值为数组（旧式）或 { label_zh, aliases }。"""
    if not isinstance(obj, dict):
        return None, f"{label}须为对象"
    out: dict[str, dict[str, Any]] = {}
    for k, v in obj.items():
        if not isinstance(k, str) or not k.strip():
            continue
        key = k.strip()
        if isinstance(v, list):
            aliases, err = _sanitize_alias_list(v)
            if err:
                return None, f"{label} 字段 {key!r}：{err}"
            if aliases is None:
                continue
            out[key] = {"label_zh": "", "aliases": aliases}
        elif isinstance(v, dict):
            aliases, err = _sanitize_alias_list(v.get("aliases"))
            if err:
                return None, f"{label} 字段 {key!r}：{err}"
            if aliases is None:
                return None, f"{label} 字段 {key!r}：须包含 aliases 数组"
            lz = str(v.get("label_zh") or "").strip()
            if len(lz) > 200:
                return None, f"{label} 字段 {key!r}：label_zh 过长（上限 200 字符）"
            out[key] = {"label_zh": lz, "aliases": aliases}
        else:
            return None, f"{label} 字段 {key!r}：须为数组或对象"
    return out, None


def _sanitize_sheets_entry_blocks(obj: Any) -> tuple[dict[str, dict[str, dict[str, Any]]] | None, str | None]:
    if not isinstance(obj, dict):
        return None, "sheets 须为对象"
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for sk, block in obj.items():
        if not isinstance(sk, str) or not sk.strip():
            continue
        sheet_key = sk.strip()
        if not isinstance(block, dict):
            return None, f"sheets 键 {sheet_key!r} 的值须为对象"
        inner, ierr = _sanitize_field_entry_block(block, label=f"sheets[{sheet_key}]")
        if ierr:
            return None, ierr
        if inner is None:
            continue
        out[sheet_key] = inner
    return out, None


def _yaml_nodes_from_entries(entries: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """序列化为 YAML 用的 dict（label_zh 非空时写出）。"""
    out: dict[str, Any] = {}
    for field in entries:
        ent = entries[field]
        lz = str(ent.get("label_zh") or "").strip()
        al = ent.get("aliases")
        aliases = list(al) if isinstance(al, list) else []
        if lz:
            out[field] = {"label_zh": lz, "aliases": aliases}
        else:
            out[field] = {"aliases": aliases}
    return out


def _sheets_disk_to_entry_maps(raw_sheets: Any) -> dict[str, dict[str, dict[str, Any]]]:
    """从磁盘 YAML 的 sheets 片段恢复为保存用的 entry 映射（兼容旧式纯列表）。"""
    result: dict[str, dict[str, dict[str, Any]]] = {}
    if not isinstance(raw_sheets, dict):
        return result
    for sk, block in raw_sheets.items():
        if not isinstance(sk, str) or not sk.strip():
            continue
        key = sk.strip()
        if not isinstance(block, dict):
            continue
        al_map, lz_map = _parse_field_block_to_maps(block)
        fm: dict[str, dict[str, Any]] = {}
        for fk, aliases in al_map.items():
            lz = (lz_map.get(fk) or "").strip()
            if lz:
                fm[fk] = {"label_zh": lz, "aliases": list(aliases)}
            else:
                fm[fk] = {"label_zh": "", "aliases": list(aliases)}
        result[key] = fm
    return result


def save_field_mapping_config(
    default_fields: Any,
    sheets: Any | None = None,
    *,
    backup: bool = True,
) -> tuple[bool, str]:
    """
    将 default / sheets 写回 field_mapping.yaml；保留 default、sheets 以外的顶层键（如 sheet_header_slugs）。
    sheets 为 None 时保留磁盘上已有 sheets 块（仅更新 default，供保守客户端）。
    """
    default_entries, derr = _sanitize_field_entry_block(default_fields, label="default_fields")
    if derr:
        return False, derr
    if not default_entries:
        return False, "default_fields 不能为空"

    try:
        raw_existing = _CONFIG_PATH.read_text(encoding="utf-8") if _CONFIG_PATH.exists() else ""
        loaded_root = yaml.safe_load(raw_existing) if raw_existing.strip() else {}
    except Exception as exc:
        return False, f"读取现有配置失败：{exc}"
    if not isinstance(loaded_root, dict):
        loaded_root = {}

    if sheets is None:
        sheets_entries = _sheets_disk_to_entry_maps(loaded_root.get("sheets"))
    else:
        smap, serr = _sanitize_sheets_entry_blocks(sheets)
        if serr:
            return False, serr
        sheets_entries = smap or {}

    merged: dict[str, Any] = {"default": _yaml_nodes_from_entries(default_entries)}
    for k, v in loaded_root.items():
        if k in ("default", "sheets"):
            continue
        merged[k] = v
    merged["sheets"] = {sk: _yaml_nodes_from_entries(fm) for sk, fm in sheets_entries.items()}

    if backup and _CONFIG_PATH.exists():
        bak = _CONFIG_PATH.with_suffix(_CONFIG_PATH.suffix + ".bak")
        try:
            shutil.copy2(_CONFIG_PATH, bak)
        except OSError:
            pass

    parent = _CONFIG_PATH.parent
    parent.mkdir(parents=True, exist_ok=True)
    try:
        text = yaml.dump(merged, allow_unicode=True, sort_keys=False, default_flow_style=False)
        tf = tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            suffix=".yaml",
            dir=str(parent),
            delete=False,
        )
        tmp_name = tf.name
        try:
            tf.write(text)
            tf.close()
            Path(tmp_name).replace(_CONFIG_PATH)
        except Exception:
            try:
                tf.close()
            except Exception:
                pass
            try:
                Path(tmp_name).unlink(missing_ok=True)
            except OSError:
                pass
            raise
    except Exception as exc:
        return False, f"写入失败：{exc}"

    invalidate_field_mapping_cache()
    return True, str(_CONFIG_PATH)


def get_field_mapping_for_sheet(sheet_name: str) -> dict[str, list[str]]:
    """
    根据 sheet_name 命中 sheet 覆盖（通过包含匹配：去空格后 override_key in sheet_name）。
    命中多个覆盖时：按 YAML 中顺序合并；同一字段在后出现的块覆盖前者。

    仅使用别名列表；label_zh 不参与列推断。

    **重要**：若命中 `sheets` 下某一类型块，则**仅对该块中显式列出的标准字段**做列推断；
    别名为空列表 => 继承 default 中该字段的别名；未出现在该块中的 default 字段不参与推断。
    这样「发票基础信息」不会要求「税收分类编码」等仅属于汇总/明细表的列。

    若工作表名未命中任何 `sheets` 键，则回退为整表 default_fields（兼容未单独建模的表）。
    """
    get_field_mapping_config_info()
    assert _cached_default_fields is not None
    assert _cached_sheet_overrides is not None

    default = _cached_default_fields
    sheet_norm = _normalize_sheet_key(sheet_name)
    if not sheet_norm:
        return {k: list(v) for k, v in default.items()}

    matching_maps: list[dict[str, list[str]]] = []
    for override_sheet_key, field_map in _cached_sheet_overrides.items():
        ok = _normalize_sheet_key(override_sheet_key) and _normalize_sheet_key(override_sheet_key) in sheet_norm
        if ok:
            matching_maps.append(field_map)

    if not matching_maps:
        return {k: list(v) for k, v in default.items()}

    out: dict[str, list[str]] = {}
    for field_map in matching_maps:
        for field, aliases in field_map.items():
            if aliases:
                out[field] = list(aliases)
            elif field in default:
                out[field] = list(default[field])
            else:
                out[field] = []

    return out


# 兼容旧代码：仍保留 FIELD_MAPPING 常量
FIELD_MAPPING = get_field_mapping()
