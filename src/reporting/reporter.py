"""Word 审计报告生成（python-docx）。"""

from __future__ import annotations

import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_CHAPTERS: dict[str, bool] = {
    "overview": True,
    "structure": True,
    "supplier": True,
    "audit_flags": True,
    "related": True,
    "compare": True,
}


def _chapter_enabled(chapters: dict[str, bool] | None, key: str) -> bool:
    if chapters is None:
        return DEFAULT_CHAPTERS.get(key, True)
    return bool(chapters.get(key, DEFAULT_CHAPTERS.get(key, True)))


def _fmt_amount(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v:,.2f}"


def _fmt_pct(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v * 100:.2f}%"


def _add_heading(doc: Any, text: str, level: int = 1) -> None:
    doc.add_heading(text, level=level)


def _add_kv_table(doc: Any, rows: list[tuple[str, str]]) -> None:
    if not rows:
        doc.add_paragraph("（无数据）")
        return
    table = doc.add_table(rows=len(rows), cols=2)
    table.style = "Table Grid"
    for i, (k, v) in enumerate(rows):
        table.rows[i].cells[0].text = k
        table.rows[i].cells[1].text = v


def _query_overview(conn: Any, stat_year: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            coalesce(sum(net_jshj), 0),
            coalesce(sum(normal_cnt + red_cnt + cancel_cnt), 0)::BIGINT,
            coalesce(sum(cancel_cnt), 0)::BIGINT
        FROM dws_inv_trend WHERE stat_year = ?
        """,
        [stat_year],
    ).fetchone()
    sup = conn.execute(
        "SELECT count(DISTINCT supplier_id)::BIGINT FROM dws_sup_conc WHERE stat_year = ?",
        [stat_year],
    ).fetchone()
    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(stat_year)
    flags = conn.execute(
        "SELECT count(*)::BIGINT FROM dm_audit_flag WHERE group_id = ?",
        [gid],
    ).fetchone()
    entity_cnt = conn.execute(
        "SELECT count(DISTINCT entity_id)::BIGINT FROM dws_inv_trend WHERE stat_year = ?",
        [stat_year],
    ).fetchone()
    return {
        "total_net": float(row[0] or 0) if row else 0.0,
        "invoice_cnt": int(row[1] or 0) if row else 0,
        "cancel_cnt": int(row[2] or 0) if row else 0,
        "supplier_cnt": int(sup[0] or 0) if sup else 0,
        "flag_cnt": int(flags[0] or 0) if flags else 0,
        "entity_cnt": int(entity_cnt[0] or 0) if entity_cnt else 0,
    }


def _query_trend_rows(conn: Any, stat_year: int) -> list[tuple[int, float]]:
    rows = conn.execute(
        """
        SELECT stat_month, coalesce(sum(net_jshj), 0)
        FROM dws_inv_trend
        WHERE stat_year = ?
        GROUP BY stat_month
        ORDER BY stat_month
        """,
        [stat_year],
    ).fetchall()
    return [(int(r[0]), float(r[1] or 0)) for r in rows or []]


def _query_top_suppliers(conn: Any, stat_year: int, limit: int = 10) -> list[tuple[str, str, float, float]]:
    rows = conn.execute(
        """
        SELECT entity_name, supplier_name, net_jshj, amount_ratio
        FROM dws_sup_conc
        WHERE stat_year = ?
        ORDER BY net_jshj DESC NULLS LAST
        LIMIT ?
        """,
        [stat_year, limit],
    ).fetchall()
    return [
        (str(r[0] or ""), str(r[1] or ""), float(r[2] or 0), float(r[3] or 0))
        for r in rows or []
    ]


def _query_flags(conn: Any, stat_year: int, limit: int = 50) -> list[tuple[str, str, str, str, str]]:
    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(stat_year)
    rows = conn.execute(
        """
        SELECT rule_id, risk_level, entity_name, seller_name, description
        FROM dm_audit_flag
        WHERE group_id = ?
        ORDER BY
            CASE risk_level WHEN '高风险' THEN 1 WHEN '中风险' THEN 2 ELSE 3 END,
            amount DESC NULLS LAST
        LIMIT ?
        """,
        [gid, limit],
    ).fetchall()
    return [
        (str(r[0] or ""), str(r[1] or ""), str(r[2] or ""), str(r[3] or ""), str(r[4] or ""))
        for r in rows or []
    ]


def _query_related(conn: Any, stat_year: int) -> tuple[list[tuple], list[tuple]]:
    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(stat_year)
    circ = conn.execute(
        """
        SELECT party_a_name, party_b_name, amount_a_to_b, amount_b_to_a, circular_ratio, risk_level
        FROM dm_circ_inv WHERE group_id = ?
        ORDER BY circular_ratio DESC NULLS LAST
        LIMIT 20
        """,
        [gid],
    ).fetchall()
    shell = conn.execute(
        """
        SELECT group_member_name, intermediary_name, amount_in, amount_out, passthrough_ratio, risk_level
        FROM dm_shell_co WHERE group_id = ?
        ORDER BY passthrough_ratio DESC NULLS LAST
        LIMIT 20
        """,
        [gid],
    ).fetchall()
    return list(circ or []), list(shell or [])


def _query_scorecard(conn: Any, stat_year: int) -> list[tuple]:
    from src.audit.config_loader import group_id_for_year

    gid = group_id_for_year(stat_year)
    rows = conn.execute(
        """
        SELECT entity_name, total_amount, total_count, supplier_count,
               flag_total, flag_high, risk_score, risk_level
        FROM ads_scorecard
        WHERE group_id = ? AND stat_year = ?
        ORDER BY risk_score ASC, flag_high DESC
        LIMIT 50
        """,
        [gid, stat_year],
    ).fetchall()
    return list(rows or [])


def generate_audit_report_docx(
    conn: Any,
    *,
    stat_year: int,
    title: str,
    chapters: dict[str, bool] | None = None,
    output_dir: str,
) -> dict[str, Any]:
    """生成 Word 审计报告，返回文件路径信息。"""
    try:
        from docx import Document
        from docx.enum.text import WD_ALIGN_PARAGRAPH
    except ImportError as exc:
        return {
            "ok": False,
            "error": {
                "message": "缺少 python-docx 依赖，请安装 requirements.txt",
                "exception_type": type(exc).__name__,
            },
        }

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = "".join(c if c.isalnum() or c in "._-" else "_" for c in title[:40])
    file_name = f"audit_report_{stat_year}_{ts}_{safe_title}.docx"
    file_path = out / file_name

    doc = Document()
    overview = _query_overview(conn, stat_year)

    # 封面
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(title)
    run.bold = True
    run.font.size = run.font.size  # keep default
    doc.add_paragraph("")
    cover = doc.add_paragraph(f"分析年度：{stat_year}")
    cover.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sub = doc.add_paragraph(
        f"数据来源：{overview['entity_cnt']} 家主体，共 {overview['invoice_cnt']:,} 张发票"
    )
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    gen = doc.add_paragraph(f"生成日期：{date.today().isoformat()}")
    gen.alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.add_paragraph("保密等级：内部资料").alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.add_page_break()

    if _chapter_enabled(chapters, "overview"):
        _add_heading(doc, "第一章  数据概览", 1)
        _add_kv_table(
            doc,
            [
                ("分析年度", str(stat_year)),
                ("净额合计（net_jshj）", _fmt_amount(overview["total_net"])),
                ("发票总张数", f"{overview['invoice_cnt']:,}"),
                ("涉及供应商数", str(overview["supplier_cnt"])),
                ("作废/冲红相关张数", str(overview["cancel_cnt"])),
                ("审计疑点数", str(overview["flag_cnt"])),
                ("涉及主体数", str(overview["entity_cnt"])),
            ],
        )
        doc.add_paragraph(
            "说明：金额口径来自 DWS 聚合层（dws_inv_trend）；疑点来自 dm_audit_flag。"
        )

    if _chapter_enabled(chapters, "structure"):
        _add_heading(doc, "第二章  发票结构分析", 1)
        trend_rows = _query_trend_rows(conn, stat_year)
        if trend_rows:
            table = doc.add_table(rows=len(trend_rows) + 1, cols=2)
            table.style = "Table Grid"
            table.rows[0].cells[0].text = "月份"
            table.rows[0].cells[1].text = "净额合计"
            for i, (m, amt) in enumerate(trend_rows, start=1):
                table.rows[i].cells[0].text = f"{stat_year}-{m:02d}"
                table.rows[i].cells[1].text = _fmt_amount(amt)
        else:
            doc.add_paragraph("（暂无月度趋势数据，请先刷新 DWS 聚合。）")

    if _chapter_enabled(chapters, "supplier"):
        _add_heading(doc, "第三章  供应商分析", 1)
        tops = _query_top_suppliers(conn, stat_year)
        if tops:
            table = doc.add_table(rows=len(tops) + 1, cols=4)
            table.style = "Table Grid"
            hdr = ("购方企业", "供应商", "采购净额", "金额占比")
            for j, h in enumerate(hdr):
                table.rows[0].cells[j].text = h
            for i, (ent, sup, amt, ratio) in enumerate(tops, start=1):
                table.rows[i].cells[0].text = ent or "—"
                table.rows[i].cells[1].text = sup or "—"
                table.rows[i].cells[2].text = _fmt_amount(amt)
                table.rows[i].cells[3].text = _fmt_pct(ratio)
        else:
            doc.add_paragraph("（暂无供应商集中度数据。）")

    if _chapter_enabled(chapters, "audit_flags"):
        _add_heading(doc, "第四章  审计疑点清单", 1)
        flags = _query_flags(conn, stat_year)
        if flags:
            table = doc.add_table(rows=len(flags) + 1, cols=5)
            table.style = "Table Grid"
            hdr = ("规则", "风险", "企业", "供应商", "描述")
            for j, h in enumerate(hdr):
                table.rows[0].cells[j].text = h
            for i, (rule, risk, ent, seller, desc) in enumerate(flags, start=1):
                table.rows[i].cells[0].text = rule
                table.rows[i].cells[1].text = risk
                table.rows[i].cells[2].text = ent or "—"
                table.rows[i].cells[3].text = seller or "—"
                table.rows[i].cells[4].text = (desc or "")[:200]
        else:
            doc.add_paragraph("（当前年度暂无审计疑点，请先运行疑点扫描。）")

    if _chapter_enabled(chapters, "related"):
        _add_heading(doc, "第五章  关联交易分析", 1)
        circ, shell = _query_related(conn, stat_year)
        doc.add_heading("5.1 对开发票", level=2)
        if circ:
            table = doc.add_table(rows=len(circ) + 1, cols=6)
            table.style = "Table Grid"
            hdr = ("甲方", "乙方", "A→B金额", "B→A金额", "对开比例", "风险")
            for j, h in enumerate(hdr):
                table.rows[0].cells[j].text = h
            for i, r in enumerate(circ, start=1):
                table.rows[i].cells[0].text = str(r[0] or "")
                table.rows[i].cells[1].text = str(r[1] or "")
                table.rows[i].cells[2].text = _fmt_amount(float(r[2] or 0))
                table.rows[i].cells[3].text = _fmt_amount(float(r[3] or 0))
                table.rows[i].cells[4].text = _fmt_pct(float(r[4] or 0))
                table.rows[i].cells[5].text = str(r[5] or "")
        else:
            doc.add_paragraph("（暂无对开发票记录。）")
        doc.add_heading("5.2 疑似通道公司", level=2)
        if shell:
            table = doc.add_table(rows=len(shell) + 1, cols=6)
            table.style = "Table Grid"
            hdr = ("集团成员", "中间商", "收款", "付款", "穿透比例", "风险")
            for j, h in enumerate(hdr):
                table.rows[0].cells[j].text = h
            for i, r in enumerate(shell, start=1):
                table.rows[i].cells[0].text = str(r[0] or "")
                table.rows[i].cells[1].text = str(r[1] or "")
                table.rows[i].cells[2].text = _fmt_amount(float(r[2] or 0))
                table.rows[i].cells[3].text = _fmt_amount(float(r[3] or 0))
                table.rows[i].cells[4].text = _fmt_pct(float(r[4] or 0))
                table.rows[i].cells[5].text = str(r[5] or "")
        else:
            doc.add_paragraph("（暂无通道公司识别结果。）")

    if _chapter_enabled(chapters, "compare"):
        _add_heading(doc, "第六章  子公司横向对比", 1)
        score_rows = _query_scorecard(conn, stat_year)
        if score_rows:
            table = doc.add_table(rows=len(score_rows) + 1, cols=8)
            table.style = "Table Grid"
            hdr = ("企业", "进项净额", "张数", "供应商数", "疑点", "高风险", "得分", "评级")
            for j, h in enumerate(hdr):
                table.rows[0].cells[j].text = h
            for i, r in enumerate(score_rows, start=1):
                table.rows[i].cells[0].text = str(r[0] or "")
                table.rows[i].cells[1].text = _fmt_amount(float(r[1] or 0))
                table.rows[i].cells[2].text = str(int(r[2] or 0))
                table.rows[i].cells[3].text = str(int(r[3] or 0))
                table.rows[i].cells[4].text = str(int(r[4] or 0))
                table.rows[i].cells[5].text = str(int(r[5] or 0))
                table.rows[i].cells[6].text = f"{float(r[6] or 0):.0f}"
                table.rows[i].cells[7].text = str(r[7] or "")
        else:
            doc.add_paragraph("（暂无评分卡数据，请先刷新 ads_scorecard。）")

    doc.save(str(file_path))
    return {
        "ok": True,
        "file_name": file_name,
        "file_path": str(file_path),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def generate_report(output_dir: str) -> str:
    """兼容旧占位接口。"""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    report = out / "report_placeholder.txt"
    report.write_text(
        "请使用 generate_audit_report_docx 或前端「报告配置」页生成 Word 报告。",
        encoding="utf-8",
    )
    return str(report)
