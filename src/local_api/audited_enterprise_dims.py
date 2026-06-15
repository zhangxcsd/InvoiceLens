from __future__ import annotations

"""
被审企业「管理与产权层级信息」「出资与股权比例信息」的 DuckDB 读写与演示种子加载。
"""

import json
import logging
import re
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEMO_ROW_PREFIX = "demo_seed_"


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _ledger_seed_path() -> Path:
    return _project_root() / "frontend" / "src" / "dim" / "data" / "property_ledger_seed.json"


def _contribution_seed_path() -> Path:
    return _project_root() / "frontend" / "src" / "dim" / "data" / "property_contribution_seed.json"


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        if isinstance(v, bool):
            return default
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return int(v)
        s = str(v).strip()
        if not s:
            return default
        return int(float(s))
    except Exception:
        return default


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None or v == "":
            return default
        return float(v)
    except Exception:
        return default


def _norm_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v != v:
        return ""
    try:
        import pandas as pd

        if pd.isna(v):
            return ""
    except Exception:
        pass
    s = str(v).strip()
    if s.lower() == "nan":
        return ""
    return s


def _snapshot_years_registry(conn: Any) -> list[str]:
    rows = conn.execute(
        "SELECT DISTINCT snapshot_year FROM dim_audited_enterprise_registry ORDER BY snapshot_year DESC"
    ).fetchall()
    return [str(int(r[0])) for r in rows if r and r[0] is not None]


def _snapshot_years_contribution(conn: Any) -> list[str]:
    rows = conn.execute(
        "SELECT DISTINCT snapshot_year FROM dim_audited_enterprise_contribution ORDER BY snapshot_year DESC"
    ).fetchall()
    return [str(int(r[0])) for r in rows if r and r[0] is not None]


def _pick_year(requested: str | None, years: list[str]) -> str:
    if requested and requested.strip().isdigit():
        y = requested.strip()
        if not years:
            return y
        if y in years:
            return y
    if years:
        return years[0]
    return (requested or "2026").strip() or "2026"


_REGISTRY_SELECT_COLS = """
    row_id, snapshot_year, unified_social_credit_code, enterprise_name,
    domestic_overseas, detail_address, currency, registered_capital, registration_date,
    national_economy_industry_major, enterprise_category, sasac_authority, sasac_relation,
    consolidated_reporting, listed_company, main_business, state_investor,
    mgmt_level, mgmt_parent, equity_level, shareholders
"""


def _registry_filter_clause(
    *,
    year_i: int,
    state_investor_kw: str,
    enterprise_kw: str,
) -> tuple[str, list[Any]]:
    clauses = ["snapshot_year = ?"]
    params: list[Any] = [year_i]
    si = state_investor_kw.strip().lower()
    ek = enterprise_kw.strip().lower()
    if si:
        clauses.append("lower(state_investor) LIKE ?")
        params.append(f"%{si}%")
    if ek:
        clauses.append(
            "(lower(enterprise_name) LIKE ? OR lower(unified_social_credit_code) LIKE ?)"
        )
        params.extend([f"%{ek}%", f"%{ek}%"])
    return " AND ".join(clauses), params


def _fetch_registry_rows(conn: Any, sql: str, params: list[Any]) -> list[tuple[Any, ...]]:
    """
    读取台账列表行。DuckDB 1.5+ 的 top_n 优化在 ORDER BY 中文列 + LIMIT 时会报
    InvalidInputException（unicode byte sequence mismatch），连接层已默认禁用 top_n，
    此处再兜底一次，避免旧连接或未走 get_conn 的路径。
    """
    try:
        conn.execute("SET disabled_optimizers='top_n'")
    except Exception:
        pass
    return conn.execute(sql, params).fetchall()


def _row_to_registry_dict(r: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "rowId": str(r[0] or ""),
        "snapshotYear": str(int(r[1])),
        "code": str(r[2] or ""),
        "name": str(r[3] or ""),
        "domesticOverseas": str(r[4] or ""),
        "detailAddress": str(r[5] or ""),
        "currency": str(r[6] or ""),
        "registeredCapital": str(r[7] or ""),
        "registrationDate": str(r[8] or ""),
        "nationalEconomyIndustryMajor": str(r[9] or ""),
        "enterpriseCategory": str(r[10] or ""),
        "sasacAuthority": str(r[11] or ""),
        "sasacRelation": str(r[12] or ""),
        "consolidatedReporting": str(r[13] or ""),
        "listedCompany": str(r[14] or ""),
        "mainBusiness": str(r[15] or ""),
        "stateInvestor": str(r[16] or ""),
        "mgmtLevel": int(r[17] or 0),
        "mgmtParent": str(r[18] or ""),
        "equityLevel": int(r[19] or 0),
        "shareholders": str(r[20] or ""),
    }


def api_registry_meta(conn: Any) -> dict[str, Any]:
    """仅返回可选快照年度（轻量，供台账页首屏）。"""
    years = _snapshot_years_registry(conn)
    return {"ok": True, "snapshot_years": years}


