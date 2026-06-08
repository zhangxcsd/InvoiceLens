"""审计疑点（dm_audit_flag）只读 API 与扫描触发。"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from src.audit.config_loader import group_id_for_year, load_audit_rules_config
from src.audit_rules.registry import all_rule_ids

logger = logging.getLogger(__name__)


def _calendar_year() -> int:
    return date.today().year


def _safe_int_year(v: str | None, default: int | None = None) -> int:
    d = _calendar_year() if default is None else default
    if not v or not str(v).strip().isdigit():
        return d
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return d
    return y


def _distinct_years(conn: Any) -> list[str]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT CAST(replace(group_id, 'Y', '') AS INTEGER) FROM dm_audit_flag WHERE group_id LIKE 'Y____'",
    ):
        try:
            for (yv,) in conn.execute(sql).fetchall() or []:
                if yv is not None:
                    yi = int(yv)
                    if 1990 <= yi <= 2100:
                        years.add(yi)
        except Exception:
            continue
    if not years:
        return [str(_calendar_year())]
    return [str(y) for y in sorted(years, reverse=True)]


def api_audit_meta(conn: Any) -> dict[str, Any]:
    try:
        years = _distinct_years(conn)
        cy = str(_calendar_year())
        default_y = cy if cy in years else years[0]
        flag_cnt = 0
        try:
            flag_cnt = int(conn.execute("SELECT COUNT(*)::BIGINT FROM dm_audit_flag").fetchone()[0] or 0)
        except Exception:
            pass
        cfg = load_audit_rules_config()
        rules_block = cfg.get("rules") if isinstance(cfg.get("rules"), dict) else {}
        rules = []
        for rid in all_rule_ids():
            rc = rules_block.get(rid) if isinstance(rules_block, dict) else {}
            rules.append(
                {
                    "rule_id": rid,
                    "name": (rc or {}).get("name") if isinstance(rc, dict) else rid,
                    "enabled": bool((rc or {}).get("enabled", True)) if isinstance(rc, dict) else True,
                }
            )
        return {
            "ok": True,
            "stat_years": years,
            "default_stat_year": default_y,
            "flag_ready": flag_cnt > 0,
            "total_flags": flag_cnt,
            "rules": rules,
            "hint": None
            if flag_cnt > 0
            else "尚无审计疑点。请先完成 ODS→DWD 构建，再点击「运行疑点扫描」。",
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _track_status_clause(track_status: str | None) -> tuple[str, list[Any]]:
    ts = (track_status or "").strip().lower()
    if ts == "pending":
        return "COALESCE(is_confirmed, FALSE) = FALSE", []
    if ts == "confirmed":
        return "COALESCE(is_confirmed, FALSE) = TRUE", []
    return "", []


def api_audit_flags_list(
    conn: Any,
    *,
    stat_year: str | None,
    risk_level: str | None = None,
    rule_id: str | None = None,
    keyword: str | None = None,
    track_status: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        group_id = group_id_for_year(y)
        clauses = ["group_id = ?"]
        params: list[Any] = [group_id]
        if risk_level and risk_level.strip() and risk_level.strip() != "all":
            clauses.append("risk_level = ?")
            params.append(risk_level.strip())
        if rule_id and rule_id.strip() and rule_id.strip() != "all":
            clauses.append("rule_id = ?")
            params.append(rule_id.strip())
        kw = (keyword or "").strip()
        if kw:
            clauses.append(
                "(coalesce(entity_name, '') ILIKE ? OR coalesce(seller_name, '') ILIKE ? "
                "OR coalesce(description, '') ILIKE ? OR coalesce(flag_type, '') ILIKE ?)"
            )
            like = f"%{kw}%"
            params.extend([like, like, like, like])
        track_clause, track_params = _track_status_clause(track_status)
        if track_clause:
            clauses.append(track_clause)
            params.extend(track_params)
        where = " AND ".join(clauses)
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM dm_audit_flag WHERE {where}", params).fetchone()[0] or 0
        )
        lim = max(1, min(int(limit or 100), 2000))
        off = max(0, int(offset or 0))
        rows = conn.execute(
            f"""
            SELECT
                flag_id, rule_id, risk_level, flag_type, group_id,
                entity_id, entity_name, seller_name, seller_tax_no,
                amount, description, suggestion, is_confirmed, confirm_note, analysis_batch, created_at
            FROM dm_audit_flag
            WHERE {where}
            ORDER BY
                CASE risk_level WHEN '高风险' THEN 1 WHEN '中风险' THEN 2 ELSE 3 END,
                coalesce(amount, 0) DESC,
                flag_id
            LIMIT ? OFFSET ?
            """,
            [*params, lim, off],
        ).fetchall()
        items = [
            {
                "flag_id": str(r[0] or ""),
                "rule_id": str(r[1] or ""),
                "risk_level": str(r[2] or ""),
                "flag_type": str(r[3] or ""),
                "group_id": str(r[4] or ""),
                "entity_id": str(r[5] or "") or None,
                "entity_name": str(r[6] or "") or None,
                "seller_name": str(r[7] or "") or None,
                "seller_tax_no": str(r[8] or "") or None,
                "amount": float(r[9]) if r[9] is not None else None,
                "description": str(r[10] or ""),
                "suggestion": str(r[11] or ""),
                "is_confirmed": bool(r[12]),
                "confirm_note": str(r[13] or "") or None,
                "analysis_batch": str(r[14] or ""),
                "created_at": str(r[15] or "") if r[15] is not None else None,
            }
            for r in rows or []
        ]
        summary_row = conn.execute(
            f"""
            SELECT
                count(*)::BIGINT,
                sum(CASE WHEN risk_level = '高风险' THEN 1 ELSE 0 END)::BIGINT,
                sum(CASE WHEN risk_level = '中风险' THEN 1 ELSE 0 END)::BIGINT,
                sum(CASE WHEN risk_level = '低风险' THEN 1 ELSE 0 END)::BIGINT,
                sum(CASE WHEN COALESCE(is_confirmed, FALSE) THEN 1 ELSE 0 END)::BIGINT,
                sum(CASE WHEN NOT COALESCE(is_confirmed, FALSE) THEN 1 ELSE 0 END)::BIGINT
            FROM dm_audit_flag WHERE {where}
            """,
            params,
        ).fetchone()
        return {
            "ok": True,
            "stat_year": str(y),
            "group_id": group_id,
            "total": total,
            "limit": lim,
            "offset": off,
            "summary": {
                "total": int(summary_row[0] or 0) if summary_row else 0,
                "high": int(summary_row[1] or 0) if summary_row else 0,
                "medium": int(summary_row[2] or 0) if summary_row else 0,
                "low": int(summary_row[3] or 0) if summary_row else 0,
                "confirmed": int(summary_row[4] or 0) if summary_row else 0,
                "pending": int(summary_row[5] or 0) if summary_row else 0,
            },
            "rows": items,
        }
    except Exception as exc:
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_audit_flag_confirm(
    conn: Any,
    *,
    flag_ids: list[str] | None,
    is_confirmed: bool = True,
    confirm_note: str | None = None,
) -> dict[str, Any]:
    """更新疑点跟踪状态（确认/结案或撤销确认）。"""
    try:
        ids = [str(x).strip() for x in (flag_ids or []) if str(x).strip()]
        if not ids:
            return {"ok": False, "error": {"message": "请指定至少一条疑点编号 flag_id", "exception_type": "ValidationError"}}
        note = (confirm_note or "").strip() or None
        if is_confirmed and not note:
            return {
                "ok": False,
                "error": {"message": "确认疑点时请填写跟踪说明（confirm_note）", "exception_type": "ValidationError"},
            }
        placeholders = ", ".join("?" for _ in ids)
        existing = conn.execute(
            f"SELECT flag_id FROM dm_audit_flag WHERE flag_id IN ({placeholders})",
            ids,
        ).fetchall()
        found = {str(r[0]) for r in existing or []}
        missing = [i for i in ids if i not in found]
        if missing:
            return {
                "ok": False,
                "error": {
                    "message": f"未找到疑点：{', '.join(missing[:5])}",
                    "exception_type": "NotFound",
                },
            }
        conn.executemany(
            """
            UPDATE dm_audit_flag
            SET is_confirmed = ?, confirm_note = ?
            WHERE flag_id = ?
            """,
            [(bool(is_confirmed), note if is_confirmed else None, fid) for fid in ids],
        )
        return {
            "ok": True,
            "updated": len(ids),
            "is_confirmed": bool(is_confirmed),
            "message": "已确认疑点" if is_confirmed else "已撤销确认",
        }
    except Exception as exc:
        logger.exception("api_audit_flag_confirm 失败")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_audit_run(
    conn: Any,
    *,
    stat_year: str | None,
    stat_years: list[str] | None = None,
    entity_id: str | None = None,
    rule_ids: list[str] | None = None,
    dry_run: bool = False,
    trigger_source: str = "manual_api",
) -> dict[str, Any]:
    try:
        from src.etl.dm_audit_build import refresh_audit_flags

        years: list[int] = []
        if stat_years:
            years = [int(y) for y in stat_years if str(y).strip().isdigit()]
        elif stat_year and str(stat_year).strip().isdigit():
            years = [int(str(stat_year).strip())]
        return refresh_audit_flags(
            conn,
            stat_years=years or None,
            entity_id=(entity_id or "").strip() or None,
            rule_ids=rule_ids,
            dry_run=dry_run,
            trigger_source=trigger_source,
        )
    except Exception as exc:
        logger.exception("api_audit_run 失败")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_audit_rules_config_get(conn: Any) -> dict[str, Any]:
    _ = conn
    try:
        from src.audit.config_loader import audit_rules_yaml_text, load_audit_rules_config

        yaml_text, source = audit_rules_yaml_text()
        cfg = load_audit_rules_config()
        return {"ok": True, "yaml_text": yaml_text, "source": source, "config": cfg}
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_audit_rules_config_save(conn: Any, *, yaml_text: str) -> dict[str, Any]:
    _ = conn
    try:
        import yaml

        from src.audit.config_loader import audit_rules_yaml_text, save_audit_rules_config

        data = yaml.safe_load(yaml_text or "") or {}
        if not isinstance(data, dict):
            return {"ok": False, "error": {"message": "YAML 根节点必须为 mapping"}}
        if "rules" not in data or not isinstance(data.get("rules"), dict):
            return {"ok": False, "error": {"message": "缺少 rules 配置块"}}
        save_audit_rules_config(data)
        _, source = audit_rules_yaml_text()
        return {"ok": True, "message": "审计规则配置已保存", "source": source}
    except yaml.YAMLError as exc:
        return {"ok": False, "error": {"message": f"YAML 解析失败：{exc}"}}
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_audit_related_circular(
    conn: Any,
    *,
    stat_year: str | None,
    risk_level: str | None = None,
    keyword: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        group_id = group_id_for_year(y)
        clauses = ["group_id = ?"]
        params: list[Any] = [group_id]
        if risk_level and risk_level.strip() and risk_level.strip() != "all":
            clauses.append("risk_level = ?")
            params.append(risk_level.strip())
        kw = (keyword or "").strip()
        if kw:
            clauses.append(
                "(coalesce(party_a_name, '') ILIKE ? OR coalesce(party_b_name, '') ILIKE ? "
                "OR coalesce(party_a_tax, '') ILIKE ? OR coalesce(party_b_tax, '') ILIKE ?)"
            )
            like = f"%{kw}%"
            params.extend([like, like, like, like])
        where = " AND ".join(clauses)
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM dm_circ_inv WHERE {where}", params).fetchone()[0] or 0
        )
        lim = max(1, min(int(limit or 100), 2000))
        off = max(0, int(offset or 0))
        rows = conn.execute(
            f"""
            SELECT circ_id, party_a_tax, party_a_name, party_b_tax, party_b_name,
                   amount_a_to_b, amount_b_to_a, circular_ratio, risk_level, analysis_batch
            FROM dm_circ_inv
            WHERE {where}
            ORDER BY circular_ratio DESC NULLS LAST, amount_a_to_b DESC
            LIMIT ? OFFSET ?
            """,
            [*params, lim, off],
        ).fetchall()
        items = [
            {
                "circ_id": str(r[0] or ""),
                "party_a_tax": str(r[1] or ""),
                "party_a_name": str(r[2] or "") or None,
                "party_b_tax": str(r[3] or ""),
                "party_b_name": str(r[4] or "") or None,
                "amount_a_to_b": float(r[5] or 0),
                "amount_b_to_a": float(r[6] or 0),
                "circular_ratio": float(r[7] or 0),
                "risk_level": str(r[8] or ""),
                "analysis_batch": str(r[9] or ""),
            }
            for r in rows or []
        ]
        return {
            "ok": True,
            "stat_year": str(y),
            "group_id": group_id,
            "total": total,
            "limit": lim,
            "offset": off,
            "rows": items,
        }
    except Exception as exc:
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_audit_related_shell(
    conn: Any,
    *,
    stat_year: str | None,
    keyword: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    try:
        y = _safe_int_year(stat_year)
        group_id = group_id_for_year(y)
        clauses = ["group_id = ?"]
        params: list[Any] = [group_id]
        kw = (keyword or "").strip()
        if kw:
            clauses.append(
                "(coalesce(group_member_name, '') ILIKE ? OR coalesce(intermediary_name, '') ILIKE ? "
                "OR coalesce(final_target_name, '') ILIKE ? OR coalesce(intermediary_tax, '') ILIKE ?)"
            )
            like = f"%{kw}%"
            params.extend([like, like, like, like])
        where = " AND ".join(clauses)
        total = int(
            conn.execute(f"SELECT COUNT(*)::BIGINT FROM dm_shell_co WHERE {where}", params).fetchone()[0] or 0
        )
        lim = max(1, min(int(limit or 100), 2000))
        off = max(0, int(offset or 0))
        rows = conn.execute(
            f"""
            SELECT shell_id, group_member_tax, group_member_name, intermediary_tax, intermediary_name,
                   final_target_tax, final_target_name, amount_in, amount_out,
                   passthrough_ratio, risk_level, analysis_batch
            FROM dm_shell_co
            WHERE {where}
            ORDER BY passthrough_ratio DESC NULLS LAST, amount_in DESC
            LIMIT ? OFFSET ?
            """,
            [*params, lim, off],
        ).fetchall()
        items = [
            {
                "shell_id": str(r[0] or ""),
                "group_member_tax": str(r[1] or ""),
                "group_member_name": str(r[2] or "") or None,
                "intermediary_tax": str(r[3] or ""),
                "intermediary_name": str(r[4] or "") or None,
                "final_target_tax": str(r[5] or "") or None,
                "final_target_name": str(r[6] or "") or None,
                "amount_in": float(r[7] or 0),
                "amount_out": float(r[8] or 0),
                "passthrough_ratio": float(r[9] or 0),
                "risk_level": str(r[10] or ""),
                "analysis_batch": str(r[11] or ""),
            }
            for r in rows or []
        ]
        return {
            "ok": True,
            "stat_year": str(y),
            "group_id": group_id,
            "total": total,
            "limit": lim,
            "offset": off,
            "rows": items,
        }
    except Exception as exc:
        return {"ok": False, "rows": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}
