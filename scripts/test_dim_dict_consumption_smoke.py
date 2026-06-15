"""CI smoke: dim_dict 消费侧 helper（Python + API meta 联动）。"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.dim_dict_api import (
    get_domain_codes,
    get_domain_label,
    get_domain_label_map,
    api_dim_dict_get,
)
from src.local_api.audit_flag_api import api_audit_meta


def test_domain_helpers() -> None:
    codes = get_domain_codes("audit_risk_level")
    assert "高风险" in codes
    assert "中风险" in codes
    assert "低风险" in codes

    label_map = get_domain_label_map("audit_risk_level")
    assert label_map.get("高风险") == "高风险"

    assert get_domain_label("audit_risk_label", "HIGH") == "高敏感"
    assert get_domain_label("finance_role_type", "进项") == "进项"
    assert get_domain_label("roster_data_source", "registry") == "台账同步"
    assert get_domain_label("roster_quality_status", "conflict") == "待核对"
    assert get_domain_label("quality_severity", "block") == "阻塞"
    assert get_domain_label("quality_severity", "warn") == "警告"
    assert get_domain_label("quality_severity", "info") == "提示"
    assert get_domain_label("dim_task_run_status", "success") == "成功"
    assert get_domain_label("unknown_domain", "X") == "X"

    disabled_only = get_domain_codes("audit_risk_level", enabled_only=True)
    assert len(disabled_only) >= 3


def test_audit_meta_risk_options() -> None:
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = (0,)
    res = api_audit_meta(conn)
    assert res.get("ok") is True
    opts = res.get("risk_level_options") or []
    codes = [o.get("code") for o in opts]
    assert "高风险" in codes
    assert all(o.get("label") for o in opts)


def test_get_api_domains_align_helpers() -> None:
    api_res = api_dim_dict_get()
    assert api_res.get("ok") is True
    domains = api_res.get("domains") or []
    domain = next((d for d in domains if d.get("domain_id") == "finance_import_status"), None)
    assert domain is not None
    helper_codes = get_domain_codes("finance_import_status")
    entry_codes = [e.get("code") for e in domain.get("entries") or []]
    assert helper_codes == entry_codes


def main() -> None:
    test_domain_helpers()
    test_audit_meta_risk_options()
    test_get_api_domains_align_helpers()
    print("dim_dict_consumption_smoke: OK")


if __name__ == "__main__":
    main()
