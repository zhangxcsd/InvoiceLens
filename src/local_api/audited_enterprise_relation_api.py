from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def _norm_pid(value: str) -> str:
    return re.sub(r"[\s-]+", "", str(value or "").strip()).upper()


def _norm_name(value: str) -> str:
    s = str(value or "").strip()
    s = re.sub(r"[（(][^）)]*[）)]", "", s)
    return s.strip().lower()


def _parse_first_shareholder(shareholders: str) -> tuple[str, str]:
    first = (shareholders or "").split(";")[0].split("；")[0].strip()
    if not first:
        return "", ""
    m = re.match(r"^(.+?)[（(]([^）)]+)[）)]$", first)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return first, ""


def _find_registry_row(
    by_name: dict[str, dict[str, Any]],
    snapshot_year: str,
    name: str,
) -> dict[str, Any] | None:
    target = _norm_name(name)
    if not target:
        return None
    return by_name.get(f"{snapshot_year}|{target}")


def _build_path_chain(
    by_name: dict[str, dict[str, Any]],
    snapshot_year: str,
    start_name: str,
    get_parent,
    format_node,
) -> str:
    chain: list[str] = []
    current = start_name.strip()
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        row = _find_registry_row(by_name, snapshot_year, current)
        chain.insert(0, format_node(row) if row else current)
        if not row:
            break
        parent = get_parent(row).strip()
        if not parent or parent in {"—", "-"}:
            break
        current = parent
    return " → ".join(chain)


def _relation_type(mgmt_parent: str, equity_parent: str) -> str:
    mp = _norm_name(mgmt_parent)
    ep = _norm_name(equity_parent)
    if mp == ep or (not mp and not ep):
        return "一致"
    return "不一致"


def _role_label(has_buyer: bool, has_seller: bool) -> str:
    if has_buyer and has_seller:
        return "购+销"
    if has_buyer:
        return "购方"
    if has_seller:
        return "销方"
    return "—"


def _load_rel_map(conn: Any, stat_year: int) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    try:
        rows = conn.execute(
            """
            SELECT
                r.subject_id,
                upper(regexp_replace(trim(COALESCE(sm.subject_no, '')), '[\\s-]+', '', 'g')) AS norm_no,
                COALESCE(r.has_buyer_role, FALSE),
                COALESCE(r.has_seller_role, FALSE),
                COALESCE(r.invoice_count, 0),
                COALESCE(sm.subject_no, ''),
                COALESCE(sm.subject_name, '')
            FROM dim_enterprise_year_rel r
            LEFT JOIN dim_subject_master sm ON sm.subject_id = r.subject_id
            WHERE r.stat_year = ?
              AND length(trim(COALESCE(sm.subject_no, ''))) > 0
            """,
            [stat_year],
        ).fetchall()
        for r in rows:
            norm = str(r[1] or "")
            if not norm:
                continue
            out[norm] = {
                "subject_id": str(r[0] or ""),
                "entity_id": norm,
                "has_buyer_role": bool(r[2]),
                "has_seller_role": bool(r[3]),
                "invoice_count": int(r[4] or 0),
                "subject_no": str(r[5] or ""),
                "subject_name": str(r[6] or ""),
            }
    except Exception as exc:
        logger.warning("relation-api: load rel map failed: %s", exc)
    return out


def _load_roster_norm_ids(conn: Any, stat_year: int) -> set[str]:
    try:
        rows = conn.execute(
            """
            SELECT upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g'))
            FROM dim_enterprise_year_roster
            WHERE stat_year = ?
              AND COALESCE(is_member, TRUE)
            """,
            [stat_year],
        ).fetchall()
        return {str(r[0]) for r in rows if r and r[0]}
    except Exception as exc:
        logger.warning("relation-api: load roster failed: %s", exc)
        return set()


