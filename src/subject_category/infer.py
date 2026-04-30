from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_matching_path() -> Path:
    return _project_root() / "config" / "subject_category_matching.yaml"


def default_category_path() -> Path:
    return _project_root() / "config" / "subject_category.yaml"


def normalize_party_id(raw: str) -> str:
    s = (raw or "").strip().upper()
    s = re.sub(r"[\s\-]+", "", s)
    return s


def normalize_party_name(raw: str) -> str:
    s = (raw or "").strip()
    s = re.sub(r"\s+", "", s)
    return s


def load_matching_doc(path: Path | None = None) -> dict[str, Any]:
    p = path or default_matching_path()
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError("subject_category_matching.yaml 顶层必须为对象")
    return raw


def load_category_doc(path: Path | None = None) -> dict[str, Any]:
    p = path or default_category_path()
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError("subject_category.yaml 顶层必须为对象")
    return raw


def enabled_category_codes(category_doc: dict[str, Any]) -> set[str]:
    rows = category_doc.get("categories")
    if not isinstance(rows, list):
        return set()
    out: set[str] = set()
    for it in rows:
        if not isinstance(it, dict):
            continue
        code = str(it.get("category_code") or "").strip()
        if not code:
            continue
        if bool(it.get("enabled", True)):
            out.add(code)
    return out


def _validate_matching_codes(
    *,
    matching_doc: dict[str, Any],
    category_doc: dict[str, Any],
) -> None:
    rows = matching_doc.get("match_order")
    if not isinstance(rows, list):
        return
    known_codes = enabled_category_codes(category_doc)
    # 一致性校验需要以全量类别码为准，而不是仅启用集合。
    all_rows = category_doc.get("categories")
    if isinstance(all_rows, list):
        known_codes = {
            str(it.get("category_code") or "").strip()
            for it in all_rows
            if isinstance(it, dict) and str(it.get("category_code") or "").strip()
        }
    unknown_codes: set[str] = set()
    for it in rows:
        if not isinstance(it, dict):
            continue
        code = str(it.get("category_code") or "").strip()
        if code and code not in known_codes:
            unknown_codes.add(code)
    if unknown_codes:
        bad = ", ".join(sorted(unknown_codes))
        raise ValueError(f"subject_category_matching.yaml 存在未定义 category_code: {bad}")


@dataclass
class InferResult:
    category_code: str | None
    matched: bool
    priority: int | None
    reasons: list[str] = field(default_factory=list)
    needs_review: bool = False
    skipped_disabled_codes: list[str] = field(default_factory=list)


def _eval_one(
    *,
    cond: dict[str, Any],
    party_id: str,
    party_name: str,
) -> tuple[bool, str | None]:
    kind = str(cond.get("kind") or "")
    op = str(cond.get("op") or "eq")
    if kind == "id_len":
        n = len(party_id)
        v = int(cond.get("value") or 0)
        if op == "neq":
            ok = n != v
        else:
            ok = n == v if op == "eq" else (n >= v if op == "gte" else n <= v)
        return ok, f"id_len:{op}{v}({n})"
    if kind == "id_card_like":
        # 18 位居民身份证号形态（全数字 + 末位数字或 X），与统一社会信用代码区分
        want = bool(cond.get("value", True))
        ok = bool(re.fullmatch(r"\d{17}[\dX]", party_id))
        if not want:
            ok = not ok
        return ok, "id_card_like" if ok else None
    if kind == "id_prefix":
        prefs = cond.get("prefixes") or []
        if not isinstance(prefs, list):
            return False, None
        for p in prefs:
            ps = str(p).strip().upper()
            if ps and party_id.startswith(ps):
                return True, f"id_prefix:{ps}"
        return False, None
    if kind == "name_len":
        n = len(party_name)
        v = int(cond.get("value") or 0)
        ok = n == v if op == "eq" else (n >= v if op == "gte" else n <= v)
        return ok, f"name_len:{op}{v}({n})"
    if kind == "name_regex":
        pat = str(cond.get("pattern") or "")
        if not pat:
            return False, None
        flags = 0
        if str(cond.get("flags") or "").upper() == "IGNORECASE":
            flags = re.IGNORECASE
        m = re.search(pat, party_name, flags)
        ok = bool(m)
        return ok, f"name_regex:{pat}" if ok else None
    if kind == "name_not_regex":
        pat = str(cond.get("pattern") or "")
        if not pat:
            return True, None
        flags = 0
        if str(cond.get("flags") or "").upper() == "IGNORECASE":
            flags = re.IGNORECASE
        ok = re.search(pat, party_name, flags) is None
        return ok, f"name_not_regex:{pat}" if ok else None
    return False, None


def _eval_group(
    group: list[dict[str, Any]] | None,
    *,
    party_id: str,
    party_name: str,
) -> tuple[bool, list[str]]:
    if not group:
        return True, []
    reasons: list[str] = []
    for cond in group:
        if not isinstance(cond, dict):
            return False, reasons
        ok, r = _eval_one(cond=cond, party_id=party_id, party_name=party_name)
        if not ok:
            return False, reasons
        if r:
            reasons.append(r)
    return True, reasons


def infer_org_subject_category(
    *,
    party_id: str,
    party_name: str,
    matching_doc: dict[str, Any] | None = None,
    category_doc: dict[str, Any] | None = None,
    enabled_codes: set[str] | None = None,
) -> InferResult:
    """
    从销方/购方「识别号 + 名称」推断组织机构侧主体类别编码。
    不关心销方/购方语义；调用方分别传入即可。
    """
    pid = normalize_party_id(party_id)
    pname = normalize_party_name(party_name)
    if not pid and not pname:
        return InferResult(None, False, None, ["empty_party"], needs_review=True)
    doc = matching_doc if matching_doc is not None else load_matching_doc()
    cdoc = category_doc if category_doc is not None else load_category_doc()
    _validate_matching_codes(matching_doc=doc, category_doc=cdoc)
    active_codes = enabled_codes if enabled_codes is not None else enabled_category_codes(cdoc)
    rows = doc.get("match_order")
    if not isinstance(rows, list):
        return InferResult(None, False, None, ["match_order_missing"], needs_review=True)

    # 15 位旧税号、以及其他非 18 位长度：默认需要复核（除非未来扩展专门规则集覆盖）
    needs_review = len(pid) not in (0, 18)

    ordered = []
    for it in rows:
        if not isinstance(it, dict):
            continue
        if not bool(it.get("enabled", True)):
            continue
        code = str(it.get("category_code") or "").strip()
        if not code:
            continue
        try:
            pri = int(it.get("priority") or 999)
        except Exception:
            pri = 999
        ordered.append((pri, code, it))
    ordered.sort(key=lambda x: x[0])

    skipped_disabled: list[str] = []
    for pri, code, it in ordered:
        if code not in active_codes:
            skipped_disabled.append(code)
            continue
        all_ok, all_rs = _eval_group(it.get("all") if isinstance(it.get("all"), list) else [], party_id=pid, party_name=pname)
        if not all_ok:
            continue
        any_block = it.get("any")
        if isinstance(any_block, list) and len(any_block) > 0:
            any_hit = False
            any_rs: list[str] = []
            for cond in any_block:
                if not isinstance(cond, dict):
                    continue
                one_ok, one_r = _eval_one(cond=cond, party_id=pid, party_name=pname)
                if one_ok:
                    any_hit = True
                    if one_r:
                        any_rs.append(one_r)
                    break
            if not any_hit:
                continue
            reasons = all_rs + any_rs
        else:
            reasons = all_rs
        return InferResult(code, True, pri, reasons, needs_review=needs_review, skipped_disabled_codes=sorted(set(skipped_disabled)))

    end_reasons = ["no_rule_matched"]
    if skipped_disabled:
        end_reasons.extend(f"category_disabled:{c}" for c in sorted(set(skipped_disabled))[:3])
    return InferResult(None, False, None, end_reasons, needs_review=True, skipped_disabled_codes=sorted(set(skipped_disabled)))
