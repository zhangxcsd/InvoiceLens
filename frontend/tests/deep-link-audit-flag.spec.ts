import { expect, test, type Page } from '@playwright/test'
import type { AuditFlagRow } from '../src/config/localApi'
import { zhCN as t } from '../src/copy/zh-CN'
import {
  dwsNavParamsFromFlag,
  financeDiffParamsFromFlag,
  getFlagActionLinks,
  relatedGraphNavParamsFromFlag,
  relatedPairsNavParamsFromFlag,
  semanticQualityNavParamsFromFlag,
  taxCodeNavParamsFromFlag,
  taxDevNavParamsFromFlag,
  taxEnterpriseNavParamsFromFlag,
  taxRiskNavParamsFromFlag,
  tradeRelationshipsNavParamsFromFlag,
} from '../src/dm/flagActionHelpers'

const dash = t.dwsDashboardUi

async function gotoLoggedIn(page: Page, pathWithQuery: string) {
  await page.goto(pathWithQuery)
  await page.waitForLoadState('domcontentloaded')
  const quickLogin = page.getByRole('button', { name: t.login.demoOneClick })
  if (await quickLogin.isVisible().catch(() => false)) {
    await quickLogin.click()
    await page.waitForLoadState('domcontentloaded')
  }
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') sp.set(k, v)
  }
  return sp.toString()
}

function mockFlag(partial: Partial<AuditFlagRow> & Pick<AuditFlagRow, 'rule_id'>): AuditFlagRow {
  return {
    flag_id: partial.flag_id ?? 'FP-TEST-001',
    rule_id: partial.rule_id,
    flag_type: partial.flag_type ?? '测试疑点',
    risk_level: partial.risk_level ?? '中',
    group_id: partial.group_id ?? 'G-TEST',
    description: partial.description ?? '',
    suggestion: partial.suggestion ?? '',
    entity_id: partial.entity_id ?? '91110000TEST000001',
    seller_tax_no: partial.seller_tax_no,
    analysis_batch: partial.analysis_batch ?? 'test_batch',
    detail_json: partial.detail_json,
    amount: partial.amount ?? 0,
    created_at: partial.created_at ?? '2026-01-01T00:00:00Z',
  }
}

