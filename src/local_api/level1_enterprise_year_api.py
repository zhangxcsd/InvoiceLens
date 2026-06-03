"""
年度一级企业名单 dim_level1_enterprise_year 读写 API。

与 dim_group_enterprise_year.level1_group_id 税号口径对齐；按 stat_year 独立维护清单。
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

logger = logging.getLogger(__name__)

_YEAR_RE = re.compile(r"^\d{4}$")
_NORM_ID_RE = re.compile(r"[\s-]+")


def _norm_str(v: Any) -> str:
    return str(v or "").strip()


def _norm_enterprise_id(raw: str) -> str:
    """与集团成员 enterprise_id / level1_group_id 关联时使用的规范化税号。"""
    s = _NORM_ID_RE.sub("", _norm_str(raw))
    return s.upper()


def _safe_int_year(v: Any, default: int = 2024) -> int:
    s = _norm_str(v)
    if s.isdigit() and _YEAR_RE.match(s):
        y = int(s)
        if 1990 <= y <= 2100:
            return y
    return default


def _distinct_stat_years(conn: Any) -> list[str]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM dim_level1_enterprise_year WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM dim_group_enterprise_year WHERE stat_year IS NOT NULL",
    ):
        try:
            rows = conn.execute(sql).fetchall()
        except Exception:
            continue
        for (yv,) in rows or []:
            if yv is None:
                continue
            try:
                yi = int(yv)
            except (TypeError, ValueError):
                continue
            if 1990 <= yi <= 2100:
                years.add(yi)
    if not years:
        from datetime import datetime

        return [str(datetime.now().year)]
    return [str(y) for y in sorted(years, reverse=True)]


def _pick_year(requested: str | None, years: list[str]) -> str:
    if requested and requested.strip().isdigit():
        y = requested.strip()
        if y in years:
            return y
        return y
    return years[0] if years else "2024"


def _resolve_source_year(target_i: int, source_raw: Any) -> int | None:
    if source_raw is not None and str(source_raw).strip() != "":
        sy = _safe_int_year(source_raw)
        if 1990 <= sy <= 2100:
            return sy
        return None
    prev = target_i - 1
    return prev if 1990 <= prev <= 2100 else None


def _list_level1_rows_for_year(conn: Any, year_i: int, *, only_active: bool) -> list[dict[str, Any]]:
    sql = """
        SELECT level1_enterprise_id, level1_enterprise_name, display_order, is_active, remark
        FROM dim_level1_enterprise_year
        WHERE stat_year = ?
    """
    if only_active:
        sql += " AND COALESCE(is_active, TRUE)"
    sql += " ORDER BY display_order ASC, level1_enterprise_name ASC, level1_enterprise_id ASC"
    rows: list[dict[str, Any]] = []
    for r in conn.execute(sql, [year_i]).fetchall():
        eid = _norm_enterprise_id(str(r[0] or ""))
        if not eid:
            continue
        rows.append(
            {
                "level1_enterprise_id": eid,
                "level1_enterprise_name": str(r[1] or "").strip() or eid,
                "display_order": int(r[2] or 0),
                "is_active": bool(r[3]) if r[3] is not None else True,
                "remark": str(r[4] or "").strip(),
            }
        )
    return rows


def _target_level1_id_set(conn: Any, year_i: int) -> set[str]:
    try:
        rows = conn.execute(
            """
            SELECT level1_enterprise_id FROM dim_level1_enterprise_year WHERE stat_year = ?
            """,
            [year_i],
        ).fetchall()
    except Exception:
        return set()
    out: set[str] = set()
    for (eid,) in rows or []:
        n = _norm_enterprise_id(str(eid or ""))
        if n:
            out.add(n)
    return out


def _group_level1_name_map(conn: Any, year_i: int) -> dict[str, str]:
    """目标年度 dim_group_enterprise_year 中 distinct level1_group 规范化 id → 名称。"""
    try:
        rows = conn.execute(
            """
            SELECT
                upper(regexp_replace(trim(COALESCE(g.level1_group_id, '')), '[\\s-]+', '', 'g')) AS norm_id,
                any_value(trim(COALESCE(g.level1_group_name, ''))) AS level1_name
            FROM dim_group_enterprise_year g
            WHERE CAST(g.stat_year AS INTEGER) = ?
              AND trim(COALESCE(g.level1_group_id, '')) <> ''
            GROUP BY norm_id
            HAVING length(norm_id) > 0
            """,
            [year_i],
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取集团 level1 名称映射失败: %s", exc)
        return {}
    out: dict[str, str] = {}
    for norm_id, name in rows or []:
        nid = str(norm_id or "").strip()
        if not nid:
            continue
        nm = str(name or "").strip()
        out[nid] = nm or nid
    return out


def api_level1_enterprise_year_preview_from_previous(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    """
    预览从来源年度复制/推导到目标年度的行（不写库）。
    mode=copy：原样复制来源年度名单；
    mode=derive：在 copy 基础上用目标年度集团成员表刷新名称，并追加成员表中新出现的一级企业。
    """
    target_i = _safe_int_year(body.get("target_stat_year") or body.get("targetStatYear"))
    source_i = _resolve_source_year(target_i, body.get("source_stat_year") or body.get("sourceStatYear"))
    mode = _norm_str(body.get("mode") or "copy").lower()
    if mode not in ("copy", "derive"):
        mode = "copy"
    only_active = bool(body.get("only_active", body.get("onlyActive", True)))

    if source_i is None:
        return {
            "ok": False,
            "error": {
                "message": "未指定有效来源年度，且目标年度的上一年不在有效范围内",
                "exception_type": "ValidationError",
            },
        }

    source_rows = _list_level1_rows_for_year(conn, source_i, only_active=only_active)
    group_names = _group_level1_name_map(conn, target_i) if mode == "derive" else {}
    existing_target = _target_level1_id_set(conn, target_i)

    preview: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in source_rows:
        eid = row["level1_enterprise_id"]
        seen.add(eid)
        name = row["level1_enterprise_name"]
        remark = row.get("remark") or ""
        derive_hint = ""
        if mode == "derive" and eid in group_names:
            gname = group_names[eid]
            if gname and gname != name:
                name = gname
                derive_hint = "名称已按目标年度集团成员表刷新"
        preview.append(
            {
                "level1_enterprise_id": eid,
                "level1_enterprise_name": name,
                "display_order": row.get("display_order", 0),
                "is_active": row.get("is_active", True),
                "remark": remark,
                "derive_hint": derive_hint,
                "already_in_target": eid in existing_target,
                "from_group_extra": False,
            }
        )

    if mode == "derive":
        order_base = max((int(r.get("display_order") or 0) for r in preview), default=0)
        extra_n = 0
        for eid, gname in sorted(group_names.items(), key=lambda x: (x[1], x[0])):
            if eid in seen:
                continue
            order_base += 1
            extra_n += 1
            preview.append(
                {
                    "level1_enterprise_id": eid,
                    "level1_enterprise_name": gname,
                    "display_order": order_base,
                    "is_active": True,
                    "remark": "由目标年度集团成员表推导新增",
                    "derive_hint": "集团成员表中出现、上年度计划未包含",
                    "already_in_target": eid in existing_target,
                    "from_group_extra": True,
                }
            )

    return {
        "ok": True,
        "mode": mode,
        "target_stat_year": str(target_i),
        "source_stat_year": str(source_i),
        "source_row_count": len(source_rows),
        "preview_row_count": len(preview),
        "rows": preview,
        "empty_source": len(source_rows) == 0,
    }


def api_level1_enterprise_year_copy_from_previous(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    """将来源年度名单复制到目标年度（合并 upsert 或覆盖目标年度后写入）。"""
    target_i = _safe_int_year(body.get("target_stat_year") or body.get("targetStatYear"))
    replace_year = bool(body.get("replace_year") or body.get("replaceYear"))
    only_active = bool(body.get("only_active", body.get("onlyActive", True)))

    preview = api_level1_enterprise_year_preview_from_previous(
        conn,
        {
            "target_stat_year": target_i,
            "source_stat_year": body.get("source_stat_year") or body.get("sourceStatYear"),
            "mode": "copy",
            "only_active": only_active,
        },
    )
    if not preview.get("ok"):
        return preview

    source_i = int(preview.get("source_stat_year") or target_i - 1)
    rows = preview.get("rows") or []
    if not rows:
        return {
            "ok": True,
            "skipped": True,
            "message": f"来源年度 {source_i} 无{'有效' if only_active else ''}一级企业可复制",
            "target_stat_year": str(target_i),
            "source_stat_year": str(source_i),
        }

    try:
        if replace_year:
            conn.execute("DELETE FROM dim_level1_enterprise_year WHERE stat_year = ?", [target_i])
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    batch_rows = [
        {
            "level1_enterprise_id": r["level1_enterprise_id"],
            "level1_enterprise_name": r["level1_enterprise_name"],
            "display_order": r.get("display_order", 0),
            "is_active": r.get("is_active", True),
            "remark": r.get("remark") or f"复制自 {source_i} 年度",
        }
        for r in rows
        if isinstance(r, dict)
    ]

    out = api_level1_enterprise_year_import_batch(
        conn,
        {
            "stat_year": target_i,
            "rows": batch_rows,
            "replace_year": False,
            "data_source": f"copy_from_{source_i}",
        },
    )
    if out.get("ok"):
        out["source_stat_year"] = str(source_i)
        out["target_stat_year"] = str(target_i)
        out["replace_year"] = replace_year
        out["copied_from_previous"] = True
    return out


def _level1_group_member_stats(conn: Any, year_i: int) -> dict[str, dict[str, Any]]:
    """按规范化 level1_group_id 汇总集团年度成员数及国家出资企业锚点（与报送覆盖视图同口径）。"""
    out: dict[str, dict[str, Any]] = {}
    try:
        rows = conn.execute(
            """
            SELECT
                upper(regexp_replace(trim(COALESCE(g.level1_group_id, '')), '[\\s-]+', '', 'g')) AS norm_l1,
                COUNT(*)::BIGINT AS member_count,
                SUM(CASE WHEN COALESCE(g.is_member, TRUE) THEN 1 ELSE 0 END)::BIGINT AS active_member_count,
                any_value(
                    CASE
                        WHEN trim(COALESCE(g.equity_root_enterprise_id, '')) <> ''
                            THEN trim(COALESCE(g.equity_root_enterprise_name, ''))
                        WHEN trim(COALESCE(g.mgmt_root_enterprise_id, '')) <> ''
                            THEN trim(COALESCE(g.mgmt_root_enterprise_name, ''))
                        ELSE trim(COALESCE(g.level1_group_name, ''))
                    END
                ) AS soe_anchor_name
            FROM dim_group_enterprise_year g
            WHERE CAST(g.stat_year AS INTEGER) = ?
              AND trim(COALESCE(g.level1_group_id, '')) <> ''
            GROUP BY norm_l1
            HAVING length(norm_l1) > 0
            """,
            [year_i],
        ).fetchall()
        for norm_l1, member_count, active_member_count, soe_anchor_name in rows or []:
            nid = str(norm_l1 or "").strip()
            if not nid:
                continue
            out[nid] = {
                "group_member_count": int(member_count or 0),
                "group_active_member_count": int(active_member_count or 0),
                "soe_anchor_name": str(soe_anchor_name or "").strip(),
            }
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取一级企业下属成员统计失败: %s", exc)
    return out


def _level1_state_investor_map(conn: Any, year_i: int) -> dict[str, str]:
    """被审企业台账中一级企业识别号 → 国家出资企业名称。"""
    out: dict[str, str] = {}
    try:
        rows = conn.execute(
            """
            SELECT
                upper(regexp_replace(trim(COALESCE(r.unified_social_credit_code, '')), '[\\s-]+', '', 'g')) AS norm_id,
                any_value(trim(COALESCE(r.state_investor, ''))) AS state_investor
            FROM dim_audited_enterprise_registry r
            WHERE CAST(r.snapshot_year AS INTEGER) = ?
              AND trim(COALESCE(r.unified_social_credit_code, '')) <> ''
            GROUP BY norm_id
            HAVING length(norm_id) > 0
            """,
            [year_i],
        ).fetchall()
        for norm_id, state_investor in rows or []:
            nid = str(norm_id or "").strip()
            si = str(state_investor or "").strip()
            if nid and si:
                out[nid] = si
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取一级企业国家出资企业映射失败: %s", exc)
    return out


def api_level1_enterprise_year_meta(conn: Any) -> dict[str, Any]:
    years = _distinct_stat_years(conn)
    counts: dict[str, int] = {}
    try:
        rows = conn.execute(
            """
            SELECT CAST(stat_year AS INTEGER) AS y, COUNT(*)::BIGINT AS n
            FROM dim_level1_enterprise_year
            GROUP BY stat_year
            ORDER BY y DESC
            """
        ).fetchall()
        for yv, nv in rows or []:
            if yv is not None:
                counts[str(int(yv))] = int(nv or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取一级企业年度行数失败: %s", exc)
    return {"ok": True, "stat_years": years, "row_counts_by_year": counts}


def api_level1_enterprise_year_list(
    conn: Any,
    *,
    stat_year: str | None,
    keyword: str = "",
    active_only: bool = False,
) -> dict[str, Any]:
    years = _distinct_stat_years(conn)
    year_s = _pick_year(stat_year, years)
    year_i = _safe_int_year(year_s)
    kw = keyword.strip().lower()

    sql = """
        SELECT
            stat_year,
            level1_enterprise_id,
            level1_enterprise_name,
            display_order,
            is_active,
            remark,
            data_source,
            updated_at
        FROM dim_level1_enterprise_year
        WHERE stat_year = ?
    """
    params: list[Any] = [year_i]
    if active_only:
        sql += " AND COALESCE(is_active, TRUE)"
    if kw:
        sql += (
            " AND (lower(level1_enterprise_name) LIKE ?"
            " OR lower(level1_enterprise_id) LIKE ?)"
        )
        like = f"%{kw}%"
        params.extend([like, like])
    sql += " ORDER BY display_order ASC, level1_enterprise_name ASC, level1_enterprise_id ASC"

    rows_out: list[dict[str, Any]] = []
    member_stats = _level1_group_member_stats(conn, year_i)
    state_investor_map = _level1_state_investor_map(conn, year_i)
    try:
        for r in conn.execute(sql, params).fetchall():
            eid_raw = str(r[1] or "")
            eid_norm = _norm_enterprise_id(eid_raw)
            stats = member_stats.get(eid_norm, {})
            state_investor = state_investor_map.get(eid_norm, "")
            soe_anchor = str(stats.get("soe_anchor_name") or "").strip()
            rows_out.append(
                {
                    "stat_year": str(int(r[0])),
                    "level1_enterprise_id": eid_raw,
                    "level1_enterprise_name": str(r[2] or ""),
                    "display_order": int(r[3] or 0),
                    "is_active": bool(r[4]) if r[4] is not None else True,
                    "remark": str(r[5] or ""),
                    "data_source": str(r[6] or ""),
                    "updated_at": str(r[7] or ""),
                    "group_member_count": int(stats.get("group_member_count") or 0),
                    "group_active_member_count": int(stats.get("group_active_member_count") or 0),
                    "state_investor": state_investor,
                    "soe_anchor_name": soe_anchor,
                }
            )
    except Exception as exc:
        logger.exception("level1 list failed")
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }

    return {
        "ok": True,
        "stat_years": years,
        "selected_stat_year": year_s,
        "rows": rows_out,
        "total": len(rows_out),
    }


def api_level1_enterprise_year_upsert(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    year_i = _safe_int_year(body.get("stat_year") or body.get("statYear"))
    name = _norm_str(body.get("level1_enterprise_name") or body.get("level1EnterpriseName"))
    raw_id = _norm_str(body.get("level1_enterprise_id") or body.get("level1EnterpriseId"))
    eid = _norm_enterprise_id(raw_id)
    if not eid:
        return {
            "ok": False,
            "error": {"message": "一级企业识别号（税号/统一码）不能为空", "exception_type": "ValidationError"},
        }
    if not name:
        return {
            "ok": False,
            "error": {"message": "一级企业名称不能为空", "exception_type": "ValidationError"},
        }

    display_order = body.get("display_order") if body.get("display_order") is not None else body.get("displayOrder")
    try:
        order_i = int(display_order) if display_order is not None and str(display_order).strip() != "" else 0
    except (TypeError, ValueError):
        order_i = 0

    is_active_raw = body.get("is_active") if "is_active" in body else body.get("isActive")
    is_active = True if is_active_raw is None else bool(is_active_raw)
    remark = _norm_str(body.get("remark"))
    data_source = _norm_str(body.get("data_source") or body.get("dataSource")) or "manual_ui"
    source_record_id = _norm_str(body.get("source_record_id")) or str(uuid.uuid4())

    try:
        conn.execute(
            """
            INSERT INTO dim_level1_enterprise_year (
                stat_year, level1_enterprise_id, level1_enterprise_name,
                display_order, is_active, remark, data_source, source_record_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
            ON CONFLICT (stat_year, level1_enterprise_id) DO UPDATE SET
                level1_enterprise_name = excluded.level1_enterprise_name,
                display_order = excluded.display_order,
                is_active = excluded.is_active,
                remark = excluded.remark,
                data_source = excluded.data_source,
                source_record_id = excluded.source_record_id,
                updated_at = now()
            """,
            [year_i, eid, name, order_i, is_active, remark or None, data_source, source_record_id],
        )
    except Exception as exc:
        logger.exception("level1 upsert failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    return {
        "ok": True,
        "stat_year": str(year_i),
        "level1_enterprise_id": eid,
        "level1_enterprise_name": name,
    }


def api_level1_enterprise_year_delete(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    year_i = _safe_int_year(body.get("stat_year") or body.get("statYear"))
    eid = _norm_enterprise_id(body.get("level1_enterprise_id") or body.get("level1EnterpriseId"))
    if not eid:
        return {"ok": False, "error": {"message": "缺少 level1_enterprise_id", "exception_type": "ValidationError"}}
    try:
        conn.execute(
            "DELETE FROM dim_level1_enterprise_year WHERE stat_year = ? AND level1_enterprise_id = ?",
            [year_i, eid],
        )
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
    return {"ok": True, "deleted": 1, "stat_year": str(year_i), "level1_enterprise_id": eid}


def api_level1_enterprise_year_import_batch(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    year_i = _safe_int_year(body.get("stat_year") or body.get("statYear"))
    raw_rows = body.get("rows")
    if not isinstance(raw_rows, list) or not raw_rows:
        return {"ok": False, "error": {"message": "rows 必须为非空数组", "exception_type": "ValidationError"}}

    replace_year = bool(body.get("replace_year") or body.get("replaceYear"))
    data_source = _norm_str(body.get("data_source")) or "batch_import"
    inserted = 0
    updated = 0
    rejected: list[dict[str, str]] = []

    try:
        if replace_year:
            conn.execute("DELETE FROM dim_level1_enterprise_year WHERE stat_year = ?", [year_i])

        for i, row in enumerate(raw_rows):
            if not isinstance(row, dict):
                rejected.append({"index": str(i), "reason": "行不是对象"})
                continue
            sub = dict(row)
            sub["stat_year"] = year_i
            sub["data_source"] = data_source
            eid = _norm_enterprise_id(sub.get("level1_enterprise_id") or sub.get("level1EnterpriseId"))
            if not eid:
                rejected.append({"index": str(i), "reason": "识别号为空"})
                continue
            existed = conn.execute(
                "SELECT 1 FROM dim_level1_enterprise_year WHERE stat_year = ? AND level1_enterprise_id = ? LIMIT 1",
                [year_i, eid],
            ).fetchone()
            sub["level1_enterprise_id"] = eid
            out = api_level1_enterprise_year_upsert(conn, sub)
            if not out.get("ok"):
                rejected.append({"index": str(i), "reason": str((out.get("error") or {}).get("message") or "失败")})
                continue
            if existed:
                updated += 1
            else:
                inserted += 1
    except Exception as exc:
        logger.exception("level1 batch import failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    return {
        "ok": True,
        "stat_year": str(year_i),
        "replace_year": replace_year,
        "inserted": inserted,
        "updated": updated,
        "rejected_count": len(rejected),
        "rejected_samples": rejected[:20],
    }


def api_level1_enterprise_year_candidates(conn: Any, *, stat_year: str | None) -> dict[str, Any]:
    """从 dim_group_enterprise_year 推断尚未纳入名单的一级企业（distinct level1_group）。"""
    year_i = _safe_int_year(stat_year)
    try:
        rows = conn.execute(
            """
            WITH grp AS (
                SELECT DISTINCT
                    CAST(g.stat_year AS INTEGER) AS stat_year,
                    upper(regexp_replace(trim(COALESCE(g.level1_group_id, '')), '[\\s-]+', '', 'g')) AS norm_id,
                    trim(COALESCE(g.level1_group_name, '')) AS level1_name
                FROM dim_group_enterprise_year g
                WHERE CAST(g.stat_year AS INTEGER) = ?
                  AND trim(COALESCE(g.level1_group_id, '')) <> ''
            )
            SELECT g.norm_id, any_value(g.level1_name) AS level1_name
            FROM grp g
            LEFT JOIN dim_level1_enterprise_year l
                ON l.stat_year = g.stat_year
               AND upper(regexp_replace(trim(COALESCE(l.level1_enterprise_id, '')), '[\\s-]+', '', 'g')) = g.norm_id
            WHERE l.level1_enterprise_id IS NULL
              AND length(g.norm_id) > 0
            GROUP BY g.norm_id
            ORDER BY level1_name NULLS LAST, g.norm_id
            """,
            [year_i],
        ).fetchall()
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    candidates = [
        {"level1_enterprise_id": str(r[0] or ""), "level1_enterprise_name": str(r[1] or r[0] or "")}
        for r in rows or []
        if r and r[0]
    ]
    return {"ok": True, "stat_year": str(year_i), "candidates": candidates, "total": len(candidates)}


def api_level1_enterprise_year_members(
    conn: Any,
    *,
    stat_year: str | None,
    level1_enterprise_id: str,
    keyword: str = "",
) -> dict[str, Any]:
    """
    按年度 + 一级企业识别号，汇总 dim_group_enterprise_year 中归属该一级企业的下属成员单位明细。
    同一 stat_year 内，成员 level1_group_id 与名单 level1_enterprise_id 规范化后对齐。
    """
    year_i = _safe_int_year(stat_year)
    l1_norm = _norm_enterprise_id(level1_enterprise_id)
    if not l1_norm:
        return {
            "ok": False,
            "error": {"message": "缺少有效的一级企业识别号", "exception_type": "ValidationError"},
        }

    level1_name = l1_norm
    in_level1_list = False
    try:
        l1_row = conn.execute(
            """
            SELECT level1_enterprise_name
            FROM dim_level1_enterprise_year
            WHERE stat_year = ?
              AND upper(regexp_replace(trim(COALESCE(level1_enterprise_id, '')), '[\\s-]+', '', 'g')) = ?
            LIMIT 1
            """,
            [year_i, l1_norm],
        ).fetchone()
        if l1_row and l1_row[0]:
            level1_name = str(l1_row[0]).strip() or l1_norm
            in_level1_list = True
        elif not l1_row:
            grp_name = conn.execute(
                """
                SELECT any_value(trim(COALESCE(level1_group_name, '')))
                FROM dim_group_enterprise_year
                WHERE CAST(stat_year AS INTEGER) = ?
                  AND upper(regexp_replace(trim(COALESCE(level1_group_id, '')), '[\\s-]+', '', 'g')) = ?
                """,
                [year_i, l1_norm],
            ).fetchone()
            if grp_name and grp_name[0]:
                level1_name = str(grp_name[0]).strip() or l1_norm
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取一级企业名称失败: %s", exc)

    kw = keyword.strip().lower()
    sql = """
        SELECT
            g.enterprise_id,
            g.enterprise_name,
            COALESCE(g.is_member, TRUE) AS is_member,
            g.mgmt_level,
            g.mgmt_parent_enterprise_id,
            g.mgmt_parent_enterprise_name,
            g.equity_level,
            g.equity_parent_enterprise_id,
            g.equity_parent_enterprise_name,
            CASE
                WHEN trim(COALESCE(g.equity_root_enterprise_id, '')) <> ''
                    THEN trim(COALESCE(g.equity_root_enterprise_name, ''))
                WHEN trim(COALESCE(g.mgmt_root_enterprise_id, '')) <> ''
                    THEN trim(COALESCE(g.mgmt_root_enterprise_name, ''))
                ELSE trim(COALESCE(g.level1_group_name, ''))
            END AS soe_anchor_name,
            trim(COALESCE(r.state_investor, '')) AS registry_state_investor
        FROM dim_group_enterprise_year g
        LEFT JOIN dim_audited_enterprise_registry r
            ON CAST(r.snapshot_year AS INTEGER) = CAST(g.stat_year AS INTEGER)
           AND upper(regexp_replace(trim(COALESCE(r.unified_social_credit_code, '')), '[\\s-]+', '', 'g'))
               = upper(regexp_replace(trim(COALESCE(g.enterprise_id, '')), '[\\s-]+', '', 'g'))
        WHERE CAST(g.stat_year AS INTEGER) = ?
          AND upper(regexp_replace(trim(COALESCE(g.level1_group_id, '')), '[\\s-]+', '', 'g')) = ?
    """
    params: list[Any] = [year_i, l1_norm]
    if kw:
        sql += " AND (lower(COALESCE(g.enterprise_name, '')) LIKE ? OR lower(COALESCE(g.enterprise_id, '')) LIKE ?)"
        like = f"%{kw}%"
        params.extend([like, like])
    sql += " ORDER BY g.mgmt_level ASC NULLS LAST, g.enterprise_name ASC NULLS LAST, g.enterprise_id ASC"

    members: list[dict[str, Any]] = []
    try:
        for r in conn.execute(sql, params).fetchall():
            registry_si = str(r[10] or "").strip()
            soe_anchor = str(r[9] or "").strip()
            members.append(
                {
                    "enterprise_id": str(r[0] or ""),
                    "enterprise_name": str(r[1] or ""),
                    "is_member": bool(r[2]),
                    "mgmt_level": int(r[3]) if r[3] is not None else None,
                    "mgmt_parent_enterprise_id": str(r[4] or ""),
                    "mgmt_parent_enterprise_name": str(r[5] or ""),
                    "equity_level": int(r[6]) if r[6] is not None else None,
                    "equity_parent_enterprise_name": str(r[8] or ""),
                    "state_investor": registry_si or soe_anchor,
                    "soe_anchor_name": soe_anchor,
                }
            )
    except Exception as exc:
        logger.exception("level1 members list failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    active_n = sum(1 for m in members if m.get("is_member"))
    return {
        "ok": True,
        "stat_year": str(year_i),
        "level1_enterprise_id": l1_norm,
        "level1_enterprise_name": level1_name,
        "in_level1_list": in_level1_list,
        "members": members,
        "total": len(members),
        "active_member_count": active_n,
    }
