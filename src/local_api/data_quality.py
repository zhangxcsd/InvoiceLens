from __future__ import annotations

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


def load_health_score_snapshot(
    conn: Any,
    *,
    batch_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    _ = conn
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
