"""Smoke: DWD 单步重跑 API 与构建日志落盘。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api.dwd_build import RETRYABLE_DWD_STEP_IDS, retry_dwd_build_step
from src.local_api.dwd_build_log import dwd_log_file_path, read_dwd_build_log, write_dwd_build_log


def main() -> None:
    bad = retry_dwd_build_step(import_batch_id="batch_x", step_id="read_ods")
    assert bad.get("ok") is False
    assert bad.get("error", {}).get("code") == "step_not_retryable"

    assert "write_dwd" in RETRYABLE_DWD_STEP_IDS

    run_id = "dwd_smoke_test_batch_20260101T000000Z"
    path = write_dwd_build_log(
        run_id=run_id,
        import_batch_id="smoke_batch",
        payload={"ok": True, "message": "smoke"},
    )
    assert path is not None
    assert dwd_log_file_path(run_id).is_file()

    loaded = read_dwd_build_log(run_id)
    assert loaded.get("ok") is True
    assert "smoke" in str(loaded.get("content") or "")

    print("test_dwd_build_log_smoke: OK")


if __name__ == "__main__":
    main()