def _enrich_row(
    reg: dict[str, Any],
    *,
    stat_year: int,
    rel_map: dict[str, dict[str, Any]],
    roster_ids: set[str],
    invoice_pids: set[str],
    subjects_by_pid: dict[str, dict[str, str]],
    subjects_by_name: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    from src.local_api.audited_enterprise_invoice_link import _match_row

    code = str(reg.get("code") or "")
    code_norm = _norm_pid(code)
    rel = rel_map.get(code_norm, {})
    in_roster = code_norm in roster_ids if code_norm else False

    match = _match_row(
        name=str(reg.get("name") or ""),
        code=code,
        state_investor=str(reg.get("stateInvestor") or ""),
        invoice_pids=invoice_pids,
        subjects_by_pid=subjects_by_pid,
        subjects_by_name=subjects_by_name,
    )

    return {
        "entity_id": code_norm or rel.get("entity_id") or "",
        "subject_id": rel.get("subject_id") or "",
        "has_buyer_role": rel.get("has_buyer_role", False),
        "has_seller_role": rel.get("has_seller_role", False),
        "invoice_count": rel.get("invoice_count", 0),
        "role_label": _role_label(rel.get("has_buyer_role", False), rel.get("has_seller_role", False)),
        "match_status": match.get("matchStatus") or "待匹配",
        "match_key": match.get("matchKey") or "未命中",
        "subject_no": rel.get("subject_no") or match.get("linkedTaxpayerId") or "",
        "subject_name": rel.get("subject_name") or "",
        "in_roster": in_roster,
        "in_analysis_pool": bool(
            in_roster and rel.get("subject_id") and int(rel.get("invoice_count") or 0) > 0
        ),
    }


def _index_registry_rows(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for row in rows:
        sy = str(row.get("snapshotYear") or "")
        nm = _norm_name(str(row.get("name") or ""))
        if sy and nm:
            by_name[f"{sy}|{nm}"] = row
    return by_name


def _mgmt_parent_name(row: dict[str, Any]) -> str:
    return str(row.get("mgmtParent") or "").strip()


def _equity_parent_name(row: dict[str, Any]) -> str:
    sh_name, _ = _parse_first_shareholder(str(row.get("shareholders") or ""))
    if int(row.get("equityLevel") or 0) <= 1:
        return ""
    return sh_name


def _node_display_name(row: dict[str, Any], mode: str) -> str:
    if mode == "equity":
        sh_name, sh_ratio = _parse_first_shareholder(str(row.get("shareholders") or ""))
        base = str(row.get("name") or "")
        return f"{base}（{sh_ratio}）" if sh_ratio else base
    return str(row.get("name") or "")


def _node_level(row: dict[str, Any], mode: str) -> int:
    if mode == "management":
        lv = int(row.get("mgmtLevel") or 0)
        return lv if lv > 0 else 1
    lv = int(row.get("equityLevel") or 0)
    return lv if lv > 0 else 1


def _build_tree_nodes(
    rows: list[dict[str, Any]],
    *,
    mode: str,
    by_name: dict[str, dict[str, Any]],
    enrichment_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    get_parent = _mgmt_parent_name if mode == "management" else _equity_parent_name
    node_map: dict[str, dict[str, Any]] = {}
    children_of: dict[str | None, list[str]] = {}

    for row in rows:
        row_id = str(row.get("rowId") or "")
        if not row_id:
            row_id = f"{row.get('code')}-{row.get('snapshotYear')}"
        sy = str(row.get("snapshotYear") or "")
        parent_row = _find_registry_row(by_name, sy, get_parent(row))
        parent_id = str(parent_row.get("rowId") or "") if parent_row else None
        parent_name = get_parent(row) or "—"
        if not parent_name:
            parent_name = "—"

        node = {
            "id": row_id,
            "name": _node_display_name(row, mode),
            "level": _node_level(row, mode),
            "parent_id": parent_id,
            "parent_name": parent_name if parent_id else "—",
            "children": [],
            "registry": row,
            "enrichment": enrichment_by_id.get(row_id, {}),
        }
        node_map[row_id] = node
        children_of.setdefault(parent_id, []).append(row_id)

    roots: list[str] = []
    for nid, node in node_map.items():
        pid = node.get("parent_id")
        if pid and pid in node_map:
            continue
        roots.append(nid)

    def attach(nid: str) -> dict[str, Any]:
        node = node_map[nid]
        child_ids = children_of.get(nid, [])
        node["children"] = [attach(cid) for cid in child_ids]
        return node

    return [attach(rid) for rid in roots]


def _parse_page(page: Any, default: int = 1) -> int:
    try:
        p = int(page)
        return max(1, p)
    except (TypeError, ValueError):
        return default


def _parse_page_size(page_size: Any, default: int = 50) -> int:
    try:
        ps = int(page_size)
        return max(1, min(ps, 500))
    except (TypeError, ValueError):
        return default


def _parse_sort(sort: str | None) -> tuple[str, str]:
    s = (sort or "name").strip().lower()
    desc_keys = {"snapshot_year_desc", "invoice_count_desc", "relation_type_desc"}
    if s.endswith("_desc"):
        key = s[:-5]
        return key, "desc"
    if s.endswith("_asc"):
        key = s[:-4]
        return key, "asc"
    if s in desc_keys:
        return s.replace("_desc", ""), "desc"
    return s, "asc"


def _load_registry_rows_for_relation(
    conn: Any,
    *,
    snapshot_year: str | None,
    state_investor: str | None,
    keyword: str | None,
) -> dict[str, Any]:
    from src.local_api.audited_enterprise_dims import fetch_all_registry_rows, _snapshot_years_registry

    si = state_investor or ""
    kw = keyword or ""
    if snapshot_year and snapshot_year.strip().isdigit():
        return fetch_all_registry_rows(
            conn,
            snapshot_year=snapshot_year,
            state_investor_kw=si,
            enterprise_kw=kw,
            include_years=True,
        )

    years = _snapshot_years_registry(conn)
    if not years:
        return fetch_all_registry_rows(
            conn,
            snapshot_year=snapshot_year,
            state_investor_kw=si,
            enterprise_kw=kw,
            include_years=True,
        )

    merged: list[dict[str, Any]] = []
    for y in years:
        part = fetch_all_registry_rows(
            conn,
            snapshot_year=y,
            state_investor_kw=si,
            enterprise_kw=kw,
            include_years=False,
        )
        if not part.get("ok"):
            return part
        merged.extend(part.get("rows") or [])

    selected = years[0]
    return {
        "ok": True,
        "snapshot_years": years,
        "selected_year": selected,
        "rows": merged,
        "total": len(merged),
    }


def api_audited_enterprise_relation_tree(
    conn: Any,
    *,
    snapshot_year: str | None,
    mode: str = "management",
    state_investor: str | None = None,
    keyword: str | None = None,
) -> dict[str, Any]:
    from src.local_api.audited_enterprise_dims import api_registry_list
    from src.local_api.audited_enterprise_invoice_link import (
        _load_invoice_pids,
        _load_subject_maps,
    )

    tree_mode = "equity" if (mode or "").strip().lower() == "equity" else "management"
    try:
        reg = _load_registry_rows_for_relation(
            conn,
            snapshot_year=snapshot_year,
            state_investor=state_investor,
            keyword=keyword,
        )
        if not reg.get("ok"):
            return reg

        rows: list[dict[str, Any]] = list(reg.get("rows") or [])
        years = reg.get("snapshot_years") or []
        selected = str(reg.get("selected_year") or snapshot_year or "")
        if not rows:
            return {
                "ok": True,
                "snapshot_years": years,
                "selected_year": selected,
                "nodes": [],
                "empty_hint": "暂无台账数据。请先在「管理与产权层级信息」页导入演示种子或手工新增。",
            }

        stat_year = int(selected) if selected.isdigit() else 2026
        rel_maps: dict[int, dict[str, dict[str, Any]]] = {}
        roster_maps: dict[int, set[str]] = {}
        stat_years_needed = {int(str(r.get("snapshotYear") or stat_year)) for r in rows}
        for sy in stat_years_needed:
            rel_maps[sy] = _load_rel_map(conn, sy)
            roster_maps[sy] = _load_roster_norm_ids(conn, sy)
        invoice_pids = _load_invoice_pids(conn)
        subjects_by_pid, subjects_by_name = _load_subject_maps(conn)

        enrichment_by_id: dict[str, dict[str, Any]] = {}
        for row in rows:
            rid = str(row.get("rowId") or "")
            if not rid:
                rid = f"{row.get('code')}-{row.get('snapshotYear')}"
            sy = int(str(row.get("snapshotYear") or stat_year))
            enrichment_by_id[rid] = _enrich_row(
                row,
                stat_year=sy,
                rel_map=rel_maps.get(sy, {}),
                roster_ids=roster_maps.get(sy, set()),
                invoice_pids=invoice_pids,
                subjects_by_pid=subjects_by_pid,
                subjects_by_name=subjects_by_name,
            )

        by_name = _index_registry_rows(rows)
        nodes = _build_tree_nodes(
            rows,
            mode=tree_mode,
            by_name=by_name,
            enrichment_by_id=enrichment_by_id,
        )
        return {
            "ok": True,
            "snapshot_years": years,
            "selected_year": selected,
            "nodes": nodes,
        }
    except Exception as exc:
        logger.exception("relation-tree failed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }


def api_audited_enterprise_relation_rows(
    conn: Any,
    *,
    snapshot_year: str | None,
    state_investor: str | None = None,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 50,
    sort: str | None = None,
) -> dict[str, Any]:
    from src.local_api.audited_enterprise_dims import api_registry_list
    from src.local_api.audited_enterprise_invoice_link import (
        _load_invoice_pids,
        _load_subject_maps,
    )

    pg = _parse_page(page)
    ps = _parse_page_size(page_size)
    sort_key, sort_dir = _parse_sort(sort)

    try:
        reg = _load_registry_rows_for_relation(
            conn,
            snapshot_year=snapshot_year,
            state_investor=state_investor,
            keyword=keyword,
        )
        if not reg.get("ok"):
            return reg

        all_rows: list[dict[str, Any]] = list(reg.get("rows") or [])
        years = reg.get("snapshot_years") or []
        selected = str(reg.get("selected_year") or snapshot_year or "")

        if not all_rows:
            return {
                "ok": True,
                "snapshot_years": years,
                "selected_year": selected,
                "total": 0,
                "rows": [],
                "kpis": {
                    "total": 0,
                    "relation_mismatch": 0,
                    "mapped": 0,
                    "unmapped": 0,
                    "in_analysis_pool": 0,
                },
                "empty_hint": "暂无台账数据。请先在「管理与产权层级信息」页导入演示种子或手工新增。",
            }

        stat_year = int(selected) if selected.isdigit() else 2026
        rel_maps: dict[int, dict[str, dict[str, Any]]] = {}
        roster_maps: dict[int, set[str]] = {}
        stat_years_needed = {int(str(r.get("snapshotYear") or stat_year)) for r in all_rows}
        for sy in stat_years_needed:
            rel_maps[sy] = _load_rel_map(conn, sy)
            roster_maps[sy] = _load_roster_norm_ids(conn, sy)
        invoice_pids = _load_invoice_pids(conn)
        subjects_by_pid, subjects_by_name = _load_subject_maps(conn)
        by_name = _index_registry_rows(all_rows)

        enriched: list[dict[str, Any]] = []
        kpi_mismatch = 0
        kpi_mapped = 0
        kpi_unmapped = 0
        kpi_pool = 0

        for row in all_rows:
            sy = str(row.get("snapshotYear") or "")
            sy_i = int(sy) if sy.isdigit() else stat_year
            name = str(row.get("name") or "")
            mgmt_parent = _mgmt_parent_name(row)
            equity_parent = _equity_parent_name(row)
            rel_type = _relation_type(mgmt_parent, equity_parent)
            mgmt_path = _build_path_chain(
                by_name,
                sy,
                name,
                _mgmt_parent_name,
                lambda r: str(r.get("name") or "") if r else "",
            )
            equity_path = _build_path_chain(
                by_name,
                sy,
                name,
                _equity_parent_name,
                lambda r: _node_display_name(r, "equity") if r else "",
            )
            enrich = _enrich_row(
                row,
                stat_year=sy_i,
                rel_map=rel_maps.get(sy_i, {}),
                roster_ids=roster_maps.get(sy_i, set()),
                invoice_pids=invoice_pids,
                subjects_by_pid=subjects_by_pid,
                subjects_by_name=subjects_by_name,
            )
            if rel_type == "不一致":
                kpi_mismatch += 1
            ms = enrich.get("match_status") or ""
            if ms == "已匹配":
                kpi_mapped += 1
            elif ms == "待匹配":
                kpi_unmapped += 1
            if enrich.get("in_analysis_pool"):
                kpi_pool += 1

            enriched.append(
                {
                    "name": name,
                    "code": str(row.get("code") or ""),
                    "snapshot_year": sy,
                    "state_investor_enterprise": str(row.get("stateInvestor") or "").strip() or "—",
                    "mgmt_path": mgmt_path,
                    "equity_path": equity_path,
                    "relation_type": rel_type,
                    **enrich,
                }
            )

        def sort_val(item: dict[str, Any]) -> Any:
            if sort_key in {"name"}:
                return item.get("name") or ""
            if sort_key in {"snapshot_year", "snapshopyear"}:
                return int(item.get("snapshot_year") or 0)
            if sort_key in {"mgmt_path", "mgmtpath"}:
                return item.get("mgmt_path") or ""
            if sort_key in {"equity_path", "equitypath"}:
                return item.get("equity_path") or ""
            if sort_key in {"relation_type", "relationtype"}:
                return 0 if item.get("relation_type") == "一致" else 1
            if sort_key in {"entity_id", "entityid"}:
                return item.get("entity_id") or ""
            if sort_key in {"invoice_count", "invoicecount"}:
                return int(item.get("invoice_count") or 0)
            if sort_key in {"match_status", "matchstatus"}:
                return item.get("match_status") or ""
            return item.get("name") or ""

        enriched.sort(key=sort_val, reverse=(sort_dir == "desc"))
        total = len(enriched)
        offset = (pg - 1) * ps
        page_rows = enriched[offset : offset + ps]

        return {
            "ok": True,
            "snapshot_years": years,
            "selected_year": selected,
            "total": total,
            "page": pg,
            "page_size": ps,
            "rows": page_rows,
            "kpis": {
                "total": total,
                "relation_mismatch": kpi_mismatch,
                "mapped": kpi_mapped,
                "unmapped": kpi_unmapped,
                "in_analysis_pool": kpi_pool,
            },
        }
    except Exception as exc:
        logger.exception("relation-rows failed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }
