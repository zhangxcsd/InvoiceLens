from __future__ import annotations

"""
可配置：DWD 写入时识别「详见销货清单」类汇总参考行的货物名称子串列表。

使用方式：
- 编辑同目录下的 `dwd_goods_summary_phrases.yaml`（支持 `#` 行注释）。
- 与 `seqno_summary_regexes.yaml` 类似，改 YAML 即生效，无需改 cleaner 代码。
"""

from pathlib import Path

import yaml

_DEFAULT_PHRASES: list[str] = ["详见销货清单", "详见销售清单"]

_yaml_path = Path(__file__).with_name("dwd_goods_summary_phrases.yaml")
try:
    if _yaml_path.exists():
        _raw = yaml.safe_load(_yaml_path.read_text(encoding="utf-8"))
        if isinstance(_raw, list) and all(isinstance(x, str) for x in _raw):
            DWD_GOODS_SUMMARY_PHRASES: list[str] = [x.strip() for x in _raw if x and str(x).strip()]
        else:
            DWD_GOODS_SUMMARY_PHRASES = list(_DEFAULT_PHRASES)
    else:
        DWD_GOODS_SUMMARY_PHRASES = list(_DEFAULT_PHRASES)
except Exception:
    DWD_GOODS_SUMMARY_PHRASES = list(_DEFAULT_PHRASES)
