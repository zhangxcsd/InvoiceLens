# 主体库分域规则（组织机构主体 / 自然人主体）

## 1. 目标与结论（收敛版）

- 目标：统一“主体库”口径，避免命名歧义，并保留跨来源可追溯能力。
- 结论（双轨并存）：
  - **存量年度模型（保留）**：
    - `dim_enterprise_subject`
    - `dim_person_subject`
    - `vw_dim_subject_union`
  - **增量统一模型（推荐）**：
    - `dim_subject_master`
    - `dim_subject_source_record`
- 术语收敛：
  - 页面/产品口径统一称“主体库”
  - 分类统一称“组织机构主体（org）/自然人主体（person）”
  - “个人主体”在存量表名中保留，但文档与页面新文案优先用“自然人主体”

## 2. 适用范围

- 上游来源：`dwd_inv_header`（主来源）+ 外部导入（可选）。
- 年度口径：
  - 存量模型按 `stat_year` 形成快照年度；
  - 增量统一模型当前阶段不强制按年度存储。
- 抽取字段命名优先复用 DWD 既有字段语义：
  - 销方：`xfsbh` / `xfmc`
  - 购方：`gfsbh` / `gfmc`
- 两张主体维表中也保留同名字段（`xfsbh/xfmc/gfsbh/gfmc`）用于口径对照与追溯，避免后续字段映射反复。

## 3. 主体类型判定规则

### 3.1 组织机构主体（org）

- 从 `dwd_inv_header` 的 `xfsbh/gfsbh` 抽取主体识别号。
- 判定条件（建议）：
  - `taxpayer_id` 非空；
  - 且满足企业纳税人识别号规则（长度与字符集符合企业税号口径）。
- 入表：
  - 存量：`dim_enterprise_subject`
  - 增量：`dim_subject_master.subject_category='org'`

### 3.2 自然人主体（person）

- 从 `dwd_inv_header` 的 `xfsbh/gfsbh` 抽取主体识别号。
- 判定条件（建议）：
  - 主体识别号满足个人身份证号规则（15/18 位口径，含校验位规则）。
- 入表：
  - 存量：`dim_person_subject`
  - 增量：`dim_subject_master.subject_category='person'`

### 3.3 无法判定（unknown）

- 识别号缺失或不满足企业/个人规则时，不进入上述两表；
- 可落异常清单（建议单独表或日志），供后续规则迭代。

## 4. 快照与去重规则

- 快照键：`(stat_year, 主体识别号)`。
- 同一年度内若同主体出现多个名称：
  - 标准名写入 `*_name_std`；
  - 原始名写入 `*_name_raw` 或名称时间线（建议后续扩展）。
- 存量年度模型首末批次字段：
  - `first_seen_batch_id / last_seen_batch_id`
- 增量统一模型血缘字段（与 DWD 命名对齐）：
  - `first_import_batch_id / first_import_session_id`
  - `last_import_batch_id / last_import_session_id`
  - 明细来源在 `dim_subject_source_record` 使用：
    - `import_batch_id / import_session_id / source_excel_file / source_parquet_file / source_sheet / ods_file_seq / ingest_ts`

## 5. 消费层默认口径（避免重复争议）

- 企业主题页面（主体库中的组织机构视角）默认仅使用组织机构主体口径。
- 自然人主体默认不纳入企业 KPI；如需分析“企业对私交易”，通过：
  - `vw_dim_subject_union`，或
  - 事实表 + `dim_person_subject` 专题查询。

## 6. 口径说明模板（建议放前端页内）

- “本页为主体库口径：组织机构主体与自然人主体按不同规则分域管理。组织机构分析默认仅纳入组织机构主体；自然人主体用于对私交易专题，不计入组织机构指标。”

## 7. 变更治理

- 规则变更（org/person 识别规则）需版本化记录：`rule_version`。
- 每次重算需记录：批次、时间、规则版本、影响记录数。
- 禁止在 DWD 主表物理删除自然人主体数据；仅在消费层按口径过滤。
