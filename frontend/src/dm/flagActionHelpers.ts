import type { AuditFlagRow } from '../config/localApi'
import type { QualityDomainKey } from '../config/localApi'
import type { NavKey } from '../types'
import { navigateToFinancePage } from '../finance/financeNav'
import { navigateToQualityPage } from '../quality/qualityNav'
import {
  navigateToFlagsList,
  navigateToFlagsTrack,
  navigateToHealthScore,
  navigateToInvoiceExport,
  navigateToInvoiceTiming,
  navigateToQualityDetail,
  navigateToRedOffsetAnalysis,
  navigateToRelatedPairs,
  navigateToRelatedShell,
  navigateToTaxRiskExposure,
  navigateToTradeRelationships,
  navigateWithQuery,
} from '../utils/navHelpers'

/** 财务核对同步疑点的 analysis_batch 前缀，可反查账表 batch_id。 */
export function financeBatchFromAnalysisBatch(analysisBatch?: string): string | undefined {
  const prefix = 'finance_reconcile_'
  if (!analysisBatch?.startsWith(prefix)) return undefined
  const id = analysisBatch.slice(prefix.length).trim()
  return id && id !== 'all' ? id : undefined
}

/** 语义质量 sync 的 analysis_batch 前缀。 */
export function semanticBatchFromAnalysisBatch(analysisBatch?: string): string | undefined {
  const prefix = 'semantic_quality_'
  if (!analysisBatch?.startsWith(prefix)) return undefined
  const id = analysisBatch.slice(prefix.length).trim()
  return id && id !== 'all' ? id : undefined
}

export function taxCodeStatYearFromAnalysisBatch(analysisBatch?: string): string | undefined {
  const prefix = 'tax_code_analysis_'
  if (!analysisBatch?.startsWith(prefix)) return undefined
  const y = analysisBatch.slice(prefix.length).trim()
  return y || undefined
}

export function isFinanceRule(ruleId: string): boolean {
  return ruleId.startsWith('RULE-FIN-')
}

export function isSemanticQualityRule(ruleId: string): boolean {
  return ruleId.startsWith('RULE-DQ-')
}

export function isTaxCodeRule(ruleId: string): boolean {
  return ruleId.startsWith('RULE-TAX-') && ruleId !== 'RULE-TAX-DEV'
}

/** 数据完整性类规则，可跳转质量/健康分页面。 */
export function isQualityRelatedRule(ruleId: string): boolean {
  return /^RULE-0[1-4]$/.test(ruleId) || isSemanticQualityRule(ruleId)
}

export function isRelatedRule(ruleId: string): boolean {
  return ruleId === 'RULE-09' || ruleId === 'RULE-10' || ruleId === 'RULE-SHELL'
}

/** 从规则 ID 构造最小疑点行（用于健康度页 flag_breakdown 深链）。 */
export function minimalFlagRowForRule(ruleId: string, entityId?: string | null): AuditFlagRow {
  return {
    flag_id: '',
    rule_id: ruleId,
    risk_level: '',
    flag_type: '',
    group_id: '',
    description: '',
    suggestion: '',
    entity_id: entityId ?? null,
  }
}

export type FlagActionLabels = {
  viewFinanceDiffBtn: string
  viewTaxCodeBtn: string
  viewSemanticDetailBtn: string
  viewQualityTrendBtn: string
  viewQualityBtn: string
  viewInvoiceBtn: string
  viewRelatedPairsBtn: string
  viewRelatedShellBtn: string
  viewRelatedGraphBtn: string
  viewTradeRelationshipsBtn: string
  viewSupplierTopBtn: string
  viewSupplierCrBtn: string
  viewOverviewTrendBtn: string
  viewInvoiceTimingBtn: string
  viewRedOffsetBtn: string
  viewTaxInOutDevBtn: string
  viewTaxRiskExposureBtn: string
  viewTrackBtn: string
  viewFlagsListBtn: string
  genReportBtn: string
}

