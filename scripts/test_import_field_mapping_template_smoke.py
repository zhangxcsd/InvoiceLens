"""CI smoke: 导入链路使用字段映射模板 + ods_load_log 可追溯元数据。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config.field_mapping import field_mapping_import_context, get_field_mapping_for_sheet
from src.local_api.data_quality import _parse_ods_load_log_detail
from src.local_api.field_mapping_template_api import (
    _BUILTIN_TEMPLATE_ID,
    api_field_mapping_template_activate,
    api_field_mapping_template_create,
    field_mapping_template_meta_payload,
    resolve_import_field_mapping_template,
)


def _with_temp_store(fn) -> None:
    with tempfile.TemporaryDirectory() as td:
        tpl_store = Path(td) / "field_mapping_templates.json"
        with patch("src.local_api.field_mapping_template_api._STORE_PATH", tpl_store):
            fn()


def test_resolve_active_template() -> None:
    def run() -> None:
        resolved = resolve_import_field_mapping_template(None)
        assert resolved["template_id"] == _BUILTIN_TEMPLATE_ID
        meta = field_mapping_template_meta_payload(resolved)
        assert meta["template_id"] == _BUILTIN_TEMPLATE_ID
        assert meta["template_name"]

    _with_temp_store(run)


def test_import_context_overrides_sheet_mapping() -> None:
    def run() -> None:
        created = api_field_mapping_template_create(
            {"name": "导入 smoke", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        assert created.get("ok") is True
        tid = created["template"]["template_id"]
        activated = api_field_mapping_template_activate({"template_id": tid})
        assert activated.get("ok") is True

        resolved = resolve_import_field_mapping_template(tid)
        smoke_alias = "__import_smoke_alias__"
        default_aliases = dict(resolved["default_field_aliases"])
        first_key = next(iter(default_aliases))
        default_aliases[first_key] = list(default_aliases[first_key]) + [smoke_alias]

        with field_mapping_import_context(
            default_fields=default_aliases,
            sheet_overrides=resolved["sheet_overrides"],
        ):
            mapped = get_field_mapping_for_sheet("发票基础信息")
            assert smoke_alias in mapped.get(first_key, [])

        mapped_after = get_field_mapping_for_sheet("发票基础信息")
        assert smoke_alias not in mapped_after.get(first_key, [])

    _with_temp_store(run)


def test_ods_load_log_detail_json_wrapper() -> None:
    meta = {
        "template_id": "fm_tpl_test",
        "template_name": "测试模板",
        "template_updated_at": "2026-06-12T00:00:00Z",
    }
    file_logs = [{"file_name": "a.xlsx", "status": "成功", "reject_row_samples": []}]
    wrapped = json.dumps({"field_mapping_template": meta, "file_logs": file_logs}, ensure_ascii=False)
    parsed_meta, parsed_logs = _parse_ods_load_log_detail(wrapped)
    assert parsed_meta == meta
    assert len(parsed_logs) == 1

    legacy = json.dumps(file_logs, ensure_ascii=False)
    legacy_meta, legacy_logs = _parse_ods_load_log_detail(legacy)
    assert legacy_meta is None
    assert len(legacy_logs) == 1


def main() -> None:
    test_resolve_active_template()
    test_import_context_overrides_sheet_mapping()
    test_ods_load_log_detail_json_wrapper()
    print("import_field_mapping_template_smoke: OK")


if __name__ == "__main__":
    main()
