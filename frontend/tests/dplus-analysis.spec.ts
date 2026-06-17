import { expect, test, type Page } from '@playwright/test'
import { zhCN as t } from '../src/copy/zh-CN'

const goodsUi = t.goodsCategoryUi
const redUi = t.redOffsetUi
const profileUi = t.entityProfileUi

const TEST_ENTITY = '91310000MA1BBBBBBB'
const TEST_STAT_YEAR = '2026'

async function loginAsAdmin(page: Page, pathWithQuery = '/') {
  await page.goto(pathWithQuery)
  await page.waitForLoadState('domcontentloaded')
  const quickLogin = page.getByRole('button', { name: t.login.demoOneClick })
  if (await quickLogin.isVisible().catch(() => false)) {
    await quickLogin.click()
  } else {
    await page.getByPlaceholder(t.login.accountPlaceholder).fill('')
    await page.getByPlaceholder(t.login.passwordPlaceholder).fill('')
    await page.getByRole('button', { name: t.login.submit, exact: true }).click()
  }
  await expect(page.getByRole('button', { name: t.common.logout })).toBeVisible({ timeout: 30_000 })
}

async function mockGoodsCategoryApis(page: Page) {
  await page.route('**/api/dws/goods-cat/overview**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        total_net_jshj: 500,
        total_invoice_cnt: 8,
        quarterly: [{ stat_quarter: 1, net_jshj: 300, invoice_cnt: 5, category_cnt: 2 }],
        top_categories: [
          {
            tax_code_short: '1',
            tax_code_level2: '10',
            stat_quarter: 1,
            net_jshj: 300,
            invoice_cnt: 5,
            supplier_cnt: 2,
          },
        ],
      }),
    })
  })
  await page.route('**/api/dws/goods-cat/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        rows: [
          {
            tax_code_short: '1',
            tax_code_level2: '10',
            stat_quarter: 1,
            net_jshj: 300,
            invoice_cnt: 5,
            supplier_cnt: 2,
          },
        ],
        total: 1,
      }),
    })
  })
}

async function mockRedOffsetApis(page: Page) {
  await page.route('**/api/dws/red-offset/overview**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        header_cnt: 100,
        red_cnt: 5,
        orphan_cnt: 1,
        fully_reversed_cnt: 2,
        red_ratio: 0.05,
        red_offset_amt: 1200,
        net_amt: 50000,
        monthly: [{ stat_month: 1, header_cnt: 10, red_cnt: 1, orphan_cnt: 0 }],
      }),
    })
  })
  await page.route('**/api/dws/red-offset/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, rows: [], total: 0 }),
    })
  })
}

async function mockEnterpriseBehavior(page: Page) {
  await page.route('**/api/dws/enterprise-behavior/profile**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        months: [
          {
            stat_month: 1,
            inv_cnt_total: 12,
            inv_amt_total: 3400,
            red_inv_ratio: 0.08,
            amt_mom_change: 0.12,
          },
        ],
        summary: {},
      }),
    })
  })
}

async function mockEntityProfileMinimal(page: Page) {
  await page.route('**/api/dws/entity-profile**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        stat_year: TEST_STAT_YEAR,
        entity_id: TEST_ENTITY,
        entity_name: '测试主体B',
        concentration: { cr1: null, cr3: null, cr10: null, total_net_jshj: 0, top_suppliers: [] },
        churn: { new_total: 0, new_top10: 0, disappeared_total: 0, prior_year: '2025' },
        tax_structure: { buckets: [], total_amount_je: 0, total_line_cnt: 0 },
        tax_code: {},
        related: { graph_node_count: 0, graph_edge_count: 0, graph_ok: true },
        audit_flags: { total: 0, pending: 0, by_rule: [] },
      }),
    })
  })
}

async function mockEntityProfileWithYoy(page: Page) {
  await page.route('**/api/dws/entity-profile**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        stat_year: TEST_STAT_YEAR,
        entity_id: TEST_ENTITY,
        entity_name: '测试主体B',
        concentration: { cr1: 0.5, cr3: 0.7, cr10: 0.9, total_net_jshj: 1000, top_suppliers: [] },
        churn: { new_total: 1, new_top10: 1, disappeared_total: 0, prior_year: '2025' },
        tax_structure: { buckets: [], total_amount_je: 0, total_line_cnt: 0 },
        tax_code: {},
        related: { graph_node_count: 0, graph_edge_count: 0, graph_ok: true },
        audit_flags: { total: 0, pending: 0, by_rule: [] },
        year_over_year: {
          prior_year: '2025',
          churn_summary: { new_total: 1, disappeared_total: 0 },
          tax_buckets: { current: [], prior: [] },
        },
      }),
    })
  })
}

test.describe('D+ analysis pages', () => {
  test('goods_category page loads title and filter bar', async ({ page }) => {
    await mockGoodsCategoryApis(page)
    await loginAsAdmin(page, `/?nav=goods_category&stat_year=${TEST_STAT_YEAR}&entity_id=${TEST_ENTITY}`)

    await expect(page.getByRole('heading', { name: goodsUi.pageTitle })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(goodsUi.filterTitle)).toBeVisible()
    await expect(page.getByText(goodsUi.quarterFilter)).toBeVisible()
  })

  test('red_offset_analysis page loads title and filter bar', async ({ page }) => {
    await mockRedOffsetApis(page)
    await loginAsAdmin(page, `/?nav=red_offset_analysis&stat_year=${TEST_STAT_YEAR}`)

    await expect(page.getByRole('heading', { name: redUi.pageTitle })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(redUi.filterTitle)).toBeVisible()
    await expect(page.getByText(redUi.kpiRedRatio)).toBeVisible()
  })

  test('entity_profile behavior tab loads with mocked data', async ({ page }) => {
    await mockEntityProfileMinimal(page)
    await mockEnterpriseBehavior(page)
    await loginAsAdmin(
      page,
      `/?nav=entity_profile&stat_year=${TEST_STAT_YEAR}&entity_id=${TEST_ENTITY}`,
    )

    await expect(page.getByRole('heading', { name: profileUi.pageTitle })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: profileUi.tabBehavior }).click()
    await expect(page.getByText(profileUi.behaviorTitle)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(profileUi.colMonth)).toBeVisible()
  })

  test('entity_profile deep link to red_offset_analysis', async ({ page }) => {
    await mockEntityProfileWithYoy(page)
    await mockRedOffsetApis(page)
    await loginAsAdmin(
      page,
      `/?nav=entity_profile&stat_year=${TEST_STAT_YEAR}&entity_id=${TEST_ENTITY}`,
    )

    await expect(page.getByRole('heading', { name: profileUi.pageTitle })).toBeVisible({ timeout: 15_000 })
    const redLink = page.getByRole('button', { name: profileUi.linkRedOffset })
    await expect(redLink).toBeVisible({ timeout: 15_000 })
    await redLink.click()
    await page.waitForLoadState('domcontentloaded')

    const url = new URL(page.url())
    expect(url.searchParams.get('nav')).toBe('red_offset_analysis')
    expect(url.searchParams.get('entity_id')).toBe(TEST_ENTITY)
    await expect(page.getByRole('heading', { name: redUi.pageTitle })).toBeVisible({ timeout: 15_000 })
  })
})
