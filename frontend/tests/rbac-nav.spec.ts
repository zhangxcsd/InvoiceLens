import { expect, test } from '@playwright/test'
import { zhCN as t } from '../src/copy/zh-CN'

const VIEWER_USER = 'viewer_pw_test'
const VIEWER_PASS = 'pass1234'

test.describe('RBAC sidebar nav', () => {
  test.beforeAll(async ({ request }) => {
    const loginRes = await request.post('http://127.0.0.1:8776/api/auth/login', {
      data: { username: '', password: '' },
    })
    expect(loginRes.ok()).toBeTruthy()
    const loginJson = (await loginRes.json()) as { token?: string }
    const token = String(loginJson.token ?? '')
    expect(token.length).toBeGreaterThan(0)

    const createRes = await request.post('http://127.0.0.1:8776/api/users', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        username: VIEWER_USER,
        display_name: 'Playwright查看者',
        role: 'viewer',
        password: VIEWER_PASS,
        actor: 'admin',
      },
    })
    if (!createRes.ok()) {
      const body = await createRes.json().catch(() => ({}))
      const msg = String((body as { error?: { message?: string } })?.error?.message ?? '')
      expect(msg).toContain('已存在')
    }
  })

  test('viewer cannot see admin-only sidebar items', async ({ page }) => {
    await page.goto('/')
    await page.getByPlaceholder(t.login.accountPlaceholder).fill(VIEWER_USER)
    await page.getByPlaceholder(t.login.passwordPlaceholder).fill(VIEWER_PASS)
    await page.getByRole('button', { name: t.login.submit, exact: true }).click()
    await page.waitForLoadState('domcontentloaded')

    await expect(page.getByText(t.sidebar.users, { exact: true })).toHaveCount(0)
    await expect(page.getByText(t.sidebar.settingsLicense, { exact: true })).toHaveCount(0)
    await expect(page.getByText(t.sidebar.odsToDwd, { exact: true })).toHaveCount(0)
  })

  test('viewer scan trigger is disabled on flags list', async ({ page }) => {
    await page.goto('/?nav=flags_list')
    await page.getByPlaceholder(t.login.accountPlaceholder).fill(VIEWER_USER)
    await page.getByPlaceholder(t.login.passwordPlaceholder).fill(VIEWER_PASS)
    await page.getByRole('button', { name: t.login.submit, exact: true }).click()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByText(t.auditFlagUi.pageTitle)).toBeVisible()
    const scanBtn = page.getByRole('button', { name: t.auditFlagUi.scanBtn, exact: true })
    await expect(scanBtn).toBeDisabled()
    await expect(scanBtn).toHaveAttribute('title', t.rbac.writeDisabledHint)
  })
})
