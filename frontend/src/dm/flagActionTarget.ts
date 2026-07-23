import type { AuditFlagRow } from '../config/localApi'
import type { NavKey } from '../types'
import type { FlagActionLabels } from './flagActionHelpers'
import {
  dwsNavParamsFromFlag,
  financeDiffParamsFromFlag,
  relatedGraphNavParamsFromFlag,
  relatedPairsNavParamsFromFlag,
  reportChaptersForRule,
  semanticQualityNavParamsFromFlag,
  taxCodeNavParamsFromFlag,
  taxDevNavParamsFromFlag,
  taxEnterpriseNavParamsFromFlag,
  taxNavForRule,
  taxRiskNavParamsFromFlag,
  tradeRelationshipsNavParamsFromFlag,
  invoiceExportParamsFromFlag,
} from './flagActionHelpers'

export type AnalysisShellTier = 'wide' | 'full' | 'newTab'

export type FlagActionTarget = {
  nav: NavKey
  params: Record<string, string>
  tier: AnalysisShellTier
  title: string
}

const WIDE_ACTIONS = new Set([
  'entity_profile',
  'flags_track',
  'tax_code',
  'tax_enterprise_structure',
  'semantic_quality',
  'quality_trend',
  'health_score',
  'supplier_top',
  'supplier_cr',
  'overview_trend',
  'overview_summary',
  'invoice_timing',
  'red_offset_analysis',
  'related_pairs',
  'related_shell',
  'tax_in_out_deviation',
  'tax_risk_exposure',
])

const FULL_ACTIONS = new Set(['finance_diff', 'trade_relationships'])

const NEW_TAB_ACTIONS = new Set(['related_graph', 'invoice_export', 'report_config'])

const NEW_TAB_NAVS = new Set<NavKey>(['related_graph', 'import_invoice_export', 'report_config'])

const FULL_NAVS = new Set<NavKey>(['finance_diff', 'trade_relationships'])

/** AnalysisPageHost 可嵌入的 nav 白名单。 */
export const ANALYSIS_SHELL_NAVS = new Set<NavKey>([
  'flag_detail',
  'entity_profile',
  'flags_track',
  'health_score',
  'tax_risk_exposure',
  'related_pairs',
  'related_shell',
  'trade_relationships',
  'finance_diff',
  'dim_tax_quality',
  'tax_enterprise_structure',
  'import_quality_overview',
  'import_quality_detail',
  'import_quality_trend',
  'overview_trend',
  'overview_summary',
  'supplier_top',
  'supplier_cr',
  'red_offset_analysis',
  'invoice_timing',
  'tax_in_out_deviation',
  'counterparty_risk',
  'goods_category',
  'year_over_year_compare',
  'overview_tax',
  'supplier_new',
  'compare_charts',
  'compare_rank',
])

export function isSupportedInAnalysisShell(nav: NavKey): boolean {
  return ANALYSIS_SHELL_NAVS.has(nav)
}

export function tierForNav(nav: NavKey): AnalysisShellTier {
  if (NEW_TAB_NAVS.has(nav)) return 'newTab'
  if (FULL_NAVS.has(nav)) return 'full'
  return 'wide'
}

export function tierForAction(actionId: string): AnalysisShellTier {
  if (NEW_TAB_ACTIONS.has(actionId)) return 'newTab'
  if (FULL_ACTIONS.has(actionId)) return 'full'
  if (WIDE_ACTIONS.has(actionId)) return 'wide'
  return 'wide'
}

function compactParams(raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v != null && v !== '') out[k] = v
  }
  return out
}

function titleForAction(actionId: string, labels: FlagActionLabels, nav: NavKey): string {
  const map: Record<string, string> = {
    finance_diff: labels.viewFinanceDiffBtn,
    tax_code: labels.viewTaxCodeBtn,
    tax_enterprise_structure: labels.viewTaxCodeBtn,
    semantic_quality: labels.viewSemanticDetailBtn,
    quality_trend: labels.viewQualityTrendBtn,
    health_score: labels.viewQualityBtn,
    invoice_export: labels.viewInvoiceBtn,
    supplier_top: labels.viewSupplierTopBtn,
    supplier_cr: labels.viewSupplierCrBtn,
    overview_trend: labels.viewOverviewTrendBtn,
    invoice_timing: labels.viewInvoiceTimingBtn,
    red_offset_analysis: labels.viewRedOffsetBtn,
    related_pairs: labels.viewRelatedPairsBtn,
    related_shell: labels.viewRelatedShellBtn,
    related_graph: labels.viewRelatedGraphBtn,
    trade_relationships: labels.viewTradeRelationshipsBtn,
    tax_in_out_deviation: labels.viewTaxInOutDevBtn,
    tax_risk_exposure: labels.viewTaxRiskExposureBtn,
    flags_track: labels.viewTrackBtn,
    entity_profile: '主体画像',
    report_config: labels.genReportBtn,
  }
  return map[actionId] ?? nav
}