export type FlagActionLink = {
  id: string
  label: string
}

export function reportChaptersForRule(ruleId: string): string[] {
  const chapters = ['flags_track', 'audit_flags']
  if (isFinanceRule(ruleId)) chapters.push('finance_reconcile')
  if (isTaxCodeRule(ruleId)) chapters.push('tax_code_analysis')
  if (isSemanticQualityRule(ruleId) || isQualityRelatedRule(ruleId)) {
    chapters.push('data_quality_summary')
  }
  if (isRelatedRule(ruleId)) chapters.push('related')
  if (ruleId === 'RULE-TAX-DEV' || ruleId === 'RULE-09' || ruleId === 'RULE-10') {
    chapters.push('tax_risk_exposure')
  }
  if (ruleId === 'RULE-TAX-DEV') chapters.push('tax_in_out_deviation')
  return chapters
}

export function financeDiffParamsFromFlag(row: AuditFlagRow, statYear: string) {
  const detail = parseFlagDetailJson(row)
  return {
    batchId: strField(detail, 'batch_id') ?? financeBatchFromAnalysisBatch(row.analysis_batch),
    entityId: strField(detail, 'entity_id') ?? row.entity_id ?? undefined,
    statYear: String(detail.stat_year ?? statYear),
    diffType: strField(detail, 'diff_type'),
  }
}

/** RULE-TAX-* 税码分析深链参数。 */
export function taxCodeNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year =
    String(detail.stat_year ?? taxCodeStatYearFromAnalysisBatch(row.analysis_batch) ?? statYear).trim() ||
    statYear
  const entityId = strField(detail, 'entity_id') ?? row.entity_id ?? undefined
  const goods = strField(detail, 'goods_name')
  return {
    stat_year: year,
    entity_id: entityId,
    goods_name: goods,
    slv_num: detail.slv_num != null ? String(detail.slv_num) : undefined,
    keyword: goods ?? entityId,
  }
}

/** RULE-DQ-* 语义质量深链参数。 */
export function semanticQualityNavParamsFromFlag(row: AuditFlagRow) {
  const detail = parseFlagDetailJson(row)
  return {
    batchId: strField(detail, 'batch_id') ?? semanticBatchFromAnalysisBatch(row.analysis_batch),
    domain: (strField(detail, 'domain') ?? qualityDomainForRule(row.rule_id)) as QualityDomainKey,
    statYear: detail.stat_year != null ? String(detail.stat_year) : undefined,
  }
}

