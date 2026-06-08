"""审计 Word 报告生成 API。"""

from __future__ import annotations

import logging
import re
from datetime import date
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_REPORTS_DIR = Path(__file__).resolve().parents[2] / "data" / "reports"


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
                {"id": "related", "label": "第五章 关联交易分析", "default": True},
                {"id": "compare", "label": "第六章 子公司横向对比", "default": True},
            ],
            "archive_count": len(archive.get("files") or []),
            "reports_dir": str(reports_dir()),
        }
    except Exception as exc:
        return {"ok": False, "error": {"message": str(exc), "exception_type": type(exc).__name__}}


def api_report_generate(conn: Any, body: dict[str, Any]) -> dict[str, Any]:
    try:
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


def api_report_archive_list() -> dict[str, Any]:
    try:
        d = reports_dir()
        files: list[dict[str, Any]] = []
        for p in sorted(d.glob("*.docx"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                st = p.stat()
                files.append(
                    {
                        "file_name": p.name,
                        "size_bytes": st.st_size,
                        "modified_at": st.st_mtime,
                        "download_url": f"/api/report/download?file={p.name}",
                    }
                )
            except Exception:
                continue
        return {"ok": True, "files": files}
    except Exception as exc:
        return {"ok": False, "files": [], "error": {"message": str(exc), "exception_type": type(exc).__name__}}


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
