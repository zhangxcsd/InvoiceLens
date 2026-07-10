"""
台账（dim_audited_enterprise_registry）写入后，同步派生维度表。

- dim_group_enterprise_year / dim_enterprise_year_roster（经 group_enterprise_year_build）
- dim_org_hier / dim_org_node（经 materialize_org_hier_from_registry，向后兼容旧 API）
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, str], None]


def sync_registry_derivatives(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    replace_years: bool = True,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """台账变更后统一刷新集团成员表与组织双树物化表。"""
    build_run_id = run_id or f"registry_sync_{uuid.uuid4().hex[:12]}"

    try:
        from src.local_api.group_enterprise_year_build import rebuild_group_enterprise_year_from_registry

        group_payload = rebuild_group_enterprise_year_from_registry(
            conn,
            stat_years=stat_years,
            replace_years=replace_years,
            run_id=build_run_id,
            on_progress=on_progress,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("集团成员表同步失败")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    if not group_payload.get("ok"):
        return group_payload

    out: dict[str, Any] = {
        "ok": True,
        "run_id": build_run_id,
        "group_enterprise_year": group_payload,
        "rows_written": group_payload.get("rows_written"),
        "stat_years": group_payload.get("stat_years"),
        "year_summaries": group_payload.get("year_summaries"),
    }
    rel = group_payload.get("enterprise_year_rel_rebuild")
    if isinstance(rel, dict):
        out["enterprise_year_rel_rebuild"] = rel
    if group_payload.get("rel_rebuild_warning"):
        out["rel_rebuild_warning"] = group_payload["rel_rebuild_warning"]

    try:
        from src.local_api.dim_org_hier_build import materialize_org_hier_from_registry

        org_payload = materialize_org_hier_from_registry(
            conn,
            stat_years=stat_years or group_payload.get("stat_years"),
            replace_years=replace_years,
            run_id=build_run_id,
            on_progress=on_progress,
        )
        out["org_hier_materialize"] = org_payload
        if not org_payload.get("ok"):
            out["org_hier_sync_warning"] = (org_payload.get("error") or {}).get(
                "message", "组织双树物化失败"
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception("组织双树物化失败")
        out["org_hier_sync_warning"] = str(exc)

    return out


def sync_registry_derivatives_for_snapshot_year(conn: Any, snapshot_year: int) -> dict[str, Any]:
    """单年度台账写入后的轻量同步（不抛异常到调用方）。"""
    try:
        return sync_registry_derivatives(conn, stat_years=[int(snapshot_year)], replace_years=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning("台账派生同步失败 year=%s: %s", snapshot_year, exc)
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
