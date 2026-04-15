#!/usr/bin/env python3
"""
将 config/field_mapping.yaml 的 sheets 块与「label 迁移前备份」对齐：
- 对备份里每个 sheet：表头别名、业务含义（迁移后生成的 label_zh）与 .pre_label_migrate.bak 一致
- 当前文件中「备份里没有」的 sheet 键保留不动

用法：
  python tools/sync_sheets_from_label_migrate_bak.py [--dry-run]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "field_mapping.yaml"
BAK = CFG.with_name("field_mapping.yaml.pre_label_migrate.bak")


def _migrate_value(v: Any) -> Any:
    if isinstance(v, dict) and "aliases" in v:
        return v
    if isinstance(v, list):
        aliases = [str(x).strip() for x in v if x is not None and str(x).strip()]
        if not aliases:
            return {"aliases": []}
        return {"label_zh": aliases[0], "aliases": aliases}
    return v


def _migrate_sheet_block(block: Any) -> dict[str, Any]:
    if not isinstance(block, dict):
        return {}
    out: dict[str, Any] = {}
    for k, v in block.items():
        if not isinstance(k, str):
            continue
        key = k.strip()
        if not key:
            continue
        out[key] = _migrate_value(v)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not CFG.is_file() or not BAK.is_file():
        print("需要同时存在 field_mapping.yaml 与 .pre_label_migrate.bak", file=sys.stderr)
        return 1
    cur = yaml.safe_load(CFG.read_text(encoding="utf-8"))
    old = yaml.safe_load(BAK.read_text(encoding="utf-8"))
    if not isinstance(cur, dict) or not isinstance(old, dict):
        print("YAML 根须为对象", file=sys.stderr)
        return 1
    raw_sheets = old.get("sheets")
    if not isinstance(raw_sheets, dict):
        print("备份中无 sheets 对象", file=sys.stderr)
        return 1
    from_bak: dict[str, Any] = {str(sk): _migrate_sheet_block(bl) for sk, bl in raw_sheets.items()}
    cur_sheets = cur.get("sheets")
    merged: dict[str, Any] = {}
    if isinstance(cur_sheets, dict):
        for sk, bl in cur_sheets.items():
            if sk not in from_bak:
                merged[str(sk)] = bl
    merged.update(from_bak)
    cur["sheets"] = merged
    print(f"自备份恢复 sheets 键数: {len(from_bak)}；合并后共 {len(merged)} 个 sheet 块")
    if args.dry_run:
        print("--dry-run，未写入")
        return 0
    snap = CFG.with_suffix(CFG.suffix + ".pre_sheet_sync.bak")
    shutil.copy2(CFG, snap)
    CFG.write_text(yaml.dump(cur, allow_unicode=True, sort_keys=False, default_flow_style=False), encoding="utf-8")
    print(f"已备份当前文件: {snap}")
    print(f"已写入: {CFG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
