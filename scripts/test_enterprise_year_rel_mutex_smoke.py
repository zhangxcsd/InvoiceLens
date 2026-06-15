"""Smoke: enterprise_year_rel 重算互斥（进程内锁）。"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.enterprise_year_rel_build import (
    REL_REBUILD_BUSY_CODE,
    _end_rel_rebuild,
    _try_begin_rel_rebuild,
    rel_rebuild_busy_message,
)


def main() -> None:
    with patch(
        "src.local_api.dwd_to_dim_build.summarize_dim_task_status",
        return_value={"tasks": []},
    ):
        e1 = _try_begin_rel_rebuild(run_id="REL_SMOKE_A", trigger_source="smoke_a")
        assert e1 is None, e1
        busy = rel_rebuild_busy_message()
        assert busy and "REL_SMOKE_A" in busy, busy

        e2 = _try_begin_rel_rebuild(run_id="REL_SMOKE_B", trigger_source="smoke_b")
        assert e2 is not None, "second acquire should fail"
        assert e2.get("error", {}).get("code") == REL_REBUILD_BUSY_CODE

        e3 = _try_begin_rel_rebuild(run_id="REL_SMOKE_A", trigger_source="smoke_a")
        assert e3 is None, "same run_id should be allowed (re-entrant exclude)"

        _end_rel_rebuild(run_id="REL_SMOKE_A")
        assert rel_rebuild_busy_message() is None

        e4 = _try_begin_rel_rebuild(run_id="REL_SMOKE_B", trigger_source="smoke_b")
        assert e4 is None, e4
        _end_rel_rebuild(run_id="REL_SMOKE_B")

    print("test_enterprise_year_rel_mutex_smoke: OK")


if __name__ == "__main__":
    main()
