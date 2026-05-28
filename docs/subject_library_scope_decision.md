# 主体库范围与数据职责决策说明

本文记录产品与技术对「主体库」域的**已达成共识**，作为后续改表、改写入路径与改前端的依据；与 `docs/subject_dimension_split_rules.md`、`docs/subject_naming_convergence.md` 互补。

---

## 1. 产品定位

- **主体库**表示 **全量组织机构主体 + 自然人主体** 的主数据集合，**与是否「目标企业」无关**。
- 当前阶段页面能力以 **企业基本信息 + 多来源血缘** 为主；**不按统计年度拆行展示**。
- **未来**：可针对目标企业归集全量交易信息，统计 **年度采购/销售量** 等；该能力归属 **发票事实层 / 专题分析**，**不挤占主体库主数据语义**。

---

## 2. 主表（`dim_subject_master`）职责

- 承载 **稳定身份与治理字段**：标识、名称、主体类型（org/person）、机构类别编码、来源系统、导入批次/会话、质量与类别治理备注等。
- **不承载**以下「相对事实」作为主表固有业务含义：
  - **购方 / 销方**（依赖发票方向，相对概念）
  - **统计年度**（依赖分析切片；主表上不将「快照年度」类展示与 `stat_year` 混同）

> 说明：表中若仍存在 `subject_snapshot_id` 等技术字段，仅表示 **某次构建/对齐标识**，不作为「主体库 = 按年清单」的产品定义。

---

## 3. 来源表（`dim_subject_source_record`）与血缘

- **保留**：与归集、溯源强相关的字段（如批次、会话、原始名称/税号、文件与 sheet 等），支撑 **数据来源与冲突追溯**（参见 `docs/subject_field_priority_policy.md`）。
- **已定稿（拍板 1-B）**：**停止写入** `match_rule=dwd_invoice_seller/buyer` 等购销语义来源行；来源表仅保留 **非角色** 血缘。购销与角色在 **事实表（如 `dwd_inv_header`）或专题汇总** 中计算；实现与回归见 §6、`docs/subject_library_rename_detection_spec.md` §11。

---

## 4. 「年度内更名」业务定义（与类别治理分离）

- **不再**将「更名」与 `dim_subject_master.category_status_note`（类别推断/治理）混为一谈。
- **业务规则（共识）**：
  - 以 **统一社会信用代码 / 主体识别号**（与主数据对齐字段，如 `subject_no`）为键；
  - **同一键下** 在发票时间序上出现 **多个不同名称** → 视为发生 **更名**；
  - 按 **发票日期（及必要时的发票序号）** 排序，得到 **自旧名至新名** 的轨迹。
- **已定稿补充（拍板 4-C）**：首版更名检测 **仅全历史链**，**不做**「统计年度内」切片；二期再增加年内口径与 UI 筛选。
- **实现注意**：名称 **弱规范化（5-A）**；异常（多码一名等）进清单而非强行合并。
- **细则与拍板摘要**：见 **`docs/subject_library_rename_detection_spec.md`**（§11 已定稿）。

---

## 5. 前端「主体库」页面方向（与 §1–2 对齐）

- **弱化或移除**：以主表解析的「年度」筛选/列、以及 **购销角色** 筛选/列（避免在主数据页展示相对事实）。
- **保留并强化**：数据来源（platform/external）、批次/会话等 **血缘** 展示与检索。
- **更名提示**：待 §4 规则有独立计算结果后，再绑定 UI 文案与列名（避免继续沿用易误导的「年度内更名」与 `needs_review` 的简单等同）。

---

## 6. 后续工程清单（拍板 8-C：首版一并交付）

| 项 | 说明 |
|----|------|
| 写入路径 | **已拍板**：DWD 归集 **停止** `dim_subject_source_record` 购销语义行（§3）。 |
| 列表 API / 前端 | 去掉对购销来源行的聚合依赖；角色相关展示改事实层或下线；技术字段 **7-B** 高级折叠；文案与「全历史更名」一致。 |
| 更名检测 | **新物理表（6-A）** + 任务（`build_run_id`）；**org+person（3-C）**、**弱规范化（5-A）**、**全历史（4-C）**。 |
| 文档 | 更新 `subject_dimension_split_rules.md` 等交叉引用；KPI 若仍用 `needs_review` 须标明为 **类别治理** 非更名。 |

---

*文档状态：范围已共识；§3、§4、§6 已与 2026-05-06 拍板对齐。*

## 7. 实现进展（代码）

- **DWD→主体主表归集**：当全量 `dwd_inv_header` 事实下，同一 **规范化名称**（`subject_name_std`）同时存在 **仅名称键**（无税号）与 **唯一税号键** 主体时，自动将前者并入后者（保留税号侧 `subject_id`），合并批次/会话区间与治理字段，并重挂 `dim_subject_rename_signal` 等子表外键后删除名称键主表行；若同一名称对应 **多个** 税号键则 **不自动合并**（避免误并）。接口返回 `subjects_merged_name_key_into_tax` 计数。
- 主体库列表 API / 汇总：已去掉年度与购销角色筛选；增加 `rename_signal` 筛选、`rename_signal_subject_count`、行内 `has_rename_signal` / `rename_edge_count` 及治理/技术字段供高级列展示。
- `POST /api/subject-library/rebuild-rename-signals`：默认 `{ "async": true }` 后台全量聚合，响应 **HTTP 200** + `ok`/`run_id`；异步启动时即写入 `ads_etl_task_run_log` 为 **running**（`finished_at` 为空），完成后覆盖为 **success/failed**；`{ "async": false }` 为同步模式（网关超时自担）。`GET /api/subject-library/rename-rebuild-status?run_id=` 轮询 **HTTP 200** + `ok`；内存无任务时从台账恢复 **running / success / failed**（`restored_from_task_log`）。`GET /api/subject-library/rename-timeline`：`api_subject_library_rename_timeline`。
- 前端「主体库」页：已按 §5 调整筛选、KPI、表格与「重建更名信号」按钮；可选勾选展示技术列（拍板 7-B）。