def api_registry_list(
    conn: Any,
    *,
    snapshot_year: str | None,
    state_investor_kw: str = "",
    enterprise_kw: str = "",
    limit: int = 50,
    offset: int = 0,
    include_years: bool = True,
) -> dict[str, Any]:
    years = _snapshot_years_registry(conn) if include_years else []
    year_s = _pick_year(snapshot_year, years if years else [str(snapshot_year or "2026")])
    year_i = int(year_s) if year_s.isdigit() else 2026

    where_sql, params = _registry_filter_clause(
        year_i=year_i,
        state_investor_kw=state_investor_kw,
        enterprise_kw=enterprise_kw,
    )
    lim = max(1, min(int(limit or 50), 500))
    off = max(0, int(offset or 0))

    try:
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM dim_audited_enterprise_registry WHERE {where_sql}",
                params,
            ).fetchone()[0]
            or 0
        )
        agg = conn.execute(
            f"""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE trim(COALESCE(listed_company, '')) = '是') AS listed_company,
                COUNT(*) FILTER (WHERE COALESCE(domestic_overseas, '') LIKE '%境外%') AS overseas,
                COUNT(*) FILTER (WHERE trim(COALESCE(mgmt_parent, '')) <> '') AS mgmt_parent_maintained,
                COUNT(*) FILTER (
                    WHERE trim(COALESCE(shareholders, '')) <> ''
                      AND trim(COALESCE(shareholders, '')) <> '待维护'
                ) AS equity_parent_maintained,
                COUNT(*) FILTER (WHERE trim(COALESCE(main_business, '')) <> '') AS main_business_maintained
            FROM dim_audited_enterprise_registry
            WHERE {where_sql}
            """,
            params,
        ).fetchone()
        list_sql = f"""
            SELECT {_REGISTRY_SELECT_COLS}
            FROM dim_audited_enterprise_registry
            WHERE {where_sql}
            ORDER BY enterprise_name ASC, unified_social_credit_code ASC
            LIMIT {lim} OFFSET {off}
        """
        rows_out = [_row_to_registry_dict(r) for r in _fetch_registry_rows(conn, list_sql, params)]
    except Exception as exc:
        logger.exception("registry list failed: %s", exc)
        raise

    summary = {
        "total": int(agg[0] or 0) if agg else 0,
        "listed_company": int(agg[1] or 0) if agg else 0,
        "overseas": int(agg[2] or 0) if agg else 0,
        "mgmt_parent_maintained": int(agg[3] or 0) if agg else 0,
        "equity_parent_maintained": int(agg[4] or 0) if agg else 0,
        "main_business_maintained": int(agg[5] or 0) if agg else 0,
    }

    out: dict[str, Any] = {
        "ok": True,
        "selected_year": year_s,
        "rows": rows_out,
        "total": total,
        "limit": lim,
        "offset": off,
        "summary": summary,
    }
    if include_years:
        out["snapshot_years"] = years
    return out


def fetch_all_registry_rows(
    conn: Any,
    *,
    snapshot_year: str | None,
    state_investor_kw: str = "",
    enterprise_kw: str = "",
    include_years: bool = True,
    chunk_size: int = 500,
) -> dict[str, Any]:
    """
    分页拉取台账全量行（供关系树/关系清单等需全量计算的 API 使用）。
    单次 chunk 仍受 api_registry_list 上限约束，内部循环 offset 直至 total。
    """
    chunk = max(1, min(int(chunk_size or 500), 500))
    first = api_registry_list(
        conn,
        snapshot_year=snapshot_year,
        state_investor_kw=state_investor_kw,
        enterprise_kw=enterprise_kw,
        limit=chunk,
        offset=0,
        include_years=include_years,
    )
    if not first.get("ok"):
        return first

    total = int(first.get("total") or 0)
    merged: list[dict[str, Any]] = list(first.get("rows") or [])
    if total > len(merged):
        for offset in range(len(merged), total, chunk):
            part = api_registry_list(
                conn,
                snapshot_year=snapshot_year,
                state_investor_kw=state_investor_kw,
                enterprise_kw=enterprise_kw,
                limit=chunk,
                offset=offset,
                include_years=False,
            )
            if not part.get("ok"):
                return part
            merged.extend(part.get("rows") or [])

    out: dict[str, Any] = {
        "ok": True,
        "selected_year": first.get("selected_year"),
        "rows": merged,
        "total": total,
    }
    if include_years:
        out["snapshot_years"] = first.get("snapshot_years") or []
    return out


def _merge_shareholders(name: str, ratio: str) -> str:
    n = name.strip()
    rt = ratio.strip()
    if not n:
        return ""
    if not rt:
        return n
    return f"{n}（{rt}%）"


