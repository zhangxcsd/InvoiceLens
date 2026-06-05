"""
从 dim_audited_enterprise_registry 计算 dim_enterprise_year_roster（企业年度花名册）。

口径：
- 一行 = 某 stat_year 下的一个成员企业（税号 + 名称）
- 归类维度：台账 state_investor（国家出资企业）；不写入管理/产权层级
- state_investor_unified_credit_code：在同年度台账内按企业名称匹配国家出资企业的税号
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DDL_PATCH = Path(__file__).resolve().parents[2] / "config" / "ddl" / "patch_enterprise_year_roster.sql"

ProgressFn = Callable[[str, str], None]
_NORM_ID_RE = re.compile(r"[\s-]+")


def _norm_id(raw: str) -> str:
    return _NORM_ID_RE.sub("", str(raw or "").strip()).upper()


def _norm_name(raw: str) -> str:
    return str(raw or "").strip().lower()


def ensure_enterprise_year_roster_schema(conn: Any) -> None:
    """确保花名册表存在，并将报送覆盖视图切换到花名册口径（幂等）。"""
    try:
        if _DDL_PATCH.is_file():
            conn.execute(_DDL_PATCH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("花名册表结构补丁失败: %s", exc)
    try:
        conn.execute("SELECT stat_year FROM vw_audit_invoice_coverage_group_member LIMIT 0")
    except Exception:
        try:
            from db.schema_sqlfiles import _refresh_audit_coverage_views_from_dim_ddl

            _refresh_audit_coverage_views_from_dim_ddl(conn)
        except Exception as exc2:  # noqa: BLE001
            logger.warning("报送覆盖视图刷新失败: %s", exc2)


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


def rebuild_enterprise_year_roster_from_registry(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    replace_years: bool = True,
    run_id: str | None = None,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """从管理与产权台账刷新企业年度花名册（dim_enterprise_year_roster）。"""

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
            if replace_years:
                try:
                    conn.execute("DELETE FROM dim_enterprise_year_roster WHERE stat_year = ?", [year_i])
                except Exception as exc:  # noqa: BLE001
                    logger.warning("清空花名册年度 %s 失败: %s", year_i, exc)
            year_summaries.append({"stat_year": year_i, "written": 0, "skipped": True, "reason": "台账无行"})
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
            nk = _norm_name(ename)
            if nk and nk not in name_to_id:
                name_to_id[nk] = eid

        out_rows: list[dict[str, Any]] = []
        for row in parsed:
            si_name = row["state_investor"]
            issues: list[str] = []
            if not si_name:
                issues.append("国家出资企业未维护")
            si_id = name_to_id.get(_norm_name(si_name), "") if si_name else ""
            if si_name and not si_id:
                issues.append(f"未在同年度台账中匹配到国家出资企业「{si_name}」的税号")
            quality_status = "ok" if not issues else "conflict"
            out_rows.append(
                {
                    "stat_year": year_i,
                    "enterprise_id": row["enterprise_id"],
                    "enterprise_name": row["enterprise_name"],
                    "state_investor": si_name or "（未维护国家出资企业）",
                    "state_investor_unified_credit_code": si_id or None,
                    "is_member": True,
                    "registry_row_id": row["registry_row_id"],
                    "data_source": "audited_enterprise_registry",
                    "source_record_id": build_run_id,
                    "calc_version": "v1",
                    "quality_status": quality_status,
                    "quality_issue": "；".join(issues) if issues else None,
                }
            )

        _prog("write_roster", f"写入 {year_i} 年度 dim_enterprise_year_roster（{len(out_rows)} 行）…")
        try:
            if replace_years:
                conn.execute("DELETE FROM dim_enterprise_year_roster WHERE stat_year = ?", [year_i])
            for item in out_rows:
                conn.execute(
                    """
                    INSERT INTO dim_enterprise_year_roster (
                        stat_year, enterprise_id, enterprise_name,
                        state_investor, state_investor_unified_credit_code,
                        is_member, registry_row_id,
                        data_source, source_record_id, calc_version,
                        quality_status, quality_issue, updated_at
                    ) VALUES (
                        ?, ?, ?,
                        ?, ?,
                        ?, ?,
                        ?, ?, ?,
                        ?, ?, now()
                    )
                    ON CONFLICT (stat_year, enterprise_id) DO UPDATE SET
                        enterprise_name = excluded.enterprise_name,
                        state_investor = excluded.state_investor,
                        state_investor_unified_credit_code = excluded.state_investor_unified_credit_code,
                        is_member = excluded.is_member,
                        registry_row_id = excluded.registry_row_id,
                        data_source = excluded.data_source,
                        source_record_id = excluded.source_record_id,
                        calc_version = excluded.calc_version,
                        quality_status = excluded.quality_status,
                        quality_issue = excluded.quality_issue,
                        updated_at = now()
                    """,
                    [
                        item["stat_year"],
                        item["enterprise_id"],
                        item["enterprise_name"],
                        item["state_investor"],
                        item["state_investor_unified_credit_code"],
                        item["is_member"],
                        item["registry_row_id"],
                        item["data_source"],
                        item["source_record_id"],
                        item["calc_version"],
                        item["quality_status"],
                        item["quality_issue"],
                    ],
                )
        except Exception as exc:
            logger.exception("写入企业年度花名册失败 year=%s", year_i)
            rejected.append({"stat_year": str(year_i), "reason": str(exc)})
            continue

        total_written += len(out_rows)
        conflict_n = sum(1 for x in out_rows if x.get("quality_status") == "conflict")
        year_summaries.append(
            {"stat_year": year_i, "written": len(out_rows), "conflict_count": conflict_n}
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


def sync_enterprise_year_roster_for_snapshot_year(conn: Any, snapshot_year: int) -> dict[str, Any]:
    """台账单条写入后，同步该快照年度的花名册（不抛异常到调用方）。"""
    try:
        return rebuild_enterprise_year_roster_from_registry(
            conn,
            stat_years=[int(snapshot_year)],
            replace_years=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("花名册同步失败 year=%s: %s", snapshot_year, exc)
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
