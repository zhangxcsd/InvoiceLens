"""组织层级双树 dim_org_hier HTTP API。"""

from __future__ import annotations

import logging
import math
import uuid
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
                h.eq_level,
                COALESCE(h.state_investor_name, h.state_investor_id, '')
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
            "state_investor_enterprise": str(r[11] or "—") if str(r[11] or "").strip() else "—",
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


_ORG_HIER_IMPORT_DEPRECATED_MSG = (
    "组织维度 Excel 直写 dim_org_hier 已停用；请在「管理与产权层级信息」或「组织层级树」"
    "使用台账 Excel 导入，保存后将自动物化 dim_org_hier。"
)


def api_org_hier_import(
    conn: Any,
    *,
    file_bytes: bytes,
    upload_filename: str | None,
    dry_run: bool = False,
    run_id: str | None = None,
) -> dict[str, Any]:
    """@deprecated 请改用台账导入（api_registry_import_excel）。"""
    _ = (conn, file_bytes, upload_filename, dry_run, run_id)
    return {
        "ok": False,
        "deprecated": True,
        "redirect_nav": "dim_audited_registry",
        "error": {
            "message": _ORG_HIER_IMPORT_DEPRECATED_MSG,
            "exception_type": "DeprecatedAPI",
        },
    }


def api_org_hier_template_download(conn: Any) -> tuple[int, bytes | dict[str, Any], str, str]:
    """生成组织维度导入模板：(status, body_or_error, content_type, download_name)。"""
    try:
        from src.local_api.dim_org_hier_build import generate_org_hier_import_template

        data, fname = generate_org_hier_import_template(conn)
        return (
            200,
            data,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            fname,
        )
    except ImportError as exc:
        return 500, {"ok": False, "error": {"message": "缺少 openpyxl 依赖"}}, "", ""
    except Exception as exc:  # noqa: BLE001
        logger.exception("org_hier template download")
        return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""


def _registry_materialize_years(conn: Any, stat_years: list[int] | None) -> list[int]:
    from src.local_api.group_enterprise_year_build import _registry_years

    available = [int(y) for y in _registry_years(conn)]
    if stat_years:
        wanted = {int(y) for y in stat_years}
        return [y for y in available if y in wanted]
    return available