def api_registry_insert(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    code = _norm_str(body.get("code") or body.get("unifiedSocialCreditCode"))
    name = _norm_str(body.get("name") or body.get("enterpriseName"))
    sy = _norm_str(body.get("snapshotYear") or body.get("snapshot_year"))
    if not code or not name or not sy or not sy.isdigit():
        return {
            "ok": False,
            "error": {"message": "缺少必填项：快照年度、统一社会信用代码、企业名称", "exception_type": "ValidationError"},
        }

    row_id = _norm_str(body.get("rowId")) or str(uuid.uuid4())
    year_i = int(sy)
    state_cap = _norm_str(body.get("stateCapitalStatus"))
    state_investor = _norm_str(body.get("stateInvestor"))
    if state_cap in {"non_state_owned", "unmaintained"}:
        state_investor = ""

    shareholders = _norm_str(body.get("shareholders"))
    if not shareholders:
        shareholders = _merge_shareholders(
            _norm_str(body.get("equityParentName")),
            _norm_str(body.get("equityParentRatio")),
        )

    fields = {
        "row_id": row_id,
        "snapshot_year": year_i,
        "unified_social_credit_code": code,
        "enterprise_name": name,
        "domestic_overseas": _norm_str(body.get("domesticOverseas")) or "境内",
        "detail_address": _norm_str(body.get("detailAddress")),
        "currency": _norm_str(body.get("currency")),
        "registered_capital": _norm_str(body.get("registeredCapital")),
        "registration_date": _norm_str(body.get("registrationDate")),
        "national_economy_industry_major": _norm_str(body.get("nationalEconomyIndustryMajor")),
        "enterprise_category": _norm_str(body.get("enterpriseCategory")),
        "sasac_authority": _norm_str(body.get("sasacAuthority")),
        "sasac_relation": _norm_str(body.get("sasacRelation")),
        "consolidated_reporting": _norm_str(body.get("consolidatedReporting")),
        "listed_company": _norm_str(body.get("listedCompany")),
        "main_business": _norm_str(body.get("mainBusiness")),
        "state_investor": state_investor,
        "mgmt_level": _safe_int(body.get("mgmtLevel"), 1),
        "mgmt_parent": _norm_str(body.get("mgmtParent")),
        "equity_level": _safe_int(body.get("equityLevel"), 1),
        "shareholders": shareholders,
    }

    cols = ", ".join(fields.keys())
    placeholders = ", ".join(["?"] * len(fields))
    updates = ", ".join([f"{k} = excluded.{k}" for k in fields if k not in ("row_id",)])
    sql = (
        f"INSERT INTO dim_audited_enterprise_registry ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT (snapshot_year, unified_social_credit_code) DO UPDATE SET {updates}"
    )
    try:
        conn.execute(sql, list(fields.values()))
        from src.local_api.enterprise_year_roster_build import sync_enterprise_year_roster_for_snapshot_year

        roster_sync = sync_enterprise_year_roster_for_snapshot_year(conn, year_i)
        out: dict[str, Any] = {"ok": True, "row_id": row_id}
        if roster_sync.get("ok"):
            out["roster_rows_written"] = roster_sync.get("rows_written", 0)
            rel = roster_sync.get("enterprise_year_rel_rebuild")
            if isinstance(rel, dict):
                out["enterprise_year_rel_rebuild"] = rel
        else:
            out["roster_sync_warning"] = (roster_sync.get("error") or {}).get("message", "花名册同步失败")
        if roster_sync.get("rel_rebuild_warning"):
            out["rel_rebuild_warning"] = roster_sync["rel_rebuild_warning"]
        return out
    except Exception as exc:
        logger.exception("registry insert failed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }


def _demo_registry_row_id(year: int, code: str) -> str:
    safe_code = re.sub(r"[^A-Za-z0-9]+", "_", code)[:48]
    return f"{_DEMO_ROW_PREFIX}reg_{year}_{safe_code}"


def api_registry_bootstrap_demo(conn: Any) -> dict[str, Any]:
    path = _ledger_seed_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except FileNotFoundError:
        return {
            "ok": False,
            "error": {"message": f"演示种子文件不存在：{path}", "exception_type": "FileNotFoundError"},
        }
    except Exception as exc:
        logger.exception("read ledger seed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }

    if not isinstance(data, list):
        return {"ok": False, "error": {"message": "种子 JSON 格式错误", "exception_type": "ValueError"}}

    try:
        conn.execute(
            f"DELETE FROM dim_audited_enterprise_registry WHERE row_id LIKE '{_DEMO_ROW_PREFIX}reg_%'"
        )
        n = 0
        for item in data:
            if not isinstance(item, dict):
                continue
            sy = _norm_str(item.get("snapshotYear"))
            if not sy.isdigit():
                continue
            year_i = int(sy)
            code = _norm_str(item.get("code"))
            if not code:
                continue
            rid = _demo_registry_row_id(year_i, code)
            row = {
                "row_id": rid,
                "snapshot_year": year_i,
                "unified_social_credit_code": code,
                "enterprise_name": _norm_str(item.get("name")) or code,
                "domestic_overseas": _norm_str(item.get("domesticOverseas")),
                "detail_address": _norm_str(item.get("detailAddress")),
                "currency": _norm_str(item.get("currency")),
                "registered_capital": _norm_str(item.get("registeredCapital")),
                "registration_date": _norm_str(item.get("registrationDate")),
                "national_economy_industry_major": _norm_str(item.get("nationalEconomyIndustryMajor")),
                "enterprise_category": _norm_str(item.get("enterpriseCategory")),
                "sasac_authority": _norm_str(item.get("sasacAuthority")),
                "sasac_relation": _norm_str(item.get("sasacRelation")),
                "consolidated_reporting": _norm_str(item.get("consolidatedReporting")),
                "listed_company": _norm_str(item.get("listedCompany")),
                "main_business": _norm_str(item.get("mainBusiness")),
                "state_investor": _norm_str(item.get("stateInvestor")),
                "mgmt_level": _safe_int(item.get("mgmtLevel"), 0),
                "mgmt_parent": _norm_str(item.get("mgmtParent")),
                "equity_level": _safe_int(item.get("equityLevel"), 0),
                "shareholders": _norm_str(item.get("shareholders")),
            }
            cols = ", ".join(row.keys())
            ph = ", ".join(["?"] * len(row))
            upd = ", ".join([f"{k} = excluded.{k}" for k in row if k not in ("row_id",)])
            conn.execute(
                f"INSERT INTO dim_audited_enterprise_registry ({cols}) VALUES ({ph}) "
                f"ON CONFLICT (snapshot_year, unified_social_credit_code) DO UPDATE SET {upd}",
                list(row.values()),
            )
            n += 1
            y25 = year_i - 1
            if y25 >= 2000:
                rid25 = _demo_registry_row_id(y25, code)
                row25 = {**row, "row_id": rid25, "snapshot_year": y25}
                cols25 = ", ".join(row25.keys())
                ph25 = ", ".join(["?"] * len(row25))
                upd25 = ", ".join([f"{k} = excluded.{k}" for k in row25 if k not in ("row_id",)])
                conn.execute(
                    f"INSERT INTO dim_audited_enterprise_registry ({cols25}) VALUES ({ph25}) "
                    f"ON CONFLICT (snapshot_year, unified_social_credit_code) DO UPDATE SET {upd25}",
                    list(row25.values()),
                )
                n += 1
        years_synced: set[int] = set()
        for item in data:
            if not isinstance(item, dict):
                continue
            try:
                years_synced.add(int(item.get("snapshotYear") or 0))
                years_synced.add(int(item.get("snapshotYear") or 0) - 1)
            except (TypeError, ValueError):
                pass
        from src.local_api.enterprise_year_roster_build import rebuild_enterprise_year_roster_from_registry

        roster_years = sorted(y for y in years_synced if 1990 <= y <= 2100)
        roster_sync = rebuild_enterprise_year_roster_from_registry(conn, stat_years=roster_years, replace_years=True)
        out: dict[str, Any] = {"ok": True, "inserted": n}
        if roster_sync.get("ok"):
            out["roster_rows_written"] = roster_sync.get("rows_written", 0)
            rel = roster_sync.get("enterprise_year_rel_rebuild")
            if isinstance(rel, dict):
                out["enterprise_year_rel_rebuild"] = rel
        else:
            out["roster_sync_warning"] = (roster_sync.get("error") or {}).get("message", "花名册同步失败")
        if roster_sync.get("rel_rebuild_warning"):
            out["rel_rebuild_warning"] = roster_sync["rel_rebuild_warning"]
        return out
    except Exception as exc:
        logger.exception("registry bootstrap: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }


def api_contribution_list(
    conn: Any,
    *,
    snapshot_year: str | None,
    keyword: str = "",
) -> dict[str, Any]:
    years = _snapshot_years_contribution(conn)
    year_s = _pick_year(snapshot_year, years)
    year_i = int(year_s) if year_s.isdigit() else 2026
    kw = keyword.strip().lower()

    sql = """
        SELECT
            row_id, snapshot_year, investee_unified_credit_code, investee_name,
            state_investor_enterprise, state_investor_unified_credit_code,
            contributor_name, contributor_org_code, contributor_category, contribution_info,
            relation_to_target, currency, subscribed_amount_wan, share_ratio
        FROM dim_audited_enterprise_contribution
        WHERE snapshot_year = ?
    """
    params: list[Any] = [year_i]
    if kw:
        sql += """ AND (
            lower(investee_name) LIKE ? OR lower(investee_unified_credit_code) LIKE ?
            OR lower(state_investor_enterprise) LIKE ? OR lower(state_investor_unified_credit_code) LIKE ?
            OR lower(contributor_name) LIKE ? OR lower(contributor_org_code) LIKE ?
            OR lower(contributor_category) LIKE ? OR lower(contribution_info) LIKE ?
            OR lower(relation_to_target) LIKE ? OR lower(currency) LIKE ?
        )"""
        like = f"%{kw}%"
        params.extend([like, like, like, like, like, like, like, like, like, like])

    sql += " ORDER BY investee_name ASC, contributor_name ASC"

    rows_out: list[dict[str, Any]] = []
    for r in conn.execute(sql, params).fetchall():
        wan = r[12]
        sr = r[13]
        rows_out.append(
            {
                "rowId": str(r[0] or ""),
                "snapshotYear": str(int(r[1])),
                "unifiedCreditCode": str(r[2] or ""),
                "investeeName": str(r[3] or ""),
                "stateInvestorEnterprise": str(r[4] or ""),
                "stateInvestorUnifiedCreditCode": str(r[5] or ""),
                "contributorName": str(r[6] or ""),
                "contributorOrgCode": str(r[7] or ""),
                "contributorCategory": str(r[8] or ""),
                "contributionInfo": str(r[9] or ""),
                "relationToTarget": str(r[10] or ""),
                "currency": str(r[11] or ""),
                "subscribedAmountWan": float(wan) if wan is not None else 0.0,
                "shareRatio": float(sr) if sr is not None else 0.0,
            }
        )

    return {"ok": True, "snapshot_years": years, "selected_year": year_s, "rows": rows_out}


def api_contribution_insert(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    sy = _norm_str(body.get("snapshotYear") or body.get("snapshot_year"))
    investee = _norm_str(body.get("investeeName"))
    contrib = _norm_str(body.get("contributorName"))
    if not sy.isdigit() or not investee or not contrib:
        return {
            "ok": False,
            "error": {"message": "缺少必填项：快照年度、企业名称、出资人名称", "exception_type": "ValidationError"},
        }
    row_id = _norm_str(body.get("rowId")) or str(uuid.uuid4())
    year_i = int(sy)
    code = _norm_str(body.get("unifiedCreditCode") or body.get("unified_credit_code"))
    row = {
        "row_id": row_id,
        "snapshot_year": year_i,
        "investee_unified_credit_code": code,
        "investee_name": investee,
        "state_investor_enterprise": _norm_str(body.get("stateInvestorEnterprise")),
        "state_investor_unified_credit_code": _norm_str(body.get("stateInvestorUnifiedCreditCode")),
        "contributor_name": contrib,
        "contributor_org_code": _norm_str(body.get("contributorOrgCode")),
        "contributor_category": _norm_str(body.get("contributorCategory")),
        "contribution_info": _norm_str(body.get("contributionInfo")),
        "relation_to_target": _norm_str(body.get("relationToTarget")),
        "currency": _norm_str(body.get("currency")) or "人民币",
        "subscribed_amount_wan": Decimal(str(_safe_float(body.get("subscribedAmountWan"), 0.0))),
        "share_ratio": Decimal(str(_safe_float(body.get("shareRatio"), 0.0))),
    }
    cols = ", ".join(row.keys())
    ph = ", ".join(["?"] * len(row))
    sql = f"INSERT INTO dim_audited_enterprise_contribution ({cols}) VALUES ({ph})"
    try:
        conn.execute(sql, list(row.values()))
        return {"ok": True, "row_id": row_id}
    except Exception as exc:
        logger.exception("contribution insert failed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }


def _demo_contrib_row_id(year: int, investee_code: str, contributor: str, seq: int) -> str:
    c = re.sub(r"[^A-Za-z0-9]+", "_", investee_code)[:24]
    p = re.sub(r"[^A-Za-z0-9]+", "_", contributor)[:24]
    return f"{_DEMO_ROW_PREFIX}c_{year}_{c}_{p}_{seq}"


def api_contribution_bootstrap_demo(conn: Any) -> dict[str, Any]:
    path = _contribution_seed_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except FileNotFoundError:
        return {
            "ok": False,
            "error": {"message": f"演示种子文件不存在：{path}", "exception_type": "FileNotFoundError"},
        }
    except Exception as exc:
        logger.exception("read contribution seed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }

    if not isinstance(data, list):
        return {"ok": False, "error": {"message": "种子 JSON 格式错误", "exception_type": "ValueError"}}

    try:
        conn.execute(
            f"DELETE FROM dim_audited_enterprise_contribution WHERE row_id LIKE '{_DEMO_ROW_PREFIX}c_%'"
        )
        n = 0
        seq = 0
        for item in data:
            if not isinstance(item, dict):
                continue
            sy = _norm_str(item.get("snapshotYear"))
            if not sy.isdigit():
                continue
            year_i = int(sy)
            investee = _norm_str(item.get("investeeName"))
            contributor = _norm_str(item.get("contributorName"))
            if not investee or not contributor:
                continue
            code = _norm_str(item.get("unifiedCreditCode"))
            seq += 1
            rid = _demo_contrib_row_id(year_i, code or investee, contributor, seq)
            row = {
                "row_id": rid,
                "snapshot_year": year_i,
                "investee_unified_credit_code": code,
                "investee_name": investee,
                "state_investor_enterprise": _norm_str(item.get("stateInvestorEnterprise")),
                "state_investor_unified_credit_code": _norm_str(item.get("stateInvestorUnifiedCreditCode")),
                "contributor_name": contributor,
                "contributor_org_code": _norm_str(item.get("contributorOrgCode")),
                "contributor_category": _norm_str(item.get("contributorCategory")),
                "contribution_info": _norm_str(item.get("contributionInfo")),
                "relation_to_target": _norm_str(item.get("relationToTarget")),
                "currency": _norm_str(item.get("currency")) or "人民币",
                "subscribed_amount_wan": Decimal(str(_safe_float(item.get("subscribedAmountWan"), 0.0))),
                "share_ratio": Decimal(str(_safe_float(item.get("shareRatio"), 0.0))),
            }
            cols = ", ".join(row.keys())
            ph = ", ".join(["?"] * len(row))
            conn.execute(f"INSERT INTO dim_audited_enterprise_contribution ({cols}) VALUES ({ph})", list(row.values()))
            n += 1
            y25 = year_i - 1
            if y25 >= 2000:
                seq += 1
                rid25 = _demo_contrib_row_id(y25, code or investee, contributor, seq)
                row25 = {**row, "row_id": rid25, "snapshot_year": y25}
                cols25 = ", ".join(row25.keys())
                ph25 = ", ".join(["?"] * len(row25))
                conn.execute(
                    f"INSERT INTO dim_audited_enterprise_contribution ({cols25}) VALUES ({ph25})",
                    list(row25.values()),
                )
                n += 1
        return {"ok": True, "inserted": n}
    except Exception as exc:
        logger.exception("contribution bootstrap: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }


# -----------------------------------------------------------------------------
# Excel 批量导入（管理与产权 / 出资股权）
# -----------------------------------------------------------------------------

import io as _io

import pandas as pd

_REGISTRY_EXCEL_ALIASES: dict[str, list[str]] = {
    "snapshot_year": ["snapshot_year", "快照年度", "统计年度", "年度"],
    "unified_social_credit_code": ["unified_social_credit_code", "统一社会信用代码", "信用代码", "税号"],
    "enterprise_name": ["enterprise_name", "企业名称", "名称"],
    "domestic_overseas": ["domestic_overseas", "境内/境外", "境内境外"],
    "detail_address": ["detail_address", "详细地址", "地址"],
    "currency": ["currency", "币种"],
    "registered_capital": ["registered_capital", "注册资本"],
    "registration_date": ["registration_date", "注册日期"],
    "national_economy_industry_major": ["national_economy_industry_major", "国民经济行业大类", "行业大类"],
    "enterprise_category": ["enterprise_category", "企业类别"],
    "sasac_authority": ["sasac_authority", "所属国资监管机构", "国资监管机构"],
    "sasac_relation": ["sasac_relation", "与国资监管机构的关系", "国资关系"],
    "consolidated_reporting": ["consolidated_reporting", "是否并表", "并表"],
    "listed_company": ["listed_company", "是否上市公司", "上市公司"],
    "main_business": ["main_business", "主业情况", "主业"],
    "state_investor": ["state_investor", "国家出资企业"],
    "mgmt_level": ["mgmt_level", "管理层级"],
    "mgmt_parent": ["mgmt_parent", "上级管理单位", "管理上级"],
    "equity_level": ["equity_level", "产权层级"],
    "shareholders": ["shareholders", "上级产权单位", "股东", "出资人"],
}

_CONTRIB_EXCEL_ALIASES: dict[str, list[str]] = {
    "snapshot_year": ["snapshot_year", "快照年度", "统计年度", "年度"],
    "investee_unified_credit_code": [
        "investee_unified_credit_code",
        "企业统一社会信用代码",
        "统一社会信用代码",
        "信用代码",
    ],
    "investee_name": ["investee_name", "企业名称", "标的企业名称"],
    "state_investor_enterprise": ["state_investor_enterprise", "国家出资企业"],
    "state_investor_unified_credit_code": [
        "state_investor_unified_credit_code",
        "国家出资企业统一社会信用代码",
    ],
    "contributor_name": ["contributor_name", "出资人名称", "出资人"],
    "contributor_org_code": ["contributor_org_code", "出资人组织机构代码", "组织机构代码"],
    "contributor_category": ["contributor_category", "出资人类别"],
    "contribution_info": ["contribution_info", "出资信息"],
    "relation_to_target": ["relation_to_target", "与标的企业关系"],
    "currency": ["currency", "币种"],
    "subscribed_amount_wan": ["subscribed_amount_wan", "认缴金额（万元）", "认缴金额", "出资额万元"],
    "share_ratio": ["share_ratio", "股权比例", "持股比例", "出资比例"],
}


def _norm_header_cell(v: Any) -> str:
    return str(v or "").strip().lower().replace(" ", "").replace("_", "")


def _map_excel_headers(header_row: list[Any], aliases: dict[str, list[str]]) -> dict[str, int]:
    norm_aliases: dict[str, str] = {}
    for key, names in aliases.items():
        for n in names:
            norm_aliases[_norm_header_cell(n)] = key
    out: dict[str, int] = {}
    for idx, cell in enumerate(header_row):
        key = norm_aliases.get(_norm_header_cell(cell))
        if key and key not in out:
            out[key] = idx
    return out


def _compress_seq_ranges(seqs: list[int], reason: str) -> list[dict[str, Any]]:
    if not seqs:
        return []
    sorted_seqs = sorted(set(seqs))
    ranges: list[dict[str, Any]] = []
    start = prev = sorted_seqs[0]
    for s in sorted_seqs[1:]:
        if s == prev + 1:
            prev = s
            continue
        ranges.append({"seq_no_start": start, "seq_no_end": prev, "reason": reason})
        start = prev = s
    ranges.append({"seq_no_start": start, "seq_no_end": prev, "reason": reason})
    return ranges


def _build_row_reject_summary(
    reject_rows: list[dict[str, Any]],
    sheet: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not reject_rows:
        return [], []
    samples: list[dict[str, Any]] = []
    reason_to_seqs: dict[str, list[int]] = {}
    for row in reject_rows[:50]:
        samples.append(
            {
                "seq_no": row.get("seq_no"),
                "sheet": sheet,
                "field": row.get("field") or "unknown",
                "reason": row.get("reason") or "RowValidationError",
                "exception_type": row.get("exception_type") or "RowValidationError",
            }
        )
    for row in reject_rows:
        seq_no = row.get("seq_no")
        if seq_no is None:
            continue
        reason = str(row.get("reason") or "RowValidationError")
        reason_to_seqs.setdefault(reason, []).append(int(seq_no))
    ranges: list[dict[str, Any]] = []
    for reason, seqs in reason_to_seqs.items():
        ranges.extend(_compress_seq_ranges(seqs, reason))
    ranges.sort(key=lambda x: (x["seq_no_start"], x["seq_no_end"]))
    return ranges, samples


def _read_audited_excel_sheet(
    file_bytes: bytes,
    upload_filename: str | None,
) -> tuple[pd.DataFrame, str]:
    fn = (upload_filename or "upload.xlsx").lower()
    bio = _io.BytesIO(file_bytes)
    engine = "xlrd" if fn.endswith(".xls") else "openpyxl"
    xls = pd.ExcelFile(bio, engine=engine)
    sheet = xls.sheet_names[0]
    df = pd.read_excel(xls, sheet_name=sheet, header=0, dtype=str)
    return df, sheet


def api_registry_import_excel(
    conn: Any,
    *,
    file_bytes: bytes,
    upload_filename: str | None = None,
) -> dict[str, Any]:
    try:
        df, sheet = _read_audited_excel_sheet(file_bytes, upload_filename)
    except Exception as exc:  # noqa: BLE001
        logger.exception("读取管理与产权 Excel 失败")
        return {
            "ok": False,
            "file_blocking": True,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
            "imported": 0,
            "rejected": 0,
            "reject_row_samples": [],
            "reject_row_ranges": [],
        }

    if df.empty or df.shape[1] == 0:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {"message": "Excel 无有效表头或数据行", "exception_type": "EmptyFileError"},
            "imported": 0,
            "rejected": 0,
            "reject_row_samples": [],
            "reject_row_ranges": [],
        }

    col_map = _map_excel_headers(list(df.columns), _REGISTRY_EXCEL_ALIASES)
    required = ["snapshot_year", "unified_social_credit_code", "enterprise_name"]
    missing_cols = [k for k in required if k not in col_map]
    if missing_cols:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {
                "message": f"缺少必需列：{', '.join(missing_cols)}",
                "exception_type": "TemplateError",
            },
            "imported": 0,
            "rejected": 0,
            "reject_row_samples": [],
            "reject_row_ranges": [],
            "sheet": sheet,
        }

    imported = 0
    reject_rows: list[dict[str, Any]] = []
    years_sync: set[int] = set()

    for row_idx, row in df.iterrows():
        seq_no = int(row_idx) + 2
        try:
            def _cell(key: str) -> str:
                idx = col_map.get(key)
                if idx is None:
                    return ""
                return _norm_str(row.iloc[idx])

            sy = _cell("snapshot_year")
            code = _cell("unified_social_credit_code")
            name = _cell("enterprise_name")
            if not sy or not sy.isdigit():
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "snapshot_year",
                        "reason": "快照年度无效或为空",
                        "exception_type": "ValidationError",
                    }
                )
                continue
            if not code:
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "unified_social_credit_code",
                        "reason": "统一社会信用代码为空",
                        "exception_type": "ValidationError",
                    }
                )
                continue
            if not name:
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "enterprise_name",
                        "reason": "企业名称为空",
                        "exception_type": "ValidationError",
                    }
                )
                continue

            body: dict[str, Any] = {
                "snapshotYear": sy,
                "code": code,
                "name": name,
                "domesticOverseas": _cell("domestic_overseas") or "境内",
                "detailAddress": _cell("detail_address"),
                "currency": _cell("currency"),
                "registeredCapital": _cell("registered_capital"),
                "registrationDate": _cell("registration_date"),
                "nationalEconomyIndustryMajor": _cell("national_economy_industry_major"),
                "enterpriseCategory": _cell("enterprise_category"),
                "stateInvestor": _cell("state_investor"),
                "sasacAuthority": _cell("sasac_authority"),
                "sasacRelation": _cell("sasac_relation"),
                "consolidatedReporting": _cell("consolidated_reporting"),
                "listedCompany": _cell("listed_company"),
                "mainBusiness": _cell("main_business"),
                "mgmtLevel": _safe_int(_cell("mgmt_level"), 1),
                "mgmtParent": _cell("mgmt_parent"),
                "equityLevel": _safe_int(_cell("equity_level"), 1),
                "shareholders": _cell("shareholders"),
            }
            res = api_registry_insert(conn, body)
            if not res.get("ok"):
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "row",
                        "reason": str((res.get("error") or {}).get("message") or "写入失败"),
                        "exception_type": str((res.get("error") or {}).get("exception_type") or "WriteError"),
                    }
                )
                continue
            imported += 1
            years_sync.add(int(sy))
        except Exception as exc:  # noqa: BLE001
            logger.warning("registry import row %s: %s", seq_no, exc)
            reject_rows.append(
                {
                    "seq_no": seq_no,
                    "field": "row",
                    "reason": str(exc),
                    "exception_type": type(exc).__name__,
                }
            )

    reject_ranges, reject_samples = _build_row_reject_summary(reject_rows, sheet)
    rejected = len(reject_rows)
    return {
        "ok": imported > 0 or rejected == 0,
        "imported": imported,
        "rejected": rejected,
        "reject_row_samples": reject_samples,
        "reject_row_ranges": reject_ranges,
        "sheet": sheet,
        "snapshot_years": sorted(years_sync),
    }


