import { expect, test, type Page } from '@playwright/test'
import { zhCN as t } from '../src/copy/zh-CN'

const profileUi = t.entityProfileUi
const drillUi = t.invoiceDetailDrillUi
const pagUi = t.dimDataTableUi
const dashUi = t.dwsDashboardUi

const TEST_ENTITY = '91310000MA1BBBBBBB'
const TEST_STAT_YEAR = '2026'
const TEST_SELLER = '91310000MA1AAAAAAA'

async function loginAsAdmin(page: Page, pathWithQuery = '/?nav=entity_profile') {
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

async function assertDrillPanelShell(page: Page, titleText: string) {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByRole('heading', { level: 2, name: titleText })).toBeVisible()
  await expect(dialog.getByRole('button', { name: drillUi.closeBtn })).toBeVisible()
  await expect(dialog.locator('th').filter({ hasText: drillUi.colInvoiceNo })).toBeVisible()
  await expect(dialog.locator('th').filter({ hasText: drillUi.colDate })).toBeVisible()
  await expect(dialog.locator('th').filter({ hasText: drillUi.colSeller })).toBeVisible()

  const bodyCell = dialog.locator('tbody td').first()
  await expect(bodyCell).toBeVisible({ timeout: 30_000 })
  const cellText = (await bodyCell.textContent()) ?? ''
  expect([drillUi.emptyRows, pagUi.tableLoading].some((s) => cellText.includes(s)) || cellText.trim().length > 0).toBeTruthy()
}

async function mockOverviewSummary(page: Page) {
  await page.route('**/api/dws/overview/summary**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        total_net_jshj: 0,
        invoice_cnt: 0,
        output_net_jshj: 0,
        input_net_jshj: 0,
        supplier_cnt: 0,
        quality_issue_cnt: 0,
        avg_quality_score: 0,
        red_cnt: 0,
        cancel_cnt: 0,
      }),
    })
  })
}

async function mockSupplierTopOneRow(page: Page) {
  await page.route('**/api/dws/supplier/top**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        rows: [
          {
            supplier_id: TEST_SELLER,
            supplier_name: '测试销方A',
            net_jshj: 400,
            invoice_cnt: 2,
            amount_rank: 1,
            amount_ratio: 0.7,
            cumulative_ratio: 0.7,
            is_new_supplier: true,
          },
        ],
        total: 1,
      }),
    })
  })
}

test.describe('Entity profile page', () => {
  test('loads shell and empty-state hint without entity', async ({ page }) => {
    await loginAsAdmin(page, '/?nav=entity_profile')

    await expect(page.getByRole('heading', { name: profileUi.pageTitle })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(profileUi.filterTitle)).toBeVisible()
    await expect(page.getByText(profileUi.pickEntityHint)).toBeVisible()
  })

  test('accepts entity_id and stat_year from URL params', async ({ page }) => {
    await loginAsAdmin(
      page,
      `/?nav=entity_profile&stat_year=${TEST_STAT_YEAR}&entity_id=${TEST_ENTITY}`,
    )

    await expect(page.getByText(profileUi.pageTitle)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(profileUi.pickEntityHint)).toHaveCount(0)
    await expect(page.getByText(profileUi.filterTitle)).toBeVisible()
  })

  test('navigates from supplier_top via entity profile link', async ({ page }) => {
    await loginAsAdmin(
      page,
      `/?nav=supplier_top&stat_year=${TEST_STAT_YEAR}&entity_id=${TEST_ENTITY}`,
    )

    await expect(page.getByText(dashUi.supplierTopTitle)).toBeVisible({ timeout: 15_000 })
    const profileLink = page.getByRole('button', { name: `${t.sidebar.entityProfile} →` })
    await expect(profileLink).toBeVisible({ timeout: 15_000 })
    await profileLink.click()
    await page.waitForLoadState('domcontentloaded')

    const url = new URL(page.url())
    expect(url.searchParams.get('nav')).toBe('entity_profile')
    expect(url.searchParams.get('entity_id')).toBe(TEST_ENTITY)
    expect(url.searchParams.get('stat_year')).toBe(TEST_STAT_YEAR)
    await expect(page.getByText(profileUi.pageTitle)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(profileUi.pickEntityHint)).toHaveCount(0)
  })
})

test.describe('Invoice detail drill panel', () => {
  test('opens from overview_summary KPI drill button', async ({ page }) => {
    await mockOverviewSummary(page)
    await loginAsAdmin(page, `/?nav=overview_summary&stat_year=${TEST_STAT_YEAR}`)

    await expect(page.getByText(dashUi.overviewSummaryTitle)).toBeVisible({ timeout: 15_000 })
    const drillBtn = page.getByRole('button', { name: drillUi.drillFromSummary })
    await expect(drillBtn).toBeEnabled({ timeout: 30_000 })
    await drillBtn.click()

    await assertDrillPanelShell(page, drillUi.drillFromSummary)

    await page.getByRole('button', { name: drillUi.closeBtn }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('opens from supplier_top row drill button', async ({ page }) => {
    await mockSupplierTopOneRow(page)
    await loginAsAdmin(
      page,
      `/?nav=supplier_top&stat_year=${TEST_STAT_YEAR}&entity_id=${TEST_ENTITY}`,
    )

    await expect(page.getByText(dashUi.supplierTopTitle)).toBeVisible({ timeout: 15_000 })
    const drillBtn = page.getByRole('button', { name: drillUi.drillFromSupplier })
    await expect(drillBtn).toBeVisible({ timeout: 30_000 })
    await drillBtn.click()

    await assertDrillPanelShell(page, drillUi.drillFromSupplier)
  })
})
