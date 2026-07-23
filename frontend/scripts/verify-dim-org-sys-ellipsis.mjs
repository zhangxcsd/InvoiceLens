import { chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../test-results/dim-org-sys-verify')
fs.mkdirSync(outDir, { recursive: true })

async function login(page) {
  await page.goto('http://127.0.0.1:5173/?nav=dim_org_sys', { waitUntil: 'domcontentloaded' })
  const quick = page.getByRole('button', { name: /演示免填登录|一键登录|演示/ })
  if (await quick.count()) {
    try {
      await quick.first().click({ timeout: 2000 })
      await page.waitForTimeout(800)
    } catch {}
  }
  if (page.url().includes('login') || (await page.getByPlaceholder(/账号|用户名|账户/).count())) {
    const user = page.getByPlaceholder(/账号|用户名|账户/).first()
    const pass = page.getByPlaceholder(/密码/).first()
    if (await user.count()) {
      await user.fill('admin')
      await pass.fill('admin')
      await page.getByRole('button', { name: /登录|登 录|提交/ }).first().click()
      await page.waitForTimeout(1000)
    }
  }
  if (!page.url().includes('nav=dim_org_sys')) {
    await page.goto('http://127.0.0.1:5173/?nav=dim_org_sys', { waitUntil: 'networkidle' })
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await login(page)
  await page.waitForTimeout(1500)

  // Ensure data exists: try bootstrap if empty
  const emptyHint = page.getByText(/暂无监管体系|空/)
  const bootstrap = page.getByRole('button', { name: /灌入演示|演示数据|bootstrap/i })
  const tableReady = await page.locator('table tbody tr').count()
  if (tableReady === 0 && (await bootstrap.count())) {
    await bootstrap.first().click()
    await page.waitForTimeout(2000)
  }

  // Wait for FIN_XX or any data row
  await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {})

  const metrics = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'))
    const result = {
      rowCount: rows.length,
      rows: [],
      finRow: null,
      firstRow: null,
      zebraOk: false,
      actionWrapOk: false,
      pyOk: false,
      narrowPass: null,
    }

    function measureRow(tr, label) {
      if (!tr) return null
      const tds = Array.from(tr.querySelectorAll('td'))
      const descTd = tds[4]
      const actionTd = tds[tds.length - 1]
      const ell = descTd?.querySelector('.il-table-ellipsis')
      const cs = ell ? getComputedStyle(ell) : null
      const tdCs = descTd ? getComputedStyle(descTd) : null
      const actionDiv = actionTd?.querySelector('div')
      const actionCs = actionDiv ? getComputedStyle(actionDiv) : null
      const bg = getComputedStyle(tr).backgroundColor
      return {
        label,
        sysId: tds[0]?.innerText?.trim() ?? '',
        rowHeight: Math.round(tr.getBoundingClientRect().height * 100) / 100,
        descClientHeight: descTd ? Math.round(descTd.getBoundingClientRect().height * 100) / 100 : null,
        whiteSpace: cs?.whiteSpace ?? null,
        textOverflow: cs?.textOverflow ?? null,
        overflow: cs?.overflow ?? null,
        wordBreak: cs?.wordBreak ?? null,
        clientWidth: ell?.clientWidth ?? null,
        scrollWidth: ell?.scrollWidth ?? null,
        isTruncated: ell ? ell.scrollWidth > ell.clientWidth + 1 : null,
        title: descTd?.getAttribute('title') ?? null,
        titleLen: (descTd?.getAttribute('title') ?? '').length,
        visibleText: ell?.textContent ?? '',
        paddingTop: tdCs?.paddingTop ?? null,
        paddingBottom: tdCs?.paddingBottom ?? null,
        bg,
        actionWhiteSpace: actionCs?.whiteSpace ?? null,
        actionFlexWrap: actionCs?.flexWrap ?? null,
        actionHeight: actionTd ? Math.round(actionTd.getBoundingClientRect().height * 100) / 100 : null,
        descLineCount: ell
          ? Math.round(ell.scrollHeight / (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) || 16))
          : null,
      }
    }

    result.firstRow = measureRow(rows[0], 'first')
    const fin = rows.find((r) => (r.querySelector('td')?.innerText || '').includes('FIN_XX'))
    result.finRow = measureRow(fin, 'FIN_XX')
    result.rows = rows.slice(0, 6).map((r, i) => measureRow(r, `row${i}`))

    // zebra: odd idx should not be pure white
    if (rows.length >= 2) {
      const bg0 = getComputedStyle(rows[0]).backgroundColor
      const bg1 = getComputedStyle(rows[1]).backgroundColor
      result.zebraOk = bg0 !== bg1
      result.zebra = { bg0, bg1 }
    }

    if (result.firstRow) {
      const pt = parseFloat(result.firstRow.paddingTop || '0')
      const pb = parseFloat(result.firstRow.paddingBottom || '0')
      result.pyOk = pt >= 10 && pt <= 14 && pb >= 10 && pb <= 14 // py-3 = 12px
      result.actionWrapOk =
        result.firstRow.actionWhiteSpace === 'nowrap' && result.firstRow.actionFlexWrap === 'nowrap'
    }
    return result
  })

  // Narrow description column and re-measure
  const narrow = await page.evaluate(() => {
    const col = document.querySelector('table colgroup col:nth-child(5)')
    if (col) col.style.width = '8%'
    const table = document.querySelector('table')
    // force reflow
    void table?.offsetWidth
    const rows = Array.from(document.querySelectorAll('table tbody tr'))
    const fin = rows.find((r) => (r.querySelector('td')?.innerText || '').includes('FIN_XX')) || rows[0]
    if (!fin) return null
    const tds = Array.from(fin.querySelectorAll('td'))
    const descTd = tds[4]
    const ell = descTd?.querySelector('.il-table-ellipsis')
    const cs = ell ? getComputedStyle(ell) : null
    const heights = rows.slice(0, Math.min(rows.length, 5)).map((r) =>
      Math.round(r.getBoundingClientRect().height * 100) / 100,
    )
    return {
      whiteSpace: cs?.whiteSpace ?? null,
      textOverflow: cs?.textOverflow ?? null,
      clientWidth: ell?.clientWidth ?? null,
      scrollWidth: ell?.scrollWidth ?? null,
      isTruncated: ell ? ell.scrollWidth > ell.clientWidth + 1 : null,
      rowHeight: Math.round(fin.getBoundingClientRect().height * 100) / 100,
      heights,
      heightsEqual: heights.every((h) => Math.abs(h - heights[0]) < 1.5),
      title: descTd?.getAttribute('title') ?? null,
      sysId: tds[0]?.innerText?.trim() ?? '',
    }
  })

  metrics.narrowPass = narrow

  const shot1 = path.join(outDir, 'dim-org-sys-table.png')
  const shot2 = path.join(outDir, 'dim-org-sys-narrow.png')
  await page.locator('table').first().screenshot({ path: shot1 })
  await page.screenshot({ path: shot2, fullPage: false })

  const reportPath = path.join(outDir, 'metrics.json')
  fs.writeFileSync(reportPath, JSON.stringify({ metrics, screenshots: { shot1, shot2 } }, null, 2), 'utf8')
  console.log(JSON.stringify({ metrics, screenshots: { shot1, shot2 } }, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
