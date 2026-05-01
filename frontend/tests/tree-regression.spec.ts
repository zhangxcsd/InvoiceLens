import { expect, test, type Page } from '@playwright/test'

type Row = {
  taxCode: string
  goodsName: string
  goodsShortName: string
  description: string
  parentCode: string | null
  levelDepth: number
  isLeaf: boolean
  fullPath: string
  cleanStatus: string
  auditRiskLabel: 'NORMAL' | 'HIGH'
  dataVersion: string
  importBatchId: string
  importSessionId: string
  sourceSheet: string
  sourceExcelFile: string
}

const BATCH = 'BATCH_DIM_TAX_20260423_123a6207'
const SESSION = 'SID_DIM_fa08cf4735'

const rows: Row[] = [
  {
    taxCode: '1000000000000000000',
    goodsName: '货物',
    goodsShortName: '货物',
    description: '',
    parentCode: null,
    levelDepth: 1,
    isLeaf: false,
    fullPath: '货物',
    cleanStatus: '',
    auditRiskLabel: 'NORMAL',
    dataVersion: '税务总局20171218',
    importBatchId: BATCH,
    importSessionId: SESSION,
    sourceSheet: 'sheet',
    sourceExcelFile: 'mock.xlsx',
  },
  {
    taxCode: '1010000000000000000',
    goodsName: '农、林、牧、渔业类产品',
    goodsShortName: '农产品',
    description: '',
    parentCode: '1000000000000000000',
    levelDepth: 2,
    isLeaf: false,
    fullPath: '货物/农、林、牧、渔业类产品',
    cleanStatus: '',
    auditRiskLabel: 'NORMAL',
    dataVersion: '税务总局20171218',
    importBatchId: BATCH,
    importSessionId: SESSION,
    sourceSheet: 'sheet',
    sourceExcelFile: 'mock.xlsx',
  },
  {
    taxCode: '1010100000000000000',
    goodsName: '农业产品',
    goodsShortName: '农业产品',
    description: '',
    parentCode: '1010000000000000000',
    levelDepth: 3,
    isLeaf: false,
    fullPath: '货物/农、林、牧、渔业类产品/农业产品',
    cleanStatus: '',
    auditRiskLabel: 'NORMAL',
    dataVersion: '税务总局20171218',
    importBatchId: BATCH,
    importSessionId: SESSION,
    sourceSheet: 'sheet',
    sourceExcelFile: 'mock.xlsx',
  },
  {
    taxCode: '1010101000000000000',
    goodsName: '谷物',
    goodsShortName: '谷物',
    description: '包含稻谷、小麦',
    parentCode: '1010100000000000000',
    levelDepth: 4,
    isLeaf: false,
    fullPath: '货物/农、林、牧、渔业类产品/农业产品/谷物',
    cleanStatus: '',
    auditRiskLabel: 'HIGH',
    dataVersion: '税务总局20171218',
    importBatchId: BATCH,
    importSessionId: SESSION,
    sourceSheet: 'sheet',
    sourceExcelFile: 'mock.xlsx',
  },
  {
    taxCode: '1010101010000000000',
    goodsName: '稻谷',
    goodsShortName: '谷物',
    description: '',
    parentCode: '1010101000000000000',
    levelDepth: 5,
    isLeaf: true,
    fullPath: '货物/农、林、牧、渔业类产品/农业产品/谷物/稻谷',
    cleanStatus: '',
    auditRiskLabel: 'HIGH',
    dataVersion: '税务总局20171218',
    importBatchId: BATCH,
    importSessionId: SESSION,
    sourceSheet: 'sheet',
    sourceExcelFile: 'mock.xlsx',
  },
]

async function bootTaxTreePage(page: Page) {
  let latestRowsQuery = ''

  await page.addInitScript(() => {
    // 与 App.readStoredUser 一致：username/displayName/role 均须非空，否则停留在登录页
    localStorage.setItem(
      'invoicelens.demoUser',
      JSON.stringify({ username: 'e2e', displayName: '管理员', role: '管理员' }),
    )
  })

  await page.route('**/api/dim-tax-code/filter-options**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        importBatchOptions: [BATCH],
        importSessionOptions: [SESSION],
      }),
    })
  })

  await page.route('**/api/dim-tax-code/rows**', async (route) => {
    const url = new URL(route.request().url())
    latestRowsQuery = url.search
    const risk = (url.searchParams.get('risk') || 'all').toUpperCase()
    const riskFiltered = risk === 'HIGH' ? rows.filter((r) => r.auditRiskLabel === 'HIGH') : rows
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        total: riskFiltered.length,
        rows: riskFiltered,
      }),
    })
  })

  // 直接进入结果页，避免侧栏层级文案/展开状态变化导致用例脆弱
  await page.goto('/?nav=dim_tax_result')
  await expect(page.getByRole('heading', { name: '税收分类层级树' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开全部' }).first()).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(200)
  return {
    latestRowsQuery: () => latestRowsQuery,
  }
}

test.describe('tree screenshot regression', () => {
  test('产品树：展开全部后层级线稳定', async ({ page }) => {
    await bootTaxTreePage(page)

    const levelInput = page.locator('input[type="number"]').first()
    await expect(levelInput).toHaveValue('1')
    await page.getByRole('button', { name: '展开全部' }).click()
    await expect(levelInput).toHaveValue('5')

    const connectorCount = await page.getByTestId('tree-connector-v').count()
    expect(connectorCount).toBeGreaterThan(0)

    const treeCard = page.getByTestId('tax-tree-panel')
    await expect(treeCard).toBeVisible()
    await expect(treeCard).toHaveScreenshot('tree-code-expand-all.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.05,
      timeout: 15_000,
    })
  })

  test('分类树：列对齐与连线稳定', async ({ page }) => {
    await bootTaxTreePage(page)

    await page.getByRole('button', { name: '按商品和服务分类' }).click()
    await page.getByRole('button', { name: '展开全部' }).click()
    const levelInput = page.locator('input[type="number"]').first()
    const maxDepth = await levelInput.getAttribute('max')
    await expect(levelInput).toHaveValue(maxDepth ?? '1')

    const treeCard = page.getByTestId('tax-tree-panel')
    await expect(treeCard).toBeVisible()
    await expect(treeCard).toHaveScreenshot('tree-category-expand-all.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.05,
      timeout: 15_000,
    })
  })

  /**
   * 「税收分类层级树」结果页（mode=result）固定为树形视图，不再有「列表视图」切换；
   * 敏感类目通过筛选区「仅看敏感类目」驱动 risk=HIGH 请求。
   */
  test('敏感类目筛选：展开后层级线稳定', async ({ page }) => {
    const ctx = await bootTaxTreePage(page)

    await page.getByText('仅看敏感类目').click()
    await expect.poll(() => ctx.latestRowsQuery().includes('risk=HIGH')).toBeTruthy()

    await page.getByRole('button', { name: '展开全部' }).click()
    const levelInput = page.locator('input[type="number"]').first()
    const maxDepth = await levelInput.getAttribute('max')
    await expect(levelInput).toHaveValue(maxDepth ?? '1')

    const connectorCount = await page.getByTestId('tree-connector-v').count()
    expect(connectorCount).toBeGreaterThan(0)

    const treeCard = page.getByTestId('tax-tree-panel')
    await expect(treeCard).toBeVisible()
    await expect(treeCard).toHaveScreenshot('tree-high-risk-expand.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.05,
      timeout: 15_000,
    })
  })
})

