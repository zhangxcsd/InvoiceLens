import { expect, test, type Page, type Route } from '@playwright/test'

const SNAPSHOT_YEAR = '2026'

const mockAuthUser = {
  username: 'e2e',
  display_name: '管理员',
  role: 'admin',
  role_label: '管理员',
  enabled: true,
}

function mockRegistry(name: string, overrides: Record<string, unknown> = {}) {
  return {
    rowId: `row-${name}`,
    snapshotYear: SNAPSHOT_YEAR,
    code: '91370000000000000A',
    name,
    domesticOverseas: '境内',
    detailAddress: '',
    currency: 'CNY',
    registeredCapital: '1000',
    registrationDate: '2000-01-01',
    nationalEconomyIndustryMajor: '',
    enterpriseCategory: '国有独资',
    sasacAuthority: '',
    sasacRelation: '',
    consolidatedReporting: '是',
    listedCompany: '否',
    mainBusiness: '能源',
    stateInvestor: '山东能源',
    mgmtLevel: 1,
    mgmtParent: '',
    equityLevel: 1,
    shareholders: '',
    ...overrides,
  }
}

const treeNodes = [
  {
    id: 'node-root',
    name: '山东能源集团',
    level: 1,
    parent_id: null,
    parent_name: '',
    children: [
      {
        id: 'node-child',
        name: '能源子公司A',
        level: 2,
        parent_id: 'node-root',
        parent_name: '山东能源集团',
        children: [],
        registry: mockRegistry('能源子公司A', {
          mgmtLevel: 2,
          mgmtParent: '山东能源集团',
          equityLevel: 2,
          shareholders: '山东能源集团,100%',
        }),
      },
    ],
    registry: mockRegistry('山东能源集团'),
  },
]

const longPath =
  '山东能源集团/能源子公司A/能源孙公司B/能源曾孙公司C/更深的层级D/继续延伸的路径节点E'

const relationRows = [
  {
    name: '能源子公司A',
    code: '91370000000000000B',
    snapshot_year: SNAPSHOT_YEAR,
    state_investor_enterprise: '山东能源',
    mgmt_path: longPath,
    equity_path: longPath,
    relation_type: '一致',
    entity_id: 'ent-a',
    role_label: '购方',
    invoice_count: 12,
    match_status: '已匹配',
    in_roster: true,
    in_analysis_pool: true,
  },
]

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function mockOrgHierApis(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/api/auth/me')) {
      await fulfillJson(route, { ok: true, user: mockAuthUser })
      return
    }
    if (url.includes('/api/auth/login')) {
      await fulfillJson(route, { ok: true, token: 'e2e-test-token', user: mockAuthUser })
      return
    }
    if (url.includes('/api/settings/license')) {
      await fulfillJson(route, {
        ok: true,
        license: { status: 'valid', edition: 'demo', expires_at: null },
      })
      return
    }
    if (url.includes('/api/dim/audited-enterprise/relation-tree')) {
      await fulfillJson(route, {
        ok: true,
        snapshot_years: [SNAPSHOT_YEAR],
        selected_year: SNAPSHOT_YEAR,
        nodes: treeNodes,
      })
      return
    }
    if (url.includes('/api/dim/audited-enterprise/relation-rows')) {
      await fulfillJson(route, {
        ok: true,
        snapshot_years: [SNAPSHOT_YEAR],
        selected_year: SNAPSHOT_YEAR,
        total: relationRows.length,
        page: 1,
        page_size: 50,
        rows: relationRows,
        kpis: {
          total: 1,
          relation_mismatch: 0,
          mapped: 1,
          unmapped: 0,
          in_analysis_pool: 1,
        },
      })
      return
    }
    await fulfillJson(route, { ok: true })
  })
}

async function bootOrgHierTreePage(page: Page, treeMode: 'management' | 'equity' | 'relation' = 'management') {
  await page.addInitScript(() => {
    localStorage.setItem('il_session_token', 'e2e-test-token')
    localStorage.setItem('il_remember_session', '1')
  })

  await mockOrgHierApis(page)

  await page.goto(`/?nav=dim_org_hier_tree&tree_mode=${treeMode}`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('heading', { name: '组织层级树' })).toBeVisible({ timeout: 15_000 })
}

