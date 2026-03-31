from pathlib import Path


def generate_report(output_dir: str) -> str:
    """
    报告生成占位函数：创建一个文本占位文件，后续替换为 docx/pdf 生成逻辑。
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    report = out / "report_placeholder.txt"
    report.write_text("InvoiceLens 报告生成骨架已就绪。", encoding="utf-8")
    return str(report)
