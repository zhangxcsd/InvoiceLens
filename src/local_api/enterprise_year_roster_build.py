"""
从 dim_audited_enterprise_registry 计算 dim_enterprise_year_roster（企业年度花名册）。

口径：
- 一行 = 某 stat_year 下的一个成员企业（税号 + 名称）
- 归类维度：台账 state_investor（国家出资企业）；不写入管理/产权层级
- 同步为增量合并：不删除仅人工行（见 docs/dim_enterprise_year_roster_policy.md）
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from typing import Any

from src.local_api.enterprise_year_roster_merge import merge_registry_row, norm_enterprise_id, norm_name_key
from src.local_api.enterprise_year_roster_store import count_manual_only_rows, fetch_roster_row, upsert_roster_row

logger = logging.getLogger(__name__)

AUTOMATION_TASK_CODE = "enterprise_year_roster_build"
TASK_DISPLAY_NAME = "企业年度花名册构建"

ProgressFn = Callable[[str, str], None]
_NORM_ID_RE = re.compile(r"[\s-]+")


def _norm_id(raw: str) -> str:
    return norm_enterprise_id(raw)


def ensure_enterprise_year_roster_schema(conn: Any) -> None:
    """确保花名册表存在，并将报送覆盖视图切换到花名册口径（幂等）。"""
    try:
        from db.schema_sqlfiles import migrate_dim_enterprise_year_roster_schema

        migrate_dim_enterprise_year_roster_schema(conn)
    except Exception as exc:  # noqa: BLE001
        logger.warning("花名册表结构迁移失败: %s", exc)


def _registry_years(conn: Any) -> list[int]:
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT CAST(snapshot_year AS INTEGER) AS y
            FROM dim_audited_enterprise_registry
            WHERE snapshot_year IS NOT NULL
            ORDER BY y DESC
            """
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取台账年度失败: %s", exc)
        return []
    out: list[int] = []
    for (yv,) in rows or []:
        try:
            yi = int(yv)
        except (TypeError, ValueError):
            continue
        if 1990 <= yi <= 2100:
            out.append(yi)
    return out