test.describe('org hier tree interactions', () => {
  test('Ctrl+F 聚焦企业筛选输入框', async ({ page }) => {
    await bootOrgHierTreePage(page, 'management')
    await expect(page.getByTestId('org-hier-tree-panel')).toBeVisible()

    await page.keyboard.press('Control+f')
    const input = page.getByTestId('org-tree-enterprise-filter')
    await expect(input).toBeFocused()
  })

  test('树键盘 Enter 切换到管产对照', async ({ page }) => {
    await bootOrgHierTreePage(page, 'management')
    await expect(page.locator('[data-org-tree-node="node-root"]')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('org-hier-tree-panel').click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('org-relation-table-grid')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: '管产对照' })).toHaveClass(/text-accent/)
  })

  test('管产对照 Space 展开路径、双击打开组织树', async ({ page }) => {
    await bootOrgHierTreePage(page, 'relation')
    const grid = page.getByTestId('org-relation-table-grid')
    await expect(grid).toBeVisible({ timeout: 15_000 })

    const row = page.locator('[data-relation-row]').first()
    await expect(row).toBeVisible()
    await row.click()
    await expect(row).toHaveAttribute('data-relation-path-expanded', 'false')

    await grid.click()
    await page.keyboard.press('Space')
    await expect(row).toHaveAttribute('data-relation-path-expanded', 'true')

    await page.keyboard.press('Space')
    await expect(row).toHaveAttribute('data-relation-path-expanded', 'false')

    await row.dblclick()
    await expect(page.getByTestId('org-hier-tree-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('org-tree-enterprise-filter')).toHaveValue('能源子公司A')
  })

  test('产权层级树：无悬停摘要，详情侧栏字段统一', async ({ page }) => {
    await bootOrgHierTreePage(page, 'equity')
    const child = page.locator('[data-org-tree-node="node-child"]')
    await expect(child).toBeVisible({ timeout: 15_000 })

    await child.hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(page.getByText('节点摘要')).toHaveCount(0)
    await expect(page.getByText('台账摘要')).toHaveCount(0)

    await child.click()
    const aside = page.getByTestId('org-hier-node-detail')
    await expect(aside.getByText('节点详情')).toBeVisible()
    await expect(aside.getByText('产权层级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('产权上级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('管理层级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('管理上级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('国家出资企业：', { exact: true })).toBeVisible()
    await expect(aside.getByText('企业类别：', { exact: true })).toBeVisible()
    await expect(aside.getByText('主营业务：', { exact: true })).toBeVisible()
    await expect(aside.getByText('层级：', { exact: true })).toHaveCount(0)
    await expect(aside.getByText('上级节点：', { exact: true })).toHaveCount(0)
    await expect(aside.getByText('2级').first()).toBeVisible()
    await expect(aside.getByText(/国家出资企业：\s*山东能源/)).toBeVisible()
    await expect(aside.getByText(/企业类别：\s*国有独资/)).toBeVisible()
    await expect(aside.getByText(/主营业务：\s*能源/)).toBeVisible()

    // 详情栏与树同高锁视口：树内滚动时详情仍在视口内
    const tree = page.getByTestId('org-hier-tree-panel')
    await tree.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(aside.getByText('节点详情')).toBeInViewport()
  })

  test('管理层级树：无悬停摘要，详情侧栏字段统一', async ({ page }) => {
    await bootOrgHierTreePage(page, 'management')
    const child = page.locator('[data-org-tree-node="node-child"]')
    await expect(child).toBeVisible({ timeout: 15_000 })

    await child.hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(page.getByText('节点摘要')).toHaveCount(0)
    await expect(page.getByText('台账摘要')).toHaveCount(0)

    await child.click()
    const aside = page.getByTestId('org-hier-node-detail')
    await expect(aside.getByText('节点详情')).toBeVisible()
    await expect(aside.getByText('管理层级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('管理上级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('产权层级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('产权上级：', { exact: true })).toBeVisible()
    await expect(aside.getByText('国家出资企业：', { exact: true })).toBeVisible()
    await expect(aside.getByText('企业类别：', { exact: true })).toBeVisible()
    await expect(aside.getByText('主营业务：', { exact: true })).toBeVisible()
    await expect(aside.getByText('层级：', { exact: true })).toHaveCount(0)
    await expect(aside.getByText('上级节点：', { exact: true })).toHaveCount(0)
    await expect(aside.getByText('2级').first()).toBeVisible()
    await expect(aside.getByText('管理上级：山东能源集团', { exact: true })).toBeVisible()
    await expect(aside.getByText(/国家出资企业：\s*山东能源/)).toBeVisible()

    const tree = page.getByTestId('org-hier-tree-panel')
    await tree.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(aside.getByText('节点详情')).toBeInViewport()
  })
})
