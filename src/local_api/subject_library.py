from __future__ import annotations

"""
主体库列表 API：dim_subject_master 仅持久化 org_category（编码）。
机构类别中文名（category_name）一律在展示层由本模块调用 get_org_category_display_names()
对照 config/subject_category*.yaml 解析，不向主表冗余写入。
"""

from typing import Any


def _org_category_code_to_display_name() -> dict[str, str]:
    """从 subject_category 规则文件解析 category_code → category_name。"""
    from src.subject_category.infer import load_category_doc

    doc = load_category_doc()
    out: dict[str, str] = {}
    rows = doc.get("categories")
    if not isinstance(rows, list):
        return out
    for it in rows:
        if not isinstance(it, dict):
            continue
        code = str(it.get("category_code") or "").strip()
        name = str(it.get("category_name") or "").strip()
        if code and name:
            out[code] = name
    return out


def get_org_category_display_names() -> dict[str, str]:
    """
    供主体库相关 API 复用：编码 → 类别中文名（与 dim_subject_master.org_category 对照）。
    数据来自 load_category_doc() 指向的 YAML，与重算分类使用的类别定义一致。
    """
    return _org_category_code_to_display_name()


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


def sql_dim_subject_matches_dwd_invoice_header(table_alias: str) -> str:
    """
    与 dwd_inv_header 销/购方税号归一化口径一致：主体 subject_no 是否曾在发票头出现。
    用于单次 UPDATE（如 DWD 归集后纠偏）；列表查询请用 sql_invoice_pid_left_join + inv_hit，避免相关子查询扫全表。
    """
    m = table_alias
    pid = f"upper(regexp_replace(trim(COALESCE({m}.subject_no,'')), '[\\s-]+', '', 'g'))"
    return f"""EXISTS (
        SELECT 1 FROM dwd_inv_header h
        WHERE length(trim(COALESCE({m}.subject_no,''))) > 0
          AND length({pid}) > 0
          AND {pid} IN (
            upper(regexp_replace(trim(COALESCE(h.xfsbh,'')), '[\\s-]+', '', 'g')),
            upper(regexp_replace(trim(COALESCE(h.gfsbh,'')), '[\\s-]+', '', 'g'))
          )
    )"""


def sql_invoice_pid_left_join(table_alias: str) -> str:
    """
    将 dwd_inv_header 销/购归一化税号做成去重集 inv_hit，与主体 subject_no 一次 LEFT JOIN。
    避免在 SELECT/WHERE 中对每行执行 EXISTS 相关子查询（大数据量下易拖垮请求、前端代理表现为 502）。
    """
    m = table_alias
    pid = f"upper(regexp_replace(trim(COALESCE({m}.subject_no,'')), '[\\s-]+', '', 'g'))"
    return (
        " LEFT JOIN ("
        " SELECT DISTINCT u.pid FROM ("
        " SELECT upper(regexp_replace(trim(COALESCE(xfsbh,'')), '[\\s-]+', '', 'g')) AS pid"
        " FROM dwd_inv_header WHERE length(trim(COALESCE(xfsbh,''))) > 0"
        " UNION "
        " SELECT upper(regexp_replace(trim(COALESCE(gfsbh,'')), '[\\s-]+', '', 'g')) AS pid"
        " FROM dwd_inv_header WHERE length(trim(COALESCE(gfsbh,''))) > 0"
        " ) AS u WHERE length(u.pid) > 0"
        f" ) AS inv_hit ON inv_hit.pid = {pid}"
    )


def _sql_subject_source_bucket(table_alias: str) -> str:
    """
    dim_subject_master.first_source_system 语义（DDL）：invoice / external / manual。
    列表「数据来源」对外只暴露 platform（平台计算）与 external（外部导入）：
    - platform：非 external；或台账为 external 但 inv_hit 命中（发票头曾出现该税号）；
    - external：纯外部且 inv_hit 未命中。
    调用方 SQL 须包含 sql_invoice_pid_left_join(主表别名) 且子查询别名为 inv_hit。
    """
    m = table_alias
    return (
        f"CASE WHEN lower(trim(COALESCE({m}.first_source_system,''))) <> 'external' "
        f"THEN 'platform' WHEN inv_hit.pid IS NOT NULL THEN 'platform' ELSE 'external' END"
    )


