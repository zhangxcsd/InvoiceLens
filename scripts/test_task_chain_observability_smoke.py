"""Smoke: 任务链可观测性与单步重试 API。"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.local_api import dim_task_chain as chain_mod


def test_init_step_rows_respects_skip_subject() -> None:
    all_steps = chain_mod._init_step_rows(skip_subject_pipeline=False)
    skip_steps = chain_mod._init_step_rows(skip_subject_pipeline=True)
    assert len(all_steps) == len(chain_mod.CHAIN_STEP_DEFS)
    assert len(skip_steps) == len(chain_mod.CHAIN_STEP_DEFS) - 1
    assert all(s["status"] == "pending" for s in all_steps)
    assert skip_steps[0]["step_id"] == "enterprise_year_roster_build"


def test_derive_overall_status() -> None:
    steps = [
        {"status": "success"},
        {"status": "failed"},
        {"status": "pending"},
    ]
    assert chain_mod._derive_overall_status(steps, terminal=True) == "partial"
    assert chain_mod._derive_overall_status(steps, terminal=False) == "partial"
    assert chain_mod._derive_overall_status([{"status": "success"}], terminal=True) == "success"


def test_persist_and_list_runs() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store_path = Path(tmp) / "task_chain_runs.json"
        run_id = "chain_persist01"
        steps = chain_mod._init_step_rows(skip_subject_pipeline=True)
        chain_mod._mark_step_running(steps, steps[0]["step_id"])
        chain_mod._mark_step_failed(steps, steps[0]["step_id"], error_message="mock fail")
        record = {
            "run_id": run_id,
            "started_at": chain_mod._utc_now_iso(),
            "finished_at": chain_mod._utc_now_iso(),
            "overall_status": "partial",
            "status": "partial",
            "message": "mock partial",
            "params": {"skip_subject_pipeline": True},
            "stat_years": [2024],
            "instance_snapshot": {"default_stat_year": 2024, "min_analysis_subject_invoice_count": 10},
            "steps": steps,
        }
        with patch.object(chain_mod, "_RUNS_STORE_PATH", store_path):
            chain_mod._persist_run_record(record)
            st = chain_mod.get_dim_task_chain_status(run_id)
            assert st["ok"] is True
            assert st["overall_status"] == "partial"
            assert st["steps"][0]["error_message"] == "mock fail"
            assert st["steps"][0]["duration_ms"] is not None
            listing = chain_mod.list_dim_task_chain_runs(limit=5)
            assert listing["ok"] is True
            assert listing["runs"][0]["run_id"] == run_id


def test_retry_step_rejects_and_accepts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store_path = Path(tmp) / "task_chain_runs.json"
        run_id = "chain_test_retry"
        steps = chain_mod._init_step_rows(skip_subject_pipeline=True)
        steps[0]["status"] = "failed"
        steps[0]["error_message"] = "boom"
        record = {
            "run_id": run_id,
            "overall_status": "partial",
            "status": "partial",
            "params": {"skip_subject_pipeline": True, "stat_years": [2024], "with_relations": True},
            "stat_years": [2024],
            "steps": steps,
        }
        store_path.parent.mkdir(parents=True, exist_ok=True)
        store_path.write_text(json.dumps({"runs": [record]}, ensure_ascii=False), encoding="utf-8")

        with patch.object(chain_mod, "_RUNS_STORE_PATH", store_path), patch.object(
            chain_mod, "_chain_busy_message", return_value=None
        ):
            bad = chain_mod.retry_dim_task_chain_step(run_id=run_id, step_id="not_a_step")
            assert bad["ok"] is False

            ok_step = steps[0]["step_id"]
            called: dict[str, str] = {}

            def fake_job(rid, stat_years, overwrite, with_rel, skip_subject, start_from, single_step_only=False):
                called["run_id"] = rid
                called["start_from"] = str(start_from)
                called["single_step_only"] = str(single_step_only)
                with chain_mod._chain_jobs_lock:
                    job = chain_mod._chain_jobs.get(rid)
                    if job:
                        job["status"] = "success"
                        job["overall_status"] = "success"
                    if chain_mod._active_chain_run_id == rid:
                        chain_mod._active_chain_run_id = None

            with patch.object(chain_mod, "_run_dim_task_chain_job", side_effect=fake_job):
                retry = chain_mod.retry_dim_task_chain_step(run_id=run_id, step_id=ok_step)
                assert retry["ok"] is True
                assert retry["retry_count"] == 1
                deadline = time.time() + 3
                while time.time() < deadline and "run_id" not in called:
                    time.sleep(0.02)
                assert called.get("run_id") == run_id
                assert called.get("start_from") == ok_step
                assert called.get("single_step_only") == "False"

                called.clear()
                with patch.object(chain_mod, "_run_dim_task_chain_job", side_effect=fake_job):
                    retry_only = chain_mod.retry_dim_task_chain_step(
                        run_id=run_id, step_id=ok_step, continue_chain=False
                    )
                    assert retry_only["ok"] is True
                    deadline = time.time() + 3
                    while time.time() < deadline and "single_step_only" not in called:
                        time.sleep(0.02)
                    assert called.get("single_step_only") == "True"


def test_instance_snapshot() -> None:
    snap = chain_mod._instance_config_snapshot()
    assert isinstance(snap, dict)
    assert "min_analysis_subject_invoice_count" in snap


def main() -> None:
    test_init_step_rows_respects_skip_subject()
    test_derive_overall_status()
    test_persist_and_list_runs()
    test_retry_step_rejects_and_accepts()
    test_instance_snapshot()
    print("task_chain_observability_smoke: OK")


if __name__ == "__main__":
    main()
