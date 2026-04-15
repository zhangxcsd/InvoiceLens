# -*- coding: utf-8 -*-
"""
为「YAML 尚未收录」的表头生成建议英文字段名：
优先使用表头中的拉丁字母/数字构成 snake_case；否则用 pypinyin；再兜底 column / 去重后缀。
"""
from __future__ import annotations

import re
from typing import Any


def normalize_header_key(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip().replace(" ", "")


def suggest_field_slug(header: str, *, taken_slugs: set[str]) -> str:
    hn = normalize_header_key(header)
    if not hn:
        return "empty_header"

    slug = ""
    # 1) 优先：表头内已有英文/数字 → 直接拉丁化（更简洁）
    s2 = re.sub(r"[^a-zA-Z0-9]+", "_", hn).strip("_").lower()
    s2 = re.sub(r"_+", "_", s2)
    if s2 and re.search(r"[a-zA-Z]", s2) and len(s2) >= 2:
        slug = s2[:80]

    # 2) 兜底：中文等 → pypinyin
    if not slug:
        try:
            from pypinyin import Style, lazy_pinyin

            parts = [p for p in lazy_pinyin(hn, style=Style.NORMAL) if p]
            if parts:
                s = "_".join(parts).lower()
                slug = re.sub(r"[^a-z0-9]+", "_", s)
                slug = re.sub(r"_+", "_", slug).strip("_")[:80]
        except Exception:
            pass

    if not slug:
        slug = "column"

    used = set(taken_slugs)
    base = slug[:80]
    cand = base
    i = 2
    while cand in used:
        suffix = f"_{i}"
        cand = (base[: max(1, 80 - len(suffix))] + suffix).rstrip("_")
        i += 1
        if i > 10000:
            cand = f"{base}_dup"
            break
    return cand
