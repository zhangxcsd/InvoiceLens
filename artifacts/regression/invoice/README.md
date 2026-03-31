# Excel->ODS 回归样例包说明

用于固定回归 `Excel -> ODS` 导入链路，建议至少维护 3 类样例：

1. `normal`：字段完整、无异常、可全量通过。
2. `abnormal`：关键字段缺失/格式异常，验证阻断与告警分级。
3. `special`：含旅客运输/货物运输等专项 sheet，验证词典匹配与降级策略。

## 使用约束

- 每次调整 `loader`、`field_mapping`、`sheet_mapping` 后，必须跑一次全套回归。
- 回归结果应输出到导入摘要卡（见 `artifacts/templates/ods_import_summary_template.json`）。
- 样例文件清单以 `case_manifest.json` 为准。
