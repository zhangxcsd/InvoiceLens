from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path
from typing import Any

import yaml


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _health_config_path() -> Path:
    return _project_root() / "config" / "health_indicator_config.yaml"


def _score_from_bands(value: float, bands: list[dict[str, Any]]) -> tuple[float, str, dict[str, Any] | None]:
    for b in bands:
        try:
            min_v = float(b.get("min", 0.0))
            max_v = float(b.get("max", 0.0))
        except Exception:
            continue
        if value >= min_v and value < max_v:
            return float(b.get("score", 0.0)), str(b.get("level", "normal")), b
    if not bands:
        return 0.0, "normal", None
    last = bands[-1]
    return float(last.get("score", 0.0)), str(last.get("level", "normal")), last


def _calc_health_snapshot_from_config(
    raw: dict[str, Any],
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    dimensions_raw = raw.get("dimensions") if isinstance(raw, dict) else None
    indicators_raw = raw.get("indicators") if isinstance(raw, dict) else None
    dimensions = dimensions_raw if isinstance(dimensions_raw, list) else []
    indicators = indicators_raw if isinstance(indicators_raw, list) else []
    dim_map: dict[str, dict[str, Any]] = {}
    for d in dimensions:
        if not isinstance(d, dict):
            continue
        code = str(d.get("code", "")).strip()
        if not code:
            continue
        dim_map[code] = d

    dim_score_acc: dict[str, float] = {}
    dim_weight_acc: dict[str, float] = {}
    dim_rows: list[dict[str, Any]] = []
    indicator_rows: list[dict[str, Any]] = []

    for it in indicators:
        if not isinstance(it, dict):
            continue
        code = str(it.get("code", "")).strip()
        if not code:
            continue
        dim_code = str(it.get("dimension", "")).strip()
        dim_obj = dim_map.get(dim_code, {})
        dim_name = str(dim_obj.get("name", dim_code or "未分组"))
        value = float(it.get("demo_value", 0.0) or 0.0)
        score, level, hit_band = _score_from_bands(value, it.get("score_bands", []))
        weight_in_dim = float(it.get("weight_in_dimension", 0.0) or 0.0)
        dim_score_acc[dim_code] = dim_score_acc.get(dim_code, 0.0) + score * weight_in_dim
        dim_weight_acc[dim_code] = dim_weight_acc.get(dim_code, 0.0) + weight_in_dim

        suspicion_rows: list[dict[str, Any]] = []
        for rule in it.get("suspicion_mapping", []):
            if not isinstance(rule, dict):
                continue
            if str(rule.get("when_level", "")).strip() != level:
                continue
            for item in rule.get("directions", []):
                if not isinstance(item, dict):
                    continue
                suspicion_rows.append(
                    {
                        "code": str(item.get("code", "")).strip(),
                        "title": str(item.get("title", "")).strip(),
                        "detail": str(item.get("detail", "")).strip(),
                        "related_audit_topics": [
                            str(x).strip()
                            for x in item.get("related_audit_topics", [])
                            if str(x).strip()
                        ],
                    }
                )

        indicator_rows.append(
            {
                "indicator_code": code,
                "indicator_name": str(it.get("name", code)),
                "dimension_code": dim_code,
                "dimension_name": dim_name,
                "indicator_value": value,
                "score": round(score, 2),
                "level": level,
                "weight_in_dimension": weight_in_dim,
                "weight_global": round(
                    weight_in_dim * float(dim_obj.get("weight", 0.0) or 0.0),
                    6,
                ),
                "formula_text": str(it.get("formula_text", "")).strip(),
                "threshold_text": str(it.get("threshold_text", "")).strip(),
                "data_source_text": str(it.get("data_source_text", "")).strip(),
                "hit_band_min": float(hit_band.get("min", 0.0)) if isinstance(hit_band, dict) else None,
                "hit_band_max": float(hit_band.get("max", 0.0)) if isinstance(hit_band, dict) else None,
                "suspicion_directions": suspicion_rows,
                "suggest_actions": [str(x).strip() for x in it.get("suggest_actions", []) if str(x).strip()],
                "evidence_count": int(it.get("demo_evidence_count", 0) or 0),
                "explain_text": str(it.get("explain_template", "")).replace("{value}", f"{value:.4f}"),
            }
        )

    total_score = 0.0
    for d in dimensions:
        if not isinstance(d, dict):
            continue
        code = str(d.get("code", "")).strip()
        if not code:
            continue
        w = float(d.get("weight", 0.0) or 0.0)
        ds = 0.0
        if dim_weight_acc.get(code, 0.0) > 0:
            ds = dim_score_acc[code] / dim_weight_acc[code]
        total_score += ds * w
        dim_rows.append(
            {
                "dimension_code": code,
                "dimension_name": str(d.get("name", code)),
                "weight": w,
                "score": round(ds, 2),
            }
        )
    total_score = round(total_score, 2)
    if total_score >= 85:
        grade = "A"
    elif total_score >= 70:
        grade = "B"
    elif total_score >= 55:
        grade = "C"
    else:
        grade = "D"
    top_deductions = sorted(
        indicator_rows,
        key=lambda r: float(r.get("weight_global", 0.0)) * (100.0 - float(r.get("score", 0.0))),
        reverse=True,
    )[:3]
    return {
        "ok": True,
        "batch_id": (batch_id or "").strip() or None,
        "session_id": (session_id or "").strip() or None,
        "rule_version": str(raw.get("version", "v1")),
        "overview": {
            "total_score": total_score,
            "grade": grade,
            "change_vs_prev": float(raw.get("demo_change_vs_prev", 0.0) or 0.0),
            "score_formula": "总分 = Σ(维度得分 × 维度权重)",
            "grade_rule": "A>=85, B=70~84, C=55~69, D<55",
        },
        "dimensions": dim_rows,
        "indicators": indicator_rows,
        "top_deductions": [
            {
                "indicator_code": r.get("indicator_code"),
                "indicator_name": r.get("indicator_name"),
                "dimension_name": r.get("dimension_name"),
                "score": r.get("score"),
                "level": r.get("level"),
                "explain_text": r.get("explain_text"),
            }
            for r in top_deductions
        ],
    }


def _norm_entity_id(entity_id: str | None) -> str:
    import re

    return re.sub(r"[\s-]+", "", str(entity_id or "").strip()).upper()


def _level_from_risk_score(score: float) -> str:
    if score >= 80:
        return "normal"
    if score >= 60:
        return "warning"
    return "alert"


def load_health_score_from_scorecard(
    conn: Any,
    *,
    stat_year: int,
    entity_id: str,
) -> dict[str, Any]:
    """从 ads_scorecard + dm_audit_flag 构建健康度快照（与横向对比排名同源）。"""
    eid = _norm_entity_id(entity_id)
    if not eid:
        return {"ok": False, "error": {"message": "请指定主体税号"}}

    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(stat_year)
    try:
        sc = conn.execute(
            """
            SELECT entity_name, risk_score, risk_level, total_amount, total_count, supplier_count,
                   flag_total, flag_high, flag_medium, flag_low, cr1, cancel_ratio, quality_score
            FROM ads_scorecard
            WHERE group_id = ? AND stat_year = ? AND entity_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            [gid, stat_year, eid],
        ).fetchone()
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    if not sc:
        return {
            "ok": False,
            "error": {
                "message": f"{stat_year} 年度未找到该主体评分卡，请先在「横向对比排名」刷新评分卡。",
                "exception_type": "NotFound",
            },
        }

    entity_name = str(sc[0] or eid)
    risk_score = float(sc[1] or 0)
    risk_level = str(sc[2] or "正常")
    flag_high = int(sc[7] or 0)
    flag_medium = int(sc[8] or 0)
    flag_low = int(sc[9] or 0)
    cr1 = float(sc[10] or 0) if sc[10] is not None else None
    cancel_ratio = float(sc[11] or 0) if sc[11] is not None else None
    quality_score = float(sc[12] or 0) if sc[12] is not None else None

    prev_score = risk_score
    try:
        prev_row = conn.execute(
            """
            SELECT risk_score FROM ads_scorecard
            WHERE group_id = ? AND stat_year = ? AND entity_id = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            [gid, stat_year - 1, eid],
        ).fetchone()
        if prev_row and prev_row[0] is not None:
            prev_score = float(prev_row[0])
    except Exception:
        pass
    change_vs_prev = round(risk_score - prev_score, 2)

    grade_map = {"正常": "A", "关注": "B", "重点关注": "C"}
    grade = grade_map.get(risk_level, "—")

    flag_dim_score = max(0.0, 100.0 - flag_high * 8 - flag_medium * 3 - flag_low)
    cr1_score = max(0.0, 100.0 - (5.0 if cr1 is not None and cr1 > 0.5 else 0.0))
    cancel_score = max(0.0, 100.0 - (5.0 if cancel_ratio is not None and cancel_ratio > 0.1 else 0.0))
    quality_dim_score = quality_score if quality_score is not None else 80.0

    dimensions = [
        {
            "dimension_code": "flag_risk",
            "dimension_name": "疑点风险",
            "weight": 0.4,
            "score": round(flag_dim_score, 2),
        },
        {
            "dimension_code": "data_quality",
            "dimension_name": "数据质量",
            "weight": 0.25,
            "score": round(quality_dim_score, 2),
        },
        {
            "dimension_code": "concentration",
            "dimension_name": "供应商集中度",
            "weight": 0.2,
            "score": round(cr1_score, 2),
        },
        {
            "dimension_code": "invoice_behavior",
            "dimension_name": "发票行为",
            "weight": 0.15,
            "score": round(cancel_score, 2),
        },
    ]

    rule_rows: list[dict[str, Any]] = []
    try:
        for r in conn.execute(
            """
            SELECT rule_id, risk_level, count(*)::INT, coalesce(sum(amount), 0)
            FROM dm_audit_flag
            WHERE group_id = ? AND entity_id = ?
            GROUP BY rule_id, risk_level
            ORDER BY rule_id, risk_level
            """,
            [gid, eid],
        ).fetchall() or []:
            rule_rows.append(
                {
                    "rule_id": str(r[0] or ""),
                    "risk_level": str(r[1] or ""),
                    "count": int(r[2] or 0),
                    "amount": float(r[3] or 0),
                }
            )
    except Exception:
        pass

    level = _level_from_risk_score(risk_score)
    indicators: list[dict[str, Any]] = [
        {
            "indicator_code": "risk_score",
            "indicator_name": "综合风险得分",
            "dimension_code": "flag_risk",
            "dimension_name": "疑点风险",
            "indicator_value": risk_score,
            "score": round(risk_score, 2),
            "level": level,
            "weight_in_dimension": 1.0,
            "weight_global": 0.4,
            "formula_text": "100 - 高风险疑点×8 - 中风险×3 - 低风险×1 - 作废率/CR1 扣分",
            "threshold_text": "≥80 正常，60~79 关注，<60 重点关注",
            "data_source_text": "ads_scorecard（与横向对比排名同源）",
            "hit_band_min": 60.0 if level == "warning" else (80.0 if level == "normal" else None),
            "hit_band_max": 80.0 if level == "warning" else (100.0 if level == "normal" else 60.0),
            "suspicion_directions": [],
            "suggest_actions": ["在疑点清单按规则筛选复核", "对比横向对比排名同主体评级"],
            "evidence_count": int(sc[6] or 0),
            "explain_text": f"评级 {risk_level}，得分 {risk_score:.0f}（compute_risk_score 口径）",
        },
        {
            "indicator_code": "flag_high",
            "indicator_name": "高风险疑点数",
            "dimension_code": "flag_risk",
            "dimension_name": "疑点风险",
            "indicator_value": float(flag_high),
            "score": max(0.0, 100.0 - flag_high * 8),
            "level": "alert" if flag_high > 0 else "normal",
            "weight_in_dimension": 0.5,
            "weight_global": 0.2,
            "formula_text": "dm_audit_flag 高风险等级计数",
            "threshold_text": "每条约 8 分扣分",
            "data_source_text": "dm_audit_flag",
            "hit_band_min": None,
            "hit_band_max": None,
            "suspicion_directions": [],
            "suggest_actions": ["跳转疑点清单按高风险筛选"],
            "evidence_count": flag_high,
            "explain_text": f"高风险疑点 {flag_high} 条，中风险 {flag_medium} 条，低风险 {flag_low} 条",
        },
    ]
    if cr1 is not None:
        indicators.append(
            {
                "indicator_code": "cr1",
                "indicator_name": "供应商 CR1 集中度",
                "dimension_code": "concentration",
                "dimension_name": "供应商集中度",
                "indicator_value": cr1,
                "score": round(cr1_score, 2),
                "level": "warning" if cr1 > 0.5 else "normal",
                "weight_in_dimension": 1.0,
                "weight_global": 0.2,
                "formula_text": "第一大供应商进项占比",
                "threshold_text": ">50% 扣 5 分",
                "data_source_text": "ads_scorecard.cr1",
                "hit_band_min": 0.5 if cr1 > 0.5 else None,
                "hit_band_max": None,
                "suspicion_directions": [],
                "suggest_actions": ["查看供应商集中度专题"],
                "evidence_count": 1,
                "explain_text": f"CR1 = {(cr1 * 100):.2f}%",
            }
        )
    if cancel_ratio is not None:
        indicators.append(
            {
                "indicator_code": "cancel_ratio",
                "indicator_name": "作废票占比",
                "dimension_code": "invoice_behavior",
                "dimension_name": "发票行为",
                "indicator_value": cancel_ratio,
                "score": round(cancel_score, 2),
                "level": "warning" if cancel_ratio > 0.1 else "normal",
                "weight_in_dimension": 1.0,
                "weight_global": 0.15,
                "formula_text": "作废张数 / 发票总张数",
                "threshold_text": ">10% 扣 5 分",
                "data_source_text": "ads_scorecard.cancel_ratio",
                "hit_band_min": 0.1 if cancel_ratio > 0.1 else None,
                "hit_band_max": None,
                "suspicion_directions": [],
                "suggest_actions": ["复核作废发票清单"],
                "evidence_count": 1,
                "explain_text": f"作废占比 {(cancel_ratio * 100):.2f}%",
            }
        )

    top_deductions = sorted(
        indicators,
        key=lambda r: float(r.get("weight_global", 0.0)) * (100.0 - float(r.get("score", 0.0))),
        reverse=True,
    )[:3]

    return {
        "ok": True,
        "data_source": "ads_scorecard",
        "stat_year": str(stat_year),
        "entity_id": eid,
        "entity_name": entity_name,
        "rule_version": "scorecard_v1",
        "overview": {
            "total_score": round(risk_score, 2),
            "grade": grade,
            "risk_level": risk_level,
            "change_vs_prev": change_vs_prev,
            "score_formula": "与 ads_scorecard.compute_risk_score 同源（100 分制）",
            "grade_rule": "正常≥80 / 关注 60~79 / 重点关注<60（与横向对比一致）",
        },
        "dimensions": dimensions,
        "indicators": indicators,
        "top_deductions": [
            {
                "indicator_code": r.get("indicator_code"),
                "indicator_name": r.get("indicator_name"),
                "dimension_name": r.get("dimension_name"),
                "score": r.get("score"),
                "level": r.get("level"),
                "explain_text": r.get("explain_text"),
            }
            for r in top_deductions
        ],
        "flag_breakdown": rule_rows,
    }


def load_health_score_snapshot(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    stat_year: str | int | None = None,
    entity_id: str | None = None,
) -> dict[str, Any]:
    if stat_year is not None and entity_id:
        try:
            y = int(str(stat_year).strip())
            if 1990 <= y <= 2100:
                return load_health_score_from_scorecard(conn, stat_year=y, entity_id=str(entity_id))
        except (TypeError, ValueError):
            pass

    cfg_path = _health_config_path()
    if not cfg_path.exists():
        return {
            "ok": False,
            "error": {"message": f"未找到健康度配置文件：{cfg_path}"},
        }
    try:
        loaded = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            return {"ok": False, "error": {"message": "健康度配置格式错误：根节点必须是对象"}}
        return _calc_health_snapshot_from_config(
            loaded,
            batch_id=batch_id,
            session_id=session_id,
        )
    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "message": f"健康度配置解析失败：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }


def load_red_invoice_quality_overview(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    where = ["jshj < 0"]
    params: list[Any] = []
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    if bid:
        where.append("import_batch_id = ?")
        params.append(bid)
    if sid:
        where.append("import_session_id = ?")
        params.append(sid)
    where_sql = " AND ".join(where)
    row = conn.execute(
        f"""
        SELECT
          COUNT(*)::BIGINT AS red_invoice_count,
          SUM(CASE WHEN related_blue_invoice_uuid IS NULL THEN 1 ELSE 0 END)::BIGINT AS unmatched_blue_count,
          SUM(CASE WHEN COALESCE(is_orphan_red, FALSE) THEN 1 ELSE 0 END)::BIGINT AS orphan_red_count,
          SUM(CASE WHEN related_blue_invoice_uuid IS NOT NULL THEN 1 ELSE 0 END)::BIGINT AS matched_blue_count
        FROM dwd_inv_header
        WHERE {where_sql}
        """,
        params,
    ).fetchone()
    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "red_invoice_count": int((row[0] if row else 0) or 0),
        "unmatched_blue_count": int((row[1] if row else 0) or 0),
        "orphan_red_count": int((row[2] if row else 0) or 0),
        "matched_blue_count": int((row[3] if row else 0) or 0),
    }


def load_red_invoice_quality_details(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    only_unmatched: bool = True,
    limit: int = 200,
) -> dict[str, Any]:
    where = ["jshj < 0"]
    params: list[Any] = []
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    if bid:
        where.append("import_batch_id = ?")
        params.append(bid)
    if sid:
        where.append("import_session_id = ?")
        params.append(sid)
    if only_unmatched:
        where.append("related_blue_invoice_uuid IS NULL")
    where_sql = " AND ".join(where)
    lim = max(1, min(1000, int(limit or 200)))
    rows = conn.execute(
        f"""
        SELECT
          header_uuid,
          import_batch_id,
          import_session_id,
          COALESCE(sdfphm, '') AS sdfphm,
          COALESCE(fpdm, '') AS fpdm,
          COALESCE(fphm, '') AS fphm,
          jshj,
          COALESCE(net_calc_status, '') AS net_calc_status,
          COALESCE(is_orphan_red, FALSE) AS is_orphan_red,
          COALESCE(related_blue_invoice_uuid, '') AS related_blue_invoice_uuid,
          COALESCE(bz, '') AS bz,
          CASE
            WHEN COALESCE(is_orphan_red, FALSE) THEN '备注可解析但蓝票未入库'
            WHEN trim(COALESCE(bz, '')) = '' THEN '备注为空'
            ELSE '备注未匹配规则或关键字段缺失'
          END AS quality_reason
        FROM dwd_inv_header
        WHERE {where_sql}
        ORDER BY invoice_date DESC NULLS LAST, kprq DESC NULLS LAST
        LIMIT ?
        """,
        [*params, lim],
    ).fetchall()
    cols = [
        "header_uuid",
        "import_batch_id",
        "import_session_id",
        "sdfphm",
        "fpdm",
        "fphm",
        "jshj",
        "net_calc_status",
        "is_orphan_red",
        "related_blue_invoice_uuid",
        "bz",
        "quality_reason",
    ]
    out_rows = [{k: r[i] for i, k in enumerate(cols)} for r in rows]
    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "only_unmatched": bool(only_unmatched),
        "rows": out_rows,
        "limit": lim,
    }


