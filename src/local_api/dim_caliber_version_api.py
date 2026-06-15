from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_USER = "数据治理管理员"
_CHUNK = 500


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _ensure_table(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dim_caliber_version (
            version_id             VARCHAR NOT NULL PRIMARY KEY,
            stat_year              SMALLINT NOT NULL,
            version_no             INTEGER NOT NULL,
            status                 VARCHAR NOT NULL DEFAULT 'draft',
            is_current             BOOLEAN DEFAULT FALSE,
            rule_version           VARCHAR,
            batch_start            VARCHAR,
            batch_end              VARCHAR,
            include_external_import BOOLEAN DEFAULT FALSE,
            external_import_batch_count INTEGER DEFAULT 0,
            change_note            VARCHAR,
            kpis_json              VARCHAR,
            updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_by             VARCHAR,
            published_at           TIMESTAMP,
            published_by           VARCHAR,
            UNIQUE (stat_year, version_no),
            CHECK (status IN ('draft', 'published', 'archived'))
        )
        """
    )


def _stat_years(conn: Any) -> list[int]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM dim_enterprise_year_roster WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT CAST(snapshot_year AS INTEGER) FROM dim_audited_enterprise_registry WHERE snapshot_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM dwd_inv_header WHERE stat_year IS NOT NULL",
    ):
        try:
            for r in conn.execute(sql).fetchall():
                if r and r[0] is not None:
                    yi = int(r[0])
                    if 1990 <= yi <= 2100:
                        years.add(yi)
        except Exception:
            pass
    if not years:
        years.add(datetime.now().year)
    return sorted(years, reverse=True)


def compute_live_kpis(conn: Any, stat_year: int) -> dict[str, Any]:
    """从现库汇总年度口径 KPI 快照（读路径，不写库）。"""
    subject_total = 0
    org_count = 0
    try:
        row = conn.execute(
            """
            SELECT
                COUNT(DISTINCT sm.subject_id)::BIGINT AS total,
                COUNT(DISTINCT sm.subject_id) FILTER (WHERE sm.subject_category = 'org')::BIGINT AS org_count
            FROM dim_subject_master sm
            WHERE EXISTS (
                SELECT 1
                FROM dwd_inv_header h
                WHERE h.stat_year = ?
                  AND (
                    upper(regexp_replace(trim(COALESCE(h.xfsbh, '')), '[\\s-]+', '', 'g'))
                      = upper(regexp_replace(trim(COALESCE(sm.subject_no, '')), '[\\s-]+', '', 'g'))
                    OR upper(regexp_replace(trim(COALESCE(h.gfsbh, '')), '[\\s-]+', '', 'g'))
                      = upper(regexp_replace(trim(COALESCE(sm.subject_no, '')), '[\\s-]+', '', 'g'))
                  )
            )
            """,
            [stat_year],
        ).fetchone()
        if row:
            subject_total = int(row[0] or 0)
            org_count = int(row[1] or 0)
    except Exception:
        logger.debug("compute_live_kpis subject by dwd failed year=%s", stat_year, exc_info=True)

    if subject_total <= 0:
        try:
            row = conn.execute(
                """
                SELECT
                    COUNT(*)::BIGINT,
                    COUNT(*) FILTER (WHERE subject_category = 'org')::BIGINT
                FROM dim_subject_master
                """
            ).fetchone()
            if row:
                subject_total = int(row[0] or 0)
                org_count = int(row[1] or 0)
        except Exception:
            pass

    enterprise_ratio = round(org_count / subject_total * 100, 1) if subject_total else 0.0

    roster_total = 0
    mapped = 0
    try:
        rel = conn.execute(
            """
            SELECT
                COUNT(*)::BIGINT,
                COUNT(*) FILTER (
                    WHERE subject_id IS NOT NULL AND trim(COALESCE(subject_id, '')) <> ''
                )::BIGINT
            FROM dim_enterprise_year_roster
            WHERE stat_year = ?
            """,
            [stat_year],
        ).fetchone()
        if rel:
            roster_total = int(rel[0] or 0)
            mapped = int(rel[1] or 0)
    except Exception:
        pass

    if roster_total <= 0:
        try:
            reg = conn.execute(
                "SELECT COUNT(*)::BIGINT FROM dim_audited_enterprise_registry WHERE snapshot_year = ?",
                [stat_year],
            ).fetchone()
            roster_total = int(reg[0] or 0) if reg else 0
        except Exception:
            pass

    mapping_coverage = round(mapped / roster_total * 100, 1) if roster_total else 0.0
    unmatched_count = max(0, roster_total - mapped)

    batch_start = ""
    batch_end = ""
    try:
        br = conn.execute(
            """
            SELECT MIN(import_batch_id), MAX(import_batch_id)
            FROM dwd_inv_header
            WHERE stat_year = ?
              AND nullif(trim(import_batch_id), '') IS NOT NULL
            """,
            [stat_year],
        ).fetchone()
        if br:
            batch_start = str(br[0] or "")
            batch_end = str(br[1] or "")
    except Exception:
        pass

    external_batch_count = 0
    include_external = False
    try:
        ext = conn.execute(
            """
            SELECT COUNT(DISTINCT COALESCE(first_import_batch_id, last_import_batch_id))::BIGINT
            FROM dim_subject_master
            WHERE lower(COALESCE(first_source_system, '')) = 'external'
            """
        ).fetchone()
        external_batch_count = int(ext[0] or 0) if ext else 0
        include_external = external_batch_count > 0
    except Exception:
        pass

    rule_version = "v1.0"
    try:
        rv = conn.execute(
            "SELECT MAX(category_rule_version) FROM dim_subject_master WHERE nullif(trim(category_rule_version), '') IS NOT NULL"
        ).fetchone()
        if rv and rv[0]:
            rule_version = str(rv[0])
    except Exception:
        pass

    return {
        "subjectTotal": subject_total,
        "enterpriseRatio": enterprise_ratio,
        "mappingCoverage": mapping_coverage,
        "unmatchedCount": unmatched_count,
        "batchStart": batch_start,
        "batchEnd": batch_end,
        "ruleVersion": rule_version,
        "includeExternalImport": include_external,
        "externalImportBatchCount": external_batch_count,
    }


def _row_to_version(row: tuple[Any, ...]) -> dict[str, Any]:
    kpis_raw = row[10]
    kpis: dict[str, Any] = {}
    if kpis_raw:
        try:
            kpis = json.loads(str(kpis_raw))
        except Exception:
            kpis = {}

    def _ts(v: Any) -> str | None:
        if v is None:
            return None
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d %H:%M")
        s = str(v).strip()
        return s[:16] if s else None

    stat_year = int(row[1])
    version_no = int(row[2])
    return {
        "id": str(row[0]),
        "statYear": str(stat_year),
        "versionNo": version_no,
        "status": str(row[3] or "draft"),
        "isCurrent": bool(row[4]),
        "ruleVersion": str(row[5] or ""),
        "batchStart": str(row[6] or ""),
        "batchEnd": str(row[7] or ""),
        "includeExternalImport": bool(row[8]),
        "externalImportBatchCount": int(row[9] or 0),
        "changeNote": str(row[11] or ""),
        "updatedAt": _ts(row[12]) or "",
        "updatedBy": str(row[13] or ""),
        "publishedAt": _ts(row[14]),
        "publishedBy": str(row[15]) if row[15] else None,
        "kpis": {
            "subjectTotal": int(kpis.get("subjectTotal") or 0),
            "enterpriseRatio": float(kpis.get("enterpriseRatio") or 0),
            "mappingCoverage": float(kpis.get("mappingCoverage") or 0),
            "unmatchedCount": int(kpis.get("unmatchedCount") or 0),
        },
    }


def _load_versions(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT
            version_id, stat_year, version_no, status, is_current,
            rule_version, batch_start, batch_end,
            include_external_import, external_import_batch_count,
            kpis_json, change_note, updated_at, updated_by,
            published_at, published_by
        FROM dim_caliber_version
        ORDER BY stat_year DESC, version_no DESC
        """
    ).fetchall()
    return [_row_to_version(r) for r in rows]


