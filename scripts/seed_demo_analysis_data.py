#!/usr/bin/env python3
"""一键写入演示分析数据（DWD + DWS + 分析主体池）。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from db.duckdb_conn import get_conn
    from src.bootstrap.demo_analysis_seed import DEMO_STAT_YEAR, seed_demo_analysis_data

    conn = get_conn()
    result = seed_demo_analysis_data(conn)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    if not result.get("ok"):
        return 1
    v = result.get("verification") or {}
    print(
        f"\n验证 ({DEMO_STAT_YEAR})："
        f" 年度={result.get('stat_years', [DEMO_STAT_YEAR])}，"
        f" 分析主体={v.get('analysis_subject_options', '?')}，"
        f" dws_trade_sum={v.get('dws_trade_sum', '?')}，"
        f" dwd_headers={v.get('dwd_inv_header', '?')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
