import { expect, test, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const SNAPSHOT_YEAR = '2026'
const outDir = path.resolve('test-results/org-hier-detail-lock')

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
    code: `91370000${String(name.length).padStart(10, '0')}`.slice(0, 18),
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

function buildLongTree() {
  const children = []
  for (let i = 1; i <= 40; i += 1) {
    const name = `验证企业${String(i).padStart(2, '0')}有限公司`
    children.push({
      id: `node-leaf-${i}`,
      name,
      level: 2,
      parent_id: 'node-root',
      parent_name: '验证集团有限公司',
      children: [],
      registry: mockRegistry(name, {
        mgmtLevel: 2,
        mgmtParent: '验证集团有限公司',
        equityLevel: 2,
        shareholders: '验证集团有限公司,100%',
      }),
    })
  }
  return [
    {
      id: 'node-root',
      name: '验证集团有限公司',
      level: 1,
      parent_id: null,
      parent_name: '',
      children,
      registry: mockRegistry('验证集团有限公司'),
    },
  ]
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function mockApis(page: Page) {
  const treeNodes = buildLongTree()
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
    await fulfillJson(route, { ok: true })
  })
}

test.describe('org hier detail lock visual', () => {
  test('长树 + 矮视口：左栏滚到底，右侧节点详情仍可见', async ({ page }) => {
    fs.mkdirSync(outDir, { recursive: true })
    await page.addInitScript(() => {
      localStorage.setItem('il_session_token', 'e2e-test-token')
      localStorage.setItem('il_remember_session', '1')
    })
    await mockApis(page)
    await page.goto('/?nav=dim_org_hier_tree&tree_mode=equity')
    await expect(page.getByRole('heading', { name: '组织层级树' })).toBeVisible({ timeout: 15_000 })

    // 压矮双栏，模拟「节点很多需要滚动」
    await page.evaluate(() => {
      const tree = document.querySelector('[data-testid="org-hier-tree-panel"]')
      const grid = tree?.parentElement
      if (grid instanceof HTMLElement) {
        grid.style.height = '260px'
        grid.style.minHeight = '260px'
      }
    })

    const expandBtn = page.getByRole('button', { name: '展开全部' })
    if (await expandBtn.isVisible()) {
      await expandBtn.click()
    }

    const deep = page.locator('[data-org-tree-node="node-leaf-40"]')
    await expect(deep).toBeAttached({ timeout: 10_000 })
    await deep.click()

    const aside = page.getByTestId('org-hier-node-detail')
    await expect(aside.getByText('节点详情')).toBeVisible()
    await expect(aside.getByText('产权层级：', { exact: true })).toBeVisible()

    await page.screenshot({ path: path.join(outDir, '01-before-scroll.png') })

    const tree = page.getByTestId('org-hier-tree-panel')
    await tree.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    const metrics = await page.evaluate(() => {
      const treeEl = document.querySelector('[data-testid="org-hier-tree-panel"]')
      const asideEl = document.querySelector('[data-testid="org-hier-node-detail"]')
      const box = asideEl?.getBoundingClientRect()
      return {
        canScroll: (treeEl?.scrollHeight ?? 0) > (treeEl?.clientHeight ?? 0) + 8,
        scrollTop: treeEl?.scrollTop ?? 0,
        asideInViewport: Boolean(box && box.top < window.innerHeight && box.bottom > 0),
      }
    })

    await page.screenshot({ path: path.join(outDir, '02-after-scroll-bottom.png') })
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(metrics, null, 2), 'utf8')

    expect(metrics.canScroll, '左栏应可滚动（长树生效）').toBe(true)
    expect(metrics.scrollTop, '应已滚离顶部').toBeGreaterThan(20)
    expect(metrics.asideInViewport, '右侧详情应仍在视口内').toBe(true)
    await expect(aside.getByText('节点详情')).toBeInViewport()
    await expect(aside.getByText(/验证企业40/)).toBeInViewport()
  })
})
