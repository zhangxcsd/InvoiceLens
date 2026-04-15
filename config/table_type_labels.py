from __future__ import annotations

from typing import Mapping

from config.sheet_mapping import SHEET_MAPPING


def _build_default_labels_from_sheet_mapping() -> dict[str, str]:
    """
    根据 `sheet_mapping.yaml` 反推 table_type 的中文“常用叫法”。
    注意：一个 table_type 可能对应多个 sheet 名，这里只取第一个遇到的中文名作为展示名。
    """
    labels: dict[str, str] = {}
    for sheet_cn, table_type in (SHEET_MAPPING or {}).items():
        if not isinstance(sheet_cn, str) or not isinstance(table_type, str):
            continue
        if table_type not in labels:
            labels[table_type] = sheet_cn.strip() or table_type
    return labels


# 代码 -> 中文展示名（用于 UI 显示；不改变底层分区/存储的 code）
# 注意：inv_header / inv_detail 等主流类型以 sheet_mapping.yaml 中「首次出现」的 Sheet 名为准；
# 此处仅保留 YAML 未覆盖类型的兜底。
TABLE_TYPE_LABELS: dict[str, str] = {
    **_build_default_labels_from_sheet_mapping(),
    "inv_summary": "信息汇总表",
    "inv_special_header": "专票/特殊票主表",
    "inv_vehicle_sales": "机动车销售",
    "unknown_sheet": "未知表",
}


def table_type_display(table_type: str | None, labels: Mapping[str, str] | None = None) -> str:
    """
    把 `table_type` 渲染为更友好的展示字符串：`中文名（code）`。
    若无映射则回退显示原值；若为空则显示空串。
    """
    if not table_type:
        return ""
    code = str(table_type)
    m = labels or TABLE_TYPE_LABELS
    cn = m.get(code, "").strip()
    if cn and cn != code:
        return f"{cn}（{code}）"
    return code