def load_red_invoice_quality_trend(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    stat_year: int | None = None,
    granularity: str = "week",
    limit: int = 12,
) -> dict[str, Any]:
    """按周/月聚合红票关联质量趋势（未匹配蓝票 = 异常，孤立红票 = 阻塞）。"""
    where = ["jshj < 0", "invoice_date IS NOT NULL"]
    params: list[Any] = []
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    if bid:
        where.append("import_batch_id = ?")
        params.append(bid)
    if sid:
        where.append("import_session_id = ?")
        params.append(sid)
    if stat_year is not None:
        where.append("stat_year = ?")
        params.append(int(stat_year))
    where_sql = " AND ".join(where)
    gran = str(granularity or "week").strip().lower()
    if gran == "month":
        period_expr = "strftime(invoice_date, '%Y-%m')"
    else:
        gran = "week"
        period_expr = "strftime(invoice_date, '%G-W%V')"
    lim = max(1, min(52, int(limit or 12)))

    rows = conn.execute(
        f"""
        WITH base AS (
          SELECT
            {period_expr} AS period_label,
            invoice_date,
            related_blue_invoice_uuid,
            COALESCE(is_orphan_red, FALSE) AS is_orphan_red
          FROM dwd_inv_header
          WHERE {where_sql}
        )
        SELECT
          period_label,
          MIN(invoice_date) AS period_start,
          COUNT(*)::BIGINT AS red_invoice_count,
          SUM(CASE WHEN related_blue_invoice_uuid IS NULL THEN 1 ELSE 0 END)::BIGINT AS unmatched_count,
          SUM(CASE WHEN is_orphan_red THEN 1 ELSE 0 END)::BIGINT AS orphan_count,
          SUM(CASE WHEN related_blue_invoice_uuid IS NOT NULL THEN 1 ELSE 0 END)::BIGINT AS matched_count
        FROM base
        GROUP BY period_label
        ORDER BY period_start DESC
        LIMIT ?
        """,
        [*params, lim],
    ).fetchall()

    out_rows: list[dict[str, Any]] = []
    for r in rows:
        out_rows.append(
            {
                "period_label": str(r[0] or ""),
                "period_start": str(r[1]) if r[1] is not None else None,
                "red_invoice_count": int(r[2] or 0),
                "unmatched_count": int(r[3] or 0),
                "orphan_count": int(r[4] or 0),
                "matched_count": int(r[5] or 0),
            }
        )
    # 前端柱状图从左到右按时间升序
    out_rows.reverse()
    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "stat_year": int(stat_year) if stat_year is not None else None,
        "granularity": gran,
        "rows": out_rows,
        "limit": lim,
    }


def load_lineage_reject_quality_trend(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    granularity: str = "week",
    limit: int = 12,
) -> dict[str, Any]:
    """按 ods_load_log.load_time 聚合导入拒收趋势（行级拒收 = 异常，文件阻断 = 阻塞）。"""
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    gran = str(granularity or "week").strip().lower()
    if gran != "month":
        gran = "week"
    lim = max(1, min(52, int(limit or 12)))
    clause, params = _ods_load_log_scope_where(batch_id=bid or None, session_id=sid or None)
    try:
        raw_rows = conn.execute(
            f"""
            -- 审计含义：按导入落盘时间分桶，反映各批次 Excel 读取拒收与阻断的时序分布
            SELECT load_time, detail_json
            FROM ods_load_log
            {clause}
            ORDER BY load_time DESC NULLS LAST
            """,
            params,
        ).fetchall()
    except Exception as exc:
        msg = str(exc).lower()
        if "ods_load_log" in msg and ("does not exist" in msg or "not exist" in msg):
            return {
                "ok": False,
                "error": {
                    "message": "ods_load_log 表不存在，无法读取导入拒收趋势",
                    "code": "ods_load_log_missing",
                },
            }
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    buckets: dict[str, dict[str, Any]] = {}
    for load_time, detail_json in raw_rows or []:
        label, period_start = _period_label_from_ts(load_time, gran)
        if not label:
            continue
        bucket = buckets.get(label)
        if bucket is None:
            bucket = {
                "period_label": label,
                "period_start": period_start,
                "row_reject_count": 0,
                "file_blocking_count": 0,
                "import_file_count": 0,
            }
            buckets[label] = bucket
        file_logs = _parse_ods_import_file_logs(detail_json)
        kpi = _summarize_lineage_reject(file_logs)
        bucket["row_reject_count"] += int(kpi.get("row_reject_count") or 0)
        bucket["file_blocking_count"] += int(kpi.get("file_blocking_count") or 0)
        bucket["import_file_count"] += int(kpi.get("import_file_count") or 0)

    sorted_rows = sorted(
        buckets.values(),
        key=lambda x: str(x.get("period_start") or x.get("period_label") or ""),
        reverse=True,
    )[:lim]
    out_rows: list[dict[str, Any]] = []
    for row in sorted_rows:
        ps = row.get("period_start")
        out_rows.append(
            {
                "period_label": str(row.get("period_label") or ""),
                "period_start": ps.isoformat() if hasattr(ps, "isoformat") else str(ps or ""),
                "row_reject_count": int(row.get("row_reject_count") or 0),
                "file_blocking_count": int(row.get("file_blocking_count") or 0),
                "import_file_count": int(row.get("import_file_count") or 0),
            }
        )
    out_rows.reverse()
    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "granularity": gran,
        "rows": out_rows,
        "limit": lim,
    }


def _dq_batch_pairs(conn: Any, batch_id: str | None) -> list[tuple[int, str]]:
    """按 import_batch_id 解析 (stat_year, batch_id) 对，供专项/语义跨表 SQL 使用。"""
    bid = str(batch_id or "").strip()
    if bid:
        stat_years = [
            int(r[0])
            for r in conn.execute(
                """
                SELECT DISTINCT stat_year
                FROM dwd_inv_header
                WHERE import_batch_id = ? AND stat_year IS NOT NULL
                ORDER BY stat_year
                """,
                [bid],
            ).fetchall()
        ]
        return [(sy, bid) for sy in stat_years]
    return [
        (int(r[0]), str(r[1]))
        for r in conn.execute(
            """
            SELECT DISTINCT stat_year, import_batch_id
            FROM dwd_inv_header
            WHERE stat_year IS NOT NULL
              AND nullif(trim(import_batch_id), '') IS NOT NULL
            ORDER BY stat_year, import_batch_id
            """
        ).fetchall()
    ]