test.describe('flag action deep-link params', () => {
  test('overview_trend carries stat_month and date bounds', () => {
    const row = mockFlag({
      rule_id: 'RULE-07',
      detail_json: JSON.stringify({ stat_year: 2024, stat_month: 3 }),
    })
    const p = dwsNavParamsFromFlag(row, '2024')
    expect(p.stat_month).toBe('3')
    expect(p.stat_year).toBe('2024')
    expect(p.date_from).toBe('2024-03-01')
    expect(p.date_to).toBe('2024-03-31')
  })

  test('supplier_top carries seller_tax_no', () => {
    const row = mockFlag({
      rule_id: 'RULE-06',
      detail_json: JSON.stringify({ seller_tax_no: '91110000AAA000001' }),
    })
    const p = dwsNavParamsFromFlag(row, '2024')
    expect(p.seller_tax_no).toBe('91110000AAA000001')
  })

  test('RULE-08 supplier_top carries quarter', () => {
    const row = mockFlag({
      rule_id: 'RULE-08',
      entity_id: '91110000BUY000001',
      detail_json: JSON.stringify({ stat_year: 2024, quarter: 2, seller_tax_no: '91110000SEL000002' }),
    })
    const p = dwsNavParamsFromFlag(row, '2024')
    expect(p.quarter).toBe('2')
    expect(p.seller_tax_no).toBe('91110000SEL000002')
  })

  test('RULE-FIN detail_json drives finance diff params', () => {
    const row = mockFlag({
      rule_id: 'RULE-FIN-DIFF',
      analysis_batch: 'finance_reconcile_all',
      detail_json: JSON.stringify({
        stat_year: 2026,
        entity_id: '91330100123456789X',
        batch_id: 'fin_batch_1',
        diff_type: 'C',
      }),
    })
    const p = financeDiffParamsFromFlag(row, '2024')
    expect(p.batchId).toBe('fin_batch_1')
    expect(p.entityId).toBe('91330100123456789X')
    expect(p.statYear).toBe('2026')
    expect(p.diffType).toBe('C')
  })

  test('RULE-TAX-UNMATCH detail_json drives tax code nav', () => {
    const row = mockFlag({
      rule_id: 'RULE-TAX-UNMATCH',
      entity_id: '91310000MA1BBBBBBB',
      detail_json: JSON.stringify({ stat_year: 2026, entity_id: '91310000MA1BBBBBBB', line_count: 8 }),
    })
    const p = taxCodeNavParamsFromFlag(row, '2024')
    expect(p.stat_year).toBe('2026')
    expect(p.entity_id).toBe('91310000MA1BBBBBBB')
  })

  test('RULE-DQ semantic quality links and params', () => {
    const row = mockFlag({
      rule_id: 'RULE-DQ-SUMMARY-LINE',
      analysis_batch: 'semantic_quality_all',
      detail_json: JSON.stringify({
        stat_year: 2026,
        batch_id: 'b1',
        domain: 'semantic',
      }),
    })
    const p = semanticQualityNavParamsFromFlag(row)
    expect(p.batchId).toBe('b1')
    expect(p.domain).toBe('semantic')
    const links = getFlagActionLinks(row, '2026', {
      viewFinanceDiffBtn: '',
      viewTaxCodeBtn: '',
      viewSemanticDetailBtn: t.auditFlagUi.viewSemanticDetailBtn,
      viewQualityTrendBtn: t.auditFlagUi.viewQualityTrendBtn,
      viewQualityBtn: '',
      viewInvoiceBtn: '',
      viewRelatedPairsBtn: '',
      viewRelatedShellBtn: '',
      viewRelatedGraphBtn: '',
      viewTradeRelationshipsBtn: '',
      viewSupplierTopBtn: '',
      viewSupplierCrBtn: '',
      viewOverviewTrendBtn: '',
      viewTaxInOutDevBtn: '',
      viewTaxRiskExposureBtn: '',
      viewTrackBtn: '',
      viewFlagsListBtn: '',
      genReportBtn: '',
    })
    expect(links.map((l) => l.id)).toEqual(['semantic_quality', 'quality_trend'])
  })

  test('tax code analysis carries goods and rate params', () => {
    const row = mockFlag({
      rule_id: 'RULE-05',
      detail_json: JSON.stringify({ goods_name: '咨询服务', slv_num: 0.06 }),
    })
    const p = taxEnterpriseNavParamsFromFlag(row, '2024')
    expect(p.goods_name).toBe('咨询服务')
    expect(p.keyword).toBe('咨询服务')
    expect(p.slv_num).toBe('0.06')
  })

  test('related pairs and graph carry party tax params', () => {
    const row = mockFlag({
      rule_id: 'RULE-09',
      entity_id: '91110000AAA000001',
      detail_json: JSON.stringify({
        stat_year: 2024,
        party_a_tax: '91110000AAA000001',
        party_b_tax: '91110000BBB000002',
        counterparty_id: '91110000BBB000002',
      }),
    })
    const pairs = relatedPairsNavParamsFromFlag(row, '2023')
    expect(pairs.party_a_tax).toBe('91110000AAA000001')
    expect(pairs.party_b_tax).toBe('91110000BBB000002')
    expect(pairs.stat_year).toBe('2024')
    expect(pairs.keyword).toBe('91110000BBB000002')

    const graph = relatedGraphNavParamsFromFlag(row, '2023')
    expect(graph.party_a_tax).toBe('91110000AAA000001')
    expect(graph.counterparty_tax_no).toBe('91110000BBB000002')
    expect(graph.counterparty_id).toBe('91110000BBB000002')
    expect(graph.stat_year).toBe('2024')

    const risk = taxRiskNavParamsFromFlag(row, '2023')
    expect(risk.entity_id).toBe('91110000AAA000001')
    expect(risk.stat_year).toBe('2024')

    const links = getFlagActionLinks(row, '2024', {
      viewFinanceDiffBtn: '',
      viewTaxCodeBtn: '',
      viewSemanticDetailBtn: '',
      viewQualityTrendBtn: '',
      viewQualityBtn: '',
      viewInvoiceBtn: '',
      viewRelatedPairsBtn: t.auditFlagUi.viewRelatedPairsBtn,
      viewRelatedShellBtn: '',
      viewRelatedGraphBtn: t.auditFlagUi.viewRelatedGraphBtn,
      viewTradeRelationshipsBtn: '',
      viewSupplierTopBtn: '',
      viewSupplierCrBtn: '',
      viewOverviewTrendBtn: '',
      viewTaxInOutDevBtn: '',
      viewTaxRiskExposureBtn: t.auditFlagUi.viewTaxRiskExposureBtn,
      viewTrackBtn: '',
      viewFlagsListBtn: '',
      genReportBtn: '',
    })
    expect(links.map((l) => l.id)).toEqual(['related_pairs', 'related_graph', 'tax_risk_exposure'])
  })

  test('trade relationships carry buyer and seller tax', () => {
    const row = mockFlag({
      rule_id: 'RULE-10',
      entity_id: '91110000BUY000001',
      detail_json: JSON.stringify({
        stat_year: 2024,
        buyer_tax_no: '91110000BUY000001',
        seller_tax_no: '91110000SEL000002',
        counterparty_id: '91110000SEL000002',
      }),
    })
    const p = tradeRelationshipsNavParamsFromFlag(row, '2023')
    expect(p.buyer_tax_no).toBe('91110000BUY000001')
    expect(p.seller_tax_no).toBe('91110000SEL000002')
    expect(p.stat_year).toBe('2024')
    expect(p.keyword).toBe('91110000SEL000002')

    const graph = relatedGraphNavParamsFromFlag(row, '2023')
    expect(graph.entity_id).toBe('91110000BUY000001')
    expect(graph.counterparty_id).toBe('91110000SEL000002')

    const links = getFlagActionLinks(row, '2024', {
      viewFinanceDiffBtn: '',
      viewTaxCodeBtn: '',
      viewSemanticDetailBtn: '',
      viewQualityTrendBtn: '',
      viewQualityBtn: '',
      viewInvoiceBtn: t.auditTrackUi.exportInvoiceBtn,
      viewRelatedPairsBtn: '',
      viewRelatedShellBtn: '',
      viewRelatedGraphBtn: t.auditFlagUi.viewRelatedGraphBtn,
      viewTradeRelationshipsBtn: t.auditFlagUi.viewTradeRelationshipsBtn,
      viewSupplierTopBtn: '',
      viewSupplierCrBtn: '',
      viewOverviewTrendBtn: '',
      viewTaxInOutDevBtn: '',
      viewTaxRiskExposureBtn: t.auditFlagUi.viewTaxRiskExposureBtn,
      viewTrackBtn: '',
      viewFlagsListBtn: '',
      genReportBtn: '',
    })
    expect(links.map((l) => l.id)).toEqual([
      'trade_relationships',
      'related_graph',
      'tax_risk_exposure',
      'invoice_export',
    ])
  })

  test('RULE-TAX-DEV carries stat_year entity_id and tax_bucket', () => {
    const row = mockFlag({
      rule_id: 'RULE-TAX-DEV',
      entity_id: '91110000DEMO000001',
      detail_json: JSON.stringify({
        stat_year: 2024,
        entity_id: '91110000DEMO000001',
        tax_bucket: '13%',
        ratio_diff_pp: 12.5,
      }),
    })
    const p = taxDevNavParamsFromFlag(row, '2024')
    expect(p.stat_year).toBe('2024')
    expect(p.entity_id).toBe('91110000DEMO000001')
    expect(p.tax_bucket).toBe('13%')

    const links = getFlagActionLinks(row, '2024', {
      viewFinanceDiffBtn: '',
      viewTaxCodeBtn: '',
      viewSemanticDetailBtn: '',
      viewQualityTrendBtn: '',
      viewQualityBtn: '',
      viewInvoiceBtn: '',
      viewRelatedPairsBtn: '',
      viewRelatedShellBtn: '',
      viewRelatedGraphBtn: '',
      viewTradeRelationshipsBtn: '',
      viewSupplierTopBtn: '',
      viewSupplierCrBtn: '',
      viewOverviewTrendBtn: '',
      viewTaxInOutDevBtn: t.auditFlagUi.viewTaxInOutDevBtn,
      viewTaxRiskExposureBtn: t.auditFlagUi.viewTaxRiskExposureBtn,
      viewTrackBtn: '',
      viewFlagsListBtn: '',
      genReportBtn: '',
    })
    expect(links.map((l) => l.id)).toEqual(['tax_in_out_deviation', 'tax_risk_exposure'])
  })
})

