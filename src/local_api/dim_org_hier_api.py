"""组织层级双树 dim_org_hier HTTP API。"""

from __future__ import annotations

import logging
import math
from typing import Any

logger = logging.getLogger(__name__)


def _relation_type(mg_parent: str | None, eq_parent: str | None) -> str:
    if str(mg_parent or "") == str(eq_parent or ""):
        return "一致"
    return "不一致"


def _display_name(shortname: Any, fullname: Any) -> str:
    s = str(shortname or "").strip()
    return s or str(fullname or "").strip() or "—"


def api_org_hier_meta(conn: Any) -> dict[str, Any]:
    try:
        years = conn.execute(
            """
            SELECT DISTINCT CAST(stat_year AS VARCHAR) AS y
            FROM dim_org_hier
            ORDER BY y DESC
            """
        ).fetchall()
        stat_years = [str(r[0]) for r in years or [] if r[0] is not None]
        total = conn.execute("SELECT COUNT(*) FROM dim_org_hier").fetchone()[0]
    except Exception as exc:  # noqa: BLE001
        logger.warning("org_hier meta: %s", exc)
        stat_years = []
        total = 0
    return {
        "ok": True,
        "stat_years": stat_years,
        "row_count": int(total or 0),
        "empty_hint": "暂无组织层级数据。请上传组织维度 Excel 模板导入。" if not stat_years else "",
    }


def _build_tree_nodes(
    rows: list[dict[str, Any]],
    *,
    tree: str,
) -> list[dict[str, Any]]:
    parent_key = "mg_parent_id" if tree == "mg" else "eq_parent_id"
    sort_key = "mg_sort_no" if tree == "mg" else "eq_sort_no"
    level_key = "mg_level" if tree == "mg" else "eq_level"
    path_key = "mg_path" if tree == "mg" else "eq_path"

    by_id = {r["entity_id"]: r for r in rows}
    children_map: dict[str, list[dict[str, Any]]] = {}
    roots: list[dict[str, Any]] = []

    for r in rows:
        eid = r["entity_id"]
        pid = str(r.get(parent_key) or "")
        if pid == eid or pid not in by_id:
            roots.append(r)
        else:
            children_map.setdefault(pid, []).append(r)

    for pid in children_map:
        children_map[pid].sort(
            key=lambda x: (
                int(x.get(sort_key) or 0),
                _display_name(x.get("entity_shortname"), x.get("entity_fullname")),
            )
        )
    roots.sort(
        key=lambda x: (
            int(x.get(level_key) or 0),
            int(x.get(sort_key) or 0),
            _display_name(x.get("entity_shortname"), x.get("entity_fullname")),
        )
    )

    def to_node(row: dict[str, Any]) -> dict[str, Any]:
        eid = row["entity_id"]
        pid = row.get(parent_key)
        parent = by_id.get(str(pid or "")) if pid and str(pid) != eid else None
        return {
            "id": eid,
            "name": _display_name(row.get("entity_shortname"), row.get("entity_fullname")),
            "entity_fullname": row.get("entity_fullname"),
            "level": int(row.get(level_key) or 0),
            "parent_id": None if not parent else str(pid),
            "parent_name": _display_name(parent.get("entity_shortname"), parent.get("entity_fullname")) if parent else "—",
            "sort_no": int(row.get(sort_key) or 0),
            "path": row.get(path_key) or "",
            "is_hier_diff": bool(row.get("is_hier_diff")),
            "hier_diff_note": row.get("hier_diff_note"),
            "eq_shareholding_ratio": row.get("eq_shareholding_ratio"),
            "children": [to_node(c) for c in children_map.get(eid, [])],
        }

    return [to_node(r) for r in roots]