/** 将疑点操作解析为导航目标（nav + 参数 + 容器档位）。 */
export function resolveFlagActionTarget(
  actionId: string,
  row: AuditFlagRow,
  statYear: string,
  labels: FlagActionLabels,
): FlagActionTarget | null {
  const entityId = row.entity_id ?? undefined
  const ruleId = row.rule_id
  const tier = tierForAction(actionId)

  switch (actionId) {
    case 'entity_profile':
      if (!entityId) return null
      return {
        nav: 'entity_profile',
        params: compactParams({ stat_year: statYear, entity_id: entityId }),
        tier,
        title: titleForAction(actionId, labels, 'entity_profile'),
      }
    case 'finance_diff': {
      const p = financeDiffParamsFromFlag(row, statYear)
      return {
        nav: 'finance_diff',
        params: compactParams({
          batch_id: p.batchId,
          stat_year: p.statYear,
          entity_id: p.entityId,
          diff_type: p.diffType,
        }),
        tier,
        title: titleForAction(actionId, labels, 'finance_diff'),
      }
    }
    case 'tax_code':
      return {
        nav: taxNavForRule(ruleId),
        params: compactParams(taxCodeNavParamsFromFlag(row, statYear)),
        tier,
        title: titleForAction(actionId, labels, taxNavForRule(ruleId)),
      }
    case 'tax_enterprise_structure':
      return {
        nav: 'tax_enterprise_structure',
        params: compactParams(taxEnterpriseNavParamsFromFlag(row, statYear)),
        tier,
        title: titleForAction(actionId, labels, 'tax_enterprise_structure'),
      }
    case 'semantic_quality': {
      const p = semanticQualityNavParamsFromFlag(row)
      return {
        nav: 'import_quality_detail',
        params: compactParams({
          batch_id: p.batchId,
          domain: p.domain,
          stat_year: p.statYear,
        }),
        tier,
        title: titleForAction(actionId, labels, 'import_quality_detail'),
      }
    }
    case 'quality_trend': {
      const p = semanticQualityNavParamsFromFlag(row)
      return {
        nav: 'import_quality_trend',
        params: compactParams({ batch_id: p.batchId }),
        tier,
        title: titleForAction(actionId, labels, 'import_quality_trend'),
      }
    }
    case 'health_score':
      return {
        nav: 'health_score',
        params: compactParams({ stat_year: statYear, entity_id: entityId }),
        tier,
        title: titleForAction(actionId, labels, 'health_score'),
      }
    case 'invoice_export': {
      const p = invoiceExportParamsFromFlag(row, statYear)
      return {
        nav: 'import_invoice_export',
        params: compactParams({
          stat_year: p.statYear,
          entity_id: p.entityId,
          date_from: p.dateFrom,
          date_to: p.dateTo,
          fpzt: p.fpzt,
          seller_tax_no: p.sellerTaxNo,
        }),
        tier,
        title: titleForAction(actionId, labels, 'import_invoice_export'),
      }
    }
    case 'supplier_top':
    case 'supplier_cr':
    case 'overview_trend':
      return {
        nav: actionId as NavKey,
        params: compactParams(dwsNavParamsFromFlag(row, statYear)),
        tier,
        title: titleForAction(actionId, labels, actionId as NavKey),
      }
    case 'invoice_timing':
      return {
        nav: 'invoice_timing',
        params: compactParams({ stat_year: statYear, entity_id: entityId }),
        tier,
        title: titleForAction(actionId, labels, 'invoice_timing'),
      }
    case 'red_offset_analysis':
      return {
        nav: 'red_offset_analysis',
        params: compactParams({ stat_year: statYear, entity_id: entityId }),
        tier,
        title: titleForAction(actionId, labels, 'red_offset_analysis'),
      }
    case 'related_pairs': {
      const p = relatedPairsNavParamsFromFlag(row, statYear)
      return {
        nav: 'related_pairs',
        params: compactParams({
          stat_year: p.stat_year,
          party_a_tax: p.party_a_tax,
          party_b_tax: p.party_b_tax,
          keyword: p.keyword,
        }),
        tier,
        title: titleForAction(actionId, labels, 'related_pairs'),
      }
    }
    case 'related_shell':
      return {
        nav: 'related_shell',
        params: compactParams({ stat_year: statYear, entity_id: entityId }),
        tier,
        title: titleForAction(actionId, labels, 'related_shell'),
      }
    case 'related_graph':
      return {
        nav: 'related_graph',
        params: compactParams(relatedGraphNavParamsFromFlag(row, statYear)),
        tier,
        title: titleForAction(actionId, labels, 'related_graph'),
      }
    case 'trade_relationships': {
      const p = tradeRelationshipsNavParamsFromFlag(row, statYear)
      return {
        nav: 'trade_relationships',
        params: compactParams({
          stat_year: p.stat_year,
          entity_id: p.entity_id,
          buyer_tax_no: p.buyer_tax_no,
          seller_tax_no: p.seller_tax_no,
          counterparty_id: p.counterparty_id,
          keyword: p.keyword,
        }),
        tier,
        title: titleForAction(actionId, labels, 'trade_relationships'),
      }
    }
    case 'tax_in_out_deviation':
      return {
        nav: 'tax_in_out_deviation',
        params: compactParams(taxDevNavParamsFromFlag(row, statYear)),
        tier,
        title: titleForAction(actionId, labels, 'tax_in_out_deviation'),
      }
    case 'tax_risk_exposure': {
      const p = taxRiskNavParamsFromFlag(row, statYear)
      return {
        nav: 'tax_risk_exposure',
        params: compactParams({ stat_year: p.stat_year, entity_id: p.entity_id }),
        tier,
        title: titleForAction(actionId, labels, 'tax_risk_exposure'),
      }
    }
    case 'flags_track':
      return {
        nav: 'flags_track',
        params: compactParams({
          stat_year: statYear,
          rule_id: ruleId,
          entity_id: entityId,
          track_tab: 'pending',
          track_status: 'pending',
        }),
        tier,
        title: titleForAction(actionId, labels, 'flags_track'),
      }
    case 'report_config':
      return {
        nav: 'report_config',
        params: compactParams({
          stat_year: statYear,
          entity_id: entityId,
          chapters: reportChaptersForRule(ruleId).join(','),
        }),
        tier,
        title: titleForAction(actionId, labels, 'report_config'),
      }
    default:
      if (entityId) {
        const p = invoiceExportParamsFromFlag(row, statYear)
        return {
          nav: 'import_invoice_export',
          params: compactParams({
            stat_year: p.statYear,
            entity_id: p.entityId,
            date_from: p.dateFrom,
            date_to: p.dateTo,
            fpzt: p.fpzt,
            seller_tax_no: p.sellerTaxNo,
          }),
          tier: 'newTab',
          title: titleForAction('invoice_export', labels, 'import_invoice_export'),
        }
      }
      return null
  }
}