/** 解析疑点 detail_json（失败返回空对象）。 */
export function parseFlagDetailJson(row: AuditFlagRow): Record<string, unknown> {
  const raw = row.detail_json
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function strField(detail: Record<string, unknown>, key: string): string | undefined {
  const v = String(detail[key] ?? '').trim()
  return v || undefined
}

function monthDateBounds(statYear: string, statMonth: number): { dateFrom: string; dateTo: string } | null {
  const y = parseInt(statYear, 10)
  const m = Math.trunc(statMonth)
  if (!Number.isFinite(y) || m < 1 || m > 12) return null
  const last = new Date(y, m, 0).getDate()
  const mm = String(m).padStart(2, '0')
  return {
    dateFrom: `${y}-${mm}-01`,
    dateTo: `${y}-${mm}-${String(last).padStart(2, '0')}`,
  }
}

/** 从疑点 detail_json / 描述解析开票日期筛选项。 */
export function invoiceDateFilterFromFlag(
  row: AuditFlagRow,
  statYear: string,
): { dateFrom?: string; dateTo?: string } {
  const detail = parseFlagDetailJson(row)
  const fromRaw = strField(detail, 'date_from') ?? strField(detail, 'invoice_date') ?? strField(detail, 'red_date')
  const toRaw =
    strField(detail, 'date_to') ??
    strField(detail, 'invoice_date') ??
    strField(detail, 'blue_date') ??
    fromRaw
  if (fromRaw) return { dateFrom: fromRaw, dateTo: toRaw || fromRaw }

  const statMonthRaw = detail.stat_month
  const detailYear = String(detail.stat_year ?? statYear).trim()
  if (statMonthRaw != null && detailYear) {
    const bounds = monthDateBounds(detailYear, Number(statMonthRaw))
    if (bounds) return bounds
  }

  if (row.rule_id !== 'RULE-02') return {}

  if (row.flag_type === '年末突击开票') {
    const yMatch = row.description.match(/(\d{4})\s*年\s*11/) ?? row.flag_id.match(/FP-(\d{4})-02Y/)
    const y = yMatch?.[1] ?? statYear
    if (y) return { dateFrom: `${y}-11-01`, dateTo: `${y}-12-31` }
  }

  const iso = row.description.match(/\d{4}-\d{2}-\d{2}/)
  if (iso) return { dateFrom: iso[0], dateTo: iso[0] }

  return {}
}

/** 发票导出深链参数（含销方税号、状态等）。 */
export function invoiceExportParamsFromFlag(row: AuditFlagRow, statYear: string) {
  const detail = parseFlagDetailJson(row)
  const dateFilter = invoiceDateFilterFromFlag(row, statYear)
  const seller =
    strField(detail, 'seller_tax_no') ?? (row.seller_tax_no ? String(row.seller_tax_no).trim() : undefined)
  let fpzt: string | undefined
  if (row.rule_id === 'RULE-03' && row.flag_type === '孤立红票') {
    fpzt = strField(detail, 'fpzt') ?? '红字'
  } else if (row.rule_id === 'RULE-04') {
    fpzt = undefined
  }
  return {
    statYear,
    entityId: row.entity_id ?? undefined,
    sellerTaxNo: seller,
    ...dateFilter,
    fpzt,
  }
}

/** DWS 看板深链参数（overview_trend / supplier_top）。 */
export function dwsNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  const dateFilter = invoiceDateFilterFromFlag(row, year)
  let statMonth: string | undefined
  if (detail.stat_month != null && detail.stat_month !== '') {
    const m = Math.trunc(Number(detail.stat_month))
    if (m >= 1 && m <= 12) statMonth = String(m)
  }
  const seller =
    strField(detail, 'seller_tax_no') ?? (row.seller_tax_no ? String(row.seller_tax_no).trim() : undefined)
  return {
    stat_year: year,
    entity_id: row.entity_id ?? undefined,
    stat_month: statMonth,
    date_from: dateFilter.dateFrom,
    date_to: dateFilter.dateTo,
    seller_tax_no: seller,
    goods_key: strField(detail, 'goods_key'),
    quarter: detail.quarter != null ? String(detail.quarter) : undefined,
  }
}

/** RULE-05 税收分类结构深链参数。 */
export function taxEnterpriseNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  const goods = strField(detail, 'goods_name') ?? strField(detail, 'goods_key')
  const seller =
    strField(detail, 'seller_tax_no') ?? (row.seller_tax_no ? String(row.seller_tax_no).trim() : undefined)
  return {
    stat_year: year,
    entity_id: row.entity_id ?? undefined,
    seller_tax_no: seller,
    goods_name: goods,
    slv_num: detail.slv_num != null ? String(detail.slv_num) : undefined,
    expected_rate: detail.expected_rate != null ? String(detail.expected_rate) : undefined,
    keyword: goods ?? seller,
  }
}

/** 税风险敞口深链参数（RULE-09/10/TAX-DEV 等）。 */
export function taxRiskNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  const entityId =
    strField(detail, 'entity_id') ??
    strField(detail, 'party_a_tax') ??
    strField(detail, 'buyer_tax_no') ??
    row.entity_id ??
    undefined
  return { stat_year: year, entity_id: entityId }
}

