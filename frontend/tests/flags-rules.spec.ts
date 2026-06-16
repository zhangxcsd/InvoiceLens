import { expect, test, type Page } from '@playwright/test'
import { zhCN as t } from '../src/copy/zh-CN'

const ui = t.auditRulesUi

async function loginAsAdmin(page: Page, pathWithQuery = '/?nav=flags_rules') {
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

function ruleTableRow(page: Page, ruleId: string) {
  return page.locator('tbody tr').filter({
    has: page.locator('td.font-mono', { hasText: ruleId }),
  })
}

test.describe('Flags rules page execution modes', () => {
  test('shows execution mode badges and sync rules card', async ({ page }) => {
    await loginAsAdmin(page)

    await expect(page.getByText(ui.pageTitle)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: ui.loadBtn })).toBeEnabled({ timeout: 60_000 })
    await expect(ruleTableRow(page, 'RULE-01')).toBeVisible({ timeout: 30_000 })

    await expect(page.locator('th').filter({ hasText: ui.colExecutionMode })).toBeVisible()
    await expect(page.locator('th').filter({ hasText: ui.colTriggerHint })).toBeVisible()

    await expect(ruleTableRow(page, 'RULE-01')).toContainText(ui.executionModeSqlScan)
    await expect(ruleTableRow(page, 'RULE-SHELL')).toContainText(ui.executionModePostScan)
    await expect(ruleTableRow(page, 'RULE-FIN-DIFF')).toContainText(ui.executionModeSync)

    await expect(page.getByText(ui.syncCardTitle)).toBeVisible()

    for (const ruleId of ['RULE-FIN-DIFF', 'RULE-TAX-DEV'] as const) {
      const inTable = (await ruleTableRow(page, ruleId).count()) > 0
      if (inTable) {
        await expect(page.locator('li').filter({ hasText: ruleId })).toBeVisible()
      }
    }
  })
})
