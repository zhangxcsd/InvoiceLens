from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime
from typing import Any

from db.schema_sqlfiles import init_all_tables
from src.local_api.subject_library_manual_guard import (
    load_repaired_field_map,
    resolve_org_category_for_upsert,
    resolve_subject_category_for_upsert,
)
from src.subject_category.infer import (
    normalize_party_name,
    party_id_is_resident_id_card_form,
    party_id_is_uscc_form,
    subject_category_for_ingest,
)
from src.subject_category.recompute import _make_run_id

logger = logging.getLogger(__name__)


def _stable_subject_id(norm_no: str, norm_name: str) -> str:
    if norm_no:
        key = f"NO:{norm_no}"
    elif norm_name:
        key = f"NM:{norm_name}"
    else:
        return ""
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    return f"SUB_{h}"


def _subject_no_type(norm_no: str) -> str | None:
    if not norm_no:
        return None
    if party_id_is_uscc_form(norm_no):
        return "uscc"
    if party_id_is_resident_id_card_form(norm_no):
        return "id_card"
    if len(norm_no) == 18:
        return "uscc"
    if norm_no.isdigit() or re.match(r"^[0-9A-Z]+$", norm_no):
        return "taxpayer_id"
    return "other"


def _name_std_key_for_merge(d: dict[str, Any]) -> str:
    """与列表归集一致的名称键，用于「无税号主体」与「有税号主体」对账合并。"""
    s = str(d.get("subject_name_std") or "").strip()
    if s:
        return s
    return str(normalize_party_name(str(d.get("subject_name") or ""))).strip()


def _min_nonempty_str(*parts: str) -> str:
    xs = [p for p in parts if isinstance(p, str) and p.strip()]
    return min(xs) if xs else ""


def _max_nonempty_str(*parts: str) -> str:
    xs = [p for p in parts if isinstance(p, str) and p.strip()]
    return max(xs) if xs else ""


def _merge_invoice_agg_name_key_into_tax_id(agg: dict[str, dict[str, Any]]) -> list[tuple[str, str]]:
    """
    当同一规范化名称下，既有「仅名称键」（无税号）又有「税号键」主体时，将前者合并进后者。

    - 仅当该名称对应 **唯一** 税号键主体时自动合并；若同一名称对应多个不同税号则跳过（避免误并）。
    - 合并后删除名称键条目；canonical 保留税号键 subject_id。
    返回 (name_key_subject_id, tax_key_subject_id) 列表，供外键重挂与删行。
    """
    by_std_nm: dict[str, list[str]] = {}
    by_std_no: dict[str, list[str]] = {}
    for sid, d in agg.items():
        std = _name_std_key_for_merge(d)
        if not std:
            continue
        pid = str(d.get("subject_no") or "").strip()
        if pid:
            by_std_no.setdefault(std, []).append(sid)
        else:
            by_std_nm.setdefault(std, []).append(sid)

    merge_pairs: list[tuple[str, str]] = []
    for std, nm_sids in by_std_nm.items():
        no_sids = by_std_no.get(std, [])
        if len(no_sids) != 1:
            continue
        no_sid = no_sids[0]
        tgt = agg[no_sid]
        for nm_sid in nm_sids:
            if nm_sid == no_sid or nm_sid not in agg:
                continue
            src = agg[nm_sid]
            dn = str(tgt.get("subject_name") or "").strip()
            sn = str(src.get("subject_name") or "").strip()
            if len(sn) > len(dn):
                tgt["subject_name"] = sn
            tgt["subject_name_std"] = normalize_party_name(str(tgt.get("subject_name") or ""))
            pid = str(tgt.get("subject_no") or "").strip()
            tgt["subject_category"] = subject_category_for_ingest(pid)
            tgt["subject_no_type"] = _subject_no_type(pid)
            tgt["first_batch"] = _min_nonempty_str(
                str(src.get("first_batch") or ""),
                str(tgt.get("first_batch") or ""),
            )
            tgt["last_batch"] = _max_nonempty_str(
                str(src.get("last_batch") or ""),
                str(tgt.get("last_batch") or ""),
            )
            tgt["first_session"] = _min_nonempty_str(
                str(src.get("first_session") or ""),
                str(tgt.get("first_session") or ""),
            )
            tgt["last_session"] = _max_nonempty_str(
                str(src.get("last_session") or ""),
                str(tgt.get("last_session") or ""),
            )
            merge_pairs.append((nm_sid, no_sid))
            del agg[nm_sid]
            logger.info(
                "主体 DWD 归集：名称键并入税号键 subject_id %s -> %s（name_std=%s）",
                nm_sid,
                no_sid,
                std[:80] + ("…" if len(std) > 80 else ""),
            )
    return merge_pairs