const NAV_TITLE_MAP: Partial<Record<NavKey, string>> = {
  flag_detail: '疑点详情',
  entity_profile: '主体画像',
  flags_track: '疑点跟踪',
  health_score: '主体健康度评价',
  tax_risk_exposure: '税务风险敞口',
  related_pairs: '对开发票',
  related_shell: '被审主体关联',
  trade_relationships: '贸易关系',
  finance_diff: '财务差异',
  dim_tax_quality: '税码分析',
  tax_enterprise_structure: '企业税码结构',
  import_quality_overview: '数据质量概览',
  import_quality_detail: '语义质量明细',
  import_quality_trend: '质量趋势',
  overview_trend: '月度趋势',
  overview_summary: '整体汇总',
  overview_tax: '税率结构',
  supplier_top: 'Top 明细',
  supplier_cr: '集中度（CR）',
  supplier_new: '新增/消失',
  compare_charts: '对比图表',
  compare_rank: '对比排名',
  red_offset_analysis: '红冲分析',
  invoice_timing: '开票时间',
  tax_in_out_deviation: '进项销项偏离',
  counterparty_risk: '对手风险聚合',
  goods_category: '品类结构分析',
  year_over_year_compare: '跨年结构对比',
  related_graph: '关联图谱',
  import_invoice_export: '发票导出',
  report_config: '报告生成',
  flags_list: '疑点清单',
}

export function titleForNav(nav: NavKey, hint?: string): string {
  if (hint?.trim()) return hint.trim()
  return NAV_TITLE_MAP[nav] ?? nav
}

/** 容器内二次跳转：由 nav + params 解析目标（不依赖 actionId）。 */
export function resolveNavTarget(
  nav: NavKey,
  params: Record<string, string>,
  titleHint?: string,
): FlagActionTarget | null {
  if (!isSupportedInAnalysisShell(nav)) return null
  return {
    nav,
    params: compactParams(params),
    tier: tierForNav(nav),
    title: titleForNav(nav, titleHint),
  }
}