def _seed_initial_version(conn: Any, stat_year: int) -> None:
    live = compute_live_kpis(conn, stat_year)
    kpis = {
        "subjectTotal": live["subjectTotal"],
        "enterpriseRatio": live["enterpriseRatio"],
        "mappingCoverage": live["mappingCoverage"],
        "unmatchedCount": live["unmatchedCount"],
    }
    vid = f"{stat_year}-v1"
    now = datetime.now()
    conn.execute(
        """
        INSERT INTO dim_caliber_version (
            version_id, stat_year, version_no, status, is_current,
            rule_version, batch_start, batch_end,
            include_external_import, external_import_batch_count,
            change_note, kpis_json, updated_at, updated_by,
            published_at, published_by
        ) VALUES (?, ?, 1, 'published', TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            vid,
            stat_year,
            live["ruleVersion"],
            live["batchStart"],
            live["batchEnd"],
            live["includeExternalImport"],
            live["externalImportBatchCount"],
            "系统根据现库 KPI 自动初始化首版口径。",
            json.dumps(kpis, ensure_ascii=False),
            now,
            _DEFAULT_USER,
            now,
            _DEFAULT_USER,
        ],
    )


def api_dim_caliber_versions_list(conn: Any) -> dict[str, Any]:
    try:
        _ensure_table(conn)
        versions = _load_versions(conn)
        if not versions:
            for y in _stat_years(conn):
                _seed_initial_version(conn, y)
            versions = _load_versions(conn)
        stat_years = sorted({v["statYear"] for v in versions}, key=lambda x: int(x), reverse=True)
        return {"ok": True, "versions": versions, "stat_years": stat_years}
    except Exception as exc:
        logger.exception("dim_caliber_versions_list failed")
        return {
            "ok": False,
            "error": {"message": str(exc), "exception_type": type(exc).__name__},
        }


def _get_version(conn: Any, version_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT
            version_id, stat_year, version_no, status, is_current,
            rule_version, batch_start, batch_end,
            include_external_import, external_import_batch_count,
            kpis_json, change_note, updated_at, updated_by,
            published_at, published_by
        FROM dim_caliber_version
        WHERE version_id = ?
        """,
        [version_id],
    ).fetchone()
    return _row_to_version(row) if row else None


