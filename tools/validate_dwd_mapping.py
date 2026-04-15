#!/usr/bin/env python3
"""
轻量校验 DWD 映射配置（入口 + 可拆分 include）。

- 入口：config/dwd_mapping.yaml
- 若入口包含 includes，则逐一加载子文件并合并 tables 后校验
- 兼容：旧版单文件（入口直接包含 tables）

不执行 SQL；随规则演进可补充字段引用检查（对照 field_mapping / DDL）。
"""

from __future__ import annotations

import sys
import re
from pathlib import Path

try:
    import yaml
except ImportError:
    print("需要 PyYAML：pip install pyyaml", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    rs = str(root)
    if rs not in sys.path:
        sys.path.insert(0, rs)
    p = root / "config" / "dwd_mapping.yaml"
    try:
        from config.dwd_mapping_loader import load_merged_dwd_mapping

        merged_doc = load_merged_dwd_mapping(root)
    except Exception as exc:
        print(f"加载 dwd_mapping 失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    tables = merged_doc.get("tables") or {}
    includes = merged_doc.get("includes") or []
    if not isinstance(tables, dict) or not tables:
        print("未发现任何 tables", file=sys.stderr)
        return 1

    # ---------------------------------------------------------------------
    # DDL 覆盖校验：映射表列必须覆盖 DDL 中的列（允许少数系统列免映射）
    # ---------------------------------------------------------------------
    ddl_path = root / "config" / "ddl" / "dwd.sql"
    try:
        ddl_text = ddl_path.read_text(encoding="utf-8")
    except Exception as exc:
        print(f"无法读取 DDL：{ddl_path} ({type(exc).__name__}: {exc})", file=sys.stderr)
        return 1

    _RE_CREATE_TABLE = re.compile(
        r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
        flags=re.IGNORECASE,
    )

    # 允许 DDL 中存在但映射文件不要求显式列出（系统维护/插入默认值）
    _DDL_COLUMNS_IGNORE = {
        "created_at",
    }

    _RE_COLDEF = re.compile(
        # col_name  TYPE
        r"\b(?P<col>[A-Za-z_][A-Za-z0-9_]*)\s+"
        r"(?P<type>VARCHAR|TEXT|SMALLINT|INTEGER|INT|TIMESTAMP|DATE|TIME|DECIMAL|BOOLEAN)\b",
        flags=re.IGNORECASE,
    )

    def _extract_table_columns(sql: str) -> dict[str, list[str]]:
        """
        从 dwd.sql 中提取 CREATE TABLE 的列名清单（按出现顺序）。

        解析策略（偏鲁棒，避免被“一行多列”写法影响）：
        - 仅识别 CREATE TABLE IF NOT EXISTS <name> ( ... );
        - 取括号内 block，剔除以 -- 开头的整行注释与行尾 -- 注释；
        - 用正则匹配 `col_name TYPE`，TYPE 取常见基础类型关键词（DuckDB / 本仓库用到的类型）。
        """
        out: dict[str, list[str]] = {}
        for m in _RE_CREATE_TABLE.finditer(sql):
            tname = m.group("name")
            start = m.end()
            depth = 1
            i = start
            while i < len(sql) and depth > 0:
                ch = sql[i]
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                i += 1
            block = sql[start : i - 1]
            cleaned_lines: list[str] = []
            for line in block.splitlines():
                s = line.strip()
                if not s or s.startswith("--"):
                    continue
                if "--" in s:
                    s = s.split("--", 1)[0].rstrip()
                if s:
                    cleaned_lines.append(s)
            cleaned = "\n".join(cleaned_lines)
            cols: list[str] = []
            seen: set[str] = set()
            for cm in _RE_COLDEF.finditer(cleaned):
                col = cm.group("col")
                if col in seen:
                    continue
                seen.add(col)
                cols.append(col)
            out[tname] = cols
        return out

    ddl_cols_by_table = _extract_table_columns(ddl_text)

    ddl_errors: list[str] = []
    for tname, tbl in tables.items():
        target_ddl = tbl.get("target_ddl")
        if isinstance(target_ddl, str) and target_ddl.strip() and target_ddl.strip() != "config/ddl/dwd.sql":
            continue
        if tname not in ddl_cols_by_table:
            ddl_errors.append(f"[DDL] 在 dwd.sql 未找到表：{tname}")
            continue
        ddl_cols = [c for c in ddl_cols_by_table[tname] if c not in _DDL_COLUMNS_IGNORE]
        map_cols = set((tbl.get("columns") or {}).keys())

        missing = [c for c in ddl_cols if c not in map_cols]
        extra = sorted([c for c in map_cols if c not in set(ddl_cols_by_table[tname])])
        if missing:
            ddl_errors.append(f"[DDL] {tname} 缺少映射列：{', '.join(missing)}")
        if extra:
            ddl_errors.append(f"[DDL] {tname} 映射列在 DDL 不存在：{', '.join(extra)}")
    if ddl_errors:
        for e in ddl_errors:
            print(e, file=sys.stderr)
        return 1

    for name, tbl in tables.items():
        if not isinstance(tbl, dict):
            print(f"tables.{name} 须为 object", file=sys.stderr)
            return 1
        for k in ("label_zh", "from_table_types", "primary_key", "columns"):
            if k not in tbl:
                print(f"tables.{name} 缺少 {k}", file=sys.stderr)
                return 1
        cols = tbl.get("columns")
        if not isinstance(cols, dict):
            print(f"tables.{name}.columns 须为 object", file=sys.stderr)
            return 1
        for cn, cdef in cols.items():
            if not isinstance(cdef, dict):
                print(f"tables.{name}.columns.{cn} 须为 object", file=sys.stderr)
                return 1
            layer = cdef.get("layer")
            if layer not in ("A", "B", "C", "D"):
                print(
                    f"tables.{name}.columns.{cn} 缺少 layer（必须为 A/B/C/D）",
                    file=sys.stderr,
                )
                return 1
            if "populate" in cdef:
                continue
            if "source" not in cdef:
                print(f"tables.{name}.columns.{cn} 缺少 source（或应标注 populate）", file=sys.stderr)
                return 1
            src = cdef.get("source")
            if not isinstance(src, dict) or "ods_fields" not in src:
                print(f"tables.{name}.columns.{cn}.source 须含 ods_fields", file=sys.stderr)
                return 1
    print(f"OK: {p.relative_to(root)} ({len(tables)} tables, includes={len(includes) if isinstance(includes, list) else 0})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