def _append_subject_keyword_clause(
    where_parts: list[str],
    args: list[Any],
    *,
    table_alias: str,
    keyword: str,
) -> None:
    """主体名称 / 规范化名称 / 识别号 / subject_id 子串模糊（ILIKE %kw%）。"""
    k = str(keyword or "").strip()
    if not k:
        return
    m = table_alias
    kw = f"%{k}%"
    where_parts.append(
        f"(COALESCE({m}.subject_name,'') ILIKE ? OR COALESCE({m}.subject_name_std,'') ILIKE ? OR "
        f"COALESCE({m}.subject_no,'') ILIKE ? OR COALESCE({m}.subject_id,'') ILIKE ?)"
    )
    args.extend([kw, kw, kw, kw])


def _master_where_parts(
    *,
    subject_type: str,
    source_type: str,
    table_alias: str,
) -> tuple[list[str], list[Any]]:
    """dim_subject_master 公共筛选片段（与 _master_where_sql_and_args 一致）。"""
    st = _norm_subject_type(subject_type)
    src = _norm_source_type(source_type)
    m = table_alias
    where_parts: list[str] = ["1=1"]
    args: list[Any] = []

    if st != "all":
        where_parts.append(f"{m}.subject_category = ?")
        args.append(st)
    if src != "all":
        where_parts.append(f"{_sql_subject_source_bucket(m)} = ?")
        args.append(src)
    return where_parts, args


def _master_where_sql_and_args(
    *,
    subject_type: str,
    source_type: str,
    table_alias: str,
) -> tuple[str, list[Any]]:
    """dim_subject_master 公共筛选（无年度、无购销角色）。table_alias 如 'm' 或 'dim_subject_master'。"""
    parts, args = _master_where_parts(
        subject_type=subject_type, source_type=source_type, table_alias=table_alias
    )
    return " AND ".join(parts), args


def api_subject_library_org_category_options() -> dict[str, Any]:
    """
    主体库「主体类别」筛选下拉：与 load_category_doc() 指向的 YAML 同步，
    仅返回 enabled=true 的条目（顺序与配置文件一致）。
    """
    try:
        from src.subject_category.infer import load_category_doc

        doc = load_category_doc()
        rows = doc.get("categories")
        out: list[dict[str, str]] = []
        if isinstance(rows, list):
            for it in rows:
                if not isinstance(it, dict):
                    continue
                code = str(it.get("category_code") or "").strip()
                if not code:
                    continue
                if not bool(it.get("enabled", True)):
                    continue
                name = str(it.get("category_name") or "").strip()
                out.append({"category_code": code, "category_name": name or code})
        return {"ok": True, "categories": out}
    except Exception as exc:
        return {
            "ok": False,
            "categories": [],
            "error": {"message": f"{type(exc).__name__}: {exc}"},
        }