def api_dim_caliber_version_create_draft(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        _ensure_table(conn)
        stat_year_s = str(body.get("stat_year") or body.get("statYear") or "").strip()
        if not stat_year_s.isdigit():
            return {"ok": False, "error": {"message": "缺少有效 stat_year"}}
        stat_year = int(stat_year_s)

        current = conn.execute(
            """
            SELECT version_id FROM dim_caliber_version
            WHERE stat_year = ? AND is_current = TRUE AND status = 'published'
            ORDER BY version_no DESC LIMIT 1
            """,
            [stat_year],
        ).fetchone()
        if not current:
            _seed_initial_version(conn, stat_year)
            current = conn.execute(
                """
                SELECT version_id FROM dim_caliber_version
                WHERE stat_year = ? AND is_current = TRUE AND status = 'published'
                ORDER BY version_no DESC LIMIT 1
                """,
                [stat_year],
            ).fetchone()
        base = _get_version(conn, str(current[0])) if current else None
        if not base:
            return {"ok": False, "error": {"message": "无可用当前生效版本"}}

        live = compute_live_kpis(conn, stat_year)
        max_no = conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) FROM dim_caliber_version WHERE stat_year = ?",
            [stat_year],
        ).fetchone()
        next_no = int(max_no[0] or 0) + 1
        vid = f"{stat_year}-v{next_no}"
        kpis = {
            "subjectTotal": live["subjectTotal"],
            "enterpriseRatio": live["enterpriseRatio"],
            "mappingCoverage": live["mappingCoverage"],
            "unmatchedCount": live["unmatchedCount"],
        }
        note = str(body.get("change_note") or body.get("changeNote") or "").strip()
        if not note:
            note = "基于当前生效版本复制创建草稿。"
        now = datetime.now()
        user = str(body.get("updated_by") or body.get("updatedBy") or _DEFAULT_USER).strip() or _DEFAULT_USER
        conn.execute(
            """
            INSERT INTO dim_caliber_version (
                version_id, stat_year, version_no, status, is_current,
                rule_version, batch_start, batch_end,
                include_external_import, external_import_batch_count,
                change_note, kpis_json, updated_at, updated_by
            ) VALUES (?, ?, ?, 'draft', FALSE, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                vid,
                stat_year,
                next_no,
                live["ruleVersion"] or base["ruleVersion"],
                live["batchStart"] or base["batchStart"],
                live["batchEnd"] or base["batchEnd"],
                live["includeExternalImport"],
                live["externalImportBatchCount"],
                note,
                json.dumps(kpis, ensure_ascii=False),
                now,
                user,
            ],
        )
        return {"ok": True, "version": _get_version(conn, vid)}
    except Exception as exc:
        logger.exception("create_draft failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dim_caliber_version_publish(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        _ensure_table(conn)
        vid = str(body.get("version_id") or body.get("versionId") or "").strip()
        if not vid:
            return {"ok": False, "error": {"message": "缺少 version_id"}}
        row = conn.execute(
            "SELECT stat_year, status FROM dim_caliber_version WHERE version_id = ?",
            [vid],
        ).fetchone()
        if not row:
            return {"ok": False, "error": {"message": "版本不存在"}}
        if str(row[1]) != "draft":
            return {"ok": False, "error": {"message": "仅草稿版本可发布"}}
        stat_year = int(row[0])
        live = compute_live_kpis(conn, stat_year)
        kpis = {
            "subjectTotal": live["subjectTotal"],
            "enterpriseRatio": live["enterpriseRatio"],
            "mappingCoverage": live["mappingCoverage"],
            "unmatchedCount": live["unmatchedCount"],
        }
        now = datetime.now()
        user = str(body.get("updated_by") or body.get("updatedBy") or _DEFAULT_USER).strip() or _DEFAULT_USER
        conn.execute(
            "UPDATE dim_caliber_version SET is_current = FALSE WHERE stat_year = ?",
            [stat_year],
        )
        conn.execute(
            """
            UPDATE dim_caliber_version SET
                status = 'published',
                is_current = TRUE,
                rule_version = ?,
                batch_start = ?,
                batch_end = ?,
                include_external_import = ?,
                external_import_batch_count = ?,
                kpis_json = ?,
                updated_at = ?,
                updated_by = ?,
                published_at = ?,
                published_by = ?
            WHERE version_id = ?
            """,
            [
                live["ruleVersion"],
                live["batchStart"],
                live["batchEnd"],
                live["includeExternalImport"],
                live["externalImportBatchCount"],
                json.dumps(kpis, ensure_ascii=False),
                now,
                user,
                now,
                user,
                vid,
            ],
        )
        return {"ok": True, "version": _get_version(conn, vid)}
    except Exception as exc:
        logger.exception("publish failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dim_caliber_version_rollback(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        _ensure_table(conn)
        vid = str(body.get("version_id") or body.get("versionId") or "").strip()
        if not vid:
            return {"ok": False, "error": {"message": "缺少 version_id"}}
        cur = _get_version(conn, vid)
        if not cur or cur["status"] != "published":
            return {"ok": False, "error": {"message": "仅已发布版本可回滚"}}
        stat_year = int(cur["statYear"])
        prev_row = conn.execute(
            """
            SELECT version_id FROM dim_caliber_version
            WHERE stat_year = ?
              AND status = 'published'
              AND version_no < ?
            ORDER BY version_no DESC
            LIMIT 1
            """,
            [stat_year, cur["versionNo"]],
        ).fetchone()
        if not prev_row:
            return {"ok": False, "error": {"message": "无可回滚的上一发布版本"}}
        prev_id = str(prev_row[0])
        now = datetime.now()
        user = str(body.get("updated_by") or body.get("updatedBy") or _DEFAULT_USER).strip() or _DEFAULT_USER
        conn.execute(
            "UPDATE dim_caliber_version SET is_current = FALSE WHERE stat_year = ?",
            [stat_year],
        )
        conn.execute(
            "UPDATE dim_caliber_version SET is_current = FALSE, updated_at = ?, updated_by = ? WHERE version_id = ?",
            [now, user, vid],
        )
        conn.execute(
            """
            UPDATE dim_caliber_version SET
                is_current = TRUE,
                updated_at = ?,
                updated_by = ?
            WHERE version_id = ?
            """,
            [now, user, prev_id],
        )
        return {"ok": True, "version": _get_version(conn, prev_id)}
    except Exception as exc:
        logger.exception("rollback failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dim_caliber_version_archive(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        _ensure_table(conn)
        vid = str(body.get("version_id") or body.get("versionId") or "").strip()
        if not vid:
            return {"ok": False, "error": {"message": "缺少 version_id"}}
        row = conn.execute(
            "SELECT status, is_current FROM dim_caliber_version WHERE version_id = ?",
            [vid],
        ).fetchone()
        if not row:
            return {"ok": False, "error": {"message": "版本不存在"}}
        if str(row[0]) == "archived":
            return {"ok": False, "error": {"message": "版本已归档"}}
        now = datetime.now()
        user = str(body.get("updated_by") or body.get("updatedBy") or _DEFAULT_USER).strip() or _DEFAULT_USER
        conn.execute(
            """
            UPDATE dim_caliber_version SET
                status = 'archived',
                is_current = FALSE,
                updated_at = ?,
                updated_by = ?
            WHERE version_id = ?
            """,
            [now, user, vid],
        )
        return {"ok": True, "version": _get_version(conn, vid)}
    except Exception as exc:
        logger.exception("archive failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_dim_caliber_version_save_draft(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        _ensure_table(conn)
        vid = str(body.get("version_id") or body.get("versionId") or "").strip()
        if not vid:
            return {"ok": False, "error": {"message": "缺少 version_id"}}
        note = body.get("change_note") if "change_note" in body else body.get("changeNote")
        now = datetime.now()
        user = str(body.get("updated_by") or body.get("updatedBy") or _DEFAULT_USER).strip() or _DEFAULT_USER
        if note is not None:
            conn.execute(
                """
                UPDATE dim_caliber_version SET change_note = ?, updated_at = ?, updated_by = ?
                WHERE version_id = ? AND status = 'draft'
                """,
                [str(note), now, user, vid],
            )
        else:
            conn.execute(
                "UPDATE dim_caliber_version SET updated_at = ?, updated_by = ? WHERE version_id = ? AND status = 'draft'",
                [now, user, vid],
            )
        ver = _get_version(conn, vid)
        if not ver:
            return {"ok": False, "error": {"message": "版本不存在"}}
        return {"ok": True, "version": ver}
    except Exception as exc:
        logger.exception("save_draft failed")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}
