import { expect, test } from '@playwright/test'

/** 侧栏全部 NavKey（排除占位页）；优先 ?nav= 直达，避免菜单展开不稳定。 */
const NAV_KEYS = [
  'import_wizard_upload',
  'import_wizard_preview',
  'import_wizard_format_check',
  'ods_to_dwd_center',
  'dwd_to_dim_center',
  'dwd_data_preview',
  'processing_derived_dim_tasks',
  'import_history',
  'import_quality_overview',
  'import_quality_detail',
  'import_quality_trend',
  'import_mapping_config',
  'import_mapping_templates',
  'import_invoice_export',
  'dim_org_manage',
  'dim_audited_registry',
  'dim_enterprise_year_roster',
  'dim_audited_contribution',
  'dim_audited_invoice_link',
  'dim_enterprise_library',
  'dim_audit_related_library',
  'dim_level1_enterprise_year',
  'dim_org_equity',
  'dim_org_diff',
  'dim_tax_lib',
  'dim_tax_risk_define',
  'dim_tax_result',
  'dim_tax_quality',
  'dim_subject_category',
  'dim_dict',
  'dim_version',
  'tax_enterprise_structure',
  'tax_in_out_deviation',
  'tax_risk_exposure',
  'overview_summary',
  'overview_trend',
  'overview_tax',
  'health_score',
  'supplier_cr',
  'supplier_top',
  'supplier_new',
  'flags_list',
  'flags_rules',
  'flags_track',
  'related_graph',
  'trade_relationships',
  'related_pairs',
  'related_shell',
  'finance_reconcile',
  'finance_diff',
  'compare_rank',
  'compare_charts',
  'report_config',
  'report_templates',
  'report_archive',
  'users_list',
  'users_roles',
  'users_audit',
  'settings_thresholds',
  'settings_license',
  'settings_instance',
] as const

/** 已接通真实 API 的页面不应再展示「界面原型」页顶标识 */
const LIVE_PAGES_NO_PROTOTYPE_BADGE = [
  'import_quality_overview',
  'import_quality_detail',
  'import_quality_trend',
  'import_mapping_config',
  'import_mapping_templates',
  'ods_to_dwd_center',
  'dim_audited_registry',
  'dim_audited_contribution',
  'import_history',
  'users_list',
  'overview_summary',
  'overview_trend',
  'overview_tax',
  'supplier_top',
  'supplier_cr',
  'supplier_new',
  'compare_rank',
  'compare_charts',
  'flags_list',
  'flags_track',
  'related_pairs',
  'related_graph',
  'report_config',
  'report_archive',
  'settings_instance',
  'settings_license',
] as const

test.describe('nav walkthrough', () => {
  test('all sidebar routes load without crash', async ({ page }) => {
    for (const nav of NAV_KEYS) {
      await page.goto(`/?nav=${nav}`)
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('body')).not.toContainText('Application error', { timeout: 15_000 })
    }
  })

  test('live pages do not show prototype badge copy', async ({ page }) => {
    for (const nav of LIVE_PAGES_NO_PROTOTYPE_BADGE) {
      await page.goto(`/?nav=${nav}`)
      await page.waitForLoadState('domcontentloaded')
      const badges = page.locator('span').filter({ hasText: '界面原型' })
      await expect(badges).toHaveCount(0, { timeout: 10_000 })
    }
  })
})
