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
    return str(v or "").strip()


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


def api_registry_list(
    conn: Any,
    *,
    snapshot_year: str | None,
    state_investor_kw: str = "",
    enterprise_kw: str = "",
) -> dict[str, Any]:
    years = _snapshot_years_registry(conn)
    year_s = _pick_year(snapshot_year, years)
    year_i = int(year_s) if year_s.isdigit() else 2026

    si = state_investor_kw.strip().lower()
    ek = enterprise_kw.strip().lower()

    sql = """
        SELECT
            row_id, snapshot_year, unified_social_credit_code, enterprise_name,
            domestic_overseas, detail_address, currency, registered_capital, registration_date,
            national_economy_industry_major, enterprise_category, sasac_authority, sasac_relation,
            consolidated_reporting, listed_company, main_business, state_investor,
            mgmt_level, mgmt_parent, equity_level, shareholders
        FROM dim_audited_enterprise_registry
        WHERE snapshot_year = ?
    """
    params: list[Any] = [year_i]
    if si:
        sql += " AND lower(state_investor) LIKE ?"
        params.append(f"%{si}%")
    if ek:
        sql += " AND (lower(enterprise_name) LIKE ? OR lower(unified_social_credit_code) LIKE ?)"
        params.extend([f"%{ek}%", f"%{ek}%"])
    sql += " ORDER BY enterprise_name ASC, unified_social_credit_code ASC"

    rows_out: list[dict[str, Any]] = []
    try:
        for r in conn.execute(sql, params).fetchall():
            rows_out.append(
                {
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
            )
    except Exception as exc:
        logger.exception("registry list failed: %s", exc)
        raise

    return {"ok": True, "snapshot_years": years, "selected_year": year_s, "rows": rows_out}


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
        return {"ok": True, "row_id": row_id}
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
        return {"ok": True, "inserted": n}
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
