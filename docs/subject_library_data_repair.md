# 主体库 · 人工数据修复（规则说明）

本文描述 **「主体库」** 页面提供的 **人工数据修复** 能力与治理约定，与 ODS/DWD 归集、外部文件导入等自动链路区分。

## 1. 目标

- 在 **DuckDB `dim_subject_master`** 上，对已有主体记录做 **显式、可追溯** 的纠偏。
- 第一版支持字段：
  - **`subject_category`**：`org`（界面「组织机构主体」）/ `person`（界面「自然人主体」）。
  - **`org_category`**：组织机构类别编码（如 `SC-ENT`）；允许 **清空**（请求体传空字符串，库中置为 NULL）。

## 2. 权限与撤销

- **本地开发/本机使用场景**：**不区分用户角色**，凡能打开主体库并调用本地 API 的使用者 **均可提交修复**（不在应用内做登录鉴权）。
- **不提供撤销（Undo）**：保存后立即生效；若错误，请 **再次发起修复** 改回正确值。
- **可多次修改**：同一 `subject_id` 可反复调用修复接口；**以主表当前值为准**。

## 3. 审计（非撤销用途）

- 每次实际变更字段，在 **`dim_subject_master_repair_log`** 中 **追加** 一条记录（每个被改字段一条）。
- 记录内容包含：`subject_id`、`field_name`、`old_value`、`new_value`、`reason`（可选）、`repaired_at`、`client_hint`（调用端标识，默认 `web-enterprise-library`）。
- **审计用途**：事后对账、排障、沟通依据；**不用于**自动回滚或一键还原。

## 4. 接口约定（实现见代码）

- **HTTP**：`POST /api/subject-library/repair`
- **Content-Type**：`application/json; charset=utf-8`
- **请求体**（字段名存在即参与逻辑）：
  - **`subject_id`**（必填）：`dim_subject_master.subject_id`。
  - **`subject_category`**（可选）：`org` 或 `person`；键存在且合法时参与比较与更新。
  - **`org_category`**（可选）：字符串；键 **存在** 且值为 **空串** 表示 **清空** 库中 `org_category`。
  - **`reason`**（可选）：说明文字。
  - **`client_hint`**（可选）：调用来源标识。
- **须至少修改其一**：`subject_category` 与 `org_category` 二者 **至少有一个键出现在 JSON 中**；若均省略则返回参数错误。
- **无变更**：新值与库中一致时返回 `ok: true`，`changed` 为空数组。

## 5. 与自动链路的边界

- **DWD 归集 / 外部导入**：按规则 **写入或覆盖** 主表，不写本修复审计表（或写 `dim_subject_source_record` 等业务来源表）。
- **本修复**：仅通过 **`/api/subject-library/repair`** 写入 **`dim_subject_master_repair_log`** + 更新主表，便于区分「业务流入」与「人工纠偏」。

## 6. 前端入口

- **主体库**表格中提供 **「数据修正」** 操作，打开表单后提交上述接口。
- 表单须提示：**不可撤销，可再次修改**。

---

*文档版本与实现：`EnterpriseLibraryPage` + `src/local_api/subject_library_repair.py` + `config/ddl/dim.sql`（`dim_subject_master_repair_log`）。*