def chain_rebuild_enterprise_year_rel_after_roster(
    conn: Any,
    *,
    stat_years: list[int],
    trigger_source: str = "roster_build_chain",
    run_id: str | None = None,
) -> dict[str, Any]:
    """花名册刷新成功后，按相同年度重算 dim_enterprise_year_rel（与报送覆盖分母对齐）。"""
    if not stat_years:
        return {"ok": True, "skipped": True, "message": "无目标年度，跳过年度关系重算"}
    try:
        from src.local_api.enterprise_year_rel_build import rebuild_dim_enterprise_year_rel

        return rebuild_dim_enterprise_year_rel(
            conn,
            stat_years=stat_years,
            trigger_source=trigger_source,
            run_id=run_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("花名册后链式重算 dim_enterprise_year_rel 失败")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def rebuild_enterprise_year_roster_from_registry(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    replace_years: bool = True,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
    chain_rel_rebuild: bool = True,
) -> dict[str, Any]:
    """从管理与产权台账增量刷新企业年度花名册（dim_enterprise_year_roster）。

    replace_years 保留兼容；不再整年 DELETE，仅人工行不会被同步删除。
    """

    def _prog(step: str, msg: str) -> None:
        if on_progress:
            on_progress(step, msg)

    _ = replace_years  # 历史参数，不再触发整年删除

    years = [int(y) for y in (stat_years or []) if y is not None]
    if not years:
        years = _registry_years(conn)
    if not years:
        return {
            "ok": False,
            "error": {
                "message": "dim_audited_enterprise_registry 中无可用 snapshot_year，请先在「管理与产权层级信息」维护数据",
                "exception_type": "ValidationError",
            },
        }

    ensure_enterprise_year_roster_schema(conn)

    build_run_id = run_id or f"ent_roster_{uuid.uuid4().hex[:12]}"
    total_written = 0
    year_summaries: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []

    for year_i in years:
        _prog("load_registry", f"读取 {year_i} 年度台账并生成花名册…")
        try:
            rows = conn.execute(
                """
                SELECT
                    row_id,
                    unified_social_credit_code,
                    enterprise_name,
                    state_investor
                FROM dim_audited_enterprise_registry
                WHERE snapshot_year = ?
                  AND trim(COALESCE(unified_social_credit_code, '')) <> ''
                """,
                [year_i],
            ).fetchall()
        except Exception as exc:
            logger.exception("读取台账失败 year=%s", year_i)
            return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

        if not rows:
            manual_only = count_manual_only_rows(conn, stat_year=year_i)
            year_summaries.append(
                {
                    "stat_year": year_i,
                    "written": 0,
                    "skipped": True,
                    "reason": "台账无行",
                    "manual_only_preserved": manual_only,
                }
            )
            continue

        name_to_id: dict[str, str] = {}
        parsed: list[dict[str, Any]] = []
        for r in rows or []:
            eid = _norm_id(str(r[1] or ""))
            if not eid:
                continue
            ename = str(r[2] or "").strip() or eid
            parsed.append(
                {
                    "registry_row_id": str(r[0] or "").strip(),
                    "enterprise_id": eid,
                    "enterprise_name": ename,
                    "state_investor": str(r[3] or "").strip(),
                }
            )
            nk = norm_name_key(ename)
            if nk and nk not in name_to_id:
                name_to_id[nk] = eid

        _prog("write_roster", f"合并写入 {year_i} 年度 dim_enterprise_year_roster（台账 {len(parsed)} 行）…")
        try:
            for row in parsed:
                si_name = row["state_investor"]
                si_id = name_to_id.get(norm_name_key(si_name), "") if si_name else ""
                existing = fetch_roster_row(conn, stat_year=year_i, enterprise_id=row["enterprise_id"])
                merged = merge_registry_row(
                    existing,
                    stat_year=year_i,
                    enterprise_id=row["enterprise_id"],
                    registry_enterprise_name=row["enterprise_name"],
                    registry_state_investor=si_name,
                    registry_state_investor_code=si_id or None,
                    registry_is_member=True,
                    registry_row_id=row["registry_row_id"],
                    build_run_id=build_run_id,
                )
                upsert_roster_row(conn, merged, touch_manual=False)
                total_written += 1
        except Exception as exc:
            logger.exception("写入企业年度花名册失败 year=%s", year_i)
            rejected.append({"stat_year": str(year_i), "reason": str(exc)})
            continue

        manual_only = count_manual_only_rows(conn, stat_year=year_i)
        conflict_n = conn.execute(
            """
            SELECT COUNT(*)::BIGINT FROM dim_enterprise_year_roster
            WHERE stat_year = ? AND quality_status = 'conflict'
            """,
            [year_i],
        ).fetchone()
        conflict_count = int(conflict_n[0] or 0) if conflict_n else 0
        year_summaries.append(
            {
                "stat_year": year_i,
                "written": len(parsed),
                "registry_rows": len(parsed),
                "conflict_count": conflict_count,
                "manual_only_preserved": manual_only,
            }
        )

    if total_written == 0 and rejected and not any(s.get("manual_only_preserved") for s in year_summaries):
        return {
            "ok": False,
            "error": {"message": rejected[0].get("reason", "写入失败"), "exception_type": "BuildError"},
            "run_id": build_run_id,
            "year_summaries": year_summaries,
            "rejected": rejected,
        }

    out: dict[str, Any] = {
        "ok": True,
        "run_id": build_run_id,
        "automation_task_code": AUTOMATION_TASK_CODE,
        "rows_written": total_written,
        "stat_years": years,
        "year_summaries": year_summaries,
        "rejected": rejected,
    }
    if chain_rel_rebuild:
        rel_payload = chain_rebuild_enterprise_year_rel_after_roster(
            conn,
            stat_years=years,
            trigger_source="roster_build_chain",
            run_id=build_run_id,
        )
        out["enterprise_year_rel_rebuild"] = rel_payload
        if not rel_payload.get("ok") and not rel_payload.get("skipped"):
            out["rel_rebuild_warning"] = (rel_payload.get("error") or {}).get(
                "message", "年度购销标志重算失败，请到「DWD 派生任务」手动重算"
            )
    return out


def sync_enterprise_year_roster_for_snapshot_year(conn: Any, snapshot_year: int) -> dict[str, Any]:
    """台账单条写入后，同步该快照年度的花名册（不抛异常到调用方）。"""
    try:
        return rebuild_enterprise_year_roster_from_registry(
            conn,
            stat_years=[int(snapshot_year)],
            replace_years=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("花名册同步失败 year=%s: %s", snapshot_year, exc)
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
