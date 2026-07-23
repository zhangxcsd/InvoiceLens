export type NavKey =
  // 导入向导（3级）
  | 'import_wizard_upload'
  | 'import_wizard_preview'
  | 'import_wizard_format_check'
  // 导入：历史/质量/映射
  | 'ods_to_dwd_center'
  | 'dwd_to_dim_center'
  | 'dwd_data_preview'
  /** 加工中心：DWD 落盘后的派生维/台账重算与运行记录（如 dim_enterprise_year_rel） */
  | 'processing_derived_dim_tasks'
  | 'import_history'
  | 'import_quality_overview'
  | 'import_quality_detail'
  | 'import_quality_trend'
  | 'import_mapping_config'
  | 'import_mapping_templates'
  | 'import_invoice_export'
  // 维度管理（3级）
  | 'dim_org_hier_tree'
  /** @deprecated 兼容旧链接，侧栏已合并为 dim_org_hier_tree */
  | 'dim_org_manage'
  | 'dim_org_sys'
  | 'dim_audited_registry'
  | 'dim_enterprise_year_roster'
  | 'dim_audited_contribution'
  | 'dim_audited_invoice_link'
  | 'dim_enterprise_library'
  | 'dim_audit_related_library'
  | 'dim_level1_enterprise_year'
  /** @deprecated 兼容旧链接，侧栏已合并为 dim_org_hier_tree */
  | 'dim_org_equity'
  /** @deprecated 兼容旧链接，侧栏已合并为 dim_org_hier_tree（tree_mode=relation） */
  | 'dim_org_diff'
  | 'dim_tax_lib'
  | 'dim_tax_risk_define'
  | 'dim_tax_result'
  | 'dim_tax_quality'
  | 'dim_subject_category'
  | 'dim_dict'
  | 'dim_version'
  // 分析看板
  | 'tax_enterprise_structure'
  | 'tax_in_out_deviation'
  | 'tax_risk_exposure'
  | 'overview_summary'
  | 'overview_trend'
  | 'overview_tax'
  | 'health_score'
  | 'supplier_cr'
  | 'supplier_top'
  | 'supplier_new'
  | 'flags_list'
  | 'flags_rules'
  | 'flags_track'
  | 'related_graph'
  | 'trade_relationships'
  | 'related_pairs'
  | 'related_shell'
  | 'finance_reconcile'
  | 'finance_diff'
  | 'compare_rank'
  | 'compare_charts'
  | 'entity_profile'
  | 'goods_category'
  | 'red_offset_analysis'
  | 'invoice_timing'
  | 'counterparty_risk'
  | 'year_over_year_compare'
  // 输出
  | 'report_config'
  | 'report_templates'
  | 'report_archive'
  // 系统
  | 'users_list'
  | 'users_roles'
  | 'users_audit'
  | 'settings_thresholds'
  | 'settings_license'
  | 'settings_instance'
  | 'placeholder'

export type User = {
  username: string
  displayName: string
  /** 角色键：admin | analyst | viewer（与后端 ROLES 对齐） */
  role: string
  roleLabel?: string
}