/** RULE-09 对开发票深链参数。 */
export function relatedPairsNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  const partyA = strField(detail, 'party_a_tax') ?? row.entity_id ?? undefined
  const partyB =
    strField(detail, 'party_b_tax') ??
    strField(detail, 'counterparty_id') ??
    strField(detail, 'counterparty_tax_no')
  return {
    stat_year: year,
    party_a_tax: partyA,
    party_b_tax: partyB,
    keyword: partyB ?? partyA,
  }
}

/** RULE-09/10 关联图谱深链参数。 */
export function relatedGraphNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  const partyA =
    strField(detail, 'party_a_tax') ??
    strField(detail, 'buyer_tax_no') ??
    row.entity_id ??
    undefined
  const partyB =
    strField(detail, 'party_b_tax') ??
    strField(detail, 'seller_tax_no') ??
    strField(detail, 'counterparty_id') ??
    strField(detail, 'counterparty_tax_no')
  return {
    stat_year: year,
    entity_id: partyA,
    counterparty_id: partyB,
    counterparty_tax_no: partyB,
    party_a_tax: partyA,
    party_b_tax: partyB,
  }
}

/** RULE-10 被审主体关联视图深链参数。 */
export function tradeRelationshipsNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  const buyer = strField(detail, 'buyer_tax_no') ?? row.entity_id ?? undefined
  const seller =
    strField(detail, 'seller_tax_no') ??
    strField(detail, 'counterparty_id') ??
    strField(detail, 'counterparty_tax_no') ??
    (row.seller_tax_no ? String(row.seller_tax_no).trim() : undefined)
  return {
    stat_year: year,
    entity_id: buyer,
    buyer_tax_no: buyer,
    seller_tax_no: seller,
    counterparty_id: seller,
    keyword: seller ?? buyer,
  }
}

/** RULE-TAX-DEV 进销偏离深链参数。 */
export function taxDevNavParamsFromFlag(
  row: AuditFlagRow,
  statYear: string,
): Record<string, string | undefined> {
  const detail = parseFlagDetailJson(row)
  const year = String(detail.stat_year ?? statYear).trim() || statYear
  return {
    stat_year: year,
    entity_id: row.entity_id ?? strField(detail, 'entity_id'),
    tax_bucket: strField(detail, 'tax_bucket'),
  }
}

/** 是否具备月度/日期趋势上下文（可展示趋势页按钮）。 */
export function hasTrendContextFromFlag(row: AuditFlagRow): boolean {
  if (row.rule_id === 'RULE-07') return true
  const detail = parseFlagDetailJson(row)
  if (detail.stat_month != null) return true
  if (strField(detail, 'date_from') || strField(detail, 'invoice_date')) return true
  if (row.flag_type === '年末突击开票') return true
  return false
}

function qualityDomainForRule(ruleId: string): QualityDomainKey {
  if (ruleId === 'RULE-DQ-MISSING-SPC') return 'cross_table'
  if (ruleId === 'RULE-DQ-SUMMARY-LINE') return 'semantic'
  return 'semantic'
}

export function taxNavForRule(ruleId: string): 'dim_tax_quality' | 'tax_enterprise_structure' {
  return ruleId === 'RULE-TAX-HIGH-CODE' ? 'tax_enterprise_structure' : 'dim_tax_quality'
}

