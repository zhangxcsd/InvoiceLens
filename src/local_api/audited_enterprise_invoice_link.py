from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def _norm_pid(value: str) -> str:
    return re.sub(r"[\s-]+", "", str(value or "").strip()).upper()


def _norm_name(value: str) -> str:
    return str(value or "").strip().lower()


def _state_capital_status(state_investor: str, code: str) -> str:
    if state_investor.strip():
        return "国资"
    if code.strip():
        return "非国资"
    return "未维护"


def _load_invoice_pids(conn: Any) -> set[str]:
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT upper(regexp_replace(trim(COALESCE(pid,'')), '[\\s-]+', '', 'g')) AS p
            FROM (
                SELECT xfsbh AS pid FROM dwd_inv_header WHERE length(trim(COALESCE(xfsbh,''))) > 0
                UNION ALL
                SELECT gfsbh AS pid FROM dwd_inv_header WHERE length(trim(COALESCE(gfsbh,''))) > 0
            ) u
            WHERE length(trim(COALESCE(pid,''))) > 0
            """
        ).fetchall()
        return {str(r[0]) for r in rows if r and r[0]}
    except Exception as exc:
        logger.warning("invoice-link: load invoice pids failed: %s", exc)
        return set()


def _load_subject_maps(conn: Any) -> tuple[dict[str, dict[str, str]], dict[str, list[dict[str, str]]]]:
    by_pid: dict[str, dict[str, str]] = {}
    by_name: dict[str, list[dict[str, str]]] = {}
    try:
        for r in conn.execute(
            "SELECT COALESCE(subject_no,''), COALESCE(subject_name,'') FROM dim_subject_master"
        ).fetchall():
            subject_no = str(r[0] or "")
            subject_name = str(r[1] or "")
            entry = {"subjectNo": subject_no, "subjectName": subject_name}
            pid = _norm_pid(subject_no)
            if pid:
                by_pid[pid] = entry
            nm = _norm_name(subject_name)
            if nm:
                by_name.setdefault(nm, []).append(entry)
    except Exception as exc:
        logger.warning("invoice-link: load subjects failed: %s", exc)
    return by_pid, by_name


def _match_row(
    *,
    name: str,
    code: str,
    state_investor: str,
    invoice_pids: set[str],
    subjects_by_pid: dict[str, dict[str, str]],
    subjects_by_name: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    code_norm = _norm_pid(code)
    name_norm = _norm_name(name)
    state_capital_status = _state_capital_status(state_investor, code)

    if not code_norm:
        return {
            "name": name,
            "code": code,
            "stateCapitalStatus": state_capital_status,
            "matchKey": "未命中",
            "linkedTaxpayerId": "-",
            "matchStatus": "待匹配",
            "pendingReason": "缺少统一社会信用代码",
        }

    subject = subjects_by_pid.get(code_norm)
    if subject and code_norm in invoice_pids:
        return {
            "name": name,
            "code": code,
            "stateCapitalStatus": state_capital_status,
            "matchKey": "统一社会信用代码",
            "linkedTaxpayerId": subject["subjectNo"] or code,
            "matchStatus": "已匹配",
            "pendingReason": "",
        }

    if subject and code_norm not in invoice_pids:
        return {
            "name": name,
            "code": code,
            "stateCapitalStatus": state_capital_status,
            "matchKey": "统一社会信用代码",
            "linkedTaxpayerId": subject["subjectNo"] or code,
            "matchStatus": "待匹配",
            "pendingReason": "主体库已命中但无发票覆盖",
        }

    name_hits = subjects_by_name.get(name_norm, [])
    invoice_name_hits = [
        s for s in name_hits if _norm_pid(s.get("subjectNo", "")) in invoice_pids
    ]
    if invoice_name_hits:
        linked = invoice_name_hits[0]
        linked_pid = linked.get("subjectNo", "") or "-"
        pending_reason = ""
        if _norm_pid(linked_pid) != code_norm:
            pending_reason = "税号疑似变更"
        return {
            "name": name,
            "code": code,
            "stateCapitalStatus": state_capital_status,
            "matchKey": "企业名称兜底",
            "linkedTaxpayerId": linked_pid,
            "matchStatus": "名称兜底匹配",
            "pendingReason": pending_reason,
        }

    if name_hits:
        return {
            "name": name,
            "code": code,
            "stateCapitalStatus": state_capital_status,
            "matchKey": "未命中",
            "linkedTaxpayerId": "-",
            "matchStatus": "待匹配",
            "pendingReason": "企业名称不一致",
        }

    return {
        "name": name,
        "code": code,
        "stateCapitalStatus": state_capital_status,
        "matchKey": "未命中",
        "linkedTaxpayerId": "-",
        "matchStatus": "待匹配",
        "pendingReason": "企业名称不一致",
    }


def api_audited_enterprise_invoice_link(conn: Any, *, snapshot_year: str | None) -> dict[str, Any]:
    from src.local_api.audited_enterprise_dims import api_registry_list

    try:
        reg = api_registry_list(conn, snapshot_year=snapshot_year)
        if not reg.get("ok"):
            return reg

        invoice_pids = _load_invoice_pids(conn)
        subjects_by_pid, subjects_by_name = _load_subject_maps(conn)

        rows_out: list[dict[str, Any]] = []
        for row in reg.get("rows") or []:
            try:
                rows_out.append(
                    _match_row(
                        name=str(row.get("name") or ""),
                        code=str(row.get("code") or ""),
                        state_investor=str(row.get("stateInvestor") or ""),
                        invoice_pids=invoice_pids,
                        subjects_by_pid=subjects_by_pid,
                        subjects_by_name=subjects_by_name,
                    )
                )
            except Exception as exc:
                logger.warning("invoice-link row skipped: %s", exc)

        return {
            "ok": True,
            "snapshot_years": reg.get("snapshot_years") or [],
            "selected_year": reg.get("selected_year"),
            "rows": rows_out,
        }
    except Exception as exc:
        logger.exception("invoice-link list failed: %s", exc)
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__, "detail": str(exc)},
        }
