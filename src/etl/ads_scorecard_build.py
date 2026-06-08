"""ADS 子公司综合评分卡构建（dws + dm → ads_scorecard）。"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Callable

from src.audit.config_loader import group_id_for_year

logger = logging.getLogger(__name__)

AUTOMATION_TASK_CODE = "ads.scorecard.refresh"
TASK_DISPLAY_NAME = "子公司评分卡刷新"

ProgressFn = Callable[[str, str], None] | None


def _make_batch_id(prefix: str = "scorecard") -> str:
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def compute_risk_score(
    *,
    flag_high: int,
    flag_medium: int,
    flag_low: int,
    cancel_ratio: float | None,
    cr1: float | None,
) -> tuple[float, str]:
    """风险得分：基础 100 分，按疑点等级与作废率/CR1 扣分。"""
    score = 100.0
    score -= int(flag_high) * 8
    score -= int(flag_medium) * 3
    score -= int(flag_low) * 1
    if cancel_ratio is not None and cancel_ratio > 0.10:
        score -= 5.0
    if cr1 is not None and cr1 > 0.50:
        score -= 5.0
    score = max(0.0, score)
    if score >= 80:
        level = "正常"
    elif score >= 60:
        level = "关注"
    else:
        level = "重点关注"
    return round(score, 2), level


def _entity_rows(conn: Any, stat_year: int) -> list[tuple[str, str | None]]:
    rows = conn.execute(
        """
        SELECT entity_id, max(entity_name) AS entity_name
        FROM (
            SELECT
                upper(regexp_replace(trim(COALESCE(enterprise_id, '')), '[\\s-]+', '', 'g')) AS entity_id,
                trim(COALESCE(enterprise_name, '')) AS entity_name
            FROM dim_enterprise_year_roster
            WHERE stat_year = ?
            UNION ALL
            SELECT entity_id, max(entity_name)
            FROM dws_inv_trend
            WHERE stat_year = ?
            GROUP BY entity_id
        ) u
        WHERE length(trim(entity_id)) > 0
        GROUP BY entity_id
        ORDER BY entity_id
        """,
        [stat_year, stat_year],
    ).fetchall()
    return [(str(r[0]), str(r[1]) if r[1] else None) for r in rows or [] if r and r[0]]


def _trend_metrics(conn: Any, stat_year: int, entity_id: str) -> dict[str, float | int]:
    row = conn.execute(
        """
        SELECT
            coalesce(sum(net_jshj) FILTER (WHERE role_type = '进项'), 0) AS input_net,
            coalesce(sum(normal_cnt + red_cnt + cancel_cnt), 0)::BIGINT AS invoice_cnt,
            coalesce(sum(cancel_cnt), 0)::BIGINT AS cancel_cnt
        FROM dws_inv_trend
        WHERE stat_year = ? AND entity_id = ?
        """,
        [stat_year, entity_id],
    ).fetchone()
    if not row:
        return {"input_net": 0.0, "invoice_cnt": 0, "cancel_ratio": 0.0}
    inv_cnt = int(row[1] or 0)
    cancel_cnt = int(row[2] or 0)
    cancel_ratio = (cancel_cnt / inv_cnt) if inv_cnt > 0 else 0.0
    return {
        "input_net": float(row[0] or 0),
        "invoice_cnt": inv_cnt,
        "cancel_ratio": round(cancel_ratio, 6),
    }


def _supplier_cnt(conn: Any, stat_year: int, entity_id: str) -> int:
    row = conn.execute(
        "SELECT count(*)::BIGINT FROM dws_sup_conc WHERE stat_year = ? AND entity_id = ?",
        [stat_year, entity_id],
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _cr1(conn: Any, stat_year: int, entity_id: str) -> float | None:
    row = conn.execute(
        """
        SELECT amount_ratio FROM dws_sup_conc
        WHERE stat_year = ? AND entity_id = ? AND amount_rank = 1
        LIMIT 1
        """,
        [stat_year, entity_id],
    ).fetchone()
    if not row or row[0] is None:
        return None
    return round(float(row[0]), 6)


def _quality_score(conn: Any, stat_year: int, entity_id: str) -> float | None:
    row = conn.execute(
        "SELECT quality_score FROM dws_quality WHERE stat_year = ? AND entity_id = ? LIMIT 1",
        [stat_year, entity_id],
    ).fetchone()
    if not row or row[0] is None:
        return None
    return round(float(row[0]), 2)


def _flag_counts(conn: Any, group_id: str, entity_id: str) -> dict[str, int]:
    row = conn.execute(
        """
        SELECT
            count(*)::BIGINT AS total,
            count(*) FILTER (WHERE risk_level = '高风险')::BIGINT AS high_cnt,
            count(*) FILTER (WHERE risk_level = '中风险')::BIGINT AS medium_cnt,
            count(*) FILTER (WHERE risk_level = '低风险')::BIGINT AS low_cnt
        FROM dm_audit_flag
        WHERE group_id = ? AND entity_id = ?
        """,
        [group_id, entity_id],
    ).fetchone()
    if not row:
        return {"total": 0, "high": 0, "medium": 0, "low": 0}
    return {
        "total": int(row[0] or 0),
        "high": int(row[1] or 0),
        "medium": int(row[2] or 0),
        "low": int(row[3] or 0),
    }


def refresh_ads_scorecard(
    conn: Any,
    *,
    stat_year: int,
    group_id: str | None = None,
    analysis_batch: str | None = None,
    on_progress: ProgressFn = None,
) -> dict[str, Any]:
    """按 stat_year 重建 ads_scorecard（DELETE + INSERT）。"""
    gid = group_id or group_id_for_year(stat_year)
    batch = analysis_batch or _make_batch_id()
    entities = _entity_rows(conn, stat_year)
    if on_progress:
        on_progress("entities", str(len(entities)))

    conn.execute(
        "DELETE FROM ads_scorecard WHERE group_id = ? AND stat_year = ?",
        [gid, stat_year],
    )

    inserted = 0
    now = datetime.now()
    for entity_id, entity_name in entities:
        trend = _trend_metrics(conn, stat_year, entity_id)
        flags = _flag_counts(conn, gid, entity_id)
        cr1_val = _cr1(conn, stat_year, entity_id)
        q_score = _quality_score(conn, stat_year, entity_id)
        risk_score, risk_level = compute_risk_score(
            flag_high=flags["high"],
            flag_medium=flags["medium"],
            flag_low=flags["low"],
            cancel_ratio=float(trend["cancel_ratio"]),
            cr1=cr1_val,
        )
        scorecard_id = f"SC_{uuid.uuid4().hex[:24]}"
        conn.execute(
            """
            INSERT INTO ads_scorecard (
                scorecard_id, group_id, entity_id, entity_name, stat_year,
                total_amount, total_count, supplier_count,
                flag_total, flag_high, flag_medium, flag_low,
                risk_score, risk_level, cr1, cancel_ratio, quality_score,
                analysis_batch, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                scorecard_id,
                gid,
                entity_id,
                entity_name,
                stat_year,
                trend["input_net"],
                trend["invoice_cnt"],
                _supplier_cnt(conn, stat_year, entity_id),
                flags["total"],
                flags["high"],
                flags["medium"],
                flags["low"],
                risk_score,
                risk_level,
                cr1_val,
                trend["cancel_ratio"],
                q_score,
                batch,
                now,
            ],
        )
        inserted += 1

    return {
        "ok": True,
        "stat_year": stat_year,
        "group_id": gid,
        "analysis_batch": batch,
        "entity_count": len(entities),
        "inserted": inserted,
    }