def api_org_hier_rebuild(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    dry_run: bool = False,
    run_id: str | None = None,
) -> dict[str, Any]:
    """从台账物化 dim_org_hier（台账为权威源；不再依赖独立 Excel 导入链路）。"""
    from src.local_api.dim_org_hier_build import materialize_org_hier_from_registry

    build_run_id = run_id or f"org_hier_rebuild_{uuid.uuid4().hex[:12]}"
    years = _registry_materialize_years(conn, stat_years)
    if not years:
        return {
            "ok": False,
            "dry_run": dry_run,
            "error": {
                "message": "dim_audited_enterprise_registry 无可用 snapshot_year，请先在「管理与产权层级信息」导入台账",
                "exception_type": "ValidationError",
            },
            "run_id": build_run_id,
        }

    if dry_run:
        placeholders = ",".join("?" * len(years))
        count = int(
            conn.execute(
                f"""
                SELECT COUNT(*)::BIGINT
                FROM dim_audited_enterprise_registry
                WHERE snapshot_year IN ({placeholders})
                """,
                years,
            ).fetchone()[0]
            or 0
        )
        return {
            "ok": True,
            "dry_run": True,
            "run_id": build_run_id,
            "rows_affected": count,
            "stat_years": years,
        }

    result = materialize_org_hier_from_registry(
        conn,
        stat_years=years,
        replace_years=True,
        run_id=build_run_id,
        updated_by="ORG_HIER_REBUILD",
    )
    if result.get("ok"):
        result["rows_affected"] = int(result.get("rows_written") or 0)
        try:
            from src.local_api.dwd_to_dim_build import record_dim_task_run

            record_dim_task_run(
                conn,
                run_id=str(result.get("run_id") or build_run_id),
                task_code="dim.org_hier.build",
                task_name="组织层级双树 · 台账物化",
                status="success",
                trigger_source="org_hier_rebuild",
                rows_affected=int(result.get("rows_affected") or 0),
                result=result,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("record org_hier rebuild run failed: %s", exc)
    return result


_DEMO_STAT_YEAR = 2024
_DEMO_SYS_ID = "PROV_SD"
_DEMO_ROOT_ID = "ROOT_DEMO_SD"
_DEMO_GROUP_ID = "91110000DEMO000001"
_DEMO_SUB_ID = "91110000DEMO000002"
_DEMO_ENTITY_IDS = (_DEMO_ROOT_ID, _DEMO_GROUP_ID, _DEMO_SUB_ID)


def _seed_demo_org_sys(conn: Any) -> None:
    conn.execute(
        """
        INSERT INTO dim_org_sys (sys_id, sys_name, admin_level, gov_owner, description, sort_no, is_active)
        VALUES (?, ?, ?, ?, ?, ?, TRUE)
        ON CONFLICT (sys_id) DO UPDATE SET is_active = TRUE
        """,
        [
            _DEMO_SYS_ID,
            "山东省属企业",
            "省",
            "山东省国有资产监督管理委员会",
            "演示种子用监管体系（组织层级演示数据）",
            1,
        ],
    )


def _demo_org_hier_xlsx_bytes() -> bytes:
    import io

    import pandas as pd

    header = [
        "entity_id",
        "entity_fullname",
        "entity_shortname",
        "entity_type",
        "sys_id",
        "stat_year",
        "main_business",
        "industry_id",
        "industry_name",
        "is_stat_inc",
        "state_investor_id",
        "state_investor_name",
        "mg_parent_id",
        "mg_parent_name",
        "mg_sort_no",
        "eq_parent_id",
        "eq_parent_name",
        "eq_sort_no",
        "eq_shareholding_ratio",
        "reg_capital",
        "is_active",
        "hier_diff_note",
    ]
    desc = ["统一社会信用代码"] * len(header)
    root = _DEMO_ROOT_ID
    group = _DEMO_GROUP_ID
    sub = _DEMO_SUB_ID
    rows = [
        [
            root,
            "示例监管根节点",
            "示例根节点",
            "其他",
            _DEMO_SYS_ID,
            str(_DEMO_STAT_YEAR),
            "",
            "",
            "",
            "否",
            "",
            "",
            root,
            "示例监管根节点",
            "0",
            root,
            "示例监管根节点",
            "0",
            "",
            "",
            "是",
            "",
        ],
        [
            group,
            "示例：集团总部",
            "示例：集团总部",
            "有限责任公司",
            _DEMO_SYS_ID,
            str(_DEMO_STAT_YEAR),
            "",
            "",
            "",
            "是",
            group,
            "示例：集团总部",
            root,
            "示例监管根节点",
            "1",
            root,
            "示例监管根节点",
            "1",
            "",
            "",
            "是",
            "",
        ],
        [
            sub,
            "示例子公司",
            "示例子公司",
            "有限责任公司",
            _DEMO_SYS_ID,
            str(_DEMO_STAT_YEAR),
            "",
            "",
            "",
            "是",
            group,
            "示例：集团总部",
            group,
            "示例：集团总部",
            "1",
            root,
            "示例监管根节点",
            "2",
            "0.51",
            "",
            "是",
            "示例：产权上挂集团总部，管理上挂示例子公司",
        ],
    ]
    bio = io.BytesIO()
    with pd.ExcelWriter(bio, engine="openpyxl") as writer:
        pd.DataFrame([header, desc, *rows]).to_excel(writer, index=False, header=False)
    return bio.getvalue()


def api_org_hier_bootstrap_demo(conn: Any) -> dict[str, Any]:
    """写入演示种子；已改为写入台账并自动物化 dim_org_hier。"""
    from src.local_api.audited_enterprise_dims import api_registry_bootstrap_demo

    result = api_registry_bootstrap_demo(conn)
    if not result.get("ok"):
        return result
    return {
        **result,
        "deprecated_api": True,
        "message": result.get("message")
        or "演示数据已写入台账（dim_audited_enterprise_registry），并已同步组织层级物化。",
    }
