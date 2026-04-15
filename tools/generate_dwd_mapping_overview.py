#!/usr/bin/env python3
"""
生成 DWD 映射总览（Markdown + CSV）。

输入：
- config/dwd_mapping.yaml（入口，支持 includes 拆分）

输出：
- docs/mapping/dwd_mapping_overview.md
- docs/mapping/dwd_mapping_overview.csv

注意：
- 本脚本不执行 SQL；建议先运行 tools/validate_dwd_mapping.py（含 DDL 覆盖校验）。
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    raise SystemExit("需要 PyYAML：pip install pyyaml") from exc


ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / "config" / "dwd_mapping.yaml"
OUT_DIR = ROOT / "docs" / "mapping"
OUT_MD = OUT_DIR / "dwd_mapping_overview.md"
OUT_CSV = OUT_DIR / "dwd_mapping_overview.csv"


@dataclass(frozen=True)
class ColRow:
    dwd_table: str
    dwd_column: str
    column_type: str
    nullable: str
    layer: str
    rule_zh: str
    from_table_types: str
    sheet_labels_zh: str
    ods_fields: str
    expr_or_populate: str
    comment: str
    target_ddl: str


def _as_list(v: Any) -> list:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def _load_yaml(rel_path: str) -> dict:
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ValueError("includes 条目须为非空字符串路径")
    p = (ROOT / rel_path).resolve()
    try:
        p.relative_to(ROOT)
    except Exception as exc:
        raise ValueError(f"includes 路径必须在仓库内：{rel_path}") from exc
    if not p.exists():
        raise FileNotFoundError(f"include 文件未找到：{rel_path}")
    data = yaml.safe_load(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"include 根节点须为 mapping：{rel_path}")
    if data.get("version") != 1:
        raise ValueError(f"include.version 须为 1：{rel_path}")
    return data


def load_tables() -> dict[str, dict]:
    entry = yaml.safe_load(ENTRY.read_text(encoding="utf-8"))
    if not isinstance(entry, dict):
        raise ValueError("入口根节点须为 mapping")
    if entry.get("version") != 1:
        raise ValueError("入口 version 须为 1")

    merged: dict[str, dict] = {}
    base_tables = entry.get("tables") or {}
    if base_tables is None:
        base_tables = {}
    if not isinstance(base_tables, dict):
        raise ValueError("入口 tables 须为 object")
    merged.update(base_tables)

    includes = entry.get("includes") or []
    if includes is None:
        includes = []
    if not isinstance(includes, list):
        raise ValueError("入口 includes 须为 list（或省略）")
    for rel in includes:
        inc = _load_yaml(rel)
        inc_tables = inc.get("tables") or {}
        if not isinstance(inc_tables, dict) or not inc_tables:
            raise ValueError(f"include.tables 不能为空：{rel}")
        for tname, tbl in inc_tables.items():
            if tname in merged:
                raise ValueError(f"重复表定义：{tname}（来自 {rel}）")
            merged[tname] = tbl

    if not merged:
        raise ValueError("未发现任何 tables（入口 tables 为空且 includes 为空）")
    return merged


def _render_md(rows: list[ColRow]) -> str:
    lines: list[str] = []
    lines.append("# DWD 映射总览")
    lines.append("")
    lines.append("本文件由 `tools/generate_dwd_mapping_overview.py` 自动生成。")
    lines.append("")
    lines.append(f"- 入口：`config/dwd_mapping.yaml`（includes 合并后展开）")
    lines.append(f"- 行数：{len(rows)}")
    lines.append("")
    lines.append("## 列级总览")
    lines.append("")
    lines.append(
        "| dwd_table | dwd_column | type | nullable | layer | rule_zh | from_table_types | sheet_labels_zh | ods_fields | expr/populate | comment |"
    )
    lines.append(
        "|---|---|---|---|---|---|---|---|---|---|---|"
    )
    for r in rows:
        def esc(s: str) -> str:
            return (s or "").replace("\n", " ").replace("|", "\\|").strip()

        lines.append(
            "| "
            + " | ".join(
                [
                    esc(r.dwd_table),
                    esc(r.dwd_column),
                    esc(r.column_type),
                    esc(r.nullable),
                    esc(r.layer),
                    esc(r.rule_zh),
                    esc(r.from_table_types),
                    esc(r.sheet_labels_zh),
                    esc(r.ods_fields),
                    esc(r.expr_or_populate),
                    esc(r.comment),
                ]
            )
            + " |"
        )
    lines.append("")
    lines.append("## 备注")
    lines.append("")
    lines.append("- `layer` 当前若为空，表示该列尚未补充分层标注（后续建议强制 A/B/C/D）。")
    lines.append("- `rule_zh` 为中文口径说明；用于快速查阅与排错。")
    lines.append("- `expr/populate` 仅用于对齐语义；真正 SQL 以 ETL 实现为准。")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    tables = load_tables()

    rows: list[ColRow] = []
    for tname in sorted(tables.keys()):
        tbl = tables[tname]
        cols = tbl.get("columns") or {}
        if not isinstance(cols, dict):
            raise ValueError(f"tables.{tname}.columns 须为 object")
        from_table_types = ",".join([str(x) for x in _as_list(tbl.get("from_table_types")) if str(x).strip()])
        sheet_labels_zh = ",".join([str(x) for x in _as_list(tbl.get("sheet_labels_zh")) if str(x).strip()])
        target_ddl = str(tbl.get("target_ddl") or "")

        for col_name in cols.keys():
            cdef = cols[col_name] or {}
            if not isinstance(cdef, dict):
                raise ValueError(f"tables.{tname}.columns.{col_name} 须为 object")
            src = cdef.get("source") or {}
            ods_fields = ""
            if isinstance(src, dict) and "ods_fields" in src:
                ods_fields = ",".join([str(x) for x in _as_list(src.get("ods_fields")) if str(x).strip()])

            expr = str(cdef.get("expr") or "")
            populate = str(cdef.get("populate") or "")
            expr_or_populate = populate if populate else expr

            # 这些字段是“展示用”；缺失时保持空串
            col_type = str(cdef.get("type") or "")
            nullable = str(cdef.get("nullable") if "nullable" in cdef else "")
            comment = str(cdef.get("comment") or "")
            layer = str(cdef.get("layer") or "")
            rule_zh = str(cdef.get("rule_zh") or "")

            rows.append(
                ColRow(
                    dwd_table=tname,
                    dwd_column=col_name,
                    column_type=col_type,
                    nullable=nullable,
                    layer=layer,
                    rule_zh=rule_zh,
                    from_table_types=from_table_types,
                    sheet_labels_zh=sheet_labels_zh,
                    ods_fields=ods_fields,
                    expr_or_populate=expr_or_populate,
                    comment=comment,
                    target_ddl=target_ddl,
                )
            )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text(_render_md(rows), encoding="utf-8")

    with OUT_CSV.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "dwd_table",
                "dwd_column",
                "type",
                "nullable",
                "layer",
                "rule_zh",
                "from_table_types",
                "sheet_labels_zh",
                "ods_fields",
                "expr_or_populate",
                "comment",
                "target_ddl",
            ],
        )
        w.writeheader()
        for r in rows:
            w.writerow(
                {
                    "dwd_table": r.dwd_table,
                    "dwd_column": r.dwd_column,
                    "type": r.column_type,
                    "nullable": r.nullable,
                    "layer": r.layer,
                    "rule_zh": r.rule_zh,
                    "from_table_types": r.from_table_types,
                    "sheet_labels_zh": r.sheet_labels_zh,
                    "ods_fields": r.ods_fields,
                    "expr_or_populate": r.expr_or_populate,
                    "comment": r.comment,
                    "target_ddl": r.target_ddl,
                }
            )

    print(f"OK: wrote {OUT_MD.relative_to(ROOT)} and {OUT_CSV.relative_to(ROOT)} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

