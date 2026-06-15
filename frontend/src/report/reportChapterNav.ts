import type { NavKey } from '../types'

/** 报告章节 id → 对应在线分析页（深链目标）。 */
export const REPORT_CHAPTER_NAV: Partial<Record<string, NavKey>> = {
  overview: 'overview_summary',
  structure: 'overview_tax',
  supplier: 'supplier_top',
  audit_flags: 'flags_list',
  flags_track: 'flags_track',
  related: 'related_pairs',
  compare: 'compare_rank',
  supplier_new: 'supplier_new',
  trade_relationships: 'trade_relationships',
  tax_in_out_deviation: 'tax_in_out_deviation',
  finance_reconcile: 'finance_reconcile',
  data_quality_summary: 'import_quality_overview',
  tax_code_analysis: 'tax_enterprise_structure',
  tax_risk_exposure: 'tax_risk_exposure',
}

export function reportChapterNavKey(chapterId: string): NavKey | undefined {
  return REPORT_CHAPTER_NAV[chapterId]
}
