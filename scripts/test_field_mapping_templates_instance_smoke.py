"""CI smoke: 字段映射模板 CRUD + 实例配置 API。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.field_mapping_template_api import (
    _BUILTIN_TEMPLATE_ID,
    _STORE_PATH,
    api_field_mapping_template_activate,
    api_field_mapping_template_create,
    api_field_mapping_template_delete,
    api_field_mapping_template_get,
    api_field_mapping_template_save,
    api_field_mapping_templates_list,
)
from src.local_api.settings_api import (
    _INSTANCE_CONFIG_PATH,
    api_settings_instance_get,
    api_settings_instance_post,
)


def _with_temp_stores(fn) -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        tpl_store = root / "field_mapping_templates.json"
        inst_store = root / "instance_config.json"
        with (
            patch("src.local_api.field_mapping_template_api._STORE_PATH", tpl_store),
            patch("src.local_api.settings_api._INSTANCE_CONFIG_PATH", inst_store),
        ):
            fn(root)


def test_field_mapping_templates_crud() -> None:
    def run(_root: Path) -> None:
        listed = api_field_mapping_templates_list()
        assert listed.get("ok") is True
        templates = listed.get("templates") or []
        assert any(t.get("template_id") == _BUILTIN_TEMPLATE_ID for t in templates)

        created = api_field_mapping_template_create(
            {"name": "测试模板", "description": "smoke", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        assert created.get("ok") is True
        tid = created["template"]["template_id"]

        got = api_field_mapping_template_get(tid)
        assert got.get("ok") is True
        assert got["template"]["name"] == "测试模板"

        saved = api_field_mapping_template_save(
            {
                "template_id": tid,
                "name": "测试模板（改）",
                "description": "updated",
            }
        )
        assert saved.get("ok") is True
        assert saved["template"]["name"] == "测试模板（改）"

        base_fields = dict(got["template"]["default_fields"])
        assert base_fields
        first_key = next(iter(base_fields))
        first_entry = dict(base_fields[first_key])
        first_aliases = list(first_entry.get("aliases") or [])
        first_aliases.append("__smoke_alias__")
        first_entry["aliases"] = first_aliases
        base_fields[first_key] = first_entry
        sheets = dict(got["template"].get("sheets") or {})
        content_saved = api_field_mapping_template_save(
            {
                "template_id": tid,
                "name": "测试模板（改）",
                "description": "updated",
                "default_fields": base_fields,
                "sheets": sheets,
            }
        )
        assert content_saved.get("ok") is True
        got2 = api_field_mapping_template_get(tid)
        assert got2.get("ok") is True
        saved_aliases = got2["template"]["default_fields"][first_key]["aliases"]
        assert "__smoke_alias__" in saved_aliases

        builtin_save = api_field_mapping_template_save(
            {
                "template_id": _BUILTIN_TEMPLATE_ID,
                "name": "内置",
                "default_fields": base_fields,
            }
        )
        assert builtin_save.get("ok") is False
        assert builtin_save.get("error", {}).get("code") == "builtin_readonly"

        builtin_del = api_field_mapping_template_delete(_BUILTIN_TEMPLATE_ID)
        assert builtin_del.get("ok") is False

        deleted = api_field_mapping_template_delete(tid)
        assert deleted.get("ok") is True
        assert api_field_mapping_template_get(tid).get("ok") is False

    _with_temp_stores(run)


def test_field_mapping_template_activate() -> None:
    def run(_root: Path) -> None:
        created = api_field_mapping_template_create({"name": "激活测试", "source_template_id": _BUILTIN_TEMPLATE_ID})
        assert created.get("ok") is True
        tid = created["template"]["template_id"]

        activated = api_field_mapping_template_activate({"template_id": tid})
        assert activated.get("ok") is True
        assert activated.get("active_template_id") == tid

        listed = api_field_mapping_templates_list()
        active = next(t for t in (listed.get("templates") or []) if t.get("template_id") == tid)
        assert active.get("is_active") is True

        api_field_mapping_template_delete(tid)

    _with_temp_stores(run)


def test_instance_config_api() -> None:
    def run(_root: Path) -> None:
        base = api_settings_instance_get()
        assert base.get("ok") is True
        assert "config" in base
        assert "system" in base
        assert base["system"].get("db_path")

        saved = api_settings_instance_post(
            {
                "config": {
                    "display_name": "票鉴测试实例",
                    "instance_id": "test-local",
                    "default_stat_year": 2024,
                    "notes": "smoke",
                }
            }
        )
        assert saved.get("ok") is True
        assert saved["config"]["display_name"] == "票鉴测试实例"
        assert saved["config"]["default_stat_year"] == 2024

        again = api_settings_instance_get()
        assert again["config"]["display_name"] == "票鉴测试实例"

        bad = api_settings_instance_post({"config": {"default_stat_year": 1800}})
        assert bad.get("ok") is False

    _with_temp_stores(run)


def main() -> None:
    assert _STORE_PATH.name == "field_mapping_templates.json"
    assert _INSTANCE_CONFIG_PATH.name == "instance_config.json"
    test_field_mapping_templates_crud()
    test_field_mapping_template_activate()
    test_instance_config_api()
    print("field_mapping_templates_instance_smoke: OK")


if __name__ == "__main__":
    main()
