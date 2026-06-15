import { expect, test, type Page } from '@playwright/test'
import { zhCN as t } from '../src/copy/zh-CN'

const DEMO_ENTITY = '91110000DEMO000001'
const DEMO_NAME = '演示子公司'
const STAT_YEAR = '2024'

async function gotoLoggedIn(page: Page, pathWithQuery: string) {
  await page.goto(pathWithQuery)
  await page.waitForLoadState('domcontentloaded')
  const quickLogin = page.getByRole('button', { name: t.login.demoOneClick })
  if (await quickLogin.isVisible().catch(() => false)) {
    await quickLogin.click()
    await page.waitForLoadState('domcontentloaded')
  }
}

async function mockCompareChartsApis(page: Page) {
  await page.route('**/api/settings/license**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        tier: 'enterprise',
        cross_group: true,
        export_report: true,
        gates: { cross_group: true, export_report: true },
      }),
    })
  })

  await page.route('**/api/compare/meta**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        stat_years: [STAT_YEAR],
        default_stat_year: STAT_YEAR,
        scorecard_ready: true,
      }),
    })
  })

  await page.route('**/api/compare/charts/series**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        series: [
          {
            entity_id: DEMO_ENTITY,
            entity_name: DEMO_NAME,
            risk_level: '关注',
            risk_score: 72,
            total_amount: 1200000,
            flag_high: 3,
            flag_total: 8,
            cr1: 0.12,
            cancel_ratio: 0.02,
            supplier_count: 15,
            value: 1200000,
          },
        ],
        risk_distribution: { normal: 4, watch: 2, critical: 1, total: 7 },
      }),
    })
  })
}

test.describe('CompareCharts drill-down', () => {
  test.beforeEach(async ({ page }) => {
    await mockCompareChartsApis(page)
  })

  test('drills to overview_summary with entity filter', async ({ page }) => {
    await gotoLoggedIn(page, `/?nav=compare_charts&stat_year=${STAT_YEAR}`)
    await expect(page.getByText(t.compareChartsUi.pageTitle)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(DEMO_NAME)).toBeVisible({ timeout: 15_000 })

    const row = page.locator('div').filter({ hasText: DEMO_NAME }).first()
    await row.getByRole('button', { name: t.compareChartsUi.actionOverviewSummary }).click()
    await page.waitForLoadState('domcontentloaded')

    const url = new URL(page.url())
    expect(url.searchParams.get('nav')).toBe('overview_summary')
    expect(url.searchParams.get('stat_year')).toBe(STAT_YEAR)
    expect(url.searchParams.get('entity_id')).toBe(DEMO_ENTITY)
  })

  test('drills to tax_risk_exposure with entity filter', async ({ page }) => {
    await gotoLoggedIn(page, `/?nav=compare_charts&stat_year=${STAT_YEAR}`)
    await expect(page.getByText(DEMO_NAME)).toBeVisible({ timeout: 15_000 })

    const row = page.locator('div').filter({ hasText: DEMO_NAME }).first()
    await row.getByRole('button', { name: t.compareChartsUi.actionTaxRiskExposure }).click()
    await page.waitForLoadState('domcontentloaded')

    const url = new URL(page.url())
    expect(url.searchParams.get('nav')).toBe('tax_risk_exposure')
    expect(url.searchParams.get('entity_id')).toBe(DEMO_ENTITY)
  })

  test('drills to supplier_top with entity filter', async ({ page }) => {
    await gotoLoggedIn(page, `/?nav=compare_charts&stat_year=${STAT_YEAR}`)
    await expect(page.getByText(DEMO_NAME)).toBeVisible({ timeout: 15_000 })

    const row = page.locator('div').filter({ hasText: DEMO_NAME }).first()
    await row.getByRole('button', { name: t.compareChartsUi.actionSupplierTop }).click()
    await page.waitForLoadState('domcontentloaded')

    const url = new URL(page.url())
    expect(url.searchParams.get('nav')).toBe('supplier_top')
    expect(url.searchParams.get('entity_id')).toBe(DEMO_ENTITY)
  })
})