def _semantic_missing_spc_findings(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> list[dict[str, Any]]:
    """收集疑似缺专项票头（明细正行>0 且专项正行=0）。"""
    from src.etl.dwd_shared_logic_line import sql_spc_inv_positive_linecount_mismatch

    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    tk = _sql_ticket_key("h")
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for sy, pair_bid in _dq_batch_pairs(conn, bid or None):
        dq_params = [sy, pair_bid, sy, pair_bid]
        for spc_tbl in _SPC_TABLES:
            spc_label = next(
                (lbl for tbl, lbl, _ in _SPC_BIZ_DUP_SPECS if tbl == spc_tbl),
                spc_tbl,
            )
            try:
                sql_lc = sql_spc_inv_positive_linecount_mismatch(spc_tbl)
                for row in conn.execute(sql_lc, dq_params).fetchall() or []:
                    huid = str(row[0] or "")
                    inv_pos = int(row[2] or 0)
                    spc_pos = int(row[3] or 0)
                    if inv_pos <= 0 or spc_pos > 0 or huid in seen:
                        continue
                    seen.add(huid)
                    hrow = conn.execute(
                        f"""
                        SELECT
                          h.import_batch_id,
                          h.import_session_id,
                          h.stat_year,
                          h.invoice_date,
                          h.xfsbh,
                          h.xfmc,
                          h.gfsbh,
                          h.gfmc,
                          {tk}
                        FROM dwd_inv_header h
                        WHERE h.header_uuid = ?
                        LIMIT 1
                        """,
                        [huid],
                    ).fetchone()
                    if sid and hrow and str(hrow[1] or "").strip() != sid:
                        continue
                    ticket = str(hrow[8] or huid) if hrow else huid
                    out.append(
                        {
                            "header_uuid": huid,
                            "ticket_key": ticket,
                            "stat_year": int(hrow[2] or sy) if hrow else sy,
                            "invoice_date": hrow[3] if hrow else None,
                            "import_batch_id": str(hrow[0] or pair_bid) if hrow else pair_bid,
                            "import_session_id": str(hrow[1] or "") if hrow else "",
                            "entity_id": str(hrow[4] or hrow[6] or "").strip(),
                            "entity_name": str(hrow[5] or hrow[7] or hrow[4] or "").strip(),
                            "spc_table": spc_tbl,
                            "spc_label": spc_label,
                            "inv_detail_positive_lines": inv_pos,
                        }
                    )
            except Exception:
                pass
    return out


def _semantic_summary_findings(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> list[dict[str, Any]]:
    """收集 logic_line_no=0 汇总参考行明细。"""
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    dtl_where, dtl_params = _scope_filters("d", batch_id=bid or None, session_id=sid or None)
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""
    tk = _sql_ticket_key("h2")
    out: list[dict[str, Any]] = []
    try:
        for r in conn.execute(
            f"""
            SELECT
              d.header_uuid,
              d.import_batch_id,
              d.import_session_id,
              h2.stat_year,
              h2.invoice_date,
              h2.xfsbh,
              h2.xfmc,
              h2.gfsbh,
              h2.gfmc,
              {tk.replace('h2.', 'h2.')} AS ticket_key,
              d.hwlwmc,
              d.source_sheet
            FROM dwd_inv_detail d
            LEFT JOIN dwd_inv_header h2 ON h2.header_uuid = d.header_uuid
            WHERE d.logic_line_no = 0{dtl_clause}
            ORDER BY d.header_uuid, d.detail_uuid
            """,
            dtl_params,
        ).fetchall() or []:
            ticket = str(r[9] or "").strip() or str(r[0] or "")
            out.append(
                {
                    "header_uuid": str(r[0] or ""),
                    "ticket_key": ticket,
                    "stat_year": int(r[3] or 0) if r[3] is not None else None,
                    "invoice_date": r[4],
                    "import_batch_id": str(r[1] or ""),
                    "import_session_id": str(r[2] or ""),
                    "entity_id": str(r[5] or r[7] or "").strip(),
                    "entity_name": str(r[6] or r[8] or r[5] or "").strip(),
                    "hwlwmc": str(r[10] or ""),
                    "source_sheet": str(r[11] or ""),
                }
            )
    except Exception:
        pass
    return out


def _semantic_detail_rows(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    rule_id: str | None = None,
    ticket_key: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """语义域明细（汇总参考行 + 疑似缺专项），支持 rule_id / ticket_key 过滤与分页。"""
    dom = "semantic"
    rid_filter = str(rule_id or "").strip().lower()
    tk_filter = str(ticket_key or "").strip().lower()
    rows: list[dict[str, Any]] = []

    if not rid_filter or rid_filter == "summary_reference_line":
        for item in _semantic_summary_findings(conn, batch_id=batch_id, session_id=session_id):
            rows.append(
                {
                    "ticket_key": item["ticket_key"],
                    "header_uuid": item["header_uuid"],
                    "domain": dom,
                    "rule_id": "summary_reference_line",
                    "severity": "info",
                    "summary": f"汇总参考行（logic_line_no=0）：{str(item.get('hwlwmc') or '')[:80]}",
                    "import_batch_id": item["import_batch_id"],
                    "import_session_id": item["import_session_id"],
                    "delta_value": None,
                    "extra": {
                        "source_sheet": item.get("source_sheet") or "",
                        "hwlwmc": item.get("hwlwmc") or "",
                    },
                }
            )

    if not rid_filter or rid_filter == "missing_spc_positive_lines":
        for item in _semantic_missing_spc_findings(conn, batch_id=batch_id, session_id=session_id):
            rows.append(
                {
                    "ticket_key": item["ticket_key"],
                    "header_uuid": item["header_uuid"],
                    "domain": dom,
                    "rule_id": "missing_spc_positive_lines",
                    "severity": "warn",
                    "summary": (
                        f"疑似缺专项（{item.get('spc_label')}）："
                        f"明细正行 {item.get('inv_detail_positive_lines')}，专项正行 0"
                    ),
                    "import_batch_id": item["import_batch_id"],
                    "import_session_id": item["import_session_id"],
                    "delta_value": float(item.get("inv_detail_positive_lines") or 0),
                    "extra": {"spc_table": item.get("spc_table") or ""},
                }
            )

    if tk_filter:
        rows = [
            r
            for r in rows
            if tk_filter in str(r.get("ticket_key") or "").lower()
            or tk_filter in str(r.get("header_uuid") or "").lower()
        ]
    if rid_filter and rid_filter not in {"summary_reference_line", "missing_spc_positive_lines"}:
        rows = [r for r in rows if str(r.get("rule_id") or "").lower() == rid_filter]

    total = len(rows)
    off = max(0, int(offset or 0))
    lim = max(1, min(1000, int(limit or 200)))
    return rows[off : off + lim], total


def load_semantic_quality_trend(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    granularity: str = "week",
    limit: int = 12,
) -> dict[str, Any]:
    """按开票日期聚合语义质量趋势（疑似缺专项票 = 异常，汇总参考行 = 提示）。"""
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    gran = str(granularity or "week").strip().lower()
    if gran == "month":
        period_expr = "strftime(h.invoice_date, '%Y-%m')"
    else:
        gran = "week"
        period_expr = "strftime(h.invoice_date, '%G-W%V')"
    lim = max(1, min(52, int(limit or 12)))
    hdr_where, hdr_params = _scope_filters("h", batch_id=bid or None, session_id=sid or None)
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
    dtl_where, dtl_params = _scope_filters("d", batch_id=bid or None, session_id=sid or None)
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""

    buckets: dict[str, dict[str, Any]] = {}
    try:
        for period_label, period_start, summary_cnt in conn.execute(
            f"""
            -- 审计含义：按开票日期分桶统计 logic_line_no=0 汇总参考行命中规模
            WITH base AS (
              SELECT
                {period_expr} AS period_label,
                h.invoice_date AS period_ts
              FROM dwd_inv_detail d
              INNER JOIN dwd_inv_header h ON h.header_uuid = d.header_uuid
              WHERE d.logic_line_no = 0
                AND h.invoice_date IS NOT NULL{dtl_clause}{hdr_clause}
            )
            SELECT
              period_label,
              MIN(period_ts) AS period_start,
              COUNT(*)::BIGINT AS summary_line_count
            FROM base
            GROUP BY period_label
            """,
            [*dtl_params, *hdr_params],
        ).fetchall() or []:
            label = str(period_label or "")
            if not label:
                continue
            buckets[label] = {
                "period_label": label,
                "period_start": period_start,
                "missing_spc_tickets": 0,
                "summary_line_count": int(summary_cnt or 0),
            }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    for finding in _semantic_missing_spc_findings(conn, batch_id=bid or None, session_id=sid or None):
        inv_date = finding.get("invoice_date")
        if inv_date is None:
            continue
        label, period_start = _period_label_from_ts(inv_date, gran)
        if not label:
            continue
        bucket = buckets.get(label)
        if bucket is None:
            bucket = {
                "period_label": label,
                "period_start": period_start,
                "missing_spc_tickets": 0,
                "summary_line_count": 0,
            }
            buckets[label] = bucket
        bucket["missing_spc_tickets"] += 1

    sorted_rows = sorted(
        buckets.values(),
        key=lambda x: str(x.get("period_start") or x.get("period_label") or ""),
        reverse=True,
    )[:lim]
    out_rows: list[dict[str, Any]] = []
    for row in sorted_rows:
        ps = row.get("period_start")
        out_rows.append(
            {
                "period_label": str(row.get("period_label") or ""),
                "period_start": ps.isoformat() if hasattr(ps, "isoformat") else str(ps or ""),
                "missing_spc_tickets": int(row.get("missing_spc_tickets") or 0),
                "summary_line_count": int(row.get("summary_line_count") or 0),
            }
        )
    out_rows.reverse()
    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "granularity": gran,
        "time_basis": "invoice_date",
        "rows": out_rows,
        "limit": lim,
    }


_SPC_TABLES = (
    "dwd_spc_transport_passenger",
    "dwd_spc_transport_freight",
    "dwd_spc_vehicle_sales",
    "dwd_spc_construction_service",
    "dwd_spc_estate_lease",
)

# 专项业务重复键：各表字段组合（logic_line_no>0 参与分组）
_SPC_BIZ_DUP_SPECS: tuple[tuple[str, str, str], ...] = (
    (
        "dwd_spc_transport_passenger",
        "客运",
        "COALESCE(CAST(trip_date AS VARCHAR), '') || '|' || COALESCE(TRIM(departure_place), '')"
        " || '|' || COALESCE(TRIM(arrival_place), '') || '|' || COALESCE(TRIM(passenger_name), '')",
    ),
    (
        "dwd_spc_transport_freight",
        "货运",
        "COALESCE(TRIM(departure_place), '') || '|' || COALESCE(TRIM(arrival_place), '')"
        " || '|' || COALESCE(TRIM(cargo_name), '') || '|' || COALESCE(TRIM(transport_means_plate_no), '')",
    ),
    (
        "dwd_spc_vehicle_sales",
        "机动车",
        "COALESCE(TRIM(vin_chassis), '') || '|' || COALESCE(TRIM(vehicle_plate_no), '')"
        " || '|' || COALESCE(TRIM(engine_no), '')",
    ),
    (
        "dwd_spc_construction_service",
        "建筑服务",
        "COALESCE(TRIM(construction_service_location), '') || '|' || COALESCE(TRIM(construction_project_name), '')"
        " || '|' || COALESCE(CAST(je AS VARCHAR), '')",
    ),
    (
        "dwd_spc_estate_lease",
        "不动产租赁",
        "COALESCE(TRIM(property_title_cert_no), '') || '|' || COALESCE(TRIM(license_plate_no), '')"
        " || '|' || COALESCE(CAST(je AS VARCHAR), '')",
    ),
)

_DQ_DETAIL_DOMAINS = frozenset(
    {
        "uniqueness",
        "tax_id",
        "header_detail",
        "cross_table",
        "semantic",
        "red_link",
        "lineage_reject",
        "dwd_lineage",
    }
)


def _lineage_source_missing_sql(alias: str = "") -> str:
    """审计含义：DWD 行级血缘不完整——无法定位源 Excel 或 Sheet，复核与导出溯源将失败。"""
    p = f"{alias}." if alias else ""
    return (
        f"trim(COALESCE({p}source_excel_file, '')) = ''"
        f" OR trim(COALESCE({p}source_sheet, '')) = ''"
    )


def _period_label_from_ts(ts: Any, granularity: str) -> tuple[str, Any]:
    """将导入/构建时间戳映射为周/月桶标签（与红票趋势 API 口径一致）。"""
    gran = str(granularity or "week").strip().lower()
    if gran == "month":
        if isinstance(ts, datetime):
            return ts.strftime("%Y-%m"), ts.date().replace(day=1)
        if isinstance(ts, date):
            return ts.strftime("%Y-%m"), ts.replace(day=1)
        return str(ts or ""), ts
    if isinstance(ts, datetime):
        iso = ts.isocalendar()
        label = f"{iso.year:04d}-W{iso.week:02d}"
        return label, ts.date()
    if isinstance(ts, date):
        iso = ts.isocalendar()
        label = f"{iso.year:04d}-W{iso.week:02d}"
        return label, ts
    return str(ts or ""), ts


def _ods_load_log_scope_where(
    *,
    batch_id: str | None,
    session_id: str | None,
) -> tuple[str, list[Any]]:
    """ods_load_log 批次/会话过滤（与 DWD scope 语义一致）。"""
    where: list[str] = []
    params: list[Any] = []
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    if bid:
        where.append("import_batch_id = ?")
        params.append(bid)
    if sid:
        where.append("import_session_id = ?")
        params.append(sid)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    return clause, params


def _parse_ods_import_file_logs(raw_detail_json: Any) -> list[dict[str, Any]]:
    """解析 ods_load_log.detail_json 为单文件导入日志列表。"""
    _, file_logs = _parse_ods_load_log_detail(raw_detail_json)
    return file_logs


def _parse_ods_load_log_detail(raw_detail_json: Any) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """解析 detail_json，返回 (field_mapping_template 元数据, 文件级日志列表)。"""
    try:
        detail = json.loads(str(raw_detail_json) if raw_detail_json is not None else "[]")
    except Exception:
        return None, []
    if isinstance(detail, list):
        out: list[dict[str, Any]] = []
        for item in detail:
            if isinstance(item, dict):
                out.append(item)
        return None, out
    if isinstance(detail, dict):
        tmpl_raw = detail.get("field_mapping_template")
        template_meta = tmpl_raw if isinstance(tmpl_raw, dict) else None
        files_raw = detail.get("file_logs")
        file_logs: list[dict[str, Any]] = []
        if isinstance(files_raw, list):
            for item in files_raw:
                if isinstance(item, dict):
                    file_logs.append(item)
        return template_meta, file_logs
    return None, []


def _fetch_ods_import_file_logs(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """
    从 ods_load_log.detail_json 汇总导入文件级日志（含拒收样本/范围）。
    表不存在或查询失败时返回空列表与可选错误码。
    """
    clause, params = _ods_load_log_scope_where(batch_id=batch_id, session_id=session_id)
    try:
        rows = conn.execute(
            f"""
            SELECT detail_json, import_batch_id, import_session_id
            FROM ods_load_log
            {clause}
            ORDER BY load_time DESC NULLS LAST
            """,
            params,
        ).fetchall()
    except Exception as exc:
        msg = str(exc).lower()
        if "ods_load_log" in msg and ("does not exist" in msg or "not exist" in msg):
            return [], "ods_load_log_missing"
        return [], type(exc).__name__

    file_logs: list[dict[str, Any]] = []
    template_meta: dict[str, Any] | None = None
    for raw_detail, row_batch, row_session in rows or []:
        batch = str(row_batch or "").strip()
        session = str(row_session or "").strip()
        row_template, items = _parse_ods_load_log_detail(raw_detail)
        if row_template and template_meta is None:
            template_meta = row_template
        for item in items:
            enriched = dict(item)
            if batch and not str(enriched.get("import_batch_id") or "").strip():
                enriched["import_batch_id"] = batch
            if session and not str(enriched.get("import_session_id") or "").strip():
                enriched["import_session_id"] = session
            file_logs.append(enriched)
    return file_logs, None


def _fetch_ods_import_template_meta(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any] | None:
    """从 ods_load_log.detail_json 读取导入所用字段映射模板元数据。"""
    clause, params = _ods_load_log_scope_where(batch_id=batch_id, session_id=session_id)
    try:
        rows = conn.execute(
            f"""
            SELECT detail_json
            FROM ods_load_log
            {clause}
            ORDER BY load_time DESC NULLS LAST
            LIMIT 1
            """,
            params,
        ).fetchall()
    except Exception:
        return None
    if not rows:
        return None
    template_meta, _ = _parse_ods_load_log_detail(rows[0][0])
    if not template_meta:
        return None
    tid = str(template_meta.get("template_id") or "").strip()
    if not tid:
        return None
    return {
        "template_id": tid,
        "template_name": str(template_meta.get("template_name") or "").strip(),
        "template_updated_at": str(template_meta.get("template_updated_at") or "").strip(),
    }


def _summarize_lineage_reject(file_logs: list[dict[str, Any]]) -> dict[str, int]:
    """聚合行级拒收与文件级阻断 KPI。"""
    row_reject_count = 0
    file_blocking_count = 0
    reject_sample_count = 0
    for log in file_logs:
        if bool(log.get("file_blocking")):
            file_blocking_count += 1
            continue
        dropped = log.get("rows_dropped_within_file")
        if dropped is not None:
            try:
                row_reject_count += max(0, int(dropped))
            except Exception:
                pass
        else:
            for rng in log.get("reject_row_ranges") or []:
                if not isinstance(rng, dict):
                    continue
                try:
                    start = int(rng.get("seq_no_start") or 0)
                    end = int(rng.get("seq_no_end") or start)
                    row_reject_count += max(0, end - start + 1)
                except Exception:
                    pass
        for sample in log.get("reject_row_samples") or []:
            if isinstance(sample, dict):
                reject_sample_count += 1
    return {
        "row_reject_count": row_reject_count,
        "file_blocking_count": file_blocking_count,
        "reject_sample_count": reject_sample_count,
        "import_file_count": len(file_logs),
    }


def _lineage_reject_detail_rows(
    file_logs: list[dict[str, Any]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    """将 ODS 导入拒收样本/文件阻断转为质量域明细行。"""
    lim = max(1, min(1000, int(limit or 200)))
    rows: list[dict[str, Any]] = []

    for log in file_logs:
        if len(rows) >= lim:
            break
        batch = str(log.get("import_batch_id") or "")
        session = str(log.get("import_session_id") or "")
        source_file = str(log.get("source_excel_file") or log.get("file_name") or "")
        file_name = str(log.get("file_name") or Path(source_file).name if source_file else "")

        if bool(log.get("file_blocking")):
            rows.append(
                {
                    "ticket_key": file_name or source_file or "—",
                    "header_uuid": "",
                    "domain": "lineage_reject",
                    "rule_id": "file_blocking",
                    "severity": "block",
                    "summary": str(log.get("reason") or "文件级阻断"),
                    "import_batch_id": batch,
                    "import_session_id": session,
                    "delta_value": None,
                    "extra": {
                        "source_excel_file": source_file,
                        "file_name": file_name,
                        "exception_type": str(log.get("exception_type") or ""),
                        "status": str(log.get("status") or ""),
                    },
                }
            )
            continue

        for sample in log.get("reject_row_samples") or []:
            if len(rows) >= lim:
                break
            if not isinstance(sample, dict):
                continue
            seq_no = sample.get("seq_no")
            sheet = str(sample.get("sheet") or "")
            field = str(sample.get("field") or "")
            reason = str(sample.get("reason") or "行级拒收")
            exc_type = str(sample.get("exception_type") or "")
            ticket = f"序号{seq_no}" if seq_no is not None else file_name or "—"
            rows.append(
                {
                    "ticket_key": ticket,
                    "header_uuid": "",
                    "domain": "lineage_reject",
                    "rule_id": "row_reject",
                    "severity": "warn",
                    "summary": reason,
                    "import_batch_id": batch,
                    "import_session_id": session,
                    "delta_value": float(seq_no) if seq_no is not None else None,
                    "extra": {
                        "source_excel_file": source_file,
                        "file_name": file_name,
                        "sheet": sheet,
                        "seq_no": seq_no,
                        "field": field,
                        "exception_type": exc_type,
                    },
                }
            )

        if len(rows) >= lim:
            break
        for rng in log.get("reject_row_ranges") or []:
            if len(rows) >= lim:
                break
            if not isinstance(rng, dict):
                continue
            try:
                start = int(rng.get("seq_no_start") or 0)
                end = int(rng.get("seq_no_end") or start)
            except Exception:
                continue
            reason = str(rng.get("reason") or "行级拒收")
            ticket = f"序号{start}" if start == end else f"序号{start}-{end}"
            rows.append(
                {
                    "ticket_key": ticket,
                    "header_uuid": "",
                    "domain": "lineage_reject",
                    "rule_id": "reject_row_range",
                    "severity": "warn",
                    "summary": reason,
                    "import_batch_id": batch,
                    "import_session_id": session,
                    "delta_value": float(end - start + 1),
                    "extra": {
                        "source_excel_file": source_file,
                        "file_name": file_name,
                        "seq_no_start": start,
                        "seq_no_end": end,
                    },
                }
            )
    return rows[:lim]


def _summarize_dwd_lineage(
    conn: Any,
    *,
    batch_id: str | None,
    session_id: str | None,
    scanned_headers: int,
) -> dict[str, Any]:
    """DWD 层血缘覆盖 KPI：缺源票头/明细、源文件种类、覆盖率。"""
    hdr_where, hdr_params = _scope_filters("h", batch_id=batch_id, session_id=session_id)
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
    dtl_where, dtl_params = _scope_filters("", batch_id=batch_id, session_id=session_id)
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""
    missing_hdr = 0
    missing_dtl = 0
    distinct_files = 0
    try:
        missing_hdr = int(
            conn.execute(
                f"""
                -- 审计含义：票头缺少 source_excel_file 或 source_sheet，无法回溯导入文件
                SELECT COUNT(*)::BIGINT
                FROM dwd_inv_header h
                WHERE 1=1{hdr_clause}
                  AND ({_lineage_source_missing_sql("h")})
                """,
                hdr_params,
            ).fetchone()[0]
            or 0
        )
    except Exception:
        pass
    try:
        missing_dtl = int(
            conn.execute(
                f"""
                -- 审计含义：明细行缺少源文件/sheet，logic_line_no 无法与 Excel 序号对位复核
                SELECT COUNT(*)::BIGINT
                FROM dwd_inv_detail d
                WHERE 1=1{dtl_clause}
                  AND ({_lineage_source_missing_sql("d")})
                """,
                dtl_params,
            ).fetchone()[0]
            or 0
        )
    except Exception:
        pass
    try:
        distinct_files = int(
            conn.execute(
                f"""
                SELECT COUNT(DISTINCT src)::BIGINT FROM (
                  SELECT trim(h.source_excel_file) AS src
                  FROM dwd_inv_header h
                  WHERE 1=1{hdr_clause}
                    AND trim(COALESCE(h.source_excel_file, '')) <> ''
                  UNION
                  SELECT trim(d.source_excel_file) AS src
                  FROM dwd_inv_detail d
                  WHERE 1=1{dtl_clause}
                    AND trim(COALESCE(d.source_excel_file, '')) <> ''
                ) u
                """,
                [*hdr_params, *dtl_params],
            ).fetchone()[0]
            or 0
        )
    except Exception:
        pass
    scanned = max(0, int(scanned_headers or 0))
    covered = max(0, scanned - missing_hdr)
    coverage_rate = round((covered / scanned) * 100.0, 1) if scanned > 0 else 100.0
    return {
        "missing_header_count": missing_hdr,
        "missing_detail_count": missing_dtl,
        "distinct_source_files": distinct_files,
        "coverage_rate": coverage_rate,
    }


def _dwd_lineage_row_from_sql(
    r: tuple[Any, ...],
    *,
    row_kind: str,
) -> dict[str, Any]:
    """将 DWD 血缘检索 SQL 行映射为 domain-details 统一结构。"""
    header_uuid = str(r[1] or "")
    detail_uuid = str(r[2] or "") if r[2] is not None else ""
    import_batch_id = str(r[3] or "")
    import_session_id = str(r[4] or "")
    logic_no_raw = r[5]
    logic_no = int(logic_no_raw or 0) if logic_no_raw is not None else None
    src = str(r[6] or "").strip()
    sheet = str(r[7] or "").strip()
    ods_file_seq = r[8]
    ticket_key = str(r[9] or "")
    rule_id = str(r[10] or "")
    severity = str(r[11] or "info")
    sdfphm = str(r[12] or "")
    fpdm = str(r[13] or "")
    fphm = str(r[14] or "")
    hwlwmc = str(r[15] or "") if len(r) > 15 else ""
    file_label = Path(src).name if src else "—"
    if rule_id == "missing_header_source":
        parts: list[str] = []
        if not src:
            parts.append("源 Excel 缺失")
        if not sheet:
            parts.append("Sheet 缺失")
        summary = "；".join(parts) or "票头血缘不完整"
    elif rule_id == "missing_detail_source":
        parts = []
        if not src:
            parts.append("源 Excel 缺失")
        if not sheet:
            parts.append("Sheet 缺失")
        ln = logic_no or 0
        summary = f"明细 logic_line_no={ln}：{'；'.join(parts) or '血缘不完整'}"
    elif row_kind == "header":
        summary = f"票头 · {file_label} / {sheet or '—'}"
    else:
        summary = f"{file_label} / {sheet or '—'} / 逻辑行 {logic_no or 0}"
    extra: dict[str, Any] = {
        "row_kind": row_kind,
        "source_excel_file": src,
        "source_sheet": sheet,
        "file_name": file_label,
        "ods_file_seq": ods_file_seq,
    }
    if row_kind == "header":
        extra.update({"sdfphm": sdfphm, "fpdm": fpdm, "fphm": fphm})
    else:
        extra.update(
            {
                "detail_uuid": detail_uuid,
                "logic_line_no": logic_no,
                "seq_no": logic_no,
                "hwlwmc": hwlwmc,
            }
        )
    return {
        "ticket_key": ticket_key,
        "header_uuid": header_uuid,
        "domain": "dwd_lineage",
        "rule_id": rule_id,
        "severity": severity if severity in {"block", "warn", "info"} else "info",
        "summary": summary,
        "import_batch_id": import_batch_id,
        "import_session_id": import_session_id,
        "delta_value": float(logic_no) if logic_no else None,
        "extra": extra,
    }


def _dwd_lineage_search_rows(
    conn: Any,
    *,
    batch_id: str | None,
    session_id: str | None,
    ticket_key: str | None = None,
    source_excel_file: str | None = None,
    source_sheet: str | None = None,
    row_kind: str = "all",
    only_missing: bool = False,
    offset: int = 0,
    limit: int = 200,
) -> tuple[list[dict[str, Any]], int]:
    """DWD 血缘全量检索：票头/明细 UNION，支持源文件/Sheet/票键筛选与分页。"""
    lim = max(1, min(1000, int(limit or 200)))
    off = max(0, int(offset or 0))
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    hdr_where, hdr_params = _scope_filters("h", batch_id=bid or None, session_id=sid or None)
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
    dtl_where, dtl_params = _scope_filters("d", batch_id=bid or None, session_id=sid or None)
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""
    tk = _sql_ticket_key("h")
    tk_d = _sql_ticket_key("h")
    kind = str(row_kind or "all").strip().lower()
    if kind not in {"header", "detail", "all"}:
        kind = "all"
    tk_q = str(ticket_key or "").strip()
    src_q = str(source_excel_file or "").strip()
    sheet_q = str(source_sheet or "").strip()

    filter_where: list[str] = []
    filter_params: list[Any] = []
    if only_missing:
        filter_where.append("is_missing = TRUE")
    if tk_q:
        like = f"%{tk_q}%"
        filter_where.append(
            "(ticket_key ILIKE ? OR header_uuid ILIKE ? OR sdfphm ILIKE ? OR fphm ILIKE ?)"
        )
        filter_params.extend([like, like, like, like])
    if src_q:
        filter_where.append("source_excel_file ILIKE ?")
        filter_params.append(f"%{src_q}%")
    if sheet_q:
        filter_where.append("source_sheet ILIKE ?")
        filter_params.append(f"%{sheet_q}%")
    filter_clause = (" AND " + " AND ".join(filter_where)) if filter_where else ""

    hdr_select = f"""
        SELECT
          'header' AS row_kind,
          h.header_uuid,
          CAST(NULL AS VARCHAR) AS detail_uuid,
          h.import_batch_id,
          h.import_session_id,
          CAST(NULL AS INTEGER) AS logic_line_no,
          h.source_excel_file,
          h.source_sheet,
          h.ods_file_seq,
          {tk} AS ticket_key,
          CASE WHEN ({_lineage_source_missing_sql("h")})
            THEN 'missing_header_source' ELSE 'lineage_trace' END AS rule_id,
          CASE WHEN ({_lineage_source_missing_sql("h")})
            THEN 'warn' ELSE 'info' END AS severity,
          h.sdfphm,
          h.fpdm,
          h.fphm,
          CAST(NULL AS VARCHAR) AS hwlwmc,
          ({_lineage_source_missing_sql("h")}) AS is_missing
        FROM dwd_inv_header h
        WHERE 1=1{hdr_clause}
    """
    dtl_select = f"""
        SELECT
          'detail' AS row_kind,
          d.header_uuid,
          d.detail_uuid,
          d.import_batch_id,
          d.import_session_id,
          d.logic_line_no,
          d.source_excel_file,
          d.source_sheet,
          d.ods_file_seq,
          {tk_d} AS ticket_key,
          CASE WHEN ({_lineage_source_missing_sql("d")})
            THEN 'missing_detail_source' ELSE 'lineage_trace' END AS rule_id,
          CASE WHEN ({_lineage_source_missing_sql("d")})
            THEN 'warn' ELSE 'info' END AS severity,
          h.sdfphm,
          h.fpdm,
          h.fphm,
          d.hwlwmc,
          ({_lineage_source_missing_sql("d")}) AS is_missing
        FROM dwd_inv_detail d
        LEFT JOIN dwd_inv_header h ON h.header_uuid = d.header_uuid
        WHERE 1=1{dtl_clause}
    """
    union_parts: list[str] = []
    union_params: list[Any] = []
    if kind in {"header", "all"}:
        union_parts.append(hdr_select)
        union_params.extend(hdr_params)
    if kind in {"detail", "all"}:
        union_parts.append(dtl_select)
        union_params.extend(dtl_params)
    if not union_parts:
        return [], 0

    combined_sql = " UNION ALL ".join(union_parts)
    count_sql = f"""
        -- 审计含义：统计符合筛选条件的 DWD 血缘行总数（票头+明细），供分页展示
        SELECT COUNT(*)::BIGINT FROM (
          {combined_sql}
        ) combined
        WHERE 1=1{filter_clause}
    """
    data_sql = f"""
        -- 审计含义：分页返回 DWD 血缘追溯行（源 Excel/Sheet/逻辑行号），缺源行 rule_id 标记为 missing_*
        SELECT * FROM (
          {combined_sql}
        ) combined
        WHERE 1=1{filter_clause}
        ORDER BY is_missing DESC, ticket_key, row_kind, COALESCE(logic_line_no, 0), header_uuid, detail_uuid
        LIMIT ? OFFSET ?
    """
    try:
        total = int(
            conn.execute(count_sql, [*union_params, *filter_params]).fetchone()[0] or 0
        )
        raw = conn.execute(
            data_sql, [*union_params, *filter_params, lim, off]
        ).fetchall() or []
    except Exception:
        return [], 0
    rows = [_dwd_lineage_row_from_sql(r, row_kind=str(r[0] or "")) for r in raw]
    return rows, total


def _dwd_lineage_detail_rows(
    conn: Any,
    *,
    batch_id: str | None,
    session_id: str | None,
    limit: int,
    ticket_key: str | None = None,
    source_excel_file: str | None = None,
    source_sheet: str | None = None,
    row_kind: str = "all",
    only_missing: bool = False,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """DWD 血缘明细（兼容旧调用；内部委托全量检索）。"""
    return _dwd_lineage_search_rows(
        conn,
        batch_id=batch_id,
        session_id=session_id,
        ticket_key=ticket_key,
        source_excel_file=source_excel_file,
        source_sheet=source_sheet,
        row_kind=row_kind,
        only_missing=only_missing,
        offset=offset,
        limit=limit,
    )


def _sql_ticket_key(alias: str = "h") -> str:
    p = f"{alias}." if alias else ""
    return f"""COALESCE(
      NULLIF(TRIM(COALESCE({p}sdfphm, '')), ''),
      NULLIF(TRIM(COALESCE({p}fpdm, '')) || TRIM(COALESCE({p}fphm, '')), ''),
      {p}header_uuid
    )"""


def _count_spc_business_dup_groups(
    conn: Any,
    *,
    batch_id: str | None,
    session_id: str | None,
) -> int:
    where, params = _scope_filters("", batch_id=batch_id, session_id=session_id)
    clause = (" AND " + " AND ".join(where)) if where else ""
    total = 0
    for tbl, _label, biz_expr in _SPC_BIZ_DUP_SPECS:
        try:
            row = conn.execute(
                f"""
                SELECT COUNT(*)::BIGINT FROM (
                  SELECT biz_key
                  FROM (
                    SELECT {biz_expr} AS biz_key
                    FROM {tbl}
                    WHERE logic_line_no > 0{clause}
                  ) raw
                  WHERE nullif(trim(biz_key), '') IS NOT NULL
                    AND biz_key <> '|||'
                  GROUP BY biz_key
                  HAVING COUNT(*) >= 2
                ) g
                """,
                params,
            ).fetchone()
            total += int((row[0] if row else 0) or 0)
        except Exception:
            pass
    return total


def _scope_filters(
    alias: str,
    *,
    batch_id: str | None,
    session_id: str | None,
    stat_year: int | None = None,
) -> tuple[list[str], list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    prefix = f"{alias}." if alias else ""
    if bid:
        where.append(f"{prefix}import_batch_id = ?")
        params.append(bid)
    if sid:
        where.append(f"{prefix}import_session_id = ?")
        params.append(sid)
    if stat_year is not None:
        where.append(f"{prefix}stat_year = ?")
        params.append(int(stat_year))
    return where, params


def load_quality_import_batches(conn: Any, *, limit: int = 80) -> dict[str, Any]:
    """从 dwd_inv_header 列出可选导入批次（供质量页 batch 下拉）。"""
    lim = max(1, min(200, int(limit or 80)))
    try:
        rows = conn.execute(
            f"""
            SELECT
              import_batch_id,
              COUNT(*)::BIGINT AS header_count,
              MAX(dwd_build_ts) AS last_build_time
            FROM dwd_inv_header
            WHERE nullif(trim(import_batch_id), '') IS NOT NULL
            GROUP BY import_batch_id
            ORDER BY last_build_time DESC NULLS LAST, import_batch_id DESC
            LIMIT ?
            """,
            [lim],
        ).fetchall()
    except Exception as exc:
        return {
            "ok": False,
            "batches": [],
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
    batches: list[dict[str, Any]] = []
    for r in rows:
        lt = r[2]
        batches.append(
            {
                "batch_id": str(r[0] or ""),
                "header_count": int(r[1] or 0),
                "last_build_time": lt.isoformat() if lt is not None and hasattr(lt, "isoformat") else str(lt or ""),
            }
        )
    return {"ok": True, "batches": batches}


def load_dq_domain_overview(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    stat_year: int | None = None,
) -> dict[str, Any]:
    """
    质量域概览：从 DWD 实时聚合（对齐 cleaner 的 dq_* 口径 subset）。
    专项业务重复键与语义覆盖亦由 DWD 实时 SQL 计算（无需 cleaner 落库）。
    """
    from src.etl.dwd_shared_logic_line import (
        sql_amount_dq_vs_inv_detail,
        sql_spc_inv_positive_linecount_mismatch,
    )

    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    hdr_where, hdr_params = _scope_filters(
        "h",
        batch_id=bid or None,
        session_id=sid or None,
        stat_year=stat_year,
    )
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""

    try:
        scanned = int(
            conn.execute(
                f"SELECT COUNT(*)::BIGINT FROM dwd_inv_header h WHERE 1=1{hdr_clause}",
                hdr_params,
            ).fetchone()[0]
            or 0
        )
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    dup_row = conn.execute(
        f"""
        WITH keyed AS (
          SELECT
            COALESCE(
              NULLIF(trim(COALESCE(h.sdfphm, '')), ''),
              NULLIF(trim(COALESCE(h.fpdm, '')) || trim(COALESCE(h.fphm, '')), ''),
              h.header_uuid
            ) AS ticket_key
          FROM dwd_inv_header h
          WHERE 1=1{hdr_clause}
        ),
        grp AS (
          SELECT ticket_key, COUNT(*)::BIGINT AS cnt
          FROM keyed
          GROUP BY ticket_key
          HAVING COUNT(*) >= 2
        )
        SELECT
          COUNT(*)::BIGINT AS dup_groups,
          COALESCE(SUM(cnt), 0)::BIGINT AS dup_tickets
        FROM grp
        """,
        hdr_params,
    ).fetchone()
    dup_groups = int((dup_row[0] if dup_row else 0) or 0)
    dup_tickets = int((dup_row[1] if dup_row else 0) or 0)

    tax_row = conn.execute(
        f"""
        SELECT
          SUM(
            CASE
              WHEN trim(COALESCE(h.gfsbh, '')) = '' OR trim(COALESCE(h.xfsbh, '')) = ''
              THEN 1 ELSE 0
            END
          )::BIGINT AS tax_empty,
          SUM(
            CASE
              WHEN (
                trim(COALESCE(h.gfsbh, '')) <> ''
                AND length(replace(trim(COALESCE(h.gfsbh, '')), ' ', '')) <> 18
              ) OR (
                trim(COALESCE(h.xfsbh, '')) <> ''
                AND length(replace(trim(COALESCE(h.xfsbh, '')), ' ', '')) <> 18
              )
              THEN 1 ELSE 0
            END
          )::BIGINT AS tax_bad_len
        FROM dwd_inv_header h
        WHERE 1=1{hdr_clause}
        """,
        hdr_params,
    ).fetchone()
    tax_empty = int((tax_row[0] if tax_row else 0) or 0)
    tax_bad_len = int((tax_row[1] if tax_row else 0) or 0)

    unbalanced = int(
        conn.execute(
            f"""
            SELECT COUNT(*)::BIGINT
            FROM dwd_inv_header h
            WHERE 1=1{hdr_clause}
              AND coalesce(h.is_balanced, '未校验') NOT IN ('平账', '差异可接受', '强制通过')
            """,
            hdr_params,
        ).fetchone()[0]
        or 0
    )

    dtl_where, dtl_params = _scope_filters(
        "",
        batch_id=bid or None,
        session_id=sid or None,
        stat_year=stat_year,
    )
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""
    dup_detail_groups = int(
        conn.execute(
            f"""
            SELECT COUNT(*)::BIGINT FROM (
              SELECT detail_uuid
              FROM dwd_inv_detail
              WHERE 1=1{dtl_clause}
              GROUP BY detail_uuid
              HAVING COUNT(*) > 1
            ) t
            """,
            dtl_params,
        ).fetchone()[0]
        or 0
    )

    linecount_mismatch_tickets = 0
    uuid_mismatch_rows = 0
    missing_spc_tickets: set[str] = set()
    mismatch_headers: set[str] = set()
    batch_pairs: list[tuple[int, str]] = []
    if bid:
        stat_years = [
            int(r[0])
            for r in conn.execute(
                """
                SELECT DISTINCT stat_year
                FROM dwd_inv_header
                WHERE import_batch_id = ? AND stat_year IS NOT NULL
                ORDER BY stat_year
                """,
                [bid],
            ).fetchall()
        ]
        batch_pairs = [(sy, bid) for sy in stat_years]
    else:
        batch_pairs = [
            (int(r[0]), str(r[1]))
            for r in conn.execute(
                """
                SELECT DISTINCT stat_year, import_batch_id
                FROM dwd_inv_header
                WHERE stat_year IS NOT NULL
                  AND nullif(trim(import_batch_id), '') IS NOT NULL
                ORDER BY stat_year, import_batch_id
                """
            ).fetchall()
        ]

    for sy, pair_bid in batch_pairs:
        dq_params = [sy, pair_bid, sy, pair_bid]
        for spc_tbl in _SPC_TABLES:
            try:
                sql_lc = sql_spc_inv_positive_linecount_mismatch(spc_tbl)
                for row in conn.execute(sql_lc, dq_params).fetchall() or []:
                    huid = str(row[0] or "")
                    mismatch_headers.add(huid)
                    inv_pos = int(row[2] or 0)
                    spc_pos = int(row[3] or 0)
                    if inv_pos > 0 and spc_pos == 0:
                        missing_spc_tickets.add(huid)
            except Exception:
                pass
            try:
                sql_amt = sql_amount_dq_vs_inv_detail(spc_tbl)
                cnt = conn.execute(
                    f"SELECT COUNT(*)::BIGINT FROM ({sql_amt}) t",
                    [sy, pair_bid],
                ).fetchone()
                uuid_mismatch_rows += int((cnt[0] if cnt else 0) or 0)
            except Exception:
                pass
    linecount_mismatch_tickets = len(mismatch_headers)

    summary_line_count = 0
    try:
        summary_line_count = int(
            conn.execute(
                f"""
                SELECT COUNT(*)::BIGINT
                FROM dwd_inv_detail
                WHERE logic_line_no = 0{dtl_clause}
                """,
                dtl_params,
            ).fetchone()[0]
            or 0
        )
    except Exception:
        pass

    max_balance_delta: float | None = None
    try:
        max_row = conn.execute(
            f"""
            SELECT MAX(ABS(COALESCE(h.balance_diff, 0)))
            FROM dwd_inv_header h
            WHERE 1=1{hdr_clause}
              AND coalesce(h.is_balanced, '未校验') NOT IN ('平账', '差异可接受', '强制通过')
            """,
            hdr_params,
        ).fetchone()
        if max_row and max_row[0] is not None:
            max_balance_delta = float(max_row[0])
    except Exception:
        pass

    spc_groups = _count_spc_business_dup_groups(conn, batch_id=bid or None, session_id=sid or None)

    red_ov = load_red_invoice_quality_overview(conn, batch_id=bid or None, session_id=sid or None)
    orphan_red = int(red_ov.get("orphan_red_count") or 0)
    unmatched_blue = int(red_ov.get("unmatched_blue_count") or 0)

    file_logs, _ods_err = _fetch_ods_import_file_logs(conn, batch_id=bid or None, session_id=sid or None)
    import_template_meta = _fetch_ods_import_template_meta(conn, batch_id=bid or None, session_id=sid or None)
    lineage_kpi = _summarize_lineage_reject(file_logs)
    dwd_lineage_kpi = _summarize_dwd_lineage(
        conn,
        batch_id=bid or None,
        session_id=sid or None,
        scanned_headers=scanned,
    )

    warn_count = (
        tax_empty
        + linecount_mismatch_tickets
        + unmatched_blue
        + dup_groups
        + int(lineage_kpi.get("row_reject_count") or 0)
        + int(dwd_lineage_kpi.get("missing_header_count") or 0)
        + int(dwd_lineage_kpi.get("missing_detail_count") or 0)
    )
    block_count = orphan_red + unbalanced + int(lineage_kpi.get("file_blocking_count") or 0)
    info_count = tax_bad_len
    anomaly_headers = warn_count + block_count + info_count

    gaps: list[str] = []
    if _ods_err == "ods_load_log_missing":
        gaps.append("lineage_reject_requires_ods_load_log")

    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "import_field_mapping_template": import_template_meta,
        "kpi": {
            "scanned_headers": scanned,
            "anomaly_headers": anomaly_headers,
            "block_count": block_count,
            "warn_count": warn_count,
            "info_count": info_count,
        },
        "domains": {
            "uniqueness": {
                "dup_groups": dup_groups,
                "dup_tickets": dup_tickets,
            },
            "tax_id": {
                "empty_count": tax_empty,
                "bad_len_count": tax_bad_len,
            },
            "cross_table": {
                "linecount_mismatch_tickets": linecount_mismatch_tickets,
                "uuid_mismatch_rows": uuid_mismatch_rows,
            },
            "header_detail": {
                "unbalanced_count": unbalanced,
                "max_balance_delta": max_balance_delta,
            },
            "semantic": {
                "missing_spc_tickets": len(missing_spc_tickets),
                "summary_line_count": summary_line_count,
            },
            "red_link": {
                "unmatched_blue_count": unmatched_blue,
                "orphan_red_count": orphan_red,
                "matched_blue_count": int(red_ov.get("matched_blue_count") or 0),
                "red_invoice_count": int(red_ov.get("red_invoice_count") or 0),
            },
            "lineage_reject": {
                "row_reject_count": int(lineage_kpi.get("row_reject_count") or 0),
                "file_blocking_count": int(lineage_kpi.get("file_blocking_count") or 0),
                "reject_sample_count": int(lineage_kpi.get("reject_sample_count") or 0),
                "import_file_count": int(lineage_kpi.get("import_file_count") or 0),
            },
            "dwd_lineage": {
                "missing_header_count": int(dwd_lineage_kpi.get("missing_header_count") or 0),
                "missing_detail_count": int(dwd_lineage_kpi.get("missing_detail_count") or 0),
                "distinct_source_files": int(dwd_lineage_kpi.get("distinct_source_files") or 0),
                "coverage_rate": float(dwd_lineage_kpi.get("coverage_rate") or 0.0),
            },
        },
        "dup_counts": {
            "header_groups": dup_groups,
            "detail_groups": dup_detail_groups,
            "spc_groups": spc_groups,
        },
        "gaps": gaps,
    }


def export_data_quality_domain_summary_csv_bytes(
    conn: Any,
    *,
    stat_year: int | None = None,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> tuple[bytes, int]:
    """导出质量域汇总 CSV（UTF-8 BOM），返回 (bytes, metric_row_count)。"""
    import csv
    import io

    overview: dict[str, Any]
    try:
        overview = load_dq_domain_overview(
            conn,
            batch_id=batch_id,
            session_id=session_id,
            stat_year=stat_year,
        )
    except Exception:
        overview = {"ok": False}
    if not overview.get("ok"):
        try:
            hdr_where, hdr_params = _scope_filters("h", batch_id=batch_id, session_id=session_id, stat_year=stat_year)
            hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
            scanned = int(
                conn.execute(
                    f"SELECT COUNT(*)::BIGINT FROM dwd_inv_header h WHERE 1=1{hdr_clause}",
                    hdr_params,
                ).fetchone()[0]
                or 0
            )
            overview = {
                "ok": True,
                "kpi": {
                    "scanned_headers": scanned,
                    "anomaly_headers": 0,
                    "block_count": 0,
                    "warn_count": 0,
                    "info_count": 0,
                },
                "domains": {},
                "dup_counts": {},
            }
        except Exception:
            return b"", 0

    kpi = overview.get("kpi") or {}
    domains = overview.get("domains") or {}
    dup = overview.get("dup_counts") or {}
    year_tag = str(stat_year) if stat_year is not None else "全部"

    rows: list[tuple[str, str, str, str, str]] = [
        ("汇总", "已扫描票头", str(kpi.get("scanned_headers") or 0), "", year_tag),
        ("汇总", "异常票头", str(kpi.get("anomaly_headers") or 0), "", year_tag),
        ("汇总", "阻塞级", str(kpi.get("block_count") or 0), "阻塞", year_tag),
        ("汇总", "警告级", str(kpi.get("warn_count") or 0), "警告", year_tag),
        ("汇总", "提示级", str(kpi.get("info_count") or 0), "提示", year_tag),
    ]

    def _add(domain: str, metric: str, value: Any, severity: str = "") -> None:
        rows.append((domain, metric, str(value), severity, year_tag))

    uniq = domains.get("uniqueness") or {}
    _add("身份与键·唯一性", "重复票头组", uniq.get("dup_groups") or 0, "警告")
    _add("身份与键·唯一性", "涉及票数", uniq.get("dup_tickets") or 0, "警告")

    tax = domains.get("tax_id") or {}
    _add("购销方识别号", "识别号为空（票）", tax.get("empty_count") or 0, "警告")
    _add("购销方识别号", "识别号非18位（票）", tax.get("bad_len_count") or 0, "提示")

    cross = domains.get("cross_table") or {}
    _add("跨表对齐", "行数不一致票", cross.get("linecount_mismatch_tickets") or 0, "警告")
    _add("跨表对齐", "UUID对账异常行", cross.get("uuid_mismatch_rows") or 0, "提示")

    hdr = domains.get("header_detail") or {}
    _add("头明对账", "不平账票", hdr.get("unbalanced_count") or 0, "阻塞")
    if hdr.get("max_balance_delta") is not None:
        _add("头明对账", "最大差额", hdr.get("max_balance_delta"), "")

    sem = domains.get("semantic") or {}
    _add("语义与专项", "疑似缺专项票", sem.get("missing_spc_tickets") or 0, "警告")
    _add("语义与专项", "汇总行命中", sem.get("summary_line_count") or 0, "提示")

    red = domains.get("red_link") or {}
    _add("红蓝关联", "未匹配蓝票", red.get("unmatched_blue_count") or 0, "警告")
    _add("红蓝关联", "孤立红票", red.get("orphan_red_count") or 0, "阻塞")

    lin = domains.get("lineage_reject") or {}
    _add("导入拒收", "行级拒收", lin.get("row_reject_count") or 0, "警告")
    _add("导入拒收", "文件级阻断", lin.get("file_blocking_count") or 0, "阻塞")

    dwd_lin = domains.get("dwd_lineage") or {}
    _add("DWD血缘", "缺源票头", dwd_lin.get("missing_header_count") or 0, "警告")
    _add("DWD血缘", "缺源明细", dwd_lin.get("missing_detail_count") or 0, "警告")
    _add("DWD血缘", "血缘覆盖率", f"{float(dwd_lin.get('coverage_rate') or 0):.2f}%", "")

    _add("重复对象", "主表重复组", dup.get("header_groups") or 0, "警告")
    _add("重复对象", "明细重复组", dup.get("detail_groups") or 0, "警告")
    if dup.get("spc_groups") is not None:
        _add("重复对象", "专项重复组", dup.get("spc_groups") or 0, "警告")

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["质量域", "指标", "数值", "严重度", "范围"])
    for row in rows:
        writer.writerow(row)
    data = ("\ufeff" + buf.getvalue()).encode("utf-8")
    return data, len(rows)


def load_dwd_lineage_quality_trend(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
    granularity: str = "week",
    limit: int = 12,
) -> dict[str, Any]:
    """按 dwd_build_ts 聚合 DWD 血缘覆盖率趋势（缺源票头/明细计数 + 覆盖率）。

    时间桶取自 dwd_inv_header.dwd_build_ts（ETL 写入 DWD 的时间）；明细缺源按关联票头的
    dwd_build_ts 归入同一桶。若 dwd_build_ts 为空则跳过该行（局限：无构建时间则无法入趋势）。
    """
    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    gran = str(granularity or "week").strip().lower()
    if gran == "month":
        period_expr = "strftime(h.dwd_build_ts, '%Y-%m')"
    else:
        gran = "week"
        period_expr = "strftime(h.dwd_build_ts, '%G-W%V')"
    lim = max(1, min(52, int(limit or 12)))
    hdr_where, hdr_params = _scope_filters("h", batch_id=bid or None, session_id=sid or None)
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
    dtl_where, dtl_params = _scope_filters("d", batch_id=bid or None, session_id=sid or None)
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""

    try:
        hdr_rows = conn.execute(
            f"""
            -- 审计含义：按 DWD 构建时间分桶统计票头总量与缺源票头（覆盖率分子分母）
            WITH base AS (
              SELECT
                {period_expr} AS period_label,
                h.dwd_build_ts AS period_ts,
                ({_lineage_source_missing_sql("h")}) AS is_missing
              FROM dwd_inv_header h
              WHERE h.dwd_build_ts IS NOT NULL{hdr_clause}
            )
            SELECT
              period_label,
              MIN(period_ts) AS period_start,
              COUNT(*)::BIGINT AS header_count,
              SUM(CASE WHEN is_missing THEN 1 ELSE 0 END)::BIGINT AS missing_header_count
            FROM base
            GROUP BY period_label
            ORDER BY period_start DESC
            LIMIT ?
            """,
            [*hdr_params, lim],
        ).fetchall() or []
    except Exception as exc:
        msg = str(exc).lower()
        if "dwd_build_ts" in msg and ("does not exist" in msg or "not exist" in msg):
            return {
                "ok": False,
                "error": {
                    "message": "dwd_inv_header 缺少 dwd_build_ts 列，无法绘制血缘趋势",
                    "code": "dwd_build_ts_missing",
                },
            }
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    dtl_missing_by_period: dict[str, int] = {}
    dtl_period_expr = period_expr.replace("h.", "h2.")
    try:
        dtl_rows = conn.execute(
            f"""
            -- 审计含义：明细缺源按票头 dwd_build_ts 分桶，与票头趋势时间轴对齐
            SELECT
              {dtl_period_expr} AS period_label,
              COUNT(*)::BIGINT AS missing_detail_count
            FROM dwd_inv_detail d
            INNER JOIN dwd_inv_header h2 ON h2.header_uuid = d.header_uuid
            WHERE h2.dwd_build_ts IS NOT NULL
              AND ({_lineage_source_missing_sql("d")}){dtl_clause}
            GROUP BY period_label
            """,
            dtl_params,
        ).fetchall() or []
        for r in dtl_rows:
            dtl_missing_by_period[str(r[0] or "")] = int(r[1] or 0)
    except Exception:
        pass

    out_rows: list[dict[str, Any]] = []
    for r in hdr_rows:
        label = str(r[0] or "")
        hdr_cnt = int(r[2] or 0)
        miss_hdr = int(r[3] or 0)
        covered = max(0, hdr_cnt - miss_hdr)
        coverage_rate = round((covered / hdr_cnt) * 100.0, 1) if hdr_cnt > 0 else 100.0
        out_rows.append(
            {
                "period_label": label,
                "period_start": str(r[1]) if r[1] is not None else None,
                "header_count": hdr_cnt,
                "missing_header_count": miss_hdr,
                "missing_detail_count": int(dtl_missing_by_period.get(label, 0)),
                "coverage_rate": coverage_rate,
            }
        )
    out_rows.reverse()
    return {
        "ok": True,
        "batch_id": bid or None,
        "session_id": sid or None,
        "granularity": gran,
        "time_basis": "dwd_build_ts",
        "rows": out_rows,
        "limit": lim,
    }


def load_structured_dq_domain_trend(
    conn: Any,
    *,
    domain: str,
    batch_id: str | None = None,
    session_id: str | None = None,
    granularity: str = "week",
    limit: int = 12,
) -> dict[str, Any]:
    """按 invoice_date 聚合 uniqueness / tax_id / cross_table / header_detail 质量趋势。"""
    dom = str(domain or "").strip().lower()
    allowed = {"uniqueness", "tax_id", "cross_table", "header_detail"}
    if dom not in allowed:
        return {
            "ok": False,
            "error": {"message": f"不支持的质量域趋势：{domain}", "supported": sorted(allowed)},
        }

    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    gran = str(granularity or "week").strip().lower()
    if gran == "month":
        period_expr = "strftime(h.invoice_date, '%Y-%m')"
    else:
        gran = "week"
        period_expr = "strftime(h.invoice_date, '%G-W%V')"
    lim = max(1, min(52, int(limit or 12)))
    hdr_where, hdr_params = _scope_filters("h", batch_id=bid or None, session_id=sid or None)
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
    tk = _sql_ticket_key("h")

    if dom == "uniqueness":
        sql = f"""
        WITH keyed AS (
          SELECT
            {period_expr} AS period_label,
            h.invoice_date,
            {tk} AS ticket_key
          FROM dwd_inv_header h
          WHERE h.invoice_date IS NOT NULL{hdr_clause}
        ),
        dup AS (
          SELECT period_label, MIN(invoice_date) AS period_start, ticket_key, COUNT(*)::BIGINT AS cnt
          FROM keyed
          GROUP BY period_label, ticket_key
        )
        SELECT period_label, MIN(period_start) AS period_start,
               SUM(CASE WHEN cnt >= 2 THEN 1 ELSE 0 END)::BIGINT AS anomaly_count,
               COUNT(*)::BIGINT AS ticket_count
        FROM dup
        GROUP BY period_label
        ORDER BY period_start DESC
        LIMIT ?
        """
    elif dom == "tax_id":
        sql = f"""
        SELECT
          {period_expr} AS period_label,
          MIN(h.invoice_date) AS period_start,
          COUNT(*)::BIGINT AS anomaly_count,
          COUNT(*)::BIGINT AS header_count
        FROM dwd_inv_header h
        WHERE h.invoice_date IS NOT NULL{hdr_clause}
          AND (
            trim(COALESCE(h.gfsbh, '')) = '' OR trim(COALESCE(h.xfsbh, '')) = ''
            OR (
              trim(COALESCE(h.gfsbh, '')) <> ''
              AND length(replace(trim(COALESCE(h.gfsbh, '')), ' ', '')) <> 18
            )
            OR (
              trim(COALESCE(h.xfsbh, '')) <> ''
              AND length(replace(trim(COALESCE(h.xfsbh, '')), ' ', '')) <> 18
            )
          )
        GROUP BY period_label
        ORDER BY period_start DESC
        LIMIT ?
        """
    elif dom == "header_detail":
        sql = f"""
        SELECT
          {period_expr} AS period_label,
          MIN(h.invoice_date) AS period_start,
          COUNT(*)::BIGINT AS anomaly_count,
          COUNT(*)::BIGINT AS header_count
        FROM dwd_inv_header h
        WHERE h.invoice_date IS NOT NULL{hdr_clause}
          AND coalesce(h.is_balanced, '未校验') NOT IN ('平账', '差异可接受', '强制通过')
        GROUP BY period_label
        ORDER BY period_start DESC
        LIMIT ?
        """
    else:
        from src.etl.dwd_shared_logic_line import sql_spc_inv_positive_linecount_mismatch

        mismatch_sql = sql_spc_inv_positive_linecount_mismatch()
        sql = f"""
        SELECT
          {period_expr} AS period_label,
          MIN(h.invoice_date) AS period_start,
          COUNT(*)::BIGINT AS anomaly_count,
          COUNT(*)::BIGINT AS header_count
        FROM dwd_inv_header h
        WHERE h.invoice_date IS NOT NULL{hdr_clause}
          AND ({mismatch_sql})
        GROUP BY period_label
        ORDER BY period_start DESC
        LIMIT ?
        """

    try:
        rows = conn.execute(sql, [*hdr_params, lim]).fetchall() or []
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    out_rows: list[dict[str, Any]] = []
    for r in rows:
        anomaly = int(r[2] or 0)
        total = int(r[3] or 0) if len(r) > 3 else anomaly
        out_rows.append(
            {
                "period_label": str(r[0] or ""),
                "period_start": str(r[1]) if r[1] is not None else None,
                "anomaly_count": anomaly,
                "header_count": total,
                "block_count": anomaly if dom == "header_detail" else 0,
            }
        )
    out_rows.reverse()
    return {
        "ok": True,
        "domain": dom,
        "batch_id": bid or None,
        "session_id": sid or None,
        "granularity": gran,
        "rows": out_rows,
        "limit": lim,
    }


def load_dq_domain_details(
    conn: Any,
    *,
    domain: str,
    batch_id: str | None = None,
    session_id: str | None = None,
    only_unmatched: bool = True,
    limit: int = 200,
    offset: int = 0,
    ticket_key: str | None = None,
    source_excel_file: str | None = None,
    source_sheet: str | None = None,
    row_kind: str = "all",
    only_missing: bool = False,
    rule_id: str | None = None,
) -> dict[str, Any]:
    """按质量域返回异常明细行（DWD 实时查询，与 domain-overview 口径一致）。"""
    from src.etl.dwd_shared_logic_line import sql_spc_inv_positive_linecount_mismatch

    dom = str(domain or "").strip().lower()
    if dom not in _DQ_DETAIL_DOMAINS:
        return {
            "ok": False,
            "error": {
                "message": f"不支持的质量域：{domain}",
                "supported": sorted(_DQ_DETAIL_DOMAINS),
            },
        }

    if dom == "red_link":
        payload = load_red_invoice_quality_details(
            conn,
            batch_id=batch_id,
            session_id=session_id,
            only_unmatched=only_unmatched,
            limit=limit,
        )
        if not payload.get("ok"):
            return payload
        rows: list[dict[str, Any]] = []
        for r in payload.get("rows") or []:
            ticket = str(r.get("sdfphm") or "").strip() or (
                f"{r.get('fpdm', '')}-{r.get('fphm', '')}".strip("-")
            )
            is_orphan = bool(r.get("is_orphan_red"))
            rows.append(
                {
                    "ticket_key": ticket,
                    "header_uuid": str(r.get("header_uuid") or ""),
                    "domain": "red_link",
                    "rule_id": "red_blue_link_unmatched",
                    "severity": "block" if is_orphan else "warn",
                    "summary": str(r.get("quality_reason") or ""),
                    "import_batch_id": str(r.get("import_batch_id") or ""),
                    "import_session_id": str(r.get("import_session_id") or ""),
                    "delta_value": float(r.get("jshj") or 0) if r.get("jshj") is not None else None,
                    "extra": {"bz": str(r.get("bz") or ""), "is_orphan_red": is_orphan},
                }
            )
        return {
            "ok": True,
            "domain": dom,
            "batch_id": payload.get("batch_id"),
            "session_id": payload.get("session_id"),
            "rows": rows,
            "limit": payload.get("limit"),
        }

    if dom == "lineage_reject":
        bid = str(batch_id or "").strip()
        sid = str(session_id or "").strip()
        lim = max(1, min(1000, int(limit or 200)))
        file_logs, ods_err = _fetch_ods_import_file_logs(conn, batch_id=bid or None, session_id=sid or None)
        if ods_err == "ods_load_log_missing":
            return {
                "ok": False,
                "error": {
                    "message": "ods_load_log 表不存在，无法读取导入拒收样本",
                    "code": ods_err,
                },
            }
        rows = _lineage_reject_detail_rows(file_logs, limit=lim)
        return {
            "ok": True,
            "domain": dom,
            "batch_id": bid or None,
            "session_id": sid or None,
            "rows": rows,
            "limit": lim,
        }

    if dom == "dwd_lineage":
        bid = str(batch_id or "").strip()
        sid = str(session_id or "").strip()
        lim = max(1, min(1000, int(limit or 200)))
        off = max(0, int(offset or 0))
        rows, total = _dwd_lineage_detail_rows(
            conn,
            batch_id=bid or None,
            session_id=sid or None,
            limit=lim,
            offset=off,
            ticket_key=ticket_key,
            source_excel_file=source_excel_file,
            source_sheet=source_sheet,
            row_kind=row_kind,
            only_missing=only_missing,
        )
        return {
            "ok": True,
            "domain": dom,
            "batch_id": bid or None,
            "session_id": sid or None,
            "rows": rows,
            "limit": lim,
            "offset": off,
            "total_count": total,
        }

    if dom == "semantic":
        bid = str(batch_id or "").strip()
        sid = str(session_id or "").strip()
        lim = max(1, min(1000, int(limit or 200)))
        off = max(0, int(offset or 0))
        rows, total = _semantic_detail_rows(
            conn,
            batch_id=bid or None,
            session_id=sid or None,
            rule_id=rule_id,
            ticket_key=ticket_key,
            limit=lim,
            offset=off,
        )
        return {
            "ok": True,
            "domain": dom,
            "batch_id": bid or None,
            "session_id": sid or None,
            "rows": rows,
            "limit": lim,
            "offset": off,
            "total_count": total,
        }

    bid = str(batch_id or "").strip()
    sid = str(session_id or "").strip()
    hdr_where, hdr_params = _scope_filters("h", batch_id=bid or None, session_id=sid or None)
    hdr_clause = (" AND " + " AND ".join(hdr_where)) if hdr_where else ""
    dtl_where, dtl_params = _scope_filters("", batch_id=bid or None, session_id=sid or None)
    dtl_clause = (" AND " + " AND ".join(dtl_where)) if dtl_where else ""
    lim = max(1, min(1000, int(limit or 200)))
    tk = _sql_ticket_key("h")

    try:
        if dom == "uniqueness":
            raw = conn.execute(
                f"""
                WITH keyed AS (
                  SELECT
                    h.header_uuid,
                    h.import_batch_id,
                    h.import_session_id,
                    h.sdfphm,
                    h.fpdm,
                    h.fphm,
                    {tk} AS ticket_key,
                    COUNT(*) OVER (PARTITION BY {tk}) AS dup_cnt
                  FROM dwd_inv_header h
                  WHERE 1=1{hdr_clause}
                )
                SELECT header_uuid, import_batch_id, import_session_id, sdfphm, fpdm, fphm, ticket_key, dup_cnt
                FROM keyed
                WHERE dup_cnt >= 2
                ORDER BY ticket_key, header_uuid
                LIMIT ?
                """,
                [*hdr_params, lim],
            ).fetchall()
            rows = [
                {
                    "ticket_key": str(r[6] or ""),
                    "header_uuid": str(r[0] or ""),
                    "domain": dom,
                    "rule_id": "header_ticket_key_dup",
                    "severity": "warn",
                    "summary": f"票键重复组内 {int(r[7] or 0)} 条头记录",
                    "import_batch_id": str(r[1] or ""),
                    "import_session_id": str(r[2] or ""),
                    "delta_value": float(int(r[7] or 0)),
                    "extra": {
                        "sdfphm": str(r[3] or ""),
                        "fpdm": str(r[4] or ""),
                        "fphm": str(r[5] or ""),
                    },
                }
                for r in raw
            ]
        elif dom == "tax_id":
            raw = conn.execute(
                f"""
                SELECT
                  h.header_uuid,
                  h.import_batch_id,
                  h.import_session_id,
                  h.sdfphm,
                  h.fpdm,
                  h.fphm,
                  {tk} AS ticket_key,
                  h.gfsbh,
                  h.xfsbh,
                  CASE
                    WHEN trim(COALESCE(h.gfsbh, '')) = '' OR trim(COALESCE(h.xfsbh, '')) = '' THEN 'empty'
                    WHEN (
                      trim(COALESCE(h.gfsbh, '')) <> ''
                      AND length(replace(trim(COALESCE(h.gfsbh, '')), ' ', '')) <> 18
                    ) OR (
                      trim(COALESCE(h.xfsbh, '')) <> ''
                      AND length(replace(trim(COALESCE(h.xfsbh, '')), ' ', '')) <> 18
                    ) THEN 'bad_len'
                    ELSE 'ok'
                  END AS tax_issue
                FROM dwd_inv_header h
                WHERE 1=1{hdr_clause}
                  AND (
                    trim(COALESCE(h.gfsbh, '')) = '' OR trim(COALESCE(h.xfsbh, '')) = ''
                    OR (
                      trim(COALESCE(h.gfsbh, '')) <> ''
                      AND length(replace(trim(COALESCE(h.gfsbh, '')), ' ', '')) <> 18
                    )
                    OR (
                      trim(COALESCE(h.xfsbh, '')) <> ''
                      AND length(replace(trim(COALESCE(h.xfsbh, '')), ' ', '')) <> 18
                    )
                  )
                ORDER BY tax_issue DESC, ticket_key
                LIMIT ?
                """,
                [*hdr_params, lim],
            ).fetchall()
            rows = []
            for r in raw:
                issue = str(r[9] or "")
                gfs = str(r[7] or "").strip()
                xfs = str(r[8] or "").strip()
                if issue == "empty":
                    parts = []
                    if not gfs:
                        parts.append("购方识别号空")
                    if not xfs:
                        parts.append("销方识别号空")
                    summary = "；".join(parts) or "识别号为空"
                    severity = "warn"
                else:
                    parts = []
                    if gfs and len(gfs.replace(" ", "")) != 18:
                        parts.append(f"购方 {len(gfs.replace(' ', ''))} 位")
                    if xfs and len(xfs.replace(" ", "")) != 18:
                        parts.append(f"销方 {len(xfs.replace(' ', ''))} 位")
                    summary = "识别号长度≠18：" + "；".join(parts)
                    severity = "info"
                rows.append(
                    {
                        "ticket_key": str(r[6] or ""),
                        "header_uuid": str(r[0] or ""),
                        "domain": dom,
                        "rule_id": f"tax_id_{issue}",
                        "severity": severity,
                        "summary": summary,
                        "import_batch_id": str(r[1] or ""),
                        "import_session_id": str(r[2] or ""),
                        "delta_value": None,
                        "extra": {"gfsbh": gfs, "xfsbh": xfs},
                    }
                )
        elif dom == "header_detail":
            raw = conn.execute(
                f"""
                SELECT
                  h.header_uuid,
                  h.import_batch_id,
                  h.import_session_id,
                  h.sdfphm,
                  h.fpdm,
                  h.fphm,
                  {tk} AS ticket_key,
                  h.jshj,
                  h.detail_total_amount,
                  h.balance_diff,
                  h.is_balanced
                FROM dwd_inv_header h
                WHERE 1=1{hdr_clause}
                  AND coalesce(h.is_balanced, '未校验') NOT IN ('平账', '差异可接受', '强制通过')
                ORDER BY ABS(COALESCE(h.balance_diff, 0)) DESC NULLS LAST
                LIMIT ?
                """,
                [*hdr_params, lim],
            ).fetchall()
            rows = [
                {
                    "ticket_key": str(r[6] or ""),
                    "header_uuid": str(r[0] or ""),
                    "domain": dom,
                    "rule_id": "header_detail_unbalanced",
                    "severity": "block",
                    "summary": (
                        f"头表 jshj={r[7]}，明细汇总={r[8]}，差额={r[9]}（{r[10]}）"
                    ),
                    "import_batch_id": str(r[1] or ""),
                    "import_session_id": str(r[2] or ""),
                    "delta_value": float(r[9] or 0) if r[9] is not None else None,
                    "extra": {
                        "jshj": r[7],
                        "detail_total_amount": r[8],
                        "is_balanced": str(r[10] or ""),
                    },
                }
                for r in raw
            ]
        elif dom == "cross_table":
            batch_pairs: list[tuple[int, str]] = []
            if bid:
                stat_years = [
                    int(r[0])
                    for r in conn.execute(
                        """
                        SELECT DISTINCT stat_year
                        FROM dwd_inv_header
                        WHERE import_batch_id = ? AND stat_year IS NOT NULL
                        ORDER BY stat_year
                        """,
                        [bid],
                    ).fetchall()
                ]
                batch_pairs = [(sy, bid) for sy in stat_years]
            else:
                batch_pairs = [
                    (int(r[0]), str(r[1]))
                    for r in conn.execute(
                        """
                        SELECT DISTINCT stat_year, import_batch_id
                        FROM dwd_inv_header
                        WHERE stat_year IS NOT NULL
                          AND nullif(trim(import_batch_id), '') IS NOT NULL
                        ORDER BY stat_year, import_batch_id
                        """
                    ).fetchall()
                ]
            seen: set[tuple[str, str]] = set()
            rows = []
            for sy, pair_bid in batch_pairs:
                dq_params = [sy, pair_bid, sy, pair_bid]
                for spc_tbl in _SPC_TABLES:
                    spc_label = next(
                        (lbl for tbl, lbl, _ in _SPC_BIZ_DUP_SPECS if tbl == spc_tbl),
                        spc_tbl,
                    )
                    try:
                        sql_lc = sql_spc_inv_positive_linecount_mismatch(spc_tbl)
                        for row in conn.execute(sql_lc, dq_params).fetchall() or []:
                            key = (str(row[0] or ""), str(row[1] or ""))
                            if key in seen:
                                continue
                            seen.add(key)
                            inv_pos = int(row[2] or 0)
                            spc_pos = int(row[3] or 0)
                            hrow = conn.execute(
                                f"""
                                SELECT import_batch_id, import_session_id, sdfphm, fpdm, fphm, {tk}
                                FROM dwd_inv_header h
                                WHERE h.header_uuid = ?
                                LIMIT 1
                                """,
                                [key[0]],
                            ).fetchone()
                            ticket = str(hrow[5] or key[0]) if hrow else key[0]
                            rows.append(
                                {
                                    "ticket_key": ticket,
                                    "header_uuid": key[0],
                                    "domain": dom,
                                    "rule_id": f"spc_linecount_mismatch_{spc_tbl}",
                                    "severity": "warn",
                                    "summary": (
                                        f"{spc_label}：明细正行 {inv_pos} vs 专项正行 {spc_pos}"
                                        f"（scope={key[1][:8]}…）"
                                    ),
                                    "import_batch_id": str(hrow[0] or pair_bid) if hrow else pair_bid,
                                    "import_session_id": str(hrow[1] or "") if hrow else "",
                                    "delta_value": float(inv_pos - spc_pos),
                                    "extra": {
                                        "spc_table": spc_tbl,
                                        "source_scope_key": key[1],
                                        "inv_detail_positive_lines": inv_pos,
                                        "spc_positive_lines": spc_pos,
                                    },
                                }
                            )
                            if len(rows) >= lim:
                                break
                    except Exception:
                        pass
                    if len(rows) >= lim:
                        break
                if len(rows) >= lim:
                    break
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}

    return {
        "ok": True,
        "domain": dom,
        "batch_id": bid or None,
        "session_id": sid or None,
        "rows": rows,
        "limit": lim,
    }


_SEMANTIC_RULE_IDS = ("RULE-DQ-MISSING-SPC", "RULE-DQ-SUMMARY-LINE")


def _dq_table_exists(conn: Any, name: str) -> bool:
    try:
        conn.execute(f"SELECT 1 FROM {name} LIMIT 1")
        return True
    except Exception:
        return False


def _semantic_flag_detail_json(cand: dict[str, Any], *, batch_id: str | None) -> str:
    import json

    rule_id = str(cand.get("rule_id") or "")
    domain = "cross_table" if rule_id == "RULE-DQ-MISSING-SPC" else "semantic"
    payload: dict[str, Any] = {
        "stat_year": int(cand.get("stat_year") or 0),
        "entity_id": str(cand.get("entity_id") or ""),
        "batch_id": str(cand.get("batch_id") or batch_id or ""),
        "domain": domain,
        "header_uuid": str(cand.get("header_uuid") or ""),
        "ticket_key": str(cand.get("ticket_key") or ""),
        "rule_subtype": "missing_spc" if rule_id == "RULE-DQ-MISSING-SPC" else "summary_line",
    }
    if rule_id == "RULE-DQ-MISSING-SPC":
        payload["spc_label"] = str(cand.get("spc_label") or "")
        payload["inv_detail_positive_lines"] = int(cand.get("inv_detail_positive_lines") or 0)
    elif rule_id == "RULE-DQ-SUMMARY-LINE":
        payload["summary_line_count"] = int(cand.get("summary_line_count") or 0)
    return json.dumps(payload, ensure_ascii=False)


def sync_semantic_quality_flags(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
) -> dict[str, Any]:
    """
    将语义质量域发现同步至 dm_audit_flag（RULE-DQ-*）。

    重同步时仅删除未确认疑点，已确认记录保留（与财务核对 sync 一致）。
    """
    import logging

    from src.audit.config_loader import group_id_for_year, load_audit_rules_config

    logger = logging.getLogger(__name__)
    bid = str(batch_id or "").strip() or None
    analysis_batch = f"semantic_quality_{bid or 'all'}"

    if not _dq_table_exists(conn, "dm_audit_flag"):
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": "dm_audit_flag 表不存在", "exception_type": "SchemaError"},
        }

    candidates: list[dict[str, Any]] = []
    for item in _semantic_missing_spc_findings(conn, batch_id=bid, session_id=None):
        sy = int(item.get("stat_year") or 0)
        if stat_year is not None and sy != int(stat_year):
            continue
        huid = str(item["header_uuid"])
        fid = f"DQSEM_{sy}_{huid}_MISSING_SPC"
        candidates.append(
            {
                "flag_id": fid,
                "rule_id": "RULE-DQ-MISSING-SPC",
                "stat_year": sy,
                "entity_id": str(item.get("entity_id") or ""),
                "entity_name": str(item.get("entity_name") or item.get("entity_id") or ""),
                "amount": float(item.get("inv_detail_positive_lines") or 0),
                "description": (
                    f"疑似缺专项（{item.get('spc_label')}）：票 {item.get('ticket_key')} "
                    f"明细正行 {item.get('inv_detail_positive_lines')}，专项正行 0"
                ),
                "suggestion": "核对是否漏导对应专项 sheet，或业务是否无需专项表",
                "flag_type": "数据质量",
                "batch_id": str(item.get("import_batch_id") or bid or ""),
                "header_uuid": huid,
                "ticket_key": str(item.get("ticket_key") or ""),
                "spc_label": str(item.get("spc_label") or ""),
                "inv_detail_positive_lines": int(item.get("inv_detail_positive_lines") or 0),
            }
        )

    summary_groups: dict[str, list[dict[str, Any]]] = {}
    for item in _semantic_summary_findings(conn, batch_id=bid, session_id=None):
        sy = int(item.get("stat_year") or 0)
        if stat_year is not None and sy != int(stat_year):
            continue
        huid = str(item["header_uuid"])
        summary_groups.setdefault(huid, []).append(item)
    for huid, items in summary_groups.items():
        first = items[0]
        sy = int(first.get("stat_year") or 0)
        fid = f"DQSEM_{sy}_{huid}_SUMMARY"
        sample_text = "；".join(str(x.get("hwlwmc") or "")[:40] for x in items[:3])
        candidates.append(
            {
                "flag_id": fid,
                "rule_id": "RULE-DQ-SUMMARY-LINE",
                "stat_year": sy,
                "entity_id": str(first.get("entity_id") or ""),
                "entity_name": str(first.get("entity_name") or first.get("entity_id") or ""),
                "amount": float(len(items)),
                "description": (
                    f"汇总参考行 {len(items)} 条（logic_line_no=0）：票 {first.get('ticket_key')} "
                    f"样例：{sample_text or '—'}"
                ),
                "suggestion": "确认是否为「详见销货清单」类占位行，避免与真实明细重复计量",
                "flag_type": "数据质量",
                "batch_id": str(first.get("import_batch_id") or bid or ""),
                "header_uuid": huid,
                "ticket_key": str(first.get("ticket_key") or ""),
                "summary_line_count": len(items),
            }
        )

    current_ids = {str(c["flag_id"]) for c in candidates}
    try:
        placeholders = ", ".join("?" for _ in _SEMANTIC_RULE_IDS)
        if current_ids:
            id_ph = ", ".join("?" for _ in current_ids)
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE analysis_batch = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                  AND flag_id NOT IN ({id_ph})
                """,
                [analysis_batch, *_SEMANTIC_RULE_IDS, *current_ids],
            )
        else:
            conn.execute(
                f"""
                DELETE FROM dm_audit_flag
                WHERE analysis_batch = ? AND rule_id IN ({placeholders})
                  AND COALESCE(is_confirmed, FALSE) = FALSE
                """,
                [analysis_batch, *_SEMANTIC_RULE_IDS],
            )
    except Exception as exc:
        logger.exception("cleanup semantic quality flags")
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }

    cfg = load_audit_rules_config()
    rules_cfg = cfg.get("rules") if isinstance(cfg, dict) else {}
    inserted = 0
    updated = 0
    skipped_confirmed = 0
    by_rule: dict[str, int] = {rid: 0 for rid in _SEMANTIC_RULE_IDS}

    for cand in candidates:
        flag_id = str(cand["flag_id"])
        rule_id = str(cand["rule_id"])
        try:
            existing = conn.execute(
                "SELECT COALESCE(is_confirmed, FALSE) FROM dm_audit_flag WHERE flag_id = ?",
                [flag_id],
            ).fetchone()
            if existing and bool(existing[0]):
                skipped_confirmed += 1
                continue
            existed = existing is not None
        except Exception:
            logger.exception("check confirmed semantic flag %s", flag_id)
            existed = False

        year = int(cand["stat_year"])
        gid = group_id_for_year(year)
        rc = rules_cfg.get(rule_id, {}) if isinstance(rules_cfg, dict) else {}
        risk_level = str(rc.get("risk_level") or "中风险")
        detail_json = _semantic_flag_detail_json(cand, batch_id=bid)
        try:
            conn.execute(
                """
                INSERT INTO dm_audit_flag (
                    flag_id, rule_id, risk_level, flag_type, group_id,
                    entity_id, entity_name, amount, description, suggestion,
                    is_confirmed, analysis_batch, detail_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)
                ON CONFLICT (flag_id) DO UPDATE SET
                    rule_id = excluded.rule_id,
                    risk_level = excluded.risk_level,
                    flag_type = excluded.flag_type,
                    entity_name = excluded.entity_name,
                    amount = excluded.amount,
                    description = excluded.description,
                    suggestion = excluded.suggestion,
                    analysis_batch = excluded.analysis_batch,
                    detail_json = excluded.detail_json
                """,
                [
                    flag_id,
                    rule_id,
                    risk_level,
                    str(cand.get("flag_type") or "数据质量"),
                    gid,
                    str(cand.get("entity_id") or ""),
                    str(cand.get("entity_name") or ""),
                    float(cand.get("amount") or 0),
                    str(cand.get("description") or ""),
                    str(cand.get("suggestion") or ""),
                    analysis_batch,
                    detail_json,
                ],
            )
            if existed:
                updated += 1
            else:
                inserted += 1
            by_rule[rule_id] = by_rule.get(rule_id, 0) + 1
        except Exception:
            logger.exception("insert semantic quality flag %s", flag_id)

    return {
        "ok": True,
        "batch_id": bid,
        "stat_year": stat_year,
        "analysis_batch": analysis_batch,
        "finding_count": len(candidates),
        "inserted": inserted,
        "updated": updated,
        "skipped_confirmed": skipped_confirmed,
        "by_rule": by_rule,
    }


def api_semantic_quality_sync_flags(
    conn: Any,
    *,
    batch_id: str | None = None,
    stat_year: int | None = None,
) -> dict[str, Any]:
    try:
        return sync_semantic_quality_flags(conn, batch_id=batch_id, stat_year=stat_year)
    except Exception as exc:
        return {
            "ok": False,
            "inserted": 0,
            "updated": 0,
            "skipped_confirmed": 0,
            "by_rule": {},
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }
