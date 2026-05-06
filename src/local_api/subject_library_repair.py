from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Any


def _new_repair_id() -> str:
    return f"RPR_{time.strftime('%Y%m%d_%H%M%S')}_{os.urandom(4).hex()}"


def api_subject_library_repair_from_request(
    conn,
    body: dict[str, Any],
) -> dict[str, Any]:
    """
    人工修正 dim_subject_master 的 subject_category（org/person）与/或 org_category。
    - 请求体须含 subject_id；subject_category / org_category 至少改其一（键存在即视为要处理）。
    - org_category 键存在且值为空串：将库中该字段置为 NULL（清空）。
    每次变更写入 dim_subject_master_repair_log（追加、不可撤销）；可再次调用修改。
    """
    sid = str(body.get("subject_id") or "").strip()
    if not sid:
        return {"ok": False, "error": {"message": "subject_id 不能为空"}}

    has_cat = "subject_category" in body
    has_org = "org_category" in body
    if not has_cat and not has_org:
        return {"ok": False, "error": {"message": "请求体须包含 subject_category 或 org_category 字段之一"}}

    raw_cat = body.get("subject_category")
    cat_in = str(raw_cat).strip().lower() if raw_cat is not None else ""
    raw_org = body.get("org_category")
    org_in = str(raw_org).strip() if raw_org is not None else ""

    if has_cat:
        if cat_in not in {"org", "person"}:
            return {"ok": False, "error": {"message": "subject_category 须为 org 或 person"}}

    reason_raw = body.get("reason")
    reason_s = (str(reason_raw or "").strip() or None) if reason_raw is not None else None
    hint_raw = body.get("client_hint")
    hint_s = (str(hint_raw or "").strip() or "web-enterprise-library")[:200]

    row = conn.execute(
        """
        SELECT subject_category, COALESCE(org_category,'') AS org_category
        FROM dim_subject_master
        WHERE subject_id = ?
        """,
        [sid],
    ).fetchone()
    if not row:
        return {"ok": False, "error": {"message": "未找到该主体（subject_id 无效）"}}

    old_cat = str(row[0] or "org").strip().lower()
    if old_cat not in {"org", "person"}:
        old_cat = "org"
    old_org = str(row[1] or "")

    new_cat = cat_in if has_cat else old_cat
    new_org = org_in if has_org else old_org

    changes: list[tuple[str, str, str]] = []
    if has_cat and new_cat != old_cat:
        changes.append(("subject_category", old_cat, new_cat))
    if has_org:
        norm_new = new_org if new_org != "" else ""
        norm_old = old_org
        if norm_new != norm_old:
            changes.append(("org_category", norm_old, norm_new))

    if not changes:
        return {
            "ok": True,
            "message": "无变更（新值与当前库中一致）",
            "subject_id": sid,
            "changed": [],
        }

    now = datetime.now()

    try:
        conn.execute("BEGIN TRANSACTION")
        for field, old_v, new_v in changes:
            rid = _new_repair_id()
            conn.execute(
                """
                INSERT INTO dim_subject_master_repair_log (
                    repair_id, subject_id, field_name, old_value, new_value, reason, repaired_at, client_hint
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [rid, sid, field, old_v, new_v, reason_s, now, hint_s],
            )

        set_parts: list[str] = []
        args: list[Any] = []
        if has_cat and new_cat != old_cat:
            set_parts.append("subject_category = ?")
            args.append(new_cat)
        if has_org:
            norm_new = new_org if new_org != "" else ""
            norm_old = old_org
            if norm_new != norm_old:
                set_parts.append("org_category = ?")
                args.append(new_org if new_org != "" else None)
        set_parts.append("updated_at = ?")
        args.append(now)
        args.append(sid)

        conn.execute(
            f"UPDATE dim_subject_master SET {', '.join(set_parts)} WHERE subject_id = ?",
            args,
        )
        conn.execute("COMMIT")
    except Exception as exc:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        return {
            "ok": False,
            "error": {
                "message": f"修复写入失败：{type(exc).__name__}: {exc}",
                "exception_type": type(exc).__name__,
                "detail": str(exc),
            },
        }

    from src.local_api.subject_library import get_org_category_display_names

    names = get_org_category_display_names()
    changed_out: list[dict[str, Any]] = []
    for field, old_v, new_v in changes:
        item: dict[str, Any] = {"field": field, "old_value": old_v, "new_value": new_v}
        if field == "org_category":
            item["old_display_name"] = names.get(str(old_v or "").strip(), "")
            item["new_display_name"] = names.get(str(new_v or "").strip(), "")
        changed_out.append(item)

    return {
        "ok": True,
        "message": "已保存修复（不可撤销；可再次修改）",
        "subject_id": sid,
        "changed": changed_out,
    }
