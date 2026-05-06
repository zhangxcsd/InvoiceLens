# 主体类别机器匹配（设计说明）

目标：在**不依赖自然语言「匹配规则说明」解析**的前提下，用**可配置、可单测**的规则，从「纳税人识别号 / 统一社会信用代码 + 名称」推断 `category_code`（与 `config/subject_category.yaml` 中类别对齐），供销方、购方等调用方复用。

## 1. 配置拆分

| 文件 | 职责 |
|------|------|
| `config/subject_category.yaml` | 人读：类别名称、登记部门、法律形态、**匹配规则说明**（`invoice_scene`）、默认风险关注等 |
| `config/subject_category_matching.yaml` | 机读：**匹配条件、优先级、命中原因码**（本设计） |

二者通过 `category_code` 关联。后续若希望「单文件维护」，可把 `match` 块合并进 `subject_category.yaml` 的每条 `categories[]` 下，由加载器在内存中合并为同一结构（本仓库先采用双文件，避免改动现有保存接口过大）。

## 2. `subject_category_matching.yaml` 顶层结构

可选顶层字段 **`matching_remarks`**：多行字符串，说明弱区分与边界（**推断引擎不解析**，仅供人读）。

```yaml
version: 1
# match_order 自上而下：先命中先返回（同优先级时按文件顺序）
match_order:
  - category_code: SC-XXX
    priority: 10          # 可选；数值越小越先评估（建议）
    enabled: true         # 可选；默认 true
    all: [ ... ]          # 条件全部满足则命中
    any: [ ... ]          # 可选；与 all 组合语义为 (all) AND (any 之一)，不写 any 则忽略
```

## 3. 条件原子（`kind`）

所有条件对**规范化后**的识别号、名称求值（见第 4 节）。

| kind | 含义 | 典型参数 |
|------|------|----------|
| `id_len` | 识别号长度 | `op`: `eq` \| `neq` \| `gte` \| `lte`；`value`: 整数 |
| `id_card_like` | 是否居民身份证号形态（18 位：17 位数字 + 末位数字或 X） | `value`: `true` / `false`（默认 `true` 表示「像身份证」） |
| `id_prefix` | 识别号前缀（大小写不敏感） | `prefixes`: 字符串列表，命中任一 |
| `id_charset` | 识别号字符集 | `allowed`: `alnum`（仅字母数字）等 |
| `name_regex` | 名称正则（**行锚**建议） | `pattern`: 字符串；`flags`: 可选 `IGNORECASE` |
| `name_len` | 名称 Unicode 长度 | 同 `id_len` |
| `name_not_regex` | 名称不匹配某正则 | 同上 |

扩展：后续可增加 `id_gb32100_check_char`（校验位）、`id_second_segment`（组织机构类别细分）等，无需改调用方签名。

## 4. 规范化（公共前置）

对入参 `taxpayer_id`（销方/购方识别号均可）：

1. `strip()`，转大写（字母部分）。
2. 去除常见分隔符空格、`-`。
3. **长度**：18 位统一社会信用代码与 15 位旧税号需分支；当前 v1 规则以 **18 位** 为主（15 位可走 `needs_review` 或单独规则集）。

对 `name`：`strip()`，压缩连续空白。

**顺序与安全边界（与配置一致）**

