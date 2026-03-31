from __future__ import annotations

"""
可配置：用于识别 Excel 中“合计/汇总行”的序号字段正则列表。

使用方式：
- 优先编辑同目录下的 `seqno_summary_regexes.yaml`（支持行注释）。
- 仅 YAML：不再读取/回退 JSON。

YAML 形状示例：
- - 合计
- - ^(小计|合计|总计)$
"""

from pathlib import Path

import yaml

_DEFAULT_REGEXES: list[str] = ["合计"]

_yaml_path = Path(__file__).with_name("seqno_summary_regexes.yaml")
try:
    if _yaml_path.exists():
        _raw = yaml.safe_load(_yaml_path.read_text(encoding="utf-8"))
        if isinstance(_raw, list) and all(isinstance(x, str) for x in _raw):
            SEQNO_SUMMARY_REGEXES: list[str] = [x for x in _raw if x.strip()]
        else:
            SEQNO_SUMMARY_REGEXES = list(_DEFAULT_REGEXES)
    else:
        SEQNO_SUMMARY_REGEXES = list(_DEFAULT_REGEXES)
except Exception:
    SEQNO_SUMMARY_REGEXES = list(_DEFAULT_REGEXES)

