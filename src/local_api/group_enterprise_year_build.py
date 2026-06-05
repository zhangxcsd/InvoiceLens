"""
从 dim_audited_enterprise_registry（管理与产权层级信息）计算 dim_group_enterprise_year。

口径：
- 来源：被审企业台账 snapshot_year → stat_year；统一社会信用代码 → enterprise_id
- 管理/产权层级、上级单位名称来自台账 mgmt_level / mgmt_parent、equity_level / shareholders
- level1_group：沿管理链上溯至 mgmt_level=1 的节点（与 dim_level1_enterprise_year 识别号可对齐）
- 上级 ID：在同年度台账内按企业名称匹配；level 0/1 时 parent 自指
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, str], None]
_NORM_ID_RE = re.compile(r"[\s-]+")
_EQUITY_PARENT_RE = re.compile(r"[（(].*$")


def _norm_id(raw: str) -> str:
    return _NORM_ID_RE.sub("", str(raw or "").strip()).upper()


def _norm_name(raw: str) -> str:
    return str(raw or "").strip().lower()


def _parse_equity_parent_name(shareholders: str) -> str:
    s = str(shareholders or "").strip()
    if not s:
        return ""
    return _EQUITY_PARENT_RE.sub("", s).strip()


def _safe_level(v: Any, default: int = 2) -> int:
    try:
        n = int(v)
        return n if n >= 0 else default
    except (TypeError, ValueError):
        return default


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


def _resolve_parent_id(
    parent_name: str,
    *,
    self_id: str,
    level: int,
    name_to_id: dict[str, str],
) -> tuple[str, str | None]:
    """返回 (parent_id, quality_issue)。"""
    if level in (0, 1):
        return self_id, None
    key = _norm_name(parent_name)
    if not key:
        return self_id, "上级单位名称为空，已暂设为自指"
    pid = name_to_id.get(key)
    if pid and pid != self_id:
        return pid, None
    return self_id, f"未在同年度台账中匹配到上级「{parent_name.strip()}」"


def _walk_mgmt_level1(
    enterprise_id: str,
    *,
    id_to_mgmt_level: dict[str, int],
    id_to_mgmt_parent_id: dict[str, str],
    id_to_name: dict[str, str],
    max_depth: int = 32,
) -> str:
    cur = enterprise_id
    for _ in range(max_depth):
        lvl = id_to_mgmt_level.get(cur, 2)
        if lvl <= 1:
            return cur
        parent = id_to_mgmt_parent_id.get(cur, cur)
        if not parent or parent == cur:
            return cur
        cur = parent
    return cur


def _walk_root(
    enterprise_id: str,
    *,
    id_to_level: dict[str, int],
    id_to_parent_id: dict[str, str],
    max_depth: int = 32,
) -> str:
    cur = enterprise_id
    for _ in range(max_depth):
        lvl = id_to_level.get(cur, 2)
        parent = id_to_parent_id.get(cur, cur)
        if lvl <= 0 or not parent or parent == cur:
            return cur
        cur = parent
    return cur


def rebuild_group_enterprise_year_from_registry(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    replace_years: bool = True,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    def _prog(step: str, msg: str) -> None:
        if on_progress:
            on_progress(step, msg)

    years = [int(y) for y in (stat_years or []) if y is not None]
    if not years:
        years = _registry_years(conn)
    if not years:
        return {
            "ok": False,
            "error": {
                "message": "dim_audited_enterprise_registry 中无可用 snapshot_year，请先在「管理与产权层级信息」导入或维护数据",
                "exception_type": "ValidationError",
            },
        }

    build_run_id = run_id or f"group_year_{uuid.uuid4().hex[:12]}"
    total_written = 0
    year_summaries: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []

    # 企业年度花名册与集团双树表同源刷新：花名册为覆盖分析/一级名单成员查询的权威口径
    try:
        from src.local_api.enterprise_year_roster_build import rebuild_enterprise_year_roster_from_registry

        roster_payload = rebuild_enterprise_year_roster_from_registry(
            conn,
            stat_years=years,
            replace_years=replace_years,
            run_id=build_run_id,
            on_progress=on_progress,
        )
        if not roster_payload.get("ok"):
            return roster_payload
    except Exception as exc:  # noqa: BLE001
        logger.exception("同步企业年度花名册失败")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    for year_i in years:
        _prog("load_registry", f"读取 {year_i} 年度管理与产权台账…")
        try:
            rows = conn.execute(
                """
                SELECT
                    unified_social_credit_code,
                    enterprise_name,
                    mgmt_level,
                    mgmt_parent,
                    equity_level,
                    shareholders,
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
            year_summaries.append({"stat_year": year_i, "written": 0, "skipped": True, "reason": "台账无行"})
            continue

        name_to_id: dict[str, str] = {}
        id_to_name: dict[str, str] = {}
        parsed_rows: list[dict[str, Any]] = []
        for r in rows or []:
            eid = _norm_id(str(r[0] or ""))
            if not eid:
                continue
            ename = str(r[1] or "").strip() or eid
            parsed_rows.append(
                {
                    "enterprise_id": eid,
                    "enterprise_name": ename,
                    "mgmt_level": _safe_level(r[2], 2),
                    "mgmt_parent_name": str(r[3] or "").strip(),
                    "equity_level": _safe_level(r[4], 2),
                    "equity_parent_name": _parse_equity_parent_name(str(r[5] or "")),
                    "state_investor": str(r[6] or "").strip(),
                }
            )
            id_to_name[eid] = ename
            nk = _norm_name(ename)
            if nk and nk not in name_to_id:
                name_to_id[nk] = eid

        _prog("resolve_hierarchy", f"解析 {year_i} 年度组织层级（{len(parsed_rows)} 家）…")

        id_to_mgmt_parent: dict[str, str] = {}
        id_to_equity_parent: dict[str, str] = {}
        id_to_mgmt_level = {x["enterprise_id"]: x["mgmt_level"] for x in parsed_rows}
        id_to_equity_level = {x["enterprise_id"]: x["equity_level"] for x in parsed_rows}

        for row in parsed_rows:
            eid = row["enterprise_id"]
            mpid, _ = _resolve_parent_id(
                row["mgmt_parent_name"],
                self_id=eid,
                level=row["mgmt_level"],
                name_to_id=name_to_id,
            )
            epid, _ = _resolve_parent_id(
                row["equity_parent_name"],
                self_id=eid,
                level=row["equity_level"],
                name_to_id=name_to_id,
            )
            id_to_mgmt_parent[eid] = mpid
            id_to_equity_parent[eid] = epid

        out_rows: list[dict[str, Any]] = []
        for row in parsed_rows:
            eid = row["enterprise_id"]
            mgmt_parent_id, mgmt_issue = _resolve_parent_id(
                row["mgmt_parent_name"],
                self_id=eid,
                level=row["mgmt_level"],
                name_to_id=name_to_id,
            )
            equity_parent_id, eq_issue = _resolve_parent_id(
                row["equity_parent_name"],
                self_id=eid,
                level=row["equity_level"],
                name_to_id=name_to_id,
            )
            l1_id = _walk_mgmt_level1(
                eid,
                id_to_mgmt_level=id_to_mgmt_level,
                id_to_mgmt_parent_id=id_to_mgmt_parent,
                id_to_name=id_to_name,
            )
            l1_name = id_to_name.get(l1_id, row["enterprise_name"])
            mgmt_root = _walk_root(eid, id_to_level=id_to_mgmt_level, id_to_parent_id=id_to_mgmt_parent)
            equity_root = _walk_root(eid, id_to_level=id_to_equity_level, id_to_parent_id=id_to_equity_parent)
            issues = [x for x in (mgmt_issue, eq_issue) if x]
            quality_status = "ok" if not issues else "conflict"
            quality_issue = "；".join(issues) if issues else None
            mgmt_parent_name = row["mgmt_parent_name"] or id_to_name.get(mgmt_parent_id, "")
            equity_parent_name = row["equity_parent_name"] or id_to_name.get(equity_parent_id, "")

            out_rows.append(
                {
                    "stat_year": year_i,
                    "enterprise_id": eid,
                    "enterprise_name": row["enterprise_name"],
                    "is_member": True,
                    "level1_group_id": l1_id,
                    "level1_group_name": l1_name,
                    "mgmt_root_enterprise_id": mgmt_root,
                    "mgmt_root_enterprise_name": id_to_name.get(mgmt_root, ""),
                    "mgmt_status": "active",
                    "mgmt_parent_enterprise_id": mgmt_parent_id,
                    "mgmt_parent_enterprise_name": mgmt_parent_name,
                    "mgmt_level": row["mgmt_level"],
                    "equity_root_enterprise_id": equity_root,
                    "equity_root_enterprise_name": id_to_name.get(equity_root, ""),
                    "equity_status": "active",
                    "equity_parent_enterprise_id": equity_parent_id,
                    "equity_parent_enterprise_name": equity_parent_name,
                    "equity_level": row["equity_level"],
                    "data_source": "audited_enterprise_registry",
                    "source_record_id": build_run_id,
                    "quality_status": quality_status,
                    "quality_issue": quality_issue,
                }
            )

        _prog("write_group_year", f"写入 {year_i} 年度 dim_group_enterprise_year（{len(out_rows)} 行）…")
        try:
            if replace_years:
                conn.execute("DELETE FROM dim_group_enterprise_year WHERE stat_year = ?", [year_i])
            for item in out_rows:
                conn.execute(
                    """
                    INSERT INTO dim_group_enterprise_year (
                        stat_year, enterprise_id, enterprise_name, is_member,
                        level1_group_id, level1_group_name,
                        mgmt_root_enterprise_id, mgmt_root_enterprise_name,
                        mgmt_status, mgmt_parent_enterprise_id, mgmt_parent_enterprise_name, mgmt_level,
                        equity_root_enterprise_id, equity_root_enterprise_name,
                        equity_status, equity_parent_enterprise_id, equity_parent_enterprise_name, equity_level,
                        data_source, source_record_id, quality_status, quality_issue, updated_at
                    ) VALUES (
                        ?, ?, ?, ?,
                        ?, ?,
                        ?, ?,
                        ?, ?, ?, ?,
                        ?, ?,
                        ?, ?, ?, ?,
                        ?, ?, ?, ?, now()
                    )
                    ON CONFLICT (stat_year, enterprise_id) DO UPDATE SET
                        enterprise_name = excluded.enterprise_name,
                        is_member = excluded.is_member,
                        level1_group_id = excluded.level1_group_id,
                        level1_group_name = excluded.level1_group_name,
                        mgmt_root_enterprise_id = excluded.mgmt_root_enterprise_id,
                        mgmt_root_enterprise_name = excluded.mgmt_root_enterprise_name,
                        mgmt_status = excluded.mgmt_status,
                        mgmt_parent_enterprise_id = excluded.mgmt_parent_enterprise_id,
                        mgmt_parent_enterprise_name = excluded.mgmt_parent_enterprise_name,
                        mgmt_level = excluded.mgmt_level,
                        equity_root_enterprise_id = excluded.equity_root_enterprise_id,
                        equity_root_enterprise_name = excluded.equity_root_enterprise_name,
                        equity_status = excluded.equity_status,
                        equity_parent_enterprise_id = excluded.equity_parent_enterprise_id,
                        equity_parent_enterprise_name = excluded.equity_parent_enterprise_name,
                        equity_level = excluded.equity_level,
                        data_source = excluded.data_source,
                        source_record_id = excluded.source_record_id,
                        quality_status = excluded.quality_status,
                        quality_issue = excluded.quality_issue,
                        updated_at = now()
                    """,
                    [
                        item["stat_year"],
                        item["enterprise_id"],
                        item["enterprise_name"],
                        item["is_member"],
                        item["level1_group_id"],
                        item["level1_group_name"],
                        item["mgmt_root_enterprise_id"],
                        item["mgmt_root_enterprise_name"],
                        item["mgmt_status"],
                        item["mgmt_parent_enterprise_id"],
                        item["mgmt_parent_enterprise_name"],
                        item["mgmt_level"],
                        item["equity_root_enterprise_id"],
                        item["equity_root_enterprise_name"],
                        item["equity_status"],
                        item["equity_parent_enterprise_id"],
                        item["equity_parent_enterprise_name"],
                        item["equity_level"],
                        item["data_source"],
                        item["source_record_id"],
                        item["quality_status"],
                        item["quality_issue"],
                    ],
                )
        except Exception as exc:
            logger.exception("写入集团成员表失败 year=%s", year_i)
            rejected.append({"stat_year": str(year_i), "reason": str(exc)})
            continue

        total_written += len(out_rows)
        conflict_n = sum(1 for x in out_rows if x.get("quality_status") == "conflict")
        year_summaries.append(
            {
                "stat_year": year_i,
                "written": len(out_rows),
                "conflict_count": conflict_n,
            }
        )

    if total_written == 0 and rejected:
        return {
            "ok": False,
            "error": {"message": rejected[0].get("reason", "写入失败"), "exception_type": "BuildError"},
            "run_id": build_run_id,
            "year_summaries": year_summaries,
            "rejected": rejected,
        }

    return {
        "ok": True,
        "run_id": build_run_id,
        "rows_written": total_written,
        "stat_years": years,
        "year_summaries": year_summaries,
        "rejected": rejected,
    }