def _merge_preserve_rows(primary: dict[str, Any], secondary: dict[str, Any]) -> dict[str, Any]:
    out = dict(primary)
    for k, v in secondary.items():
        if out.get(k) is None and v is not None:
            out[k] = v
    return out


def _repoint_subject_foreign_keys(conn, old_id: str, new_id: str) -> None:
    """将子表中旧 subject_id 改为合并后的 canonical id（尽力而为，缺表则忽略）。"""
    stmts: list[tuple[str, list[Any]]] = [
        ("UPDATE dim_subject_rename_signal SET subject_id = ? WHERE subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_source_record SET subject_id = ? WHERE subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_master_repair_log SET subject_id = ? WHERE subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_category_snapshot SET subject_id = ? WHERE subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_relation_current SET left_subject_id = ? WHERE left_subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_relation_current SET right_subject_id = ? WHERE right_subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_relation_snapshot SET left_subject_id = ? WHERE left_subject_id = ?", [new_id, old_id]),
        ("UPDATE dim_subject_relation_snapshot SET right_subject_id = ? WHERE right_subject_id = ?", [new_id, old_id]),
    ]
    for sql, args in stmts:
        try:
            conn.execute(sql, args)
        except Exception as exc:  # noqa: BLE001
            logger.debug("FK 重挂跳过（表或列可能不存在）：%s", exc)

    # 年度关系表主键 (subject_id, stat_year)：冲突时删旧名键行，否则改 id
    try:
        yrows = conn.execute(
            "SELECT stat_year FROM dim_enterprise_year_rel WHERE subject_id = ?",
            [old_id],
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.debug("读取 dim_enterprise_year_rel 失败，跳过年度关系重挂：%s", exc)
        return
    for (yr,) in yrows:
        if yr is None:
            continue
        try:
            ex = conn.execute(
                "SELECT 1 FROM dim_enterprise_year_rel WHERE subject_id = ? AND stat_year = ?",
                [new_id, yr],
            ).fetchone()
            if ex:
                conn.execute(
                    "DELETE FROM dim_enterprise_year_rel WHERE subject_id = ? AND stat_year = ?",
                    [old_id, yr],
                )
            else:
                conn.execute(
                    "UPDATE dim_enterprise_year_rel SET subject_id = ? WHERE subject_id = ? AND stat_year = ?",
                    [new_id, old_id, yr],
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("年度关系 subject_id 重挂失败 old=%s new=%s year=%s: %s", old_id, new_id, yr, exc)


def ingest_dim_subject_master_from_dwd(
    conn,
    *,
    run_id: str | None = None,
    overwrite_manual_repairs: bool = False,
) -> dict[str, Any]:
    """
    从 dwd_inv_header 的销方/购方归集写入 dim_subject_master。
    不再写入 dim_subject_source_record 的购销 match_rule 行（拍板 1-B：购销语义不在主体库来源表承载）。

    对账合并：若全量发票事实下，同一规范化名称同时出现「仅名称键」（无税号）与「唯一税号键」主体，
    则将名称键并入税号键（保留税号侧 subject_id），并重挂子表外键、删除名称键主表行。
    """
    init_all_tables(conn)
    try:
        conn.execute("SELECT 1 FROM dwd_inv_header LIMIT 1")
    except Exception:
        return {
            "ok": False,
            "error": "dwd_inv_header 不可读或不存在，请先完成 ODS→DWD 构建。",
            "subjects_upserted": 0,
            "header_rows_scanned": 0,
        }

    run_id = run_id or _make_run_id("subject_dwd_ingest")
    now = datetime.now()
    respect_manual_repairs = not overwrite_manual_repairs
    repair_map = load_repaired_field_map(conn) if respect_manual_repairs else {}
    manual_repair_preserved = 0

    header_rows = int(
        conn.execute("SELECT COUNT(*)::BIGINT FROM dwd_inv_header").fetchone()[0] or 0
    )

    # DuckDB 内聚合，避免对全量发票头在 Python 中逐行归集（与 normalize_party_id/name 语义对齐）
    rows = conn.execute(
        """
        WITH base AS (
            SELECT
                'seller'::VARCHAR AS side,
                COALESCE(xfsbh, '') AS raw_no,
                COALESCE(xfmc, '') AS raw_name,
                COALESCE(import_batch_id, first_import_batch_id, '') AS bid,
                COALESCE(import_session_id, '') AS sid,
                CAST(invoice_date AS DATE) AS inv
            FROM dwd_inv_header
            UNION ALL
            SELECT
                'buyer'::VARCHAR,
                COALESCE(gfsbh, ''),
                COALESCE(gfmc, ''),
                COALESCE(import_batch_id, first_import_batch_id, ''),
                COALESCE(import_session_id, ''),
                CAST(invoice_date AS DATE)
            FROM dwd_inv_header
        ),
        n AS (
            SELECT
                side,
                upper(regexp_replace(trim(raw_no), '[\\s-]+', '', 'g')) AS pid,
                regexp_replace(trim(raw_name), '\\s+', '', 'g') AS pname_std,
                trim(raw_name) AS raw_name_t,
                bid,
                sid,
                inv
            FROM base
        ),
        k AS (
            SELECT
                *,
                CASE
                    WHEN length(pid) > 0 THEN 'NO:' || pid
                    WHEN length(pname_std) > 0 THEN 'NM:' || pname_std
                    ELSE ''
                END AS mk
            FROM n
            WHERE length(pid) > 0 OR length(pname_std) > 0
        ),
        g AS (
            SELECT
                mk,
                max(pid) AS pid,
                max(pname_std) AS pname_std,
                arg_max(nullif(raw_name_t, ''), length(nullif(raw_name_t, ''))) AS best_name,
                min(inv) AS first_inv,
                max(inv) AS last_inv,
                min_by(bid, coalesce(inv, DATE '9999-12-31')) AS first_bid,
                max_by(bid, coalesce(inv, DATE '1900-01-01')) AS last_bid,
                min_by(sid, coalesce(inv, DATE '9999-12-31')) AS first_sid,
                max_by(sid, coalesce(inv, DATE '1900-01-01')) AS last_sid
            FROM k
            GROUP BY mk
        )
        SELECT
            mk,
            pid,
            pname_std,
            best_name,
            first_bid,
            last_bid,
            first_sid,
            last_sid
        FROM g
        """
    ).fetchall()

    agg: dict[str, dict[str, Any]] = {}
    for (
        _mk,
        pid,
        pname_std,
        best_name,
        first_bid,
        last_bid,
        first_sid,
        last_sid,
    ) in rows:
        pid_py = str(pid or "")
        pname_py = str(pname_std or "")
        sid = _stable_subject_id(pid_py, pname_py)
        if not sid:
            continue
        raw_bn = best_name if best_name is not None else ""
        display = str(raw_bn).strip() or pid_py or "（未知主体）"
        cat: str = subject_category_for_ingest(pid_py)
        agg[sid] = {
            "subject_id": sid,
            "subject_no": pid_py,
            "subject_name": display,
            "subject_name_std": normalize_party_name(display),
            "subject_category": cat,
            "subject_no_type": _subject_no_type(pid_py),
            "first_batch": str(first_bid or ""),
            "first_session": str(first_sid or ""),
            "last_batch": str(last_bid or ""),
            "last_session": str(last_sid or ""),
        }

    merge_pairs = _merge_invoice_agg_name_key_into_tax_id(agg)
    merged_nm_ids = {nm for nm, _ in merge_pairs}
    merged_no_ids = {no for _, no in merge_pairs}

    master_rows: list[tuple[Any, ...]] = []
    existing_created: dict[str, datetime] = {}
    preserve: dict[str, dict[str, Any]] = {}
    ids_to_fetch = list(set(agg.keys()) | merged_nm_ids)
    if ids_to_fetch:
        chunk = 400
        for i in range(0, len(ids_to_fetch), chunk):
            part = ids_to_fetch[i : i + chunk]
            ph = ",".join(["?"] * len(part))
            for row in conn.execute(
                f"""
                SELECT
                    subject_id,
                    created_at,
                    subject_category,
                    org_category,
                    subject_snapshot_id,
                    category_rule_version,
                    category_rule_enabled_at_run,
                    category_status_note,
                    quality_status,
                    quality_issue
                FROM dim_subject_master
                WHERE subject_id IN ({ph})
                """,
                part,
            ).fetchall():
                sid = str(row[0] or "")
                ca = row[1]
                existing_created[sid] = ca if isinstance(ca, datetime) else now
                preserve[sid] = {
                    "subject_category": row[2],
                    "org_category": row[3],
                    "subject_snapshot_id": row[4],
                    "category_rule_version": row[5],
                    "category_rule_enabled_at_run": row[6]
                    if row[6] is not None
                    else True,
                    "category_status_note": row[7],
                    "quality_status": row[8] or "ok",
                    "quality_issue": row[9],
                }

    for nm_sid, no_sid in merge_pairs:
        p_no = preserve.get(no_sid, {})
        p_nm = preserve.get(nm_sid, {})
        preserve[no_sid] = _merge_preserve_rows(p_no, p_nm)
        preserve.pop(nm_sid, None)
        ca = existing_created.get(no_sid)
        cb = existing_created.get(nm_sid)
        if isinstance(ca, datetime) and isinstance(cb, datetime):
            existing_created[no_sid] = min(ca, cb)
        elif isinstance(cb, datetime) and not isinstance(ca, datetime):
            existing_created[no_sid] = cb
        elif isinstance(ca, datetime):
            existing_created[no_sid] = ca
        else:
            existing_created[no_sid] = now
        existing_created.pop(nm_sid, None)

    for sid, a in agg.items():
        created = existing_created.get(sid, now)
        pr = preserve.get(sid, {})
        src_status = "merged" if sid in merged_no_ids else "single"
        sid_str = str(sid)
        incoming_cat = str(a["subject_category"])
        cat = resolve_subject_category_for_upsert(
            subject_id=sid_str,
            incoming_category=incoming_cat,
            existing_category=str(pr.get("subject_category") or "") or None,
            repair_map=repair_map,
            respect_manual_repairs=respect_manual_repairs,
        )
        incoming_org = pr.get("org_category") if sid in preserve else None
        org = resolve_org_category_for_upsert(
            subject_id=sid_str,
            incoming_org_category=incoming_org,
            existing_org_category=pr.get("org_category"),
            repair_map=repair_map,
            respect_manual_repairs=respect_manual_repairs,
        )
        if respect_manual_repairs and sid_str in repair_map:
            manual_repair_preserved += 1
        master_rows.append(
            (
                sid,
                str(a["subject_name"]),
                str(a["subject_name_std"] or ""),
                cat,
                org,
                str(a["subject_no"] or "") or None,
                str(a["subject_no_type"] or "") or None,
                src_status,
                "invoice",
                str(a["first_batch"] or ""),
                str(a["first_session"] or ""),
                str(a["last_batch"] or ""),
                str(a["last_session"] or ""),
                str(pr.get("quality_status") or "ok"),
                pr.get("quality_issue"),
                run_id,
                pr.get("subject_snapshot_id"),
                pr.get("category_rule_version"),
                bool(pr.get("category_rule_enabled_at_run", True)),
                pr.get("category_status_note"),
                created,
                now,
            )
        )

    conn.execute("BEGIN TRANSACTION")
    try:
        if master_rows:
            conn.executemany(
                """
                INSERT OR REPLACE INTO dim_subject_master (
                    subject_id,
                    subject_name,
                    subject_name_std,
                    subject_category,
                    org_category,
                    subject_no,
                    subject_no_type,
                    source_status,
                    first_source_system,
                    first_import_batch_id,
                    first_import_session_id,
                    last_import_batch_id,
                    last_import_session_id,
                    quality_status,
                    quality_issue,
                    subject_build_run_id,
                    subject_snapshot_id,
                    category_rule_version,
                    category_rule_enabled_at_run,
                    category_status_note,
                    created_at,
                    updated_at
                ) VALUES (
                    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
                )
                """,
                master_rows,
            )
        for nm_sid, no_sid in merge_pairs:
            _repoint_subject_foreign_keys(conn, nm_sid, no_sid)
            conn.execute("DELETE FROM dim_subject_master WHERE subject_id = ?", [nm_sid])
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    # 台账仍为 external，但发票头已能匹配税号 → 纠偏为 invoice（与主体库「平台计算」口径一致）
    try:
        from src.local_api.subject_library import sql_dim_subject_matches_dwd_invoice_header

        inv_sql = sql_dim_subject_matches_dwd_invoice_header("m")
        conn.execute(
            f"""
            UPDATE dim_subject_master AS m
            SET
                first_source_system = 'invoice',
                updated_at = ?
            WHERE lower(trim(COALESCE(m.first_source_system,''))) = 'external'
              AND ({inv_sql})
            """,
            [now],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "纠偏 external→invoice（按 dwd_inv_header 税号）失败，已忽略：%s: %s",
            type(exc).__name__,
            exc,
        )

    try:
        from src.local_api.subject_library_display_cache import refresh_subject_library_display_cache

        refresh_subject_library_display_cache(conn)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "归集后刷新主体库展示缓存失败，已忽略：%s: %s",
            type(exc).__name__,
            exc,
        )

    return {
        "ok": True,
        "run_id": run_id,
        "header_rows_scanned": header_rows,
        "subjects_upserted": len(agg),
        "subjects_merged_name_key_into_tax": len(merge_pairs),
        "source_rows_upserted": 0,
        "manual_repair_preserved": manual_repair_preserved,
        "overwrite_manual_repairs": overwrite_manual_repairs,
    }
