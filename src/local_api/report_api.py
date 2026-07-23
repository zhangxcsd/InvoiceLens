"""审计 Word 报告生成 API。"""

from __future__ import annotations

import io
import json
import logging
import re
import threading
import uuid
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_REPORTS_DIR = Path(__file__).resolve().parents[2] / "data" / "reports"
_DELIVERY_PACKAGES_DIR = _DEFAULT_REPORTS_DIR / "delivery_packages"
_DELIVERY_HISTORY_PATH = Path(__file__).resolve().parents[2] / "data" / "config" / "delivery_package_history.json"
_DELIVERY_MAX_ZIP_BYTES = 100 * 1024 * 1024
_PACKAGE_INVOICE_MAX_ROWS = 5000
_MAX_DELIVERY_HISTORY = 50

_delivery_jobs_lock = threading.Lock()
_delivery_jobs: dict[str, dict[str, Any]] = {}


def reports_dir() -> Path:
    d = _DEFAULT_REPORTS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_int_year(v: str | None) -> int | None:
    if not v or not str(v).strip().isdigit():
        return None
    y = int(str(v).strip())
    if y < 1990 or y > 2100:
        return None
    return y


def _distinct_report_years(conn: Any) -> list[str]:
    years: set[int] = set()
    for sql in (
        "SELECT DISTINCT stat_year FROM ads_scorecard WHERE stat_year IS NOT NULL",
        "SELECT DISTINCT stat_year FROM dws_inv_trend WHERE stat_year IS NOT NULL",
    ):
        try:
            for (yv,) in conn.execute(sql).fetchall() or []:
                if yv is not None:
                    yi = int(yv)
                    if 1990 <= yi <= 2100:
                        years.add(yi)
        except Exception:
            continue
    if not years:
        return [str(date.today().year)]
    return [str(y) for y in sorted(years, reverse=True)]


def _safe_filename(name: str) -> str | None:
    base = Path(name).name
    if not base or base in (".", ".."):
        return None
    if not re.match(r"^[\w\u4e00-\u9fff\-\.]+\.docx$", base):
        return None
    return base