/** 按规则返回可跳转的分析页动作（不含展开/跟踪页专属按钮）。 */
export function getFlagActionLinks(row: AuditFlagRow, _statYear: string, labels: FlagActionLabels): FlagActionLink[] {
  const links: FlagActionLink[] = []
  const entityId = row.entity_id ?? undefined
  const ruleId = row.rule_id

  if (isFinanceRule(ruleId)) {
    links.push({ id: 'finance_diff', label: labels.viewFinanceDiffBtn })
    return links
  }

  if (isTaxCodeRule(ruleId)) {
    links.push({ id: 'tax_code', label: labels.viewTaxCodeBtn })
    return links
  }

  if (isSemanticQualityRule(ruleId)) {
    links.push({ id: 'semantic_quality', label: labels.viewSemanticDetailBtn })
    links.push({ id: 'quality_trend', label: labels.viewQualityTrendBtn })
    return links
  }

  switch (ruleId) {
    case 'RULE-01':
    case 'RULE-04':
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      if (hasTrendContextFromFlag(row)) {
        links.push({ id: 'overview_trend', label: labels.viewOverviewTrendBtn })
      }
      if (isQualityRelatedRule(ruleId)) {
        links.push({ id: 'health_score', label: labels.viewQualityBtn })
      }
      break
    case 'RULE-02':
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      if (entityId) links.push({ id: 'invoice_timing', label: labels.viewInvoiceTimingBtn })
      if (hasTrendContextFromFlag(row)) {
        links.push({ id: 'overview_trend', label: labels.viewOverviewTrendBtn })
      }
      if (isQualityRelatedRule(ruleId)) {
        links.push({ id: 'health_score', label: labels.viewQualityBtn })
      }
      break
    case 'RULE-03':
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      if (entityId) links.push({ id: 'red_offset_analysis', label: labels.viewRedOffsetBtn })
      if (hasTrendContextFromFlag(row)) {
        links.push({ id: 'overview_trend', label: labels.viewOverviewTrendBtn })
      }
      if (isQualityRelatedRule(ruleId)) {
        links.push({ id: 'health_score', label: labels.viewQualityBtn })
      }
      break
    case 'RULE-05':
      links.push({ id: 'tax_enterprise_structure', label: labels.viewTaxCodeBtn })
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      break
    case 'RULE-06':
      if (entityId) links.push({ id: 'supplier_top', label: labels.viewSupplierTopBtn })
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      break
    case 'RULE-07':
      if (entityId) links.push({ id: 'overview_trend', label: labels.viewOverviewTrendBtn })
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      break
    case 'RULE-08':
      if (entityId) links.push({ id: 'supplier_top', label: labels.viewSupplierTopBtn })
      if (entityId) links.push({ id: 'supplier_cr', label: labels.viewSupplierCrBtn })
      break
    case 'RULE-09':
      links.push({ id: 'related_pairs', label: labels.viewRelatedPairsBtn })
      links.push({ id: 'related_graph', label: labels.viewRelatedGraphBtn })
      links.push({ id: 'tax_risk_exposure', label: labels.viewTaxRiskExposureBtn })
      break
    case 'RULE-10':
      links.push({ id: 'trade_relationships', label: labels.viewTradeRelationshipsBtn })
      links.push({ id: 'related_graph', label: labels.viewRelatedGraphBtn })
      links.push({ id: 'tax_risk_exposure', label: labels.viewTaxRiskExposureBtn })
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      break
    case 'RULE-SHELL':
      links.push({ id: 'related_shell', label: labels.viewRelatedShellBtn })
      break
    case 'RULE-TAX-DEV':
      if (entityId) {
        links.push({ id: 'tax_in_out_deviation', label: labels.viewTaxInOutDevBtn })
        links.push({ id: 'tax_risk_exposure', label: labels.viewTaxRiskExposureBtn })
      }
      break
    default:
      if (entityId) links.push({ id: 'invoice_export', label: labels.viewInvoiceBtn })
      break
  }

  return links
}