test.describe('deep-link context hints', () => {
  test('overview_trend shows month hint from stat_month', async ({ page }) => {
    const query = qs({
      nav: 'overview_trend',
      stat_year: '2024',
      stat_month: '3',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(page.getByText(dash.flagContextMonthHint.replace('{month}', '3'))).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(dash.monthGranularityHint)).toBeVisible({ timeout: 15_000 })
  })

  test('overview_trend shows date range hint', async ({ page }) => {
    const query = qs({
      nav: 'overview_trend',
      stat_year: '2024',
      date_from: '2024-06-01',
      date_to: '2024-06-30',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(
      page.getByText(
        dash.flagContextDateHint.replace('{from}', '2024-06-01').replace('{to}', '2024-06-30'),
      ),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('supplier_top shows seller tax hint', async ({ page }) => {
    const tax = '91110000AAA000001'
    const query = qs({
      nav: 'supplier_top',
      stat_year: '2024',
      entity_id: '91110000TEST000001',
      seller_tax_no: tax,
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(page.getByText(dash.flagContextSupplierHint.replace('{id}', tax))).toBeVisible({
      timeout: 15_000,
    })
  })

  test('supplier_top shows quarter hint', async ({ page }) => {
    const query = qs({
      nav: 'supplier_top',
      stat_year: '2024',
      entity_id: '91110000TEST000001',
      quarter: '2',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(page.getByText(dash.flagContextQuarterHint.replace('{quarter}', '2'))).toBeVisible({
      timeout: 15_000,
    })
  })

  test('tax_enterprise_structure shows goods hint', async ({ page }) => {
    const query = qs({
      nav: 'tax_enterprise_structure',
      stat_year: '2024',
      goods_name: '软件服务',
      slv_num: '0.13',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(
      page.getByText(dash.flagContextGoodsHint.replace('{goods}', '软件服务').replace('{rate}', '13.0%')),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('related_pairs shows party hint', async ({ page }) => {
    const query = qs({
      nav: 'related_pairs',
      stat_year: '2024',
      party_a_tax: '91110000AAA000001',
      party_b_tax: '91110000BBB000002',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(
      page.getByText(
        dash.flagContextPartyHint
          .replace('{partyA}', '91110000AAA000001')
          .replace('{partyB}', '91110000BBB000002'),
      ),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('related_graph shows party hint', async ({ page }) => {
    const query = qs({
      nav: 'related_graph',
      stat_year: '2024',
      entity_id: '91110000AAA000001',
      party_a_tax: '91110000AAA000001',
      party_b_tax: '91110000BBB000002',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(
      page.getByText(
        dash.flagContextPartyHint
          .replace('{partyA}', '91110000AAA000001')
          .replace('{partyB}', '91110000BBB000002'),
      ),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('related_graph shows tax-risk context from deep link', async ({ page }) => {
    const entity = '91110000AAA000001'
    const query = qs({
      nav: 'related_graph',
      stat_year: '2024',
      entity_id: entity,
      source: 'tax_risk',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(
      page.getByText(t.relatedGraphUi.taxRiskContextHint.replace('{entity}', entity)),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('trade_relationships shows buyer/seller hint', async ({ page }) => {
    const query = qs({
      nav: 'trade_relationships',
      stat_year: '2024',
      entity_id: '91110000BUY000001',
      buyer_tax_no: '91110000BUY000001',
      seller_tax_no: '91110000SEL000002',
    })
    await gotoLoggedIn(page, `/?${query}`)
    await expect(
      page.getByText(
        dash.flagContextInternalHint
          .replace('{buyer}', '91110000BUY000001')
          .replace('{seller}', '91110000SEL000002'),
      ),
    ).toBeVisible({ timeout: 15_000 })
  })
})