def api_org_hier_tree(
    conn: Any,
    *,
    stat_year: str | None = None,
    tree: str = "mg",
    keyword: str | None = None,
) -> dict[str, Any]:
    meta = api_org_hier_meta(conn)
    years = meta.get("stat_years") or []
    selected = stat_year or (years[0] if years else None)
    if not selected:
        return {
            "ok": True,
            "stat_years": years,
            "selected_year": None,
            "tree": tree,
            "nodes": [],
            "empty_hint": meta.get("empty_hint") or "暂无数据",
        }

    tree_mode = "eq" if str(tree or "").lower().startswith("eq") else "mg"
    try:
        year_i = int(selected)
    except (TypeError, ValueError):
        return {"ok": False, "error": {"message": "stat_year 无效"}}

    try:
        raw = conn.execute(
            """
            SELECT
                entity_id, entity_shortname, entity_fullname,
                mg_parent_id, mg_sort_no, mg_level, mg_path,
                eq_parent_id, eq_sort_no, eq_level, eq_path,
                eq_shareholding_ratio, is_hier_diff, hier_diff_note
            FROM dim_org_hier
            WHERE stat_year = ?
            ORDER BY mg_level, mg_sort_no, entity_fullname
            """,
            [year_i],
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    rows = [
        {
            "entity_id": str(r[0]),
            "entity_shortname": r[1],
            "entity_fullname": r[2],
            "mg_parent_id": r[3],
            "mg_sort_no": r[4],
            "mg_level": r[5],
            "mg_path": r[6],
            "eq_parent_id": r[7],
            "eq_sort_no": r[8],
            "eq_level": r[9],
            "eq_path": r[10],
            "eq_shareholding_ratio": float(r[11]) if r[11] is not None else None,
            "is_hier_diff": bool(r[12]),
            "hier_diff_note": r[13],
        }
        for r in raw or []
    ]

    kw = (keyword or "").strip().lower()
    if kw:
        rows = [
            r
            for r in rows
            if kw in _display_name(r.get("entity_shortname"), r.get("entity_fullname")).lower()
            or kw in str(r.get("entity_id") or "").lower()
        ]

    nodes = _build_tree_nodes(rows, tree=tree_mode)
    return {
        "ok": True,
        "stat_years": years,
        "selected_year": str(year_i),
        "tree": tree_mode,
        "nodes": nodes,
        "node_count": len(rows),
        "empty_hint": "" if rows else f"{year_i} 年度暂无组织层级数据",
    }


def api_org_hier_rows(
    conn: Any,
    *,
    stat_year: str | None = None,
    keyword: str | None = None,
    diff_only: bool = False,
    page: int = 1,
    page_size: int = 50,
    sort: str | None = None,
) -> dict[str, Any]:
    meta = api_org_hier_meta(conn)
    years = meta.get("stat_years") or []
    selected = stat_year or (years[0] if years else None)
    if not selected:
        return {
            "ok": True,
            "stat_years": years,
            "rows": [],
            "total": 0,
            "page": page,
            "page_size": page_size,
            "kpis": _empty_kpis(),
        }

    try:
        year_i = int(selected)
    except (TypeError, ValueError):
        return {"ok": False, "error": {"message": "stat_year 无效"}}

    where = ["h.stat_year = ?"]
    params: list[Any] = [year_i]
    if diff_only:
        where.append("h.is_hier_diff = TRUE")
    kw = (keyword or "").strip()
    if kw:
        where.append(
            "(LOWER(COALESCE(h.entity_shortname, h.entity_fullname, '')) LIKE ? OR LOWER(h.entity_id) LIKE ?)"
        )
        like = f"%{kw.lower()}%"
        params.extend([like, like])

    where_sql = " AND ".join(where)
    order_sql = "h.mg_level, h.mg_sort_no, h.entity_id"
    if sort == "name_desc":
        order_sql = "h.mg_level DESC, h.mg_sort_no DESC, h.entity_id DESC"
    elif sort == "name_asc":
        order_sql = "h.mg_level, h.mg_sort_no, h.entity_id"
    elif sort == "mgmt_path_asc":
        order_sql = "h.mg_level, h.mg_sort_no, h.entity_id"
    elif sort == "equity_path_asc":
        order_sql = "h.eq_level, h.eq_sort_no, h.entity_id"
    elif sort == "relation_type_desc":
        order_sql = "h.is_hier_diff DESC, h.mg_level, h.entity_id"

    try:
        total = conn.execute(
            f"SELECT COUNT(*) FROM dim_org_hier h WHERE {where_sql}",
            params,
        ).fetchone()[0]
        offset = max(0, (max(1, int(page)) - 1) * max(1, min(int(page_size), 500)))
        limit = max(1, min(int(page_size), 500))
        raw = conn.execute(
            f"""
            SELECT
                h.entity_id,
                COALESCE(h.entity_shortname, h.entity_fullname, h.entity_id),
                CAST(h.stat_year AS VARCHAR),
                h.mg_path,
                h.eq_path,
                h.mg_parent_id,
                h.eq_parent_id,
                h.is_hier_diff,
                h.hier_diff_note,
                h.mg_level,
                h.eq_level
            FROM dim_org_hier h
            WHERE {where_sql}
            ORDER BY {order_sql}
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    rows = [
        {
            "code": str(r[0]),
            "name": str(r[1] or r[0]),
            "snapshot_year": str(r[2]),
            "mgmt_path": str(r[3] or "—"),
            "equity_path": str(r[4] or "—"),
            "relation_type": _relation_type(r[5], r[6]),
            "is_hier_diff": bool(r[7]),
            "hier_diff_note": r[8],
            "mgmt_level": int(r[9] or 0),
            "equity_level": int(r[10] or 0),
            "state_investor_enterprise": "—",
        }
        for r in raw or []
    ]

    kpis = api_org_hier_diff_summary(conn, stat_year=str(year_i)).get("kpis") or _empty_kpis()
    return {
        "ok": True,
        "stat_years": years,
        "selected_year": str(year_i),
        "rows": rows,
        "total": int(total or 0),
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, math.ceil(int(total or 0) / limit)) if total else 0,
        "kpis": kpis,
    }


def _empty_kpis() -> dict[str, int]:
    return {
        "total": 0,
        "relation_mismatch": 0,
        "hier_diff": 0,
        "mg_change_count": 0,
        "eq_change_count": 0,
        "log_count": 0,
    }


def api_org_hier_diff_summary(conn: Any, *, stat_year: str | None = None) -> dict[str, Any]:
    meta = api_org_hier_meta(conn)
    years = meta.get("stat_years") or []
    selected = stat_year or (years[0] if years else None)
    if not selected:
        return {"ok": True, "stat_years": years, "kpis": _empty_kpis()}

    try:
        year_i = int(selected)
    except (TypeError, ValueError):
        return {"ok": False, "error": {"message": "stat_year 无效"}}

    try:
        total = int(
            conn.execute("SELECT COUNT(*) FROM dim_org_hier WHERE stat_year = ?", [year_i]).fetchone()[0] or 0
        )
        hier_diff = int(
            conn.execute(
                "SELECT COUNT(*) FROM dim_org_hier WHERE stat_year = ? AND is_hier_diff = TRUE",
                [year_i],
            ).fetchone()[0]
            or 0
        )
        log_count = int(
            conn.execute(
                "SELECT COUNT(*) FROM dim_org_hier_log WHERE stat_year = ?",
                [year_i],
            ).fetchone()[0]
            or 0
        )
        mg_change = int(
            conn.execute(
                """
                SELECT COUNT(*) FROM dim_org_hier_log
                WHERE stat_year = ? AND change_type IN ('管理变更', '管产双变')
                """,
                [year_i],
            ).fetchone()[0]
            or 0
        )
        eq_change = int(
            conn.execute(
                """
                SELECT COUNT(*) FROM dim_org_hier_log
                WHERE stat_year = ? AND change_type IN ('产权变更', '管产双变')
                """,
                [year_i],
            ).fetchone()[0]
            or 0
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    return {
        "ok": True,
        "stat_years": years,
        "selected_year": str(year_i),
        "kpis": {
            "total": total,
            "relation_mismatch": hier_diff,
            "hier_diff": hier_diff,
            "mg_change_count": mg_change,
            "eq_change_count": eq_change,
            "log_count": log_count,
            "mapped": total,
            "unmapped": 0,
            "in_analysis_pool": 0,
        },
    }


def api_org_hier_import(
    conn: Any,
    *,
    file_bytes: bytes,
    upload_filename: str | None,
    dry_run: bool = False,
    run_id: str | None = None,
) -> dict[str, Any]:
    from src.local_api.dim_org_hier_build import import_org_hierarchy_from_excel

    result = import_org_hierarchy_from_excel(
        conn,
        file_bytes=file_bytes,
        upload_filename=upload_filename,
        dry_run=dry_run,
        run_id=run_id,
    )
    if result.get("ok") and not dry_run:
        try:
            from src.local_api.dwd_to_dim_build import record_dim_task_run

            record_dim_task_run(
                conn,
                run_id=str(result.get("run_id") or run_id or ""),
                task_code="dim.org_hier.build",
                task_name="组织层级双树 · Excel 导入",
                status="success",
                trigger_source="org_hier_import",
                rows_affected=int(result.get("success") or 0),
                result=result,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("record org_hier import run failed: %s", exc)
    elif not result.get("ok"):
        try:
            from src.local_api.dwd_to_dim_build import record_dim_task_run

            record_dim_task_run(
                conn,
                run_id=str(result.get("run_id") or run_id or ""),
                task_code="dim.org_hier.build",
                task_name="组织层级双树 · Excel 导入",
                status="failed",
                trigger_source="org_hier_import",
                error_message="；".join(result.get("errors") or [])[:500] or str((result.get("error") or {}).get("message") or ""),
                result=result,
            )
        except Exception:  # noqa: BLE001
            pass
    return result


def api_org_hier_rebuild(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    dry_run: bool = False,
    run_id: str | None = None,
) -> dict[str, Any]:
    from src.local_api.dim_org_hier_build import rebuild_org_hierarchy_paths

    result = rebuild_org_hierarchy_paths(
        conn,
        stat_years=stat_years,
        dry_run=dry_run,
        run_id=run_id,
    )
    if result.get("ok") and not dry_run:
        try:
            from src.local_api.dwd_to_dim_build import record_dim_task_run

            record_dim_task_run(
                conn,
                run_id=str(result.get("run_id") or run_id or ""),
                task_code="dim.org_hier.build",
                task_name="组织层级双树 · 路径重算",
                status="success",
                trigger_source="org_hier_rebuild",
                rows_affected=int(result.get("rows_affected") or 0),
                result=result,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("record org_hier rebuild run failed: %s", exc)
    return result
