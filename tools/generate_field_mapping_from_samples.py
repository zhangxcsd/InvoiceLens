"""
从样本目录下的 .xlsx 归纳字段别名，生成 config/field_mapping.yaml。

规则：
- 读取 config/sheet_mapping.yaml 的 key，用「工作表名去空格后包含 key」匹配 sheet 类型（与 excel_to_ods 一致）。
- 在前若干行中自动探测表头行（非空单元格较多的行）。
- 用「关键词分类」把表头文本归入标准字段，并合并 config.field_mapping._DEFAULT_FIELD_MAPPING。
- 若某字段在不同 sheet 类型下观测到的表头集合不同，则写入 sheets: 覆盖；否则 sheets 可为空。

用法（项目根目录）：
  python tools/generate_field_mapping_from_samples.py --data Source_Data/Invoice
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from openpyxl import load_workbook

import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config.field_mapping import _DEFAULT_FIELD_MAPPING  # noqa: E402


def _norm(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip().replace(" ", "")


def _load_sheet_keys(path: Path) -> dict[str, str]:
    raw = path.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(k, str)}


def _sheet_key_for_name(sheet_name: str, sheet_mapping: dict[str, str]) -> str | None:
    n = _norm(sheet_name)
    best: str | None = None
    best_len = -1
    for k in sheet_mapping.keys():
        kn = _norm(k)
        if kn and kn in n and len(kn) > best_len:
            best = k
            best_len = len(kn)
    return best


def _detect_header_row(ws: Any, *, max_scan_rows: int = 12, min_nonempty: int = 5) -> list[str] | None:
    max_r = min(max_scan_rows, int(ws.max_row or 0))
    max_c = int(ws.max_column or 0)
    if max_r <= 0 or max_c <= 0:
        return None
    best: tuple[int, list[str]] | None = None
    for r in range(1, max_r + 1):
        texts: list[str] = []
        nonempty = 0
        for c in range(1, max_c + 1):
            v = ws.cell(row=r, column=c).value
            t = "" if v is None else str(v).strip()
            texts.append(t)
            if t:
                nonempty += 1
        if nonempty >= min_nonempty:
            while texts and not texts[-1]:
                texts.pop()
            score = (nonempty, len(texts))
            if best is None or score > (best[0], len(best[1])):
                best = (nonempty, texts)
    return best[1] if best else None


def _classify_header_to_fields(header: str) -> set[str]:
    """
    将单个表头文本映射到 0..n 个标准字段（保守：宁可少分不要误分）。
    """
    n = _norm(header)
    if not n:
        return set()
    out: set[str] = set()

    # 数电票号码优先于「发票号码」
    if "数电" in n and ("号码" in n or "票号" in n):
        out.add("sdfphm")
        return out

    if "发票代码" in n or n == "代码":
        out.add("invoice_code")
    if "发票号码" in n or ("发票号" in n and "代码" not in n):
        out.add("invoice_no")
    if "开票日期" in n or n == "日期":
        out.add("kprq")

    seller_hit = ("销方" in n) or ("销售方" in n) or ("销货方" in n)
    if seller_hit and ("税号" in n or "识别号" in n or "信用代码" in n or n.endswith("识别号")):
        out.add("seller_tax_no")

    buyer_hit = ("购方" in n) or ("购买方" in n) or ("购货方" in n)
    if buyer_hit and ("税号" in n or "识别号" in n or "信用代码" in n or n.endswith("识别号")):
        out.add("buyer_tax_no")

    if n in ("金额", "不含税金额"):
        out.add("amount")
    if n == "税额" or (n.startswith("税额") and "合计" not in n):
        out.add("tax_amount")
    if "价税合计" in n or n == "含税金额":
        out.add("total_amount")

    return out


def _uniq_sorted(items: list[str]) -> list[str]:
    return sorted(set(items), key=lambda x: (len(x), x))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--data",
        type=str,
        default="Source_Data/Invoice",
        help="样本根目录（相对项目根或绝对路径）",
    )
    ap.add_argument(
        "--out",
        type=str,
        default="config/field_mapping.yaml",
        help="输出 YAML（相对项目根或绝对路径）",
    )
    ap.add_argument(
        "--force-sheets",
        action="store_true",
        help="强制为 sheet_mapping.yaml 的每个 sheet_key 都输出 sheets: 覆盖块（即便与 default 相同也输出完整别名）。",
    )
    ap.add_argument(
        "--no-incremental",
        action="store_true",
        help="关闭增量更新（将直接用样本推断覆盖字段别名；默认是增量并集）。",
    )
    ap.add_argument(
        "--default-strategy",
        choices=["intersection", "union"],
        default="intersection",
        help="default 别名策略：intersection（默认，取共同部分）或 union（取并集）。",
    )
    ap.add_argument(
        "--samples-only",
        action="store_true",
        help="只输出样本中实际出现的别名：不混入内置默认别名（更贴近 Excel 表头）。",
    )
    ap.add_argument(
        "--prune-existing-to-samples",
        action="store_true",
        help="仅保留既有 YAML 中出现在样本表头里的别名（丢弃不在样本里的“额外别名”）。",
    )
    args = ap.parse_args()

    data_dir = Path(args.data)
    if not data_dir.is_absolute():
        data_dir = ROOT / data_dir
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path

    sheet_mapping = _load_sheet_keys(ROOT / "config" / "sheet_mapping.yaml")
    sheet_keys = list(sheet_mapping.keys())
    fields = list(_DEFAULT_FIELD_MAPPING.keys())

    # 读取既有文件：用于增量更新（保留你手工写的别名顺序）
    existing_default: dict[str, list[str]] = {}
    existing_sheets: dict[str, dict[str, list[str]]] = {}
    if (out_path.exists()) and (not args.no_incremental):
        try:
            existing_doc = yaml.safe_load(out_path.read_text(encoding="utf-8"))
            if isinstance(existing_doc, dict):
                if isinstance(existing_doc.get("default"), dict):
                    for k, v in existing_doc["default"].items():
                        if isinstance(k, str) and isinstance(v, list):
                            existing_default[k] = [str(x) for x in v if x is not None and str(x).strip()]
                if isinstance(existing_doc.get("sheets"), dict):
                    for sk, v in existing_doc["sheets"].items():
                        if not isinstance(sk, str) or not isinstance(v, dict):
                            continue
                        f_map: dict[str, list[str]] = {}
                        for f, aliases in v.items():
                            if not isinstance(f, str) or not isinstance(aliases, list):
                                continue
                            f_map[f] = [str(x) for x in aliases if x is not None and str(x).strip()]
                        existing_sheets[sk] = f_map
        except Exception:
            # 增量读取失败则退化为非增量
            existing_default = {}
            existing_sheets = {}

    # sheet_key -> field -> set(headers)
    per_sheet: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    global_headers: dict[str, set[str]] = defaultdict(set)
    file_errors: list[tuple[str, str, str]] = []

    for path in sorted(data_dir.rglob("*.xlsx")):
        try:
            wb = load_workbook(path, read_only=True, data_only=True)
        except Exception as exc:
            file_errors.append((str(path), type(exc).__name__, str(exc)))
            continue
        try:
            for sn in wb.sheetnames:
                sk = _sheet_key_for_name(sn, sheet_mapping)
                if sk is None:
                    continue
                try:
                    ws = wb[sn]
                    headers = _detect_header_row(ws)
                    if not headers:
                        continue
                    for h in headers:
                        if not str(h).strip():
                            continue
                        hs = str(h).strip()
                        for f in _classify_header_to_fields(hs):
                            if f in fields:
                                per_sheet[sk][f].add(hs)
                                global_headers[f].add(hs)
                except Exception as exc:
                    file_errors.append((f"{path}::{sn}", type(exc).__name__, str(exc)))
        finally:
            wb.close()

    # 计算 default / sheets 输出：
    # - default：根据 --default-strategy 从“所有 sheet_key 的样本观测集合”取交集或并集
    # - sheets：只有当该 sheet_key 的完整别名集合与 default 不同才写入覆盖；否则 sheets 可为空
    default_fields: dict[str, list[str]] = {}
    for f in fields:
        # 只用“观测到非空集合”的 sheet 参与交并集，避免某些 sheet 完全缺失字段导致 default 被拖空
        observed_sets: list[set[str]] = []
        for sk in sheet_keys:
            obs = per_sheet.get(sk, {}).get(f, set()) or set()
            if obs:
                observed_sets.append(set(obs))

        if not observed_sets:
            # 样本里没观测到该字段别名
            sample_set: set[str] = set()
        elif args.default_strategy == "intersection":
            cur = set(observed_sets[0])
            for s in observed_sets[1:]:
                cur &= s
            if not cur:
                # 防止交集为空导致推断全缺失：退回并集（仍只来自样本）
                cur = set().union(*observed_sets)
            sample_set = cur
        else:
            sample_set = set().union(*observed_sets)

        if not args.samples_only:
            sample_set |= set(_DEFAULT_FIELD_MAPPING[f])

        # default 顺序：既有 YAML 优先（可选 prune），其次补齐样本集合
        sample_sorted = _uniq_sorted(list(sample_set))
        if not args.no_incremental and existing_default:
            existing_list = existing_default.get(f) or []
            if args.prune_existing_to_samples:
                sample_set_for_filter = set(sample_set)
                existing_list = [str(x).strip() for x in existing_list if str(x).strip() in sample_set_for_filter]
            merged_order: list[str] = []
            seen: set[str] = set()
            for x in existing_list:
                sx = str(x).strip()
                if sx and sx not in seen:
                    merged_order.append(sx)
                    seen.add(sx)
            for x in sample_sorted:
                if x not in seen:
                    merged_order.append(x)
                    seen.add(x)
            default_fields[f] = merged_order
        else:
            default_fields[f] = sample_sorted

    sheets_out: dict[str, dict[str, list[str]]] = {}
    for sk in sheet_keys:
        fmap_obs = per_sheet.get(sk, {}) or {}
        sheet_block: dict[str, list[str]] = {}

        for f in fields:
            obs_aliases = fmap_obs.get(f, set()) or set()
            existing_list = (existing_sheets.get(sk, {}) or {}).get(f, []) or []
            had_manual_override = len(existing_list) > 0

            # alias_set 用于去重与“是否需要补齐”的判断
            alias_set: set[str] = set(obs_aliases)
            if had_manual_override:
                alias_set |= set(existing_list)

            # samples-only=false 时，为避免额外冗余：仅在样本观测到该字段时，才补入内置默认别名
            if not args.samples_only and obs_aliases:
                alias_set |= set(_DEFAULT_FIELD_MAPPING[f])

            alias_sorted = _uniq_sorted(list(alias_set))

            # 增量：尽量沿用 existing_sheets 的顺序；可选 prune 到样本
            if not args.no_incremental and existing_sheets:
                if args.prune_existing_to_samples:
                    alias_set_for_filter = set(alias_set)
                    existing_list = [str(x).strip() for x in existing_list if str(x).strip() in alias_set_for_filter]

                merged_order: list[str] = []
                seen: set[str] = set()
                for x in existing_list:
                    sx = str(x).strip()
                    if sx and sx not in seen:
                        merged_order.append(sx)
                        seen.add(sx)
                for x in alias_sorted:
                    if x not in seen:
                        merged_order.append(x)
                        seen.add(x)
                alias_sorted = merged_order

            # 选择最终写入值：
            # - 若存在手工覆盖：始终写出完整别名列表（优先保护人工维护的内容）
            # - 否则：若与 default 完全一致 -> 写空列表，仅表示“该字段存在、使用公共别名”；否则写 sheet 专属别名列表
            if had_manual_override:
                sheet_block[f] = alias_sorted
            else:
                if not alias_sorted:
                    sheet_block[f] = []
                elif set(alias_sorted) == set(default_fields[f]):
                    sheet_block[f] = []
                else:
                    sheet_block[f] = alias_sorted

        # 按你的要求：所有 sheet_key 都要在 sheets: 中出现，且包含所有字段 key
        sheets_out[sk] = sheet_block

    header_comment = (
        "# 由 tools/generate_field_mapping_from_samples.py 根据样本 xlsx 自动归纳生成。\n"
        "# 可手工增删别名；修改后刷新前端或重启本地 API。\n"
        "# 防覆盖策略：在非 --no-incremental 模式下，若某 sheet/字段在样本中未观测到，但 YAML 已存在手工别名，则会被保留。\n"
        "#\n"
        "# default: 公共默认别名（由样本交并集计算；可用 --samples-only / --default-strategy 控制）\n"
        "# sheets: 仅在“该 sheet 与 default 完全别名集合不同时”才写入覆盖；因此大量 sheet 可为空\n"
        "# sheets: 按 sheet_mapping.yaml 的 key 覆盖；工作表名去空格后需「包含」该 key\n"
        "# force-sheets：强制为每个 sheet_key 都输出完整别名列表（便于人工对比/统一维护）\n"
        "#\n"
    )

    doc = {"default": default_fields, "sheets": sheets_out}
    text = header_comment + yaml.safe_dump(
        doc,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    out_path.write_text(text, encoding="utf-8")

    print(f"written: {out_path}")
    print(f"xlsx files scanned under: {data_dir}")
    print(f"sheet types seen: {sorted(per_sheet.keys(), key=lambda x: x.encode('utf-8'))}")
    print(f"sheet overrides written: {len(sheets_out)}")
    if file_errors:
        print(f"errors (show up to 10 / {len(file_errors)}):")
        for row in file_errors[:10]:
            print(" ", row[0], row[1])


if __name__ == "__main__":
    main()