def api_subject_library_summary(
    conn,
    *,
    subject_type: str = "all",
    source_type: str = "all",
    keyword: str = "",
) -> dict[str, Any]:
    wp1, args1 = _master_where_parts(
        subject_type=subject_type, source_type=source_type, table_alias="dim_subject_master"
    )
    _append_subject_keyword_clause(wp1, args1, table_alias="dim_subject_master", keyword=keyword)
    where_sql = " AND ".join(wp1)
    src = _norm_source_type(source_type)
    inv_join_1 = sql_invoice_pid_left_join("dim_subject_master") if src != "all" else ""
    row = conn.execute(
        f"""
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN subject_category='org' THEN 1 ELSE 0 END) AS enterprise_count,
            SUM(CASE WHEN subject_category='person' THEN 1 ELSE 0 END) AS person_count,
            SUM(CASE WHEN COALESCE(category_status_note,'')='needs_review' THEN 1 ELSE 0 END) AS needs_review_count
        FROM dim_subject_master
        {inv_join_1}
        WHERE {where_sql}
        """,
        args1,
    ).fetchone()
    rename_subjects = 0
    wp2, args_m = _master_where_parts(
        subject_type=subject_type, source_type=source_type, table_alias="m"
    )
    _append_subject_keyword_clause(wp2, args_m, table_alias="m", keyword=keyword)
    where_m = " AND ".join(wp2)
    inv_join_2 = sql_invoice_pid_left_join("m") if src != "all" else ""
    try:
        r2 = conn.execute(
            f"""
            SELECT COUNT(DISTINCT m.subject_id)::BIGINT AS c
            FROM dim_subject_master m
            {inv_join_2}
            INNER JOIN (
                SELECT DISTINCT normalized_subject_no
                FROM dim_subject_rename_signal
            ) z
            ON upper(regexp_replace(trim(COALESCE(m.subject_no,'')), '[\\s-]+', '', 'g')) = z.normalized_subject_no
            WHERE length(trim(COALESCE(m.subject_no,''))) > 0
              AND {where_m}
            """,
            args_m,
        ).fetchone()
        rename_subjects = int(r2[0] or 0) if r2 else 0
    except Exception:
        rename_subjects = 0

    return {
        "ok": True,
        "summary": {
            "total": int(row[0] or 0),
            "enterprise_count": int(row[1] or 0),
            "person_count": int(row[2] or 0),
            "needs_review_count": int(row[3] or 0),
            "rename_signal_subject_count": rename_subjects,
        },
    }