def refresh_ads_scorecard_years(
    conn: Any,
    *,
    stat_years: list[int] | None = None,
    on_progress: ProgressFn = None,
) -> dict[str, Any]:
    years: list[int] = []
    if stat_years:
        years = sorted({int(y) for y in stat_years if 1990 <= int(y) <= 2100})
    if not years:
        try:
            rows = conn.execute(
                """
                SELECT DISTINCT stat_year FROM (
                    SELECT stat_year FROM dws_inv_trend
                    UNION
                    SELECT stat_year FROM dim_enterprise_year_roster
                ) u
                WHERE stat_year IS NOT NULL
                ORDER BY 1 DESC
                """
            ).fetchall()
            years = [int(r[0]) for r in rows or [] if r and r[0] is not None][:5]
        except Exception:
            years = []

    if not years:
        return {"ok": False, "error": {"code": "no_stat_years", "message": "无可用 stat_year"}}

    results: list[dict[str, Any]] = []
    total_inserted = 0
    for y in years:
        if on_progress:
            on_progress("year_start", str(y))
        res = refresh_ads_scorecard(conn, stat_year=y, on_progress=on_progress)
        results.append(res)
        total_inserted += int(res.get("inserted") or 0)

    return {
        "ok": True,
        "stat_years": [str(y) for y in years],
        "total_inserted": total_inserted,
        "year_results": results,
    }
