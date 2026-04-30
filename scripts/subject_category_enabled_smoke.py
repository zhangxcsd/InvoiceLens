from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.subject_category.infer import (
    enabled_category_codes,
    infer_org_subject_category,
    load_category_doc,
    load_matching_doc,
)


def _run_case(
    *,
    title: str,
    party_id: str,
    party_name: str,
    matching_doc: dict,
    category_doc: dict,
) -> None:
    result = infer_org_subject_category(
        party_id=party_id,
        party_name=party_name,
        matching_doc=matching_doc,
        category_doc=category_doc,
    )
    print(f"[{title}] code={result.category_code} needs_review={result.needs_review}")
    print(f"  reasons={result.reasons}")
    print(f"  skipped_disabled_codes={result.skipped_disabled_codes}")


def main() -> None:
    matching_doc = load_matching_doc()
    category_doc = load_category_doc()
    print(f"enabled_codes={sorted(enabled_category_codes(category_doc))}")

    # Case 1: 默认启用时，92 + 4字应命中 SC-SELF
    _run_case(
        title="default-self-enabled",
        party_id="92330100MA2BCD1234",
        party_name="某某商行",
        matching_doc=matching_doc,
        category_doc=category_doc,
    )

    # Case 2: 停用 SC-SELF 后，同输入不再命中，且记录 disabled 提示
    disabled_doc = copy.deepcopy(category_doc)
    rows = disabled_doc.get("categories")
    if isinstance(rows, list):
        for it in rows:
            if isinstance(it, dict) and str(it.get("category_code") or "").strip() == "SC-SELF":
                it["enabled"] = False
                break
    _run_case(
        title="self-disabled",
        party_id="92330100MA2BCD1234",
        party_name="某某商行",
        matching_doc=matching_doc,
        category_doc=disabled_doc,
    )

    # Case 3: 91 类别不受 SC-SELF 停用影响
    _run_case(
        title="ent-still-enabled",
        party_id="91330100MA2BCD1234",
        party_name="某某有限公司",
        matching_doc=matching_doc,
        category_doc=disabled_doc,
    )


if __name__ == "__main__":
    main()
