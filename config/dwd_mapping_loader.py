"""
加载并合并 config/dwd_mapping.yaml 及其 includes（与 tools/validate_dwd_mapping 规则一致）。

供 ODS→DWD ETL 按方案 A 读取每列的 source.ods_fields 作为 DuckDB 列绑定候选。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore[assignment]


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _load_yaml_file(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise RuntimeError("需要 PyYAML：pip install pyyaml")
    raw = path.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise ValueError(f"YAML 根节点须为 mapping：{path}")
    return data


def load_merged_dwd_mapping(project_root: Path | None = None) -> dict[str, Any]:
    """
    返回合并后的文档：含 version、defaults、includes、tables（已合并 includes 内各文件的 tables）。
    入口 config/dwd_mapping.yaml 中 tables 与 include 内表名不得冲突。
    """
    root = project_root or _project_root()
    p = root / "config" / "dwd_mapping.yaml"
    data = _load_yaml_file(p)
    if data.get("version") != 1:
        raise ValueError("dwd_mapping.yaml version 须为 1")

    merged_tables: dict[str, Any] = {}
    base_tables = data.get("tables") or {}
    if not isinstance(base_tables, dict):
        raise ValueError("dwd_mapping.yaml tables 须为 object")
    for k, v in base_tables.items():
        merged_tables[k] = v

    includes = data.get("includes") or []
    if includes is not None and not isinstance(includes, list):
        raise ValueError("includes 须为 list（或省略）")

    for rel in includes:
        if not isinstance(rel, str) or not rel.strip():
            raise ValueError("includes 条目须为非空字符串路径")
        ip = (root / rel).resolve()
        try:
            ip.relative_to(root)
        except Exception as exc:
            raise ValueError(f"includes 路径必须在仓库内：{rel}") from exc
        if not ip.exists():
            raise FileNotFoundError(f"include 文件未找到：{rel}")
        inc = _load_yaml_file(ip)
        if inc.get("version") != 1:
            raise ValueError(f"include.version 须为 1：{rel}")
        inc_tables = inc.get("tables") or {}
        if not isinstance(inc_tables, dict) or not inc_tables:
            raise ValueError(f"include.tables 不能为空：{rel}")
        for tname, tbl in inc_tables.items():
            if tname in merged_tables:
                raise ValueError(f"重复表定义：{tname}（来自 {rel}）")
            merged_tables[tname] = tbl

    if not merged_tables:
        raise ValueError("未发现任何 tables（入口 tables 为空且 includes 为空）")

    out = {**data, "tables": merged_tables}
    return out


def ods_candidates_for_dwd_column(
    merged_doc: dict[str, Any],
    table_name: str,
    dwd_column: str,
) -> tuple[str, ...] | None:
    """
    读取某 DWD 列在映射中的 source.ods_fields（按顺序即为绑定优先级）。

    对 populate 标记列（如 post_aggregate、dwd_lineage）返回 None，由 ETL 单独处理。
    """
    tables = merged_doc.get("tables")
    if not isinstance(tables, dict):
        return None
    tbl = tables.get(table_name)
    if not isinstance(tbl, dict):
        return None
    cols = tbl.get("columns")
    if not isinstance(cols, dict):
        return None
    cdef = cols.get(dwd_column)
    if not isinstance(cdef, dict):
        return None
    if cdef.get("populate"):
        return None
    src = cdef.get("source")
    if not isinstance(src, dict):
        return None
    fields = src.get("ods_fields")
    if not isinstance(fields, list) or not fields:
        return None
    return tuple(str(x) for x in fields)
