from __future__ import annotations

from datetime import datetime
from pathlib import Path

import yaml

# 仅 YAML：不再读取/回退 JSON，避免双份配置导致被覆盖或歧义。
_DEFAULT_MAPPING: dict[str, str] = {
    "发票汇总表": "inv_header",
    "发票明细表": "inv_detail",
    "信息汇总表": "inv_summary",
    "建筑服务": "inv_special_header",
    "机动车销售": "inv_vehicle_sales",
}

_yaml_path = Path(__file__).with_name("sheet_mapping.yaml")
_raw_text: str | None = None
try:
    if _yaml_path.exists():
        _raw_text = _yaml_path.read_text(encoding="utf-8")
        loaded = yaml.safe_load(_raw_text)
        if isinstance(loaded, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in loaded.items()):
            SHEET_MAPPING: dict[str, str] = dict(loaded)
        else:
            SHEET_MAPPING = dict(_DEFAULT_MAPPING)
    else:
        SHEET_MAPPING = dict(_DEFAULT_MAPPING)
except Exception:
    # 解析失败：不覆盖原文件，留一份备份方便你回滚/修复
    try:
        if _yaml_path.exists():
            ts = datetime.now().strftime("%Y%m%d%H%M%S")
            invalid_path = _yaml_path.with_name(f"sheet_mapping.invalid.{ts}.yaml")
            invalid_path.write_text(_raw_text or _yaml_path.read_text(encoding="utf-8"), encoding="utf-8")
    except Exception:
        pass
    SHEET_MAPPING = dict(_DEFAULT_MAPPING)


def update_sheet_mapping_if_missing(new_entries: dict[str, str]) -> dict[str, str]:
    """
    仅 YAML 模式下：遇到未知 sheet，只生成“建议合并文件”，不修改原始 `sheet_mapping.yaml`。
    你后续手工把建议条目合并回 YAML 即可。
    """
    if not new_entries:
        return {}

    try:
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        suggested_path = _yaml_path.with_name(f"sheet_mapping.suggested.{ts}.yaml")
        lines = [
            "# sheet_mapping.suggested：未知 sheet 的建议合并条目（仅建议，不会自动覆盖原 YAML）。",
            "# 你可以把这里的 key/value 追加到 config/sheet_mapping.yaml 中。",
            "",
        ]
        # 稳定排序，便于你比对
        for k in sorted(new_entries.keys(), key=lambda x: str(x)):
            v = new_entries[k]
            lines.append(f"{k}: {v}")
        suggested_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        pass
    return {}

