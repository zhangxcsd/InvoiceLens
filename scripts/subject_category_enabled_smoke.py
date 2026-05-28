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
    subject_category_for_ingest,
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

    # Case 4: 20 位识别号 → SC-TEMP（与名称长度、是否全数字无关）
    _run_case(
        title="temp-20-digit",
        party_id="37142819821020402801",
        party_name="德州经济技术开发区鹏程办公用品商行",
        matching_doc=matching_doc,
        category_doc=category_doc,
    )
    _run_case(
        title="temp-20-mixed",
        party_id="AB12CD34EF56GH78IJ90",
        party_name="某某测试主体有限公司",
        matching_doc=matching_doc,
        category_doc=category_doc,
    )

    # Case 5: 91 段 USCC 与 18 位身份证形态重叠 → 入库分域应为 org
    luoyang_id = "914103000768204278"
    luoyang_name = "洛阳长运站务有限公司洛阳汽车站"
    ingest_cat = subject_category_for_ingest(luoyang_id)
    print(f"[ingest-uscc-91] subject_category={ingest_cat}")
    assert ingest_cat == "org", ingest_cat
    _run_case(
        title="luoyang-branch-uscc",
        party_id=luoyang_id,
        party_name=luoyang_name,
        matching_doc=matching_doc,
        category_doc=category_doc,
    )

    # Case 6: 典型 18 位身份证仍归 person
    id_card = "440301199001011234"
    ingest_person = subject_category_for_ingest(id_card)
    print(f"[ingest-id-card] subject_category={ingest_person}")
    assert ingest_person == "person", ingest_person


if __name__ == "__main__":
    main()