def api_report_meta(conn: Any) -> dict[str, Any]:
    try:
        years = _distinct_report_years(conn)
        cy = str(date.today().year)
        default_y = cy if cy in years else years[0]
        archive = api_report_archive_list()
        return {
            "ok": True,
            "stat_years": years,
            "default_stat_year": default_y,
            "default_title": f"{default_y}年度发票数据审计分析报告",
            "chapters": [
                {"id": "overview", "label": "第一章 数据概览", "default": True},
                {"id": "structure", "label": "第二章 发票结构分析", "default": True},
                {"id": "supplier", "label": "第三章 供应商分析", "default": True},
                {"id": "audit_flags", "label": "第四章 审计疑点清单", "default": True},
                {"id": "flags_track", "label": "附录 已确认疑点摘要", "default": True},
                {"id": "related", "label": "第五章 关联交易分析", "default": True},
                {"id": "compare", "label": "第六章 主体横向对比", "default": True},
                {"id": "supplier_new", "label": "专题 新增供应商", "default": False},
                {"id": "trade_relationships", "label": "专题 往来关系摘要", "default": False},
                {"id": "tax_in_out_deviation", "label": "专题 进销偏离分析", "default": False},
                {"id": "finance_reconcile", "label": "专题 财务账票核对差异", "default": False},
                {"id": "data_quality_summary", "label": "专题 数据质量域摘要", "default": False},
                {"id": "tax_code_analysis", "label": "专题 税收分类编码分析", "default": False},
                {"id": "tax_risk_exposure", "label": "专题 税风险敞口", "default": False},
            ],
            "archive_count": len(archive.get("files") or []),
            "reports_dir": str(reports_dir()),
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_generate(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
        from src.local_api.license_gate import check_export_allowed

        denied = check_export_allowed()
        if denied:
            return denied

        from src.reporting.reporter import generate_audit_report_docx

        stat_year = _safe_int_year(str(body.get("stat_year") or "").strip())
        if stat_year is None:
            return {
                "ok": False,
                "error": {"code": "stat_year_required", "message": "stat_year 无效或缺失"},
            }
        title = str(body.get("title") or "").strip() or f"{stat_year}年度发票数据审计分析报告"
        raw_chapters = body.get("chapters")
        chapters: dict[str, bool] | None = None
        if isinstance(raw_chapters, dict):
            chapters = {str(k): bool(v) for k, v in raw_chapters.items()}

        out_dir = reports_dir()
        result = generate_audit_report_docx(
            conn,
            stat_year=stat_year,
            title=title,
            chapters=chapters,
            output_dir=str(out_dir),
        )
        if not result.get("ok"):
            return result
        file_name = str(result.get("file_name") or "")
        file_path = out_dir / file_name
        size_bytes = file_path.stat().st_size if file_path.is_file() else 0
        return {
            "ok": True,
            "stat_year": stat_year,
            "title": title,
            "file_name": file_name,
            "download_url": f"/api/report/download?file={file_name}",
            "size_bytes": size_bytes,
            "generated_at": result.get("generated_at"),
        }
    except Exception as exc:
        logger.exception("report_generate")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_archive_list(
    *,
    stat_year: str | None = None,
    template_keyword: str | None = None,
) -> dict[str, Any]:
    try:
        d = reports_dir()
        year_filter = (stat_year or "").strip()
        tpl_kw = (template_keyword or "").strip().lower()
        files: list[dict[str, Any]] = []
        for p in sorted(d.glob("*.docx"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                st = p.stat()
                m = re.search(r"audit_report_(\d{4})_", p.name)
                file_year = m.group(1) if m else None
                if year_filter and year_filter.isdigit() and file_year != year_filter:
                    continue
                if tpl_kw and tpl_kw not in p.name.lower():
                    continue
                files.append(
                    {
                        "file_name": p.name,
                        "stat_year": file_year,
                        "size_bytes": st.st_size,
                        "modified_at": st.st_mtime,
                        "download_url": f"/api/report/download?file={p.name}",
                    }
                )
            except Exception:
                continue
        return {"ok": True, "files": files, "total": len(files)}
    except Exception as exc:
        return {"ok": False, "files": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_archive_batch_download(file_names: list[str]) -> tuple[int, bytes | dict[str, Any], str, str]:
    """打包多个 docx 为 zip 下载。"""
    import zipfile

    safe_names: list[str] = []
    for raw in file_names or []:
        s = _safe_filename(str(raw))
        if s:
            safe_names.append(s)
    if not safe_names:
        return 400, {"ok": False, "error": {"message": "未指定有效文件"}}, "", ""
    buf = io.BytesIO()
    d = reports_dir()
    added = 0
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in safe_names:
                path = d / name
                if path.is_file():
                    zf.write(path, arcname=name)
                    added += 1
        if added == 0:
            return 404, {"ok": False, "error": {"message": "文件不存在"}}, "", ""
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        return 200, buf.getvalue(), "application/zip", f"reports_batch_{ts}.zip"
    except Exception as exc:
        return 500, {"ok": False, "error": {"message": str(exc)}}, "", ""


def api_report_download_file(file_name: str) -> tuple[int, bytes, str, str] | tuple[int, dict[str, Any], None, None]:
    """返回 (status, body_bytes_or_error_dict, content_type, download_name)。"""
    safe = _safe_filename(file_name)
    if not safe:
        return 400, {"ok": False, "error": {"message": "非法文件名"}}, None, None
    path = reports_dir() / safe
    if not path.is_file():
        return 404, {"ok": False, "error": {"message": "文件不存在"}}, None, None
    try:
        data = path.read_bytes()
        return (
            200,
            data,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            safe,
        )
    except Exception as exc:
        return 500, {"ok": False, "error": {"message": str(exc)}}, None, None


def _delivery_readme(title: str, stat_year: int, contents: list[dict[str, Any]]) -> str:
    lines = [
        "InvoiceLens 审计交付包",
        "=" * 40,
        f"报告标题：{title}",
        f"分析年度：{stat_year}",
        f"生成时间：{datetime.now().isoformat(timespec='seconds')}",
        "",
        "包内文件：",
    ]
    for item in contents:
        lines.append(f"  - {item.get('path')} ({item.get('description', item.get('type', ''))})")
    lines.extend(
        [
            "",
            "说明：",
            "  - report/ 目录为 Word 审计分析报告",
            "  - exports/ 目录为疑点清单与可复用的明细 CSV",
            "  - manifest.json 为机器可读元数据",
        ]
    )
    return "\n".join(lines) + "\n"


def _delivery_chapter_files(stat_year: int, report_file: str) -> dict[str, str]:
    """报告章节与交付包内文件的对应关系（manifest 用）。"""
    return {
        "overview": f"report/{report_file}",
        "structure": f"report/{report_file}",
        "supplier": f"report/{report_file}",
        "audit_flags": f"exports/audit_flags_{stat_year}.csv",
        "flags_track": f"report/{report_file}",
        "related": f"report/{report_file}",
        "compare": f"report/{report_file}",
        "supplier_new": f"report/{report_file}",
        "trade_relationships": f"report/{report_file}",
        "tax_in_out_deviation": f"report/{report_file}",
        "finance_reconcile": f"exports/finance_reconcile_diff_{stat_year}.csv",
        "data_quality_summary": f"exports/data_quality_domain_summary_{stat_year}.csv",
        "tax_code_analysis": f"exports/tax_code_analysis_{stat_year}.csv",
        "tax_risk_exposure": f"exports/tax_risk_exposure_{stat_year}.csv",
    }


def _parse_chapters_dict(body: dict[str, Any]) -> dict[str, bool] | None:
    raw = body.get("chapters")
    if isinstance(raw, dict):
        return {str(k): bool(v) for k, v in raw.items()}
    return None


def _chapter_selected(chapters: dict[str, bool] | None, chapter_id: str, *, default: bool) -> bool:
    if chapters is None:
        return default
    return bool(chapters.get(chapter_id, default))


def _delivery_include_plan(body: dict[str, Any]) -> dict[str, bool]:
    """交付包各 CSV/附件是否打包（与 ReportConfigPage 章节勾选对齐；显式 include_* 优先）。"""
    chapters = _parse_chapters_dict(body)

    def _explicit_or_chapter(body_key: str, chapter_id: str, *, legacy_default: bool, chapter_default: bool) -> bool:
        explicit = body.get(body_key)
        if explicit is not None:
            return bool(explicit)
        if chapters is not None:
            return _chapter_selected(chapters, chapter_id, default=chapter_default)
        return legacy_default

    audit_flags = (
        _chapter_selected(chapters, "audit_flags", default=True) if chapters is not None else True
    )
    tax_code = (
        _chapter_selected(chapters, "tax_code_analysis", default=False)
        if chapters is not None
        else True
    )
    tax_risk = (
        _chapter_selected(chapters, "tax_risk_exposure", default=False)
        if chapters is not None
        else False
    )
    return {
        "report_docx": True,
        "audit_flags": audit_flags,
        "finance_reconcile": _explicit_or_chapter(
            "include_finance", "finance_reconcile", legacy_default=True, chapter_default=False
        ),
        "data_quality_summary": _explicit_or_chapter(
            "include_data_quality", "data_quality_summary", legacy_default=True, chapter_default=False
        ),
        "tax_code_analysis": tax_code if body.get("include_tax_code") is None else bool(body.get("include_tax_code")),
        "tax_risk_exposure": tax_risk
        if body.get("include_tax_risk") is None
        else bool(body.get("include_tax_risk")),
        "invoice_detail": _explicit_or_chapter(
            "include_invoices", "invoice_detail", legacy_default=True, chapter_default=True
        ),
    }


_DOCX_SIZE_BASE_BYTES = 48_000
_DOCX_SIZE_PER_CHAPTER_BYTES = 9_000
_CSV_BYTES_PER_ROW_HEURISTIC = 180


def _estimate_docx_size_bytes(chapters: dict[str, bool] | None) -> int:
    if chapters:
        selected = sum(1 for v in chapters.values() if v)
    else:
        selected = 8
    return _DOCX_SIZE_BASE_BYTES + _DOCX_SIZE_PER_CHAPTER_BYTES * max(1, selected)


def _section_row(
    *,
    section_id: str,
    label: str,
    path: str,
    included: bool,
    row_count: int | None = None,
    size_bytes: int | None = None,
    chapter_id: str | None = None,
    kind: str = "csv",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": section_id,
        "label": label,
        "path": path,
        "kind": kind,
        "included": included,
        "row_count": row_count,
        "size_bytes": size_bytes,
    }
    if chapter_id:
        row["chapter_id"] = chapter_id
    if extra:
        row.update(extra)
    return row


def _collect_delivery_sections_estimate(conn: Any, body: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """统计交付包各文件行数与估算大小（不生成 ZIP / Word）。"""
    stat_year = _safe_int_year(str(body.get("stat_year") or "").strip())
    if stat_year is None:
        raise ValueError("stat_year 无效或缺失")

    entity_id = str(body.get("entity_id") or body.get("subject_id") or "").strip() or None
    chapters = _parse_chapters_dict(body)
    plan = _delivery_include_plan(body)
    labels = _delivery_chapter_labels()

    flag_filters = body.get("flag_filters") if isinstance(body.get("flag_filters"), dict) else {}
    risk_level = str(flag_filters.get("risk_level") or body.get("risk_level") or "").strip() or None
    rule_id = str(flag_filters.get("rule_id") or body.get("rule_id") or "").strip() or None
    track_status = str(flag_filters.get("track_status") or body.get("track_status") or "").strip() or None

    sections: list[dict[str, Any]] = []
    estimates: dict[str, Any] = {"report_docx": 1}
    notes: list[str] = []

    docx_path = f"report/audit_report_{stat_year}_*.docx"
    docx_size = _estimate_docx_size_bytes(chapters)
    sections.append(
        _section_row(
            section_id="report_docx",
            label="Word 审计报告",
            path=docx_path,
            included=True,
            kind="report_docx",
            row_count=None,
            size_bytes=docx_size,
        )
    )

    from src.local_api.audit_flag_api import _audit_flags_where, export_audit_flags_csv_bytes

    where, params, _gid = _audit_flags_where(
        stat_year=stat_year,
        risk_level=risk_level,
        rule_id=rule_id,
        track_status=track_status,
    )
    flag_count = int(
        conn.execute(f"SELECT COUNT(*)::BIGINT FROM dm_audit_flag WHERE {where}", params).fetchone()[0] or 0
    )
    flag_path = f"exports/audit_flags_{stat_year}.csv"
    flag_size: int | None = None
    if plan["audit_flags"]:
        try:
            flags_csv, flag_count = export_audit_flags_csv_bytes(
                conn,
                stat_year=stat_year,
                risk_level=risk_level,
                rule_id=rule_id,
                track_status=track_status,
            )
            flag_size = len(flags_csv)
        except Exception:
            flag_size = flag_count * _CSV_BYTES_PER_ROW_HEURISTIC + 256
    estimates["audit_flags"] = flag_count if plan["audit_flags"] else 0
    sections.append(
        _section_row(
            section_id="audit_flags",
            chapter_id="audit_flags",
            label=labels.get("audit_flags", "审计疑点清单"),
            path=flag_path,
            included=plan["audit_flags"],
            row_count=flag_count if plan["audit_flags"] else None,
            size_bytes=flag_size if plan["audit_flags"] else 0,
        )
    )

    if plan["finance_reconcile"]:
        fin_count: int | None = None
        fin_size: int | None = None
        try:
            from src.local_api.finance_reconcile_api import export_finance_reconcile_csv_bytes

            fin_csv, fin_count = export_finance_reconcile_csv_bytes(
                conn,
                stat_year=stat_year,
                entity_id=entity_id,
            )
            fin_size = len(fin_csv) if fin_csv else 0
        except Exception:
            fin_count = None
        estimates["finance_reconcile"] = fin_count
        sections.append(
            _section_row(
                section_id="finance_reconcile",
                chapter_id="finance_reconcile",
                label=labels.get("finance_reconcile", "财务账票核对差异"),
                path=f"exports/finance_reconcile_diff_{stat_year}.csv",
                included=True,
                row_count=fin_count,
                size_bytes=fin_size,
            )
        )
    else:
        estimates["finance_reconcile"] = 0
        sections.append(
            _section_row(
                section_id="finance_reconcile",
                chapter_id="finance_reconcile",
                label=labels.get("finance_reconcile", "财务账票核对差异"),
                path=f"exports/finance_reconcile_diff_{stat_year}.csv",
                included=False,
                row_count=None,
                size_bytes=0,
            )
        )

    if plan["invoice_detail"]:
        try:
            inv_where = ["h.stat_year = ?"]
            inv_params: list[Any] = [stat_year]
            if entity_id:
                inv_where.append("(h.gfsbh = ? OR h.xfsbh = ? OR h.entity_id = ?)")
                inv_params.extend([entity_id, entity_id, entity_id])
            inv_total = int(
                conn.execute(
                    f"SELECT COUNT(*)::BIGINT FROM dwd_inv_header h WHERE {' AND '.join(inv_where)}",
                    inv_params,
                ).fetchone()[0]
                or 0
            )
            exported = min(inv_total, _PACKAGE_INVOICE_MAX_ROWS)
            inv_size = exported * _CSV_BYTES_PER_ROW_HEURISTIC + 512
            estimates["invoice_detail"] = exported
            estimates["invoice_detail_total"] = inv_total
            if inv_total > _PACKAGE_INVOICE_MAX_ROWS:
                notes.append(f"发票明细共 {inv_total:,} 行，交付包最多包含 {_PACKAGE_INVOICE_MAX_ROWS:,} 行")
            sections.append(
                _section_row(
                    section_id="invoice_detail",
                    label="发票明细导出",
                    path=f"exports/invoice_detail_{stat_year}.csv",
                    included=True,
                    kind="attachment",
                    row_count=exported,
                    size_bytes=inv_size,
                    extra={"total_matched": inv_total, "truncated": inv_total > exported},
                )
            )
        except Exception:
            estimates["invoice_detail"] = None
    else:
        estimates["invoice_detail"] = 0
        sections.append(
            _section_row(
                section_id="invoice_detail",
                label="发票明细导出",
                path=f"exports/invoice_detail_{stat_year}.csv",
                included=False,
                kind="attachment",
                row_count=None,
                size_bytes=0,
            )
        )

    if plan["data_quality_summary"]:
        dq_count: int | None = None
        dq_size: int | None = None
        scanned: int | None = None
        anomaly: int | None = None
        try:
            from src.local_api.data_quality import (
                export_data_quality_domain_summary_csv_bytes,
                load_dq_domain_overview,
            )

            dq_csv, dq_count = export_data_quality_domain_summary_csv_bytes(conn, stat_year=stat_year)
            dq_size = len(dq_csv) if dq_csv else 0
            dq = load_dq_domain_overview(conn, stat_year=stat_year)
            if dq.get("ok"):
                kpi = dq.get("kpi") or {}
                scanned = int(kpi.get("scanned_headers") or 0)
                anomaly = int(kpi.get("anomaly_headers") or 0)
        except Exception:
            try:
                scanned = int(
                    conn.execute(
                        "SELECT COUNT(*)::BIGINT FROM dwd_inv_header WHERE stat_year = ?",
                        [stat_year],
                    ).fetchone()[0]
                    or 0
                )
                anomaly = 0
            except Exception:
                scanned = None
                anomaly = None
        estimates["data_quality_metrics"] = anomaly
        estimates["data_quality_scanned"] = scanned
        sections.append(
            _section_row(
                section_id="data_quality_summary",
                chapter_id="data_quality_summary",
                label=labels.get("data_quality_summary", "数据质量域摘要"),
                path=f"exports/data_quality_domain_summary_{stat_year}.csv",
                included=True,
                row_count=dq_count,
                size_bytes=dq_size,
            )
        )
    else:
        estimates["data_quality_metrics"] = 0
        estimates["data_quality_scanned"] = 0
        sections.append(
            _section_row(
                section_id="data_quality_summary",
                chapter_id="data_quality_summary",
                label=labels.get("data_quality_summary", "数据质量域摘要"),
                path=f"exports/data_quality_domain_summary_{stat_year}.csv",
                included=False,
                row_count=None,
                size_bytes=0,
            )
        )

    if plan["tax_code_analysis"]:
        tax_count: int | None = None
        tax_size: int | None = None
        try:
            from src.local_api.tax_code_analysis_api import export_tax_code_delivery_csv_bytes

            tax_csv, tax_count = export_tax_code_delivery_csv_bytes(conn, stat_year=stat_year)
            tax_size = len(tax_csv) if tax_csv else 0
        except Exception:
            tax_count = None
        estimates["tax_code_analysis"] = tax_count
        sections.append(
            _section_row(
                section_id="tax_code_analysis",
                chapter_id="tax_code_analysis",
                label=labels.get("tax_code_analysis", "税收分类编码分析"),
                path=f"exports/tax_code_analysis_{stat_year}.csv",
                included=True,
                row_count=tax_count,
                size_bytes=tax_size,
            )
        )
    else:
        estimates["tax_code_analysis"] = 0
        sections.append(
            _section_row(
                section_id="tax_code_analysis",
                chapter_id="tax_code_analysis",
                label=labels.get("tax_code_analysis", "税收分类编码分析"),
                path=f"exports/tax_code_analysis_{stat_year}.csv",
                included=False,
                row_count=None,
                size_bytes=0,
            )
        )

    if plan["tax_risk_exposure"]:
        risk_count: int | None = None
        risk_size: int | None = None
        try:
            from src.local_api.dws_dashboard_api import export_tax_risk_delivery_csv_bytes

            risk_csv, risk_count = export_tax_risk_delivery_csv_bytes(
                conn,
                stat_year=stat_year,
                entity_id=entity_id,
            )
            risk_size = len(risk_csv) if risk_csv else 0
        except Exception:
            risk_count = None
        estimates["tax_risk_exposure"] = risk_count
        sections.append(
            _section_row(
                section_id="tax_risk_exposure",
                chapter_id="tax_risk_exposure",
                label=labels.get("tax_risk_exposure", "税风险敞口"),
                path=f"exports/tax_risk_exposure_{stat_year}.csv",
                included=True,
                row_count=risk_count,
                size_bytes=risk_size,
            )
        )
    else:
        estimates["tax_risk_exposure"] = 0
        sections.append(
            _section_row(
                section_id="tax_risk_exposure",
                chapter_id="tax_risk_exposure",
                label=labels.get("tax_risk_exposure", "税风险敞口"),
                path=f"exports/tax_risk_exposure_{stat_year}.csv",
                included=False,
                row_count=None,
                size_bytes=0,
            )
        )

    manifest_size = 2048
    readme_size = 1024
    included_sizes = [int(s.get("size_bytes") or 0) for s in sections if s.get("included")]
    total_uncompressed = sum(included_sizes) + manifest_size + readme_size
    total_zip_est = int(total_uncompressed * 0.72)

    return sections, {
        **estimates,
        "total_uncompressed_bytes": total_uncompressed,
        "total_zip_bytes_est": total_zip_est,
    }, notes


def _delivery_chapter_labels() -> dict[str, str]:
    return {
        "overview": "第一章 数据概览",
        "structure": "第二章 发票结构分析",
        "supplier": "第三章 供应商分析",
        "audit_flags": "第四章 审计疑点清单",
        "flags_track": "附录 已确认疑点摘要",
        "related": "第五章 关联交易分析",
        "compare": "第六章 主体横向对比",
        "supplier_new": "专题 新增供应商",
        "trade_relationships": "专题 往来关系摘要",
        "tax_in_out_deviation": "专题 进销偏离分析",
        "finance_reconcile": "专题 财务账票核对差异",
        "data_quality_summary": "专题 数据质量域摘要",
        "tax_code_analysis": "专题 税收分类编码分析",
        "tax_risk_exposure": "专题 税风险敞口",
        "goods_category": "专题 品类结构分析",
        "red_offset_analysis": "专题 红冲/作废分析",
        "counterparty_risk": "专题 对手风险聚合",
        "invoice_timing": "专题 开票时间行为",
        "year_over_year": "专题 跨年结构对比",
    }


def api_report_delivery_package(
    conn: Any,
    body: dict[str, Any],
) -> tuple[int, bytes | dict[str, Any], str, str]:
    """
    一键生成交付包 ZIP：Word 报告 + 疑点 CSV +（可选）财务差异/发票明细 CSV。

    返回 (status, body_bytes_or_error_dict, content_type, download_name)。
    """
    if body.get("async") is True:
        started = start_delivery_package_async(body)
        if not started.get("ok"):
            err_code = str((started.get("error") or {}).get("code") or "")
            status = 403 if err_code in {"license_export_denied", "license_expired"} else 400
            return status, started, "", ""
        return 202, started, "", ""

    try:
        from src.local_api.license_gate import check_export_allowed

        denied = check_export_allowed()
        if denied:
            code = str(denied.get("error", {}).get("code") or "")
            status = 403 if code in {"license_export_denied", "license_expired"} else 403
            return status, denied, "", ""

        stat_year = _safe_int_year(str(body.get("stat_year") or "").strip())
        if stat_year is None:
            return (
                400,
                {"ok": False, "error": {"code": "stat_year_required", "message": "stat_year 无效或缺失"}},
                "",
                "",
            )

        title = str(body.get("title") or "").strip() or f"{stat_year}年度发票数据审计分析报告"
        raw_chapters = body.get("chapters")
        chapters: dict[str, bool] | None = None
        if isinstance(raw_chapters, dict):
            chapters = {str(k): bool(v) for k, v in raw_chapters.items()}

        entity_id = str(body.get("entity_id") or body.get("subject_id") or "").strip() or None
        flag_filters = body.get("flag_filters") if isinstance(body.get("flag_filters"), dict) else {}
        risk_level = str(flag_filters.get("risk_level") or body.get("risk_level") or "").strip() or None
        rule_id = str(flag_filters.get("rule_id") or body.get("rule_id") or "").strip() or None
        track_status = str(flag_filters.get("track_status") or body.get("track_status") or "").strip() or None
        include_plan = _delivery_include_plan(body)
        progress_run_id = str(body.get("progress_run_id") or "").strip() or None

        def _progress(msg: str) -> None:
            if progress_run_id:
                _set_delivery_job(progress_run_id, {"message": msg})

        from src.reporting.reporter import generate_audit_report_docx

        out_dir = reports_dir()
        _progress("正在生成 Word 审计报告…")
        result = generate_audit_report_docx(
            conn,
            stat_year=stat_year,
            title=title,
            chapters=chapters,
            output_dir=str(out_dir),
        )
        if not result.get("ok"):
            return 400, result, "", ""

        file_name = str(result.get("file_name") or "")
        docx_path = out_dir / file_name
        if not docx_path.is_file():
            return 404, {"ok": False, "error": {"message": "报告文件生成失败"}}, "", ""

        from src.local_api.audit_flag_api import export_audit_flags_csv_bytes

        contents: list[dict[str, Any]] = [
            {
                "path": f"report/{file_name}",
                "type": "report_docx",
                "description": "Word 审计分析报告（含勾选章节）",
                "chapters": [k for k, v in (chapters or {}).items() if v] if chapters else None,
                "size_bytes": docx_path.stat().st_size,
            },
        ]
        flags_csv = b""
        flag_count = 0
        if include_plan["audit_flags"]:
            _progress("正在导出审计疑点清单…")
            flags_csv, flag_count = export_audit_flags_csv_bytes(
                conn,
                stat_year=stat_year,
                risk_level=risk_level,
                rule_id=rule_id,
                track_status=track_status,
            )
            contents.append(
                {
                    "path": f"exports/audit_flags_{stat_year}.csv",
                    "type": "audit_flags_csv",
                    "description": "审计疑点清单（对应第四章 audit_flags）",
                    "chapter_id": "audit_flags",
                    "row_count": flag_count,
                }
            )

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(docx_path, arcname=f"report/{file_name}")
            if include_plan["audit_flags"] and flags_csv:
                zf.writestr(f"exports/audit_flags_{stat_year}.csv", flags_csv)

            if include_plan["finance_reconcile"]:
                try:
                    _progress("正在导出财务账票核对差异…")
                    from src.local_api.finance_reconcile_api import export_finance_reconcile_csv_bytes

                    fin_csv, fin_count = export_finance_reconcile_csv_bytes(
                        conn,
                        stat_year=stat_year,
                        entity_id=entity_id,
                    )
                    if fin_csv:
                        fin_name = f"exports/finance_reconcile_diff_{stat_year}.csv"
                        zf.writestr(fin_name, fin_csv)
                        contents.append(
                            {
                                "path": fin_name,
                                "type": "finance_reconcile_csv",
                                "description": "财务账票核对差异（对应 finance_reconcile 章节）",
                                "chapter_id": "finance_reconcile",
                                "row_count": fin_count,
                            }
                        )
                except Exception as exc:
                    logger.warning("delivery package finance export skipped: %s", exc)

            invoice_note: str | None = None
            if include_plan["invoice_detail"]:
                try:
                    _progress("正在导出发票明细…")
                    from src.local_api.invoice_export_api import export_invoices_csv_bytes

                    inv_csv, inv_rows, inv_total = export_invoices_csv_bytes(
                        conn,
                        stat_year=stat_year,
                        entity_id=entity_id,
                        max_rows=_PACKAGE_INVOICE_MAX_ROWS,
                    )
                    if inv_csv:
                        inv_name = f"exports/invoice_detail_{stat_year}.csv"
                        zf.writestr(inv_name, inv_csv)
                        truncated = inv_total > inv_rows
                        if truncated:
                            invoice_note = (
                                f"发票明细共匹配 {inv_total:,} 行，交付包仅包含前 {inv_rows:,} 行"
                            )
                        contents.append(
                            {
                                "path": inv_name,
                                "type": "invoice_detail_csv",
                                "description": "发票明细（截断）" if truncated else "发票明细",
                                "chapter_id": None,
                                "row_count": inv_rows,
                                "total_matched": inv_total,
                                "truncated": truncated,
                            }
                        )
                except Exception as exc:
                    logger.warning("delivery package invoice export skipped: %s", exc)

            if include_plan["data_quality_summary"]:
                try:
                    _progress("正在导出数据质量域汇总…")
                    from src.local_api.data_quality import export_data_quality_domain_summary_csv_bytes

                    dq_csv, dq_count = export_data_quality_domain_summary_csv_bytes(
                        conn,
                        stat_year=stat_year,
                    )
                    if dq_csv:
                        dq_name = f"exports/data_quality_domain_summary_{stat_year}.csv"
                        zf.writestr(dq_name, dq_csv)
                        contents.append(
                            {
                                "path": dq_name,
                                "type": "data_quality_summary_csv",
                                "description": "数据质量域汇总（对应 data_quality_summary 章节）",
                                "chapter_id": "data_quality_summary",
                                "row_count": dq_count,
                            }
                        )
                except Exception as exc:
                    logger.warning("delivery package data quality export skipped: %s", exc)

            if include_plan["tax_code_analysis"]:
                try:
                    _progress("正在导出税码分析 CSV…")
                    from src.local_api.tax_code_analysis_api import export_tax_code_delivery_csv_bytes

                    tax_csv, tax_count = export_tax_code_delivery_csv_bytes(conn, stat_year=stat_year)
                    if tax_csv:
                        tax_name = f"exports/tax_code_analysis_{stat_year}.csv"
                        zf.writestr(tax_name, tax_csv)
                        contents.append(
                            {
                                "path": tax_name,
                                "type": "tax_code_analysis_csv",
                                "description": "税收分类编码分析（未匹配税码 + 企业摘要）",
                                "chapter_id": "tax_code_analysis",
                                "row_count": tax_count,
                            }
                        )
                except Exception as exc:
                    logger.warning("delivery package tax code export skipped: %s", exc)

            if include_plan["tax_risk_exposure"]:
                try:
                    _progress("正在导出税风险敞口 CSV…")
                    from src.local_api.dws_dashboard_api import export_tax_risk_delivery_csv_bytes

                    risk_csv, risk_count = export_tax_risk_delivery_csv_bytes(
                        conn,
                        stat_year=stat_year,
                        entity_id=entity_id,
                    )
                    if risk_csv:
                        risk_name = f"exports/tax_risk_exposure_{stat_year}.csv"
                        zf.writestr(risk_name, risk_csv)
                        contents.append(
                            {
                                "path": risk_name,
                                "type": "tax_risk_exposure_csv",
                                "description": "税风险敞口按主体汇总（进销偏离 + 高风险编码 + 疑点金额）",
                                "chapter_id": "tax_risk_exposure",
                                "row_count": risk_count,
                            }
                        )
                except Exception as exc:
                    logger.warning("delivery package tax risk export skipped: %s", exc)

            _progress("正在写入 manifest 与 README…")
            manifest = {
                "ok": True,
                "generated_at": datetime.now().isoformat(timespec="seconds"),
                "stat_year": stat_year,
                "title": title,
                "entity_id": entity_id,
                "chapters": chapters,
                "chapter_labels": _delivery_chapter_labels(),
                "chapter_files": _delivery_chapter_files(stat_year, file_name),
                "include_plan": include_plan,
                "flag_filters": {
                    "risk_level": risk_level,
                    "rule_id": rule_id,
                    "track_status": track_status,
                },
                "report_file": file_name,
                "contents": contents,
                "notes": [n for n in [invoice_note] if n],
            }
            zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            zf.writestr("README.txt", _delivery_readme(title, stat_year, contents))

        data = buf.getvalue()
        if len(data) > _DELIVERY_MAX_ZIP_BYTES:
            return (
                413,
                {
                    "ok": False,
                    "error": {
                        "code": "package_too_large",
                        "message": f"交付包超过大小上限 {_DELIVERY_MAX_ZIP_BYTES // (1024 * 1024)} MB，请缩小导出范围。",
                        "size_bytes": len(data),
                        "max_bytes": _DELIVERY_MAX_ZIP_BYTES,
                    },
                },
                "",
                "",
            )

        try:
            from src.local_api.users_api import append_audit_log

            append_audit_log(
                action="report_delivery_package",
                username=str(body.get("actor") or body.get("username") or "system"),
                detail={
                    "stat_year": stat_year,
                    "title": title,
                    "file_count": len(contents),
                    "flag_count": flag_count,
                    "size_bytes": len(data),
                },
            )
        except Exception:
            pass

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_name = f"delivery_package_{stat_year}_{ts}.zip"
        return 200, data, "application/zip", zip_name
    except Exception as exc:
        logger.exception("report_delivery_package")
        return 500, {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}, "", ""


def delivery_packages_dir() -> Path:
    d = _DELIVERY_PACKAGES_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_delivery_history() -> list[dict[str, Any]]:
    if not _DELIVERY_HISTORY_PATH.is_file():
        return []
    try:
        raw = json.loads(_DELIVERY_HISTORY_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("packages"), list):
            return [dict(x) for x in raw["packages"] if isinstance(x, dict)]
        if isinstance(raw, list):
            return [dict(x) for x in raw if isinstance(x, dict)]
    except Exception as exc:
        logger.warning("load delivery history failed: %s", exc)
    return []


def _save_delivery_history(packages: list[dict[str, Any]]) -> None:
    try:
        _DELIVERY_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        trimmed = packages[:_MAX_DELIVERY_HISTORY]
        _DELIVERY_HISTORY_PATH.write_text(
            json.dumps({"packages": trimmed}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:
        logger.exception("save delivery history failed")


def _append_delivery_history(record: dict[str, Any]) -> None:
    packages = _load_delivery_history()
    rid = str(record.get("package_id") or record.get("run_id") or "")
    packages = [p for p in packages if str(p.get("package_id") or p.get("run_id") or "") != rid]
    packages.insert(0, record)
    _save_delivery_history(packages)


def _set_delivery_job(run_id: str, patch: dict[str, Any]) -> None:
    with _delivery_jobs_lock:
        job = dict(_delivery_jobs.get(run_id) or {})
        job.update(patch)
        _delivery_jobs[run_id] = job


def _get_delivery_job(run_id: str) -> dict[str, Any] | None:
    with _delivery_jobs_lock:
        job = _delivery_jobs.get(run_id)
        return dict(job) if job else None


def start_delivery_package_async(body: dict[str, Any]) -> dict[str, Any]:
    """后台生成交付包；立即返回 run_id。"""
    try:
        from src.local_api.license_gate import check_export_allowed

        denied = check_export_allowed()
        if denied:
            return denied

        stat_year = _safe_int_year(str(body.get("stat_year") or "").strip())
        if stat_year is None:
            return {"ok": False, "error": {"code": "stat_year_required", "message": "stat_year 无效或缺失"}}

        run_id = str(body.get("run_id") or "").strip() or f"dp_{uuid.uuid4().hex[:12]}"
        if _get_delivery_job(run_id):
            return {"ok": False, "error": {"message": "run_id 已存在"}}

        started_at = datetime.now().isoformat(timespec="seconds")
        _set_delivery_job(
            run_id,
            {
                "run_id": run_id,
                "status": "running",
                "message": "正在生成交付包…",
                "started_at": started_at,
                "finished_at": None,
                "stat_year": stat_year,
                "title": str(body.get("title") or "").strip() or f"{stat_year}年度发票数据审计分析报告",
                "params": dict(body),
            },
        )
        job_body = {**body, "async": False, "progress_run_id": run_id}
        job_body.pop("run_id", None)
        t = threading.Thread(target=_run_delivery_package_job, args=(run_id, job_body), daemon=True)
        t.start()
        return {
            "ok": True,
            "async": True,
            "run_id": run_id,
            "message": "交付包生成已启动，请轮询状态。",
        }
    except Exception as exc:
        logger.exception("start_delivery_package_async")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def _run_delivery_package_job(run_id: str, body: dict[str, Any]) -> None:
    try:
        from db.duckdb_conn import get_conn
        from db.schema_sqlfiles import init_all_tables

        conn = get_conn()
        init_all_tables(conn)
        status, payload, ctype, fname = api_report_delivery_package(conn, body)
        finished_at = datetime.now().isoformat(timespec="seconds")
        if status == 200 and isinstance(payload, bytes) and ctype:
            out_dir = delivery_packages_dir()
            safe_name = Path(str(fname or f"{run_id}.zip")).name
            out_path = out_dir / safe_name
            out_path.write_bytes(payload)
            record = {
                "package_id": run_id,
                "run_id": run_id,
                "status": "success",
                "file_name": safe_name,
                "size_bytes": len(payload),
                "stat_year": body.get("stat_year"),
                "title": body.get("title"),
                "started_at": (_get_delivery_job(run_id) or {}).get("started_at"),
                "finished_at": finished_at,
                "download_url": f"/api/report/delivery-package/download?package_id={run_id}",
                "params": dict(body),
            }
            _append_delivery_history(record)
            _set_delivery_job(
                run_id,
                {
                    "status": "success",
                    "message": "交付包已生成",
                    "finished_at": finished_at,
                    "file_name": safe_name,
                    "size_bytes": len(payload),
                    "download_url": record["download_url"],
                },
            )
            return
        err = payload if isinstance(payload, dict) else {"ok": False, "error": {"message": "生成失败"}}
        err_msg = str((err.get("error") or {}).get("message") or "交付包生成失败")
        err_code = str((err.get("error") or {}).get("code") or "")
        _append_delivery_history(
            {
                "package_id": run_id,
                "run_id": run_id,
                "status": "failed",
                "message": err_msg,
                "error": err.get("error"),
                "error_code": err_code or None,
                "stat_year": body.get("stat_year"),
                "title": body.get("title"),
                "started_at": (_get_delivery_job(run_id) or {}).get("started_at"),
                "finished_at": finished_at,
                "params": dict(body),
            }
        )
        _set_delivery_job(
            run_id,
            {
                "status": "failed",
                "message": err_msg,
                "finished_at": finished_at,
                "error": err.get("error"),
                "error_code": err_code or None,
            },
        )
    except Exception as exc:
        logger.exception("delivery package job %s", run_id)
        _set_delivery_job(
            run_id,
            {
                "status": "failed",
                "message": str(exc),
                "finished_at": datetime.now().isoformat(timespec="seconds"),
                "error": {"message": str(exc), "exception_type": type(exc).__name__},
            },
        )


def get_delivery_package_status(run_id: str) -> dict[str, Any]:
    rid = (run_id or "").strip()
    if not rid:
        return {"ok": False, "error": {"message": "run_id 不能为空"}}
    job = _get_delivery_job(rid)
    if job is None:
        for rec in _load_delivery_history():
            if str(rec.get("package_id") or rec.get("run_id") or "") == rid:
                return {"ok": True, **rec, "restored_from_history": True}
        return {"ok": False, "error": {"message": "run_id 不存在"}}
    return {"ok": True, **job}


def list_delivery_packages(*, limit: int = 20) -> dict[str, Any]:
    lim = max(1, min(int(limit or 20), _MAX_DELIVERY_HISTORY))
    packages = _load_delivery_history()[:lim]
    with _delivery_jobs_lock:
        running = [
            {
                "package_id": rid,
                "run_id": rid,
                "status": str(j.get("status") or "running"),
                "message": j.get("message"),
                "stat_year": j.get("stat_year"),
                "title": j.get("title"),
                "started_at": j.get("started_at"),
                "finished_at": j.get("finished_at"),
            }
            for rid, j in _delivery_jobs.items()
            if str(j.get("status") or "") == "running"
        ]
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in running + packages:
        pid = str(row.get("package_id") or row.get("run_id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        merged.append(row)
    return {"ok": True, "packages": merged[:lim], "total": len(merged[:lim])}


def estimate_delivery_package(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    """交付包生成前预估各附件行数与文件大小（轻量统计，不生成 ZIP）。"""
    try:
        sections, estimates, notes = _collect_delivery_sections_estimate(conn, body)
        stat_year = _safe_int_year(str(body.get("stat_year") or "").strip())
        return {
            "ok": True,
            "stat_year": stat_year,
            "estimates": estimates,
            "sections": sections,
            "include_plan": _delivery_include_plan(body),
            "notes": notes,
            "max_zip_mb": _DELIVERY_MAX_ZIP_BYTES // (1024 * 1024),
        }
    except Exception as exc:
        logger.exception("estimate_delivery_package")
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_delivery_package_download(package_id: str) -> tuple[int, bytes | dict[str, Any], str, str]:
    rid = (package_id or "").strip()
    if not rid:
        return 400, {"ok": False, "error": {"message": "package_id 不能为空"}}, "", ""
    job = _get_delivery_job(rid)
    fname = str((job or {}).get("file_name") or "")
    if not fname:
        for rec in _load_delivery_history():
            if str(rec.get("package_id") or rec.get("run_id") or "") == rid:
                fname = str(rec.get("file_name") or "")
                break
    if not fname:
        return 404, {"ok": False, "error": {"message": "交付包文件不存在"}}, "", ""
    path = delivery_packages_dir() / Path(fname).name
    if not path.is_file():
        return 404, {"ok": False, "error": {"message": "交付包文件不存在"}}, "", ""
    try:
        data = path.read_bytes()
        return 200, data, "application/zip", path.name
    except Exception as exc:
        return 500, {"ok": False, "error": {"message": str(exc)}}, "", ""
