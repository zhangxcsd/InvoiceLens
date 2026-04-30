from __future__ import annotations

from typing import Any


def _norm_subject_type(v: str) -> str:
    s = str(v or "").strip().lower()
    if s in {"enterprise", "org"}:
        return "org"
    if s in {"person"}:
        return "person"
    return "all"


def _norm_source_type(v: str) -> str:
    s = str(v or "").strip().lower()
    if s in {"platform", "external"}:
        return s
    return "all"


def _norm_role(v: str) -> str:
    s = str(v or "").strip().lower()
    if s in {"seller", "buyer", "both"}:
        return s
    return "all"


def _derive_role(subject_no: str, has_seller: bool, has_buyer: bool) -> str:
    if has_seller and has_buyer:
        return "both"
    if has_seller:
        return "seller"
    if has_buyer:
        return "buyer"
    # 兜底：历史库缺角色字段时，按 subject_no 前缀粗分（仅展示用途）
    return "both" if str(subject_no or "").startswith("91") else "seller"


def api_subject_library_summary(
    conn,
    *,
    snapshot_year: str = "",
    subject_type: str = "all",
    source_type: str = "all",
) -> dict[str, Any]:
    st = _norm_subject_type(subject_type)
    src = _norm_source_type(source_type)
    where_parts = ["1=1"]
    args: list[Any] = []

    if st != "all":
        where_parts.append("subject_category = ?")
        args.append(st)
    if src != "all":
        where_parts.append("COALESCE(first_source_system,'platform') = ?")
        args.append(src)
    if snapshot_year.strip():
        where_parts.append("COALESCE(subject_snapshot_id,'') LIKE ?")
        args.append(f"%{snapshot_year.strip()}%")

    where_sql = " AND ".join(where_parts)
    row = conn.execute(
        f"""
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN subject_category='org' THEN 1 ELSE 0 END) AS enterprise_count,
            SUM(CASE WHEN subject_category='person' THEN 1 ELSE 0 END) AS person_count,
            SUM(CASE WHEN COALESCE(category_status_note,'')='needs_review' THEN 1 ELSE 0 END) AS needs_review_count
        FROM dim_subject_master
        WHERE {where_sql}
        """,
        args,
    ).fetchone()
    return {
        "ok": True,
        "summary": {
            "total": int(row[0] or 0),
            "enterprise_count": int(row[1] or 0),
            "person_count": int(row[2] or 0),
            "needs_review_count": int(row[3] or 0),
        },
    }


def api_subject_library_rows(
    conn,
    *,
    snapshot_year: str = "",
    keyword: str = "",
    subject_type: str = "all",
    source_type: str = "all",
    subject_category: str = "all",
    role: str = "all",
    batch_id: str = "",
    limit: int = 500,
) -> dict[str, Any]:
    st = _norm_subject_type(subject_type)
    src = _norm_source_type(source_type)
    role_wanted = _norm_role(role)
    where_parts = ["1=1"]
    args: list[Any] = []

    if st != "all":
        where_parts.append("m.subject_category = ?")
        args.append(st)
    if src != "all":
        where_parts.append("COALESCE(m.first_source_system,'platform') = ?")
        args.append(src)
    if subject_category.strip() and subject_category.strip().lower() != "all":
        where_parts.append("COALESCE(m.org_category,'') = ?")
        args.append(subject_category.strip())
    if keyword.strip():
        kw = f"%{keyword.strip()}%"
        where_parts.append(
            "(COALESCE(m.subject_name,'') ILIKE ? OR COALESCE(m.subject_no,'') ILIKE ? OR COALESCE(m.subject_id,'') ILIKE ?)"
        )
        args.extend([kw, kw, kw])
    if batch_id.strip():
        where_parts.append("COALESCE(m.last_import_batch_id,'') ILIKE ?")
        args.append(f"%{batch_id.strip()}%")
    if snapshot_year.strip():
        where_parts.append("COALESCE(m.subject_snapshot_id,'') LIKE ?")
        args.append(f"%{snapshot_year.strip()}%")

    where_sql = " AND ".join(where_parts)
    rows = conn.execute(
        f"""
        SELECT
            m.subject_id,
            COALESCE(m.subject_name,'') AS subject_name,
            COALESCE(m.subject_no,'') AS subject_no,
            COALESCE(m.first_source_system,'platform') AS source_type,
            COALESCE(m.subject_category,'org') AS subject_type,
            COALESCE(m.org_category,'') AS org_category,
            COALESCE(m.subject_snapshot_id,'') AS snapshot_id,
            COALESCE(m.quality_status,'ok') AS quality_status,
            COALESCE(m.category_status_note,'') AS category_status_note,
            COALESCE(m.first_import_batch_id,'') AS first_batch,
            COALESCE(m.last_import_batch_id,'') AS last_batch,
            COALESCE(m.created_at::VARCHAR,'') AS created_at,
            COALESCE(m.updated_at::VARCHAR,'') AS updated_at,
            COALESCE(MAX(CASE WHEN COALESCE(s.match_rule,'') = 'dwd_invoice_seller' AND COALESCE(s.raw_subject_name,'')<>'' THEN 1 ELSE 0 END),0) AS has_seller,
            COALESCE(MAX(CASE WHEN COALESCE(s.match_rule,'') = 'dwd_invoice_buyer' AND COALESCE(s.raw_subject_name,'')<>'' THEN 1 ELSE 0 END),0) AS has_buyer
        FROM dim_subject_master m
        LEFT JOIN dim_subject_source_record s ON s.subject_id = m.subject_id
        WHERE {where_sql}
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13
        ORDER BY updated_at DESC, subject_id DESC
        LIMIT ?
        """,
        [*args, max(1, min(int(limit), 2000))],
    ).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        role_tag = _derive_role(str(r[2] or ""), bool(r[13]), bool(r[14]))
        if role_wanted != "all" and role_tag != role_wanted:
            continue
        snap = str(r[6] or "")
        snap_year = ""
        for seg in snap.split("_"):
            if seg.isdigit() and len(seg) == 4:
                snap_year = seg
                break
        out.append(
            {
                "enterprise_id": str(r[0] or ""),
                "enterprise_name": str(r[1] or ""),
                "taxpayer_id": str(r[2] or ""),
                "source_type": str(r[3] or "platform"),
                "subject_type": "enterprise" if str(r[4] or "org") == "org" else "person",
                "subject_category_code": str(r[5] or ""),
                "snapshot_year": snap_year,
                "role_tag": role_tag,
                "renamed_in_year": str(r[8] or "") == "needs_review",
                "rename_hint": str(r[8] or "-") or "-",
                "rename_timeline": [],
                "first_seen_batch_id": str(r[9] or ""),
                "last_seen_batch_id": str(r[10] or ""),
                "first_seen_date": str(r[11] or ""),
                "last_seen_date": str(r[12] or ""),
            }
        )
    return {"ok": True, "rows": out, "total": len(out)}
