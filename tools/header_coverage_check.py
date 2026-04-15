# -*- coding: utf-8 -*-
"""
独立 CLI：检查 Excel 中「勾选目标」对应工作表的表头是否在 field_mapping.yaml（含 sheet_header_slugs）覆盖范围内。

用法（项目根）：
  python tools/header_coverage_check.py sample.xlsx --targets 发票基础信息 信息汇总表
  python tools/header_coverage_check.py a.xlsx b.xlsx --targets 二手车销售 --json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.services.header_coverage import analyze_excel_path  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="发票表头 YAML 覆盖检查")
    ap.add_argument("excel", nargs="+", type=str, help="一个或多个 .xlsx 路径")
    ap.add_argument(
        "--targets",
        nargs="+",
        required=True,
        help="与导入勾选一致的 sheet key（工作表名包含即命中）",
    )
    ap.add_argument("--json", action="store_true", help="输出 JSON 行（每文件一条）")
    args = ap.parse_args()

    any_bad = False
    for rel in args.excel:
        p = Path(rel)
        if not p.is_absolute():
            p = ROOT / p
        if not p.exists():
            print(f"skip missing: {p}", file=sys.stderr)
            any_bad = True
            continue
        out = analyze_excel_path(p, list(args.targets))
        if args.json:
            print(json.dumps(out, ensure_ascii=False))
        else:
            if not out.get("ok"):
                err = out.get("error") or {}
                print(f"{p.name}: ERROR {err.get('message', out)}")
                any_bad = True
                continue
            print(f"{p.name}:")
            for s in out.get("sheets") or []:
                sn = s.get("sheet_name", "")
                um = s.get("unmapped_headers") or []
                if not um:
                    print(f"  [{sn}] OK")
                    continue
                any_bad = True
                sug = s.get("suggested_slugs") or {}
                pairs = "；".join(f"{h} → {sug.get(h, '?')}" for h in um)
                print(f"  [{sn}] 未覆盖 ({len(um)}): {pairs}")
            hint = out.get("update_hint")
            if hint and not args.json:
                print(f"  提示: {hint}")
    return 1 if any_bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
