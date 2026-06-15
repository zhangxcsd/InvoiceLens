"""CI smoke: 字段映射模板包 ZIP 导入/导出。"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.field_mapping_template_api import (
    _BUILTIN_TEMPLATE_ID,
    _SAMPLES_ROOT,
    _STORE_PATH,
    api_field_mapping_template_create,
    api_field_mapping_template_export_zip,
    api_field_mapping_template_get,
    api_field_mapping_template_import_zip,
    api_field_mapping_template_preview_zip,
    api_field_mapping_template_sample_download,
    api_field_mapping_templates_list,
)


def _with_temp_store(fn) -> None:
    with tempfile.TemporaryDirectory() as td:
        tpl_store = Path(td) / "field_mapping_templates.json"
        samples_root = Path(td) / "field_mapping_templates"
        with patch("src.local_api.field_mapping_template_api._STORE_PATH", tpl_store), patch(
            "src.local_api.field_mapping_template_api._SAMPLES_ROOT", samples_root
        ):
            fn(tpl_store, samples_root)


def _build_sample_zip(
    *,
    template_body: dict,
    manifest: dict | None = None,
    sample_names: list[str] | None = None,
    template_arcname: str = "template.json",
    extra_members: list[tuple[str, bytes]] | None = None,
) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(template_arcname, json.dumps(template_body, ensure_ascii=False, indent=2))
        if manifest is not None:
            zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for name in sample_names or []:
            # xlsx 为 ZIP 容器，须以 PK 开头通过轻量校验
            zf.writestr(f"samples/{name}", b"PK\x03\x04fake-xlsx-bytes")
        for arc, data in extra_members or []:
            zf.writestr(arc, data)
    return buf.getvalue()


def test_import_zip_creates_template() -> None:
    def run(_store: Path, samples_root: Path) -> None:
        created = api_field_mapping_template_create(
            {"name": "导出源", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        assert created.get("ok") is True
        src = api_field_mapping_template_get(created["template"]["template_id"])
        assert src.get("ok") is True
        tpl = src["template"]
        first_key = next(iter(tpl["default_fields"]))
        body = {
            "name": "ZIP 导入测试",
            "description": "from zip",
            "default_fields": tpl["default_fields"],
            "sheets": tpl.get("sheets") or {},
        }
        aliases = list(body["default_fields"][first_key].get("aliases") or [])
        aliases.append("__zip_smoke_alias__")
        body["default_fields"][first_key]["aliases"] = aliases

        zbytes = _build_sample_zip(
            template_body=body,
            manifest={"name": "manifest 名", "version": "9.9"},
            sample_names=["demo.xlsx"],
        )
        imported = api_field_mapping_template_import_zip(zbytes, filename="pack.zip")
        assert imported.get("ok") is True, imported
        tid = imported["template_id"]
        assert imported["import_meta"]["sample_excel_count"] == 1
        assert imported["import_meta"]["sample_persisted_count"] == 1
        assert "demo.xlsx" in (imported["import_meta"].get("sample_persisted_files") or [])
        assert imported["import_meta"]["source_filename"] == "pack.zip"

        got = api_field_mapping_template_get(tid)
        assert got.get("ok") is True
        assert got["template"]["name"] == "ZIP 导入测试"
        assert got["template"].get("sample_excel_count") == 1
        assert len(got["template"].get("samples") or []) == 1
        sample_path = samples_root / tid / "samples" / "demo.xlsx"
        assert sample_path.is_file()
        saved_aliases = got["template"]["default_fields"][first_key]["aliases"]
        assert "__zip_smoke_alias__" in saved_aliases

        listed = api_field_mapping_templates_list()
        ids = [t["template_id"] for t in listed.get("templates") or []]
        assert tid in ids

    _with_temp_store(run)


def test_import_zip_accepts_field_mapping_json_name() -> None:
    def run(_store: Path, _samples_root: Path) -> None:
        created = api_field_mapping_template_create(
            {"name": "基线", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        src = api_field_mapping_template_get(created["template"]["template_id"])["template"]
        body = {
            "name": "field_mapping.json 名",
            "default_fields": src["default_fields"],
            "sheets": src.get("sheets") or {},
        }
        zbytes = _build_sample_zip(template_body=body, template_arcname="field_mapping.json")
        imported = api_field_mapping_template_import_zip(zbytes)
        assert imported.get("ok") is True
        got = api_field_mapping_template_get(imported["template_id"])
        assert got["template"]["name"] == "field_mapping.json 名"

    _with_temp_store(run)


def test_import_zip_rejects_invalid() -> None:
    def run(_store: Path, _samples_root: Path) -> None:
        bad = _build_sample_zip(
            template_body={"name": "无字段", "default_fields": {}, "sheets": {}},
        )
        res = api_field_mapping_template_import_zip(bad)
        assert res.get("ok") is False

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("readme.txt", "no template json")
        res2 = api_field_mapping_template_import_zip(buf.getvalue())
        assert res2.get("ok") is False

        created = api_field_mapping_template_create(
            {"name": "基线2", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        src = api_field_mapping_template_get(created["template"]["template_id"])["template"]
        evil = _build_sample_zip(
            template_body={
                "name": "evil",
                "default_fields": src["default_fields"],
                "sheets": src.get("sheets") or {},
            },
            extra_members=[("../evil.json", b"{}")],
        )
        res3 = api_field_mapping_template_import_zip(evil)
        assert res3.get("ok") is False

    _with_temp_store(run)


def test_export_zip_roundtrip() -> None:
    def run(_store: Path, _samples_root: Path) -> None:
        created = api_field_mapping_template_create(
            {"name": "导出测试", "description": "exp", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        tid = created["template"]["template_id"]
        status, payload, ctype, fname = api_field_mapping_template_export_zip(tid)
        assert status == 200
        assert isinstance(payload, bytes)
        assert ctype == "application/zip"
        assert fname.endswith(".zip")

        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            names = {n.replace("\\", "/") for n in zf.namelist()}
            assert "template.json" in names
            assert "manifest.json" in names
            tpl = json.loads(zf.read("template.json").decode("utf-8"))
            assert tpl["name"] == "导出测试"

        reimport = api_field_mapping_template_import_zip(payload, filename=fname)
        assert reimport.get("ok") is False
        assert reimport["error"]["code"] == "template_id_conflict"

        reimport_ok = api_field_mapping_template_import_zip(payload, filename=fname, overwrite=True)
        assert reimport_ok.get("ok") is True
        assert reimport_ok["template_id"] == tid

    _with_temp_store(run)


def test_import_zip_conflict_requires_overwrite() -> None:
    def run(_store: Path, _samples_root: Path) -> None:
        created = api_field_mapping_template_create(
            {"name": "已有模板", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        tid = created["template"]["template_id"]
        status, payload, _, _ = api_field_mapping_template_export_zip(tid)
        assert status == 200

        preview = api_field_mapping_template_preview_zip(payload, filename="pack.zip")
        assert preview.get("ok") is True
        assert preview["preview"]["has_conflict"] is True

        blocked = api_field_mapping_template_import_zip(payload, filename="pack.zip")
        assert blocked.get("ok") is False
        assert blocked["error"]["code"] == "template_id_conflict"

        ok = api_field_mapping_template_import_zip(payload, filename="pack.zip", overwrite=True)
        assert ok.get("ok") is True
        assert ok.get("overwritten") is True
        assert ok["template_id"] == tid

    _with_temp_store(run)


def test_import_zip_activate_after() -> None:
    def run(_store: Path, _samples_root: Path) -> None:
        created = api_field_mapping_template_create(
            {"name": "激活测试", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        src = api_field_mapping_template_get(created["template"]["template_id"])["template"]
        body = {
            "name": "激活导入",
            "default_fields": src["default_fields"],
            "sheets": src.get("sheets") or {},
        }
        zbytes = _build_sample_zip(template_body=body)
        imported = api_field_mapping_template_import_zip(zbytes, activate=True)
        assert imported.get("ok") is True
        assert imported.get("activated") is True
        listed = api_field_mapping_templates_list()
        active = listed.get("active_template_id")
        assert active == imported["template_id"]

    _with_temp_store(run)


def test_export_zip_includes_persisted_samples() -> None:
    def run(_store: Path, samples_root: Path) -> None:
        created = api_field_mapping_template_create(
            {"name": "样例导出", "source_template_id": _BUILTIN_TEMPLATE_ID}
        )
        tid = created["template"]["template_id"]
        src = api_field_mapping_template_get(tid)["template"]
        body = {
            "name": "样例导出",
            "default_fields": src["default_fields"],
            "sheets": src.get("sheets") or {},
        }
        zbytes = _build_sample_zip(
            template_body=body,
            manifest={"template_id": tid},
            sample_names=["roundtrip.xlsx"],
        )
        imported = api_field_mapping_template_import_zip(zbytes, overwrite=True)
        assert imported.get("ok") is True
        assert imported["import_meta"]["sample_persisted_count"] == 1

        status, payload, _, _ = api_field_mapping_template_export_zip(tid)
        assert status == 200
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            names = {n.replace("\\", "/") for n in zf.namelist()}
            assert "samples/roundtrip.xlsx" in names

        dl_status, dl_body, _, dl_name = api_field_mapping_template_sample_download(tid, "roundtrip.xlsx")
        assert dl_status == 200
        assert isinstance(dl_body, bytes)
        assert dl_name == "roundtrip.xlsx"
        assert (samples_root / tid / "samples" / "roundtrip.xlsx").is_file()

    _with_temp_store(run)


def main() -> None:
    assert _STORE_PATH.name == "field_mapping_templates.json"
    test_import_zip_creates_template()
    test_import_zip_accepts_field_mapping_json_name()
    test_import_zip_rejects_invalid()
    test_export_zip_roundtrip()
    test_import_zip_conflict_requires_overwrite()
    test_import_zip_activate_after()
    test_export_zip_includes_persisted_samples()
    print("field_mapping_template_zip_smoke: OK")


if __name__ == "__main__":
    main()
