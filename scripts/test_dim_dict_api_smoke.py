"""CI smoke: dim_dict JSON 持久化 API。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.dim_dict_api import _STORE_PATH, api_dim_dict_get, api_dim_dict_save


def test_dim_dict_get_seed() -> None:
    res = api_dim_dict_get()
    assert res.get("ok") is True
    domains = res.get("domains") or []
    assert len(domains) >= 10
    assert _STORE_PATH.is_file()


def test_dim_dict_save_roundtrip() -> None:
    base = api_dim_dict_get()
    assert base.get("ok") is True
    domains = list(base.get("domains") or [])
    custom_id = "smoke_custom_domain"
    domains = [d for d in domains if d.get("domain_id") != custom_id]
    domains.append(
        {
            "domain_id": custom_id,
            "domain_name": "冒烟测试域",
            "description": "smoke",
            "source_table": "test_table",
            "source_column": "test_col",
            "built_in": False,
            "entries": [
                {
                    "code": "A",
                    "label": "条目A",
                    "sort_order": 1,
                    "enabled": True,
                    "notes": "",
                }
            ],
        }
    )
    saved = api_dim_dict_save({"version": base.get("version") or 1, "domains": domains})
    assert saved.get("ok") is True
    again = api_dim_dict_get()
    found = next((d for d in again.get("domains") or [] if d.get("domain_id") == custom_id), None)
    assert found is not None
    assert found.get("entries")[0]["code"] == "A"
    # cleanup
    domains = [d for d in again.get("domains") or [] if d.get("domain_id") != custom_id]
    api_dim_dict_save({"version": again.get("version") or 1, "domains": domains})


def main() -> None:
    assert _STORE_PATH.name == "dim_dict.json"
    test_dim_dict_get_seed()
    test_dim_dict_save_roundtrip()
    print("dim_dict_api_smoke: OK")


if __name__ == "__main__":
    main()