def api_subject_library_rows(
    conn,
    *,
    keyword: str = "",
    subject_type: str = "all",
    source_type: str = "all",
    subject_category: str = "all",
    rename_signal: str = "all",
    category_review: str = "all",
    batch_id: str = "",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """
    主体库列表：主数据 + 血缘 + 发票侧更名信号聚合（无年度/购销角色列）。
    rename_signal: all | yes | no — 是否仅看存在/不存在更名边的主体。
    category_review: all | yes | no — yes 仅 category_status_note=needs_review（与 KPI「主体信息需复核」一致）。
    返回 total 为当前筛选条件下的总行数；rows 为 LIMIT/OFFSET 一页。
    """
    rs = str(rename_signal or "all").strip().lower()
    if rs not in {"all", "yes", "no"}:
        rs = "all"
    cr = str(category_review or "all").strip().lower()
    if cr not in {"all", "yes", "no"}:
        cr = "all"

    where_parts, args = _master_where_parts(subject_type=subject_type, source_type=source_type, table_alias="m")

    if subject_category.strip() and subject_category.strip().lower() != "all":
        where_parts.append("COALESCE(m.org_category,'') = ?")
        args.append(subject_category.strip())
    _append_subject_keyword_clause(where_parts, args, table_alias="m", keyword=keyword)
    if batch_id.strip():
        where_parts.append("COALESCE(m.last_import_batch_id,'') ILIKE ?")
        args.append(f"%{batch_id.strip()}%")

    if cr == "yes":
        where_parts.append("COALESCE(m.category_status_note,'') = 'needs_review'")
    elif cr == "no":
        where_parts.append("COALESCE(m.category_status_note,'') <> 'needs_review'")

    rename_filter_sql = ""
    if rs == "yes":
        rename_filter_sql = "AND COALESCE(rs.rename_edge_count, 0) > 0"
    elif rs == "no":
        rename_filter_sql = "AND COALESCE(rs.rename_edge_count, 0) = 0"

    where_sql = " AND ".join(where_parts)

    inv_join_rows = sql_invoice_pid_left_join("m")
    base_from = f"""
        FROM dim_subject_master m
        {inv_join_rows}
        LEFT JOIN (
            SELECT normalized_subject_no, COUNT(*)::BIGINT AS rename_edge_count
            FROM dim_subject_rename_signal
            GROUP BY normalized_subject_no
        ) rs
        ON upper(regexp_replace(trim(COALESCE(m.subject_no,'')), '[\\s-]+', '', 'g')) = rs.normalized_subject_no
        WHERE {where_sql}
        {rename_filter_sql}
    """
    lim = max(1, min(int(limit), 200))
    off = max(0, int(offset))

    try:
        total_row = conn.execute(f"SELECT COUNT(*)::BIGINT AS c {base_from}", args).fetchone()
        total = int(total_row[0] or 0) if total_row else 0
    except Exception:
        total = 0

    rows: list[Any] = []
    try:
        rows = conn.execute(
            f"""
            SELECT
                m.subject_id,
                COALESCE(m.subject_name,'') AS subject_name,
                COALESCE(m.subject_no,'') AS subject_no,
                {_sql_subject_source_bucket('m')} AS source_type,
                COALESCE(m.subject_category,'org') AS subject_type,
                COALESCE(m.org_category,'') AS org_category,
                COALESCE(m.subject_snapshot_id,'') AS subject_snapshot_id,
                COALESCE(m.quality_status,'ok') AS quality_status,
                COALESCE(m.category_status_note,'') AS category_status_note,
                COALESCE(m.first_import_batch_id,'') AS first_batch,
                COALESCE(m.last_import_batch_id,'') AS last_batch,
                COALESCE(m.created_at::VARCHAR,'') AS created_at,
                COALESCE(m.updated_at::VARCHAR,'') AS updated_at,
                COALESCE(m.subject_build_run_id,'') AS subject_build_run_id,
                COALESCE(m.category_rule_version,'') AS category_rule_version,
                COALESCE(rs.rename_edge_count, 0)::BIGINT AS rename_edge_count
            {base_from}
            ORDER BY m.updated_at DESC, m.subject_id DESC
            LIMIT ? OFFSET ?
            """,
            [*args, lim, off],
        ).fetchall()
    except Exception:
        rows = []

    cat_names = get_org_category_display_names()
    out: list[dict[str, Any]] = []
    for r in rows:
        edge_ct = int(r[15] or 0)
        has_sig = edge_ct > 0
        if has_sig:
            rename_hint = f"发票事实推断 {edge_ct} 段名称变化（全历史）"
        else:
            rename_hint = ""
        org_code = str(r[5] or "").strip()
        out.append(
            {
                "enterprise_id": str(r[0] or ""),
                "enterprise_name": str(r[1] or ""),
                "taxpayer_id": str(r[2] or ""),
                "source_type": str(r[3] or "platform"),
                "subject_type": "enterprise" if str(r[4] or "org") == "org" else "person",
                "subject_category_code": org_code,
                "subject_category_name": cat_names.get(org_code, ""),
                "has_rename_signal": has_sig,
                "rename_edge_count": edge_ct,
                "rename_hint": rename_hint,
                "rename_timeline": [],
                "first_seen_batch_id": str(r[9] or ""),
                "last_seen_batch_id": str(r[10] or ""),
                "first_seen_date": str(r[11] or ""),
                "last_seen_date": str(r[12] or ""),
                "subject_snapshot_id": str(r[6] or ""),
                "quality_status": str(r[7] or "ok"),
                "category_status_note": str(r[8] or ""),
                "subject_build_run_id": str(r[13] or ""),
                "category_rule_version": str(r[14] or ""),
            }
        )
    return {"ok": True, "rows": out, "total": total, "limit": lim, "offset": off}


def api_subject_library_rename_timeline(conn, *, subject_id: str) -> dict[str, Any]:
    """某主体在 dim_subject_rename_signal 中的全历史更名边（按 transition_date）。"""
    sid = str(subject_id or "").strip()
    if not sid:
        return {"ok": False, "error": {"message": "subject_id 不能为空"}}

    row = conn.execute(
        "SELECT COALESCE(subject_no,'') FROM dim_subject_master WHERE subject_id = ?",
        [sid],
    ).fetchone()
    if not row:
        return {"ok": False, "error": {"message": "未找到该主体"}}

    pid = str(row[0] or "").strip()
    pid_norm = ""
    if pid:
        try:
            pr = conn.execute(
                "SELECT upper(regexp_replace(trim(?), '[\\s-]+', '', 'g')) AS x",
                [pid],
            ).fetchone()
            pid_norm = str(pr[0] or "") if pr else ""
        except Exception:
            pid_norm = ""

    try:
        ev_rows = conn.execute(
            """
            SELECT
                COALESCE(from_name_raw, from_name_norm, '') AS from_name,
                COALESCE(to_name_raw, to_name_norm, '') AS to_name,
                CAST(transition_date AS VARCHAR) AS transition_date,
                COALESCE(confidence, '') AS confidence,
                evidence_invoice_count
            FROM dim_subject_rename_signal
            WHERE subject_id = ?
               OR (length(?) > 0 AND normalized_subject_no = ?)
            ORDER BY transition_date ASC, signal_id ASC
            """,
            [sid, pid_norm, pid_norm],
        ).fetchall()
    except Exception as exc:
        return {
            "ok": False,
            "error": {"message": f"读取更名轨迹失败：{type(exc).__name__}: {exc}"},
        }

    events: list[dict[str, Any]] = []
    for er in ev_rows:
        events.append(
            {
                "from_name": str(er[0] or ""),
                "to_name": str(er[1] or ""),
                "transition_date": str(er[2] or ""),
                "confidence": str(er[3] or ""),
                "evidence_invoice_count": int(er[4] or 0),
            }
        )
    lines = [
        f"{e['transition_date']}：{e['from_name']} → {e['to_name']}（置信 {e['confidence']}）"
        for e in events
    ]
    return {"ok": True, "subject_id": sid, "events": events, "timeline_lines": lines}


def api_subject_library_invoice_headers(
    conn,
    *,
    subject_id: str,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """
    主体库溯源：按 dim_subject_master.subject_no 与 dwd_inv_header 销/购方税号（同一套归一化）
    匹配全历史发票头，分页返回。票面主键在 DWD 已为 header_uuid；列表按开票日期/票面日期降序。
    """
    sid = str(subject_id or "").strip()
    if not sid:
        return {"ok": False, "error": {"message": "subject_id 不能为空"}}

    row = conn.execute(
        "SELECT COALESCE(subject_no,''), COALESCE(subject_name,'') FROM dim_subject_master WHERE subject_id = ?",
        [sid],
    ).fetchone()
    if not row:
        return {"ok": False, "error": {"message": "未找到该主体"}}

    subject_no = str(row[0] or "").strip()
    subject_name = str(row[1] or "").strip()
    pid_norm = ""
    if subject_no:
        try:
            pr = conn.execute(
                "SELECT upper(regexp_replace(trim(?), '[\\s-]+', '', 'g')) AS x",
                [subject_no],
            ).fetchone()
            pid_norm = str(pr[0] or "") if pr else ""
        except Exception:
            pid_norm = ""

    lim = max(1, min(int(limit), 200))
    off = max(0, int(offset))

    if not pid_norm:
        return {
            "ok": True,
            "subject_id": sid,
            "subject_name": subject_name,
            "subject_no": subject_no,
            "rows": [],
            "total": 0,
            "limit": lim,
            "offset": off,
            "warning": "该主体无主识别号（subject_no 为空），无法与发票头匹配。",
        }

    pid_match = """
        upper(regexp_replace(trim(COALESCE(h.xfsbh,'')), '[\\s-]+', '', 'g')) = ?
        OR upper(regexp_replace(trim(COALESCE(h.gfsbh,'')), '[\\s-]+', '', 'g')) = ?
    """

    try:
        cnt_row = conn.execute(
            f"""
            SELECT COUNT(*)::BIGINT AS c
            FROM dwd_inv_header h
            WHERE ({pid_match})
            """,
            [pid_norm, pid_norm],
        ).fetchone()
        total = int(cnt_row[0] or 0) if cnt_row else 0
    except Exception as exc:
        return {
            "ok": False,
            "error": {"message": f"统计关联发票失败：{type(exc).__name__}: {exc}"},
        }

    rows_out: list[dict[str, Any]] = []
    try:
        raw_rows = conn.execute(
            f"""
            SELECT
                COALESCE(h.header_uuid,'') AS header_uuid,
                COALESCE(h.fpdm,'') AS fpdm,
                COALESCE(h.fphm,'') AS fphm,
                COALESCE(h.sdfphm,'') AS sdfphm,
                COALESCE(h.xfmc,'') AS xfmc,
                COALESCE(h.gfmc,'') AS gfmc,
                COALESCE(h.kprq,'') AS kprq,
                h.stat_year,
                h.jshj
            FROM dwd_inv_header h
            WHERE ({pid_match})
            ORDER BY h.invoice_date DESC NULLS LAST,
                     h.kprq DESC NULLS LAST,
                     h.header_uuid DESC
            LIMIT ? OFFSET ?
            """,
            [pid_norm, pid_norm, lim, off],
        ).fetchall()
    except Exception as exc:
        return {
            "ok": False,
            "error": {"message": f"读取关联发票失败：{type(exc).__name__}: {exc}"},
        }

    for r in raw_rows:
        # SELECT 列序：0..6 票面字段，7 stat_year，8 jshj（勿与 0-based 错位）
        jshj = r[8]
        jshj_out: float | None
        try:
            if jshj is None:
                jshj_out = None
            else:
                jshj_out = float(jshj)
        except Exception:
            jshj_out = None
        sy = r[7]
        try:
            stat_year = int(sy) if sy is not None else None
        except Exception:
            stat_year = None
        rows_out.append(
            {
                "header_uuid": str(r[0] or ""),
                "fpdm": str(r[1] or ""),
                "fphm": str(r[2] or ""),
                "sdfphm": str(r[3] or ""),
                "xfmc": str(r[4] or ""),
                "gfmc": str(r[5] or ""),
                "kprq": str(r[6] or ""),
                "stat_year": stat_year,
                "jshj": jshj_out,
            }
        )

    return {
        "ok": True,
        "subject_id": sid,
        "subject_name": subject_name,
        "subject_no": subject_no,
        "rows": rows_out,
        "total": total,
        "limit": lim,
        "offset": off,
    }


def query_subject_category_coverage_counts(conn) -> dict[str, int]:
    """
    按机构类别编码统计 dim_subject_master 主体数（供主体类别页「覆盖主体」展示）。
    - org 主体：按 org_category 聚合；
    - SC-TEMP：subject_category=person 且 org_category=SC-TEMP。
    """
    rows = conn.execute(
        """
        SELECT
            CASE
                WHEN lower(trim(COALESCE(subject_category, ''))) = 'person'
                     AND upper(trim(COALESCE(org_category, ''))) = 'SC-TEMP'
                THEN 'SC-TEMP'
                WHEN lower(trim(COALESCE(subject_category, ''))) = 'org'
                THEN upper(trim(COALESCE(org_category, '')))
                ELSE NULL
            END AS category_code,
            COUNT(*)::BIGINT AS cnt
        FROM dim_subject_master
        GROUP BY 1
        HAVING category_code IS NOT NULL AND category_code <> ''
        """
    ).fetchall()
    out: dict[str, int] = {}
    for code, cnt in rows:
        key = str(code or "").strip().upper()
        if not key:
            continue
        out[key] = max(0, int(cnt or 0))
    return out


def apply_subject_category_coverage_counts(
    categories: list[dict[str, Any]],
    counts: dict[str, int],
) -> None:
    """将主体库统计覆盖数写入规则列表（就地修改 coverage_count）。"""
    for it in categories:
        if not isinstance(it, dict):
            continue
        code = str(it.get("category_code") or "").strip().upper()
        it["coverage_count"] = counts.get(code, 0)
