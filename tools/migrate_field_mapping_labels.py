#!/usr/bin/env python3
"""
将 field_mapping.yaml 中「纯列表」字段定义迁移为方案 A：

  field:
    label_zh: <首个别名>   # 仅当旧列表非空时写入；空列表不写 label_zh
    aliases:
      - ...

不做运行时隐式等同：label_zh 只在本脚本写入时从「当时第一个别名」拷贝一次。

用法：
  python tools/migrate_field_mapping_labels.py [--config path/to/field_mapping.yaml] [--dry-run]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _migrate_value(v: Any) -> Any | None:
    """返回新节点；若已是新式对象且含 aliases 则原样返回；无法识别则返回 None（跳过）。"""
    if isinstance(v, dict) and "aliases" in v:
        return v
    if isinstance(v, list):
        aliases = [str(x).strip() for x in v if x is not None and str(x).strip()]
        if not aliases:
            return {"aliases": []}
        return {"label_zh": aliases[0], "aliases": aliases}
    return None


def _migrate_block(block: Any) -> tuple[dict[str, Any], int]:
    if not isinstance(block, dict):
        return {}, 0
    out: dict[str, Any] = {}
    changed = 0
    for k, v in block.items():
        if not isinstance(k, str):
            continue
        key = k.strip()
        if not key:
            continue
        if isinstance(v, dict) and "aliases" in v:
            out[key] = v
            continue
        nv = _migrate_value(v)
        if nv is None:
            out[key] = v
            continue
        if nv != v:
            changed += 1
        out[key] = nv
    return out, changed


def migrate_doc(doc: dict[str, Any]) -> tuple[dict[str, Any], int]:
    total = 0
    out = dict(doc)

    if "default" in out and isinstance(out["default"], dict):
        nb, c = _migrate_block(out["default"])
        out["default"] = nb
        total += c
    else:
        # 旧式：顶层字段（排除已知键）
        skip = frozenset({"sheets", "sheet_header_slugs"})
        keys = [k for k in out if k not in skip and isinstance(out[k], (list, dict))]
        for k in keys:
            v = out[k]
            if isinstance(v, dict) and "aliases" in v:
                continue
            nv = _migrate_value(v)
            if nv is not None and nv != v:
                out[k] = nv
                total += 1

    sheets = out.get("sheets")
    if isinstance(sheets, dict):
        ns: dict[str, Any] = {}
        for sk, block in sheets.items():
            if isinstance(block, dict):
                nb, c = _migrate_block(block)
                ns[str(sk)] = nb
                total += c
            else:
                ns[str(sk)] = block
        out["sheets"] = ns

    return out, total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=str, default=str(ROOT / "config" / "field_mapping.yaml"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    path = Path(args.config)
    if not path.is_file():
        print(f"文件不存在: {path}", file=sys.stderr)
        return 1
    raw = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(raw)
    if not isinstance(doc, dict):
        print("根节点须为 YAML 对象", file=sys.stderr)
        return 1
    new_doc, n = migrate_doc(doc)
    print(f"迁移字段节点数（由列表改为 label_zh+aliases 或规范化）: {n}")
    if args.dry_run:
        print("--dry-run：未写入")
        return 0
    bak = path.with_suffix(path.suffix + ".pre_label_migrate.bak")
    shutil.copy2(path, bak)
    path.write_text(yaml.dump(new_doc, allow_unicode=True, sort_keys=False, default_flow_style=False), encoding="utf-8")
    print(f"已备份: {bak}")
    print(f"已写入: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
