# ODS 告警码建议（模板）

## 错误级（阻断）

- `ODS-E001` 文件不可读取（损坏/权限/格式不支持）
- `ODS-E002` 关键键不足（`invoice_code/invoice_no/amount` 三选二不满足）
- `ODS-E003` 必需配置缺失（`field_mapping/sheet_mapping/settings`）

## 告警级（不中断）

- `ODS-W001` 元数据解析不完整（如 period/company_name 缺失）
- `ODS-W002` 非关键字段缺失
- `ODS-W003` 专项行级无法对齐，已降级到 `inv_special_header`
- `ODS-W004` 多来源字段冲突，按首见优先保留
- `ODS-W005` 检测到 schema 漂移（新增列/缺失列）

## 约束

- 所有告警/错误必须带 `batch_id + source_file + source_sheet` 维度。
- UI、日志、验收报表使用同一套告警码，禁止各模块自定义重复编码。