1. **先评估 `SC-TEMP`（短名称 + 非统一码/身份证场景）**  
   - 名称长度 **1～4**；且满足 **`id_len != 18` 或 `id_card_like`（18 位纯身份证形态）` 之一**。  
   - 含义：短自然人名 + 身份证号、短名 + 非 18 位号等，**不要**进入后续 `91/92/…` 前缀推断。  
   - **例外**：名称仍 ≤4 字，但识别号为 **18 位且不像身份证**（即更像统一社会信用代码）时，**不命中** `SC-TEMP`，继续走后续码段规则（避免「四字店名 + 92 统一码」被误判为临时主体）。
2. **基于 18 位统一码前缀的规则（含 `SC-SELF` / `92`）一律要求「名称长度 ≥4」**：在必须用编号匹配时，增加最低限度的名称形态门槛，降低证件号误配；若个别主体名称少于 4 字且确有统一码，可走人工复核或后续单独规则。
3. **`SC-SELF`（前缀 `92`）**：与第 2 条一致，要求**名称长度 ≥4** 才机读命中；名称 1～3 字且 18 位非身份证形态时可能既不命中 `SC-TEMP`（`any` 不成立）也不命中 `SC-SELF`，见配置内 `matching_remarks`。

**18 位全数字与证件号**：与统一码形态可能重叠；当前对 `SC-TEMP` 使用 `id_card_like`（`^\d{17}[\dX]$`，大小写不敏感）做弱区分，避免短名 + 身份证号误入 `91/92/…` 前缀链。

空名称：不参与「短名称 TEMP」命中（要求 `name_len >= 1`）；也不会命中带 `name_len >= 4` 的码段规则，结果多为 `needs_review`。

## 5. 与当前七类 YAML 的对应关系（v1 口径）

与 `config/subject_category.yaml` 中 `invoice_scene` 描述对齐的**可执行化**要点：

| category_code | v1 核心逻辑（摘要） |
|-----------------|---------------------|
| SC-TEMP | **最先**：名称 1～4 字，且（非 18 位号 \| 18 位身份证形态） |
| SC-SELF | **名称 ≥4 字**，且 18 位且前缀 `92` |
| SC-COOP | 名称 ≥4 字，且 18 位且前缀 `93` |
| SC-SOCIAL | 名称 ≥4 字，且 18 位且首字符 `5` |
| SC-INSTITUTION | 名称 ≥4 字，且 18 位且首字符 `1` |
| SC-BRANCH | 名称 ≥4 字，且 18 位且前缀 `91`，且名称命中分支机构形态（见 YAML 正则） |
| SC-ENT | 名称 ≥4 字，且 18 位且前缀 `91`，且不命中 SC-BRANCH |

**优先级（数值越小越先评估）**：  
`SC-TEMP`（短名）→ `SC-INSTITUTION` / `SC-SOCIAL` / `SC-SELF` / `SC-COOP` → `SC-BRANCH`（91+分支形态）→ `SC-ENT`（91 默认法人）。

> 说明：`91` 同时对应法人企业与分支机构，**在名称已通过 ≥4 字门槛后**，仍须先评估 `SC-BRANCH` 再评估 `SC-ENT`。

## 6. 公共函数契约（Python）

建议导出：

- `normalize_party_id(raw: str) -> str`
- `normalize_party_name(raw: str) -> str`
- `load_matching_rules(path: Path | None = None) -> list[dict]`  
- `infer_org_subject_category(*, party_id: str, party_name: str, rules_doc: dict | None = None) -> InferResult`

`InferResult` 建议字段：

- `category_code: str | None`
- `category_name: str | None`（可由 `subject_category.yaml` 再解析，或匹配文件内不写）
- `matched: bool`
- `priority: int | None`（命中规则优先级）
- `reasons: list[str]`（如 `id_prefix:92`、`name_regex:branch_suffix`）
- `needs_review: bool`（多规则可命中、或 15 位税号、或名称缺失等）

调用方（发票清洗）对销方、购方**各调用一次**即可，不必单独维护两套函数。

## 7. 测试与回归

在 `tests/` 或 `scripts/` 下维护小型用例表（CSV/内嵌 list）：`(party_id, party_name) -> expected_code`，覆盖：

- 92/93/5/1 前缀；
- 91 + 分公司名称；
- 91 + 标准有限公司名称；
- 非 18 位 → TEMP 或 `needs_review`。

## 8. 后续演进

1. 将 `coverage_count` 等与匹配无关字段继续留在 `subject_category.yaml`。
2. 若规则稳定，可把 `match_order` 合并进每条 `categories[].match`。
3. 与 DuckDB 中 `dim_subject_master` 落库的 `subject_category` 字段对齐时，在 ETL 中只调用 `infer_org_subject_category`，保证**全链路单一实现**。