def api_contribution_import_excel(
    conn: Any,
    *,
    file_bytes: bytes,
    upload_filename: str | None = None,
) -> dict[str, Any]:
    try:
        df, sheet = _read_audited_excel_sheet(file_bytes, upload_filename)
    except Exception as exc:  # noqa: BLE001
        logger.exception("读取出资股权 Excel 失败")
        return {
            "ok": False,
            "file_blocking": True,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
            "imported": 0,
            "rejected": 0,
            "reject_row_samples": [],
            "reject_row_ranges": [],
        }

    if df.empty or df.shape[1] == 0:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {"message": "Excel 无有效表头或数据行", "exception_type": "EmptyFileError"},
            "imported": 0,
            "rejected": 0,
            "reject_row_samples": [],
            "reject_row_ranges": [],
        }

    col_map = _map_excel_headers(list(df.columns), _CONTRIB_EXCEL_ALIASES)
    required = ["snapshot_year", "investee_name", "contributor_name"]
    missing_cols = [k for k in required if k not in col_map]
    if missing_cols:
        return {
            "ok": False,
            "file_blocking": True,
            "error": {
                "message": f"缺少必需列：{', '.join(missing_cols)}",
                "exception_type": "TemplateError",
            },
            "imported": 0,
            "rejected": 0,
            "reject_row_samples": [],
            "reject_row_ranges": [],
            "sheet": sheet,
        }

    imported = 0
    reject_rows: list[dict[str, Any]] = []

    for row_idx, row in df.iterrows():
        seq_no = int(row_idx) + 2
        try:
            def _cell(key: str) -> str:
                idx = col_map.get(key)
                if idx is None:
                    return ""
                return _norm_str(row.iloc[idx])

            sy = _cell("snapshot_year")
            investee = _cell("investee_name")
            contributor = _cell("contributor_name")
            if not sy or not sy.isdigit():
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "snapshot_year",
                        "reason": "快照年度无效或为空",
                        "exception_type": "ValidationError",
                    }
                )
                continue
            if not investee:
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "investee_name",
                        "reason": "企业名称为空",
                        "exception_type": "ValidationError",
                    }
                )
                continue
            if not contributor:
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "contributor_name",
                        "reason": "出资人名称为空",
                        "exception_type": "ValidationError",
                    }
                )
                continue

            body: dict[str, Any] = {
                "snapshotYear": sy,
                "unifiedCreditCode": _cell("investee_unified_credit_code"),
                "investeeName": investee,
                "stateInvestorEnterprise": _cell("state_investor_enterprise"),
                "stateInvestorUnifiedCreditCode": _cell("state_investor_unified_credit_code"),
                "contributorName": contributor,
                "contributorOrgCode": _cell("contributor_org_code"),
                "contributorCategory": _cell("contributor_category"),
                "contributionInfo": _cell("contribution_info"),
                "relationToTarget": _cell("relation_to_target"),
                "currency": _cell("currency") or "人民币",
                "subscribedAmountWan": _safe_float(_cell("subscribed_amount_wan"), 0.0),
                "shareRatio": _safe_float(_cell("share_ratio"), 0.0),
            }
            res = api_contribution_insert(conn, body)
            if not res.get("ok"):
                reject_rows.append(
                    {
                        "seq_no": seq_no,
                        "field": "row",
                        "reason": str((res.get("error") or {}).get("message") or "写入失败"),
                        "exception_type": str((res.get("error") or {}).get("exception_type") or "WriteError"),
                    }
                )
                continue
            imported += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("contribution import row %s: %s", seq_no, exc)
            reject_rows.append(
                {
                    "seq_no": seq_no,
                    "field": "row",
                    "reason": str(exc),
                    "exception_type": type(exc).__name__,
                }
            )

    reject_ranges, reject_samples = _build_row_reject_summary(reject_rows, sheet)
    rejected = len(reject_rows)
    return {
        "ok": imported > 0 or rejected == 0,
        "imported": imported,
        "rejected": rejected,
        "reject_row_samples": reject_samples,
        "reject_row_ranges": reject_ranges,
        "sheet": sheet,
    }