export function navigateFlagAction(
  onNav: (key: NavKey) => void,
  actionId: string,
  row: AuditFlagRow,
  statYear: string,
) {
  const entityId = row.entity_id ?? undefined
  const ruleId = row.rule_id

  switch (actionId) {
    case 'finance_diff':
      navigateToFinancePage(onNav, 'finance_diff', financeDiffParamsFromFlag(row, statYear))
      return
    case 'tax_code': {
      navigateWithQuery(onNav, taxNavForRule(ruleId), taxCodeNavParamsFromFlag(row, statYear))
      return
    }
    case 'tax_enterprise_structure':
      navigateWithQuery(onNav, 'tax_enterprise_structure', taxEnterpriseNavParamsFromFlag(row, statYear))
      return
    case 'semantic_quality':
      navigateToQualityDetail(onNav, semanticQualityNavParamsFromFlag(row))
      return
    case 'quality_trend': {
      const p = semanticQualityNavParamsFromFlag(row)
      navigateToQualityPage(onNav, 'import_quality_trend', { batchId: p.batchId })
      return
    }
    case 'health_score':
      navigateToHealthScore(onNav, { statYear, entityId })
      return
    case 'invoice_export':
      navigateToInvoiceExport(onNav, invoiceExportParamsFromFlag(row, statYear))
      return
    case 'supplier_top':
      navigateWithQuery(onNav, 'supplier_top', dwsNavParamsFromFlag(row, statYear))
      return
    case 'supplier_cr':
      navigateWithQuery(onNav, 'supplier_cr', dwsNavParamsFromFlag(row, statYear))
      return
    case 'overview_trend':
      navigateWithQuery(onNav, 'overview_trend', dwsNavParamsFromFlag(row, statYear))
      return
    case 'invoice_timing':
      navigateToInvoiceTiming(onNav, { statYear, entityId })
      return
    case 'red_offset_analysis':
      navigateToRedOffsetAnalysis(onNav, { statYear, entityId })
      return
    case 'related_pairs': {
      const p = relatedPairsNavParamsFromFlag(row, statYear)
      navigateToRelatedPairs(onNav, {
        statYear: p.stat_year,
        partyATax: p.party_a_tax,
        partyBTax: p.party_b_tax,
        keyword: p.keyword,
      })
      return
    }
    case 'related_shell':
      navigateToRelatedShell(onNav, { statYear })
      return
    case 'related_graph':
      navigateWithQuery(onNav, 'related_graph', relatedGraphNavParamsFromFlag(row, statYear))
      return
    case 'trade_relationships': {
      const p = tradeRelationshipsNavParamsFromFlag(row, statYear)
      navigateToTradeRelationships(onNav, {
        statYear: p.stat_year,
        entityId: p.entity_id,
        buyerTaxNo: p.buyer_tax_no,
        sellerTaxNo: p.seller_tax_no,
        keyword: p.keyword,
      })
      return
    }
    case 'tax_in_out_deviation':
      navigateWithQuery(onNav, 'tax_in_out_deviation', taxDevNavParamsFromFlag(row, statYear))
      return
    case 'tax_risk_exposure': {
      const p = taxRiskNavParamsFromFlag(row, statYear)
      navigateToTaxRiskExposure(onNav, {
        statYear: p.stat_year,
        entityId: p.entity_id,
      })
      return
    }
    case 'flags_track':
      navigateToFlagsTrack(onNav, {
        statYear,
        ruleId,
        entityId,
        trackTab: 'pending',
      })
      return
    case 'flags_list': {
      const fin = isFinanceRule(ruleId) ? financeDiffParamsFromFlag(row, statYear) : null
      navigateToFlagsList(onNav, {
        statYear,
        ruleId,
        entityId,
        batchId: fin?.batchId,
      })
      return
    }
    default:
      if (entityId) navigateToInvoiceExport(onNav, invoiceExportParamsFromFlag(row, statYear))
  }
}

/** @deprecated 使用 navigateFlagAction(actionId='tax_code') */
export function navigateToTaxCodePage(
  onNav: (key: NavKey) => void,
  nav: 'dim_tax_quality' | 'tax_enterprise_structure',
  params?: { statYear?: string; entityId?: string },
) {
  navigateWithQuery(onNav, nav, {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
  })
}

/** @deprecated 使用 navigateFlagAction(actionId='semantic_quality') */
export function navigateToSemanticQualityDetail(
  onNav: (key: NavKey) => void,
  params?: { batchId?: string; domain?: string },
) {
  navigateToQualityDetail(onNav, {
    batchId: params?.batchId,
    domain: params?.domain ?? 'semantic',
  })
}
