/**
 * 核验 DimOrgSysPage 表头拖拽调列宽 + 说明列单行省略随列宽变化。
 * 只读业务页，不改业务代码。
 */
import { chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../test-results/dim-org-sys-col-resize')
const STORAGE_KEY = 'il.dimOrgSys.colWidths.v1'
const DESC_COL_INDEX = 4 // 0-based: 说明列

fs.mkdirSync(outDir, { recursive: true })

async function login(page) {
  await page.goto('http://127.0.0.1:5173/?nav=dim_org_sys', {
    waitUntil: 'domcontentloaded',
  })
  const quick = page.getByRole('button', { name: /演示免填登录|一键登录|演示/ })
  if (await quick.count()) {
    try {
      await quick.first().click({ timeout: 2000 })
      await page.waitForTimeout(800)
    } catch {
      /* ignore */
    }
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
  // 硬刷新避开缓存
  await page.reload({ waitUntil: 'networkidle' })
}

function measurePage(descColIndex) {
  const rows = Array.from(document.querySelectorAll('table tbody tr'))
  const handles = Array.from(document.querySelectorAll('.il-col-resize-handle'))
  const cols = Array.from(document.querySelectorAll('table colgroup col'))
  const ths = Array.from(document.querySelectorAll('table thead th'))

  function measureFin() {
    const fin =
      rows.find((r) => (r.querySelector('td')?.innerText || '').includes('FIN_XX')) || rows[0]
    if (!fin) return null
    const tds = Array.from(fin.querySelectorAll('td'))
    const descTd = tds[descColIndex]
    const actionTd = tds[tds.length - 1]
    const ell = descTd?.querySelector('.il-table-ellipsis')
    const cs = ell ? getComputedStyle(ell) : null
    const actionDiv = actionTd?.querySelector('div')
    const actionCs = actionDiv ? getComputedStyle(actionDiv) : null
    const lineH = parseFloat(cs?.lineHeight) || parseFloat(cs?.fontSize) || 16
    return {
      sysId: tds[0]?.innerText?.trim() ?? '',
      rowHeight: Math.round(fin.getBoundingClientRect().height * 100) / 100,
      descTdWidth: descTd ? Math.round(descTd.getBoundingClientRect().width * 100) / 100 : null,
      colStyleWidth: cols[descColIndex]
        ? parseFloat(String(cols[descColIndex].style.width || '0'))
        : null,
      whiteSpace: cs?.whiteSpace ?? null,
      textOverflow: cs?.textOverflow ?? null,
      overflow: cs?.overflow ?? null,
      clientWidth: ell?.clientWidth ?? null,
      scrollWidth: ell?.scrollWidth ?? null,
      isTruncated: ell ? ell.scrollWidth > ell.clientWidth + 1 : null,
      visibleText: ell?.textContent ?? '',
      visibleLen: (ell?.textContent ?? '').length,
      descLineCount: ell ? Math.round(ell.scrollHeight / lineH) : null,
      actionWhiteSpace: actionCs?.whiteSpace ?? null,
      actionFlexWrap: actionCs?.flexWrap ?? null,
      actionHeight: actionTd
        ? Math.round(actionTd.getBoundingClientRect().height * 100) / 100
        : null,
    }
  }

  const heights = rows.slice(0, Math.min(rows.length, 6)).map((r) => {
    return Math.round(r.getBoundingClientRect().height * 100) / 100
  })

  let zebraOk = false
  let zebra = null
  if (rows.length >= 2) {
    const bg0 = getComputedStyle(rows[0]).backgroundColor
    const bg1 = getComputedStyle(rows[1]).backgroundColor
    zebraOk = bg0 !== bg1
    zebra = { bg0, bg1 }
  }

  let storage = null
  try {
    storage = localStorage.getItem('il.dimOrgSys.colWidths.v1')
  } catch {
    storage = null
  }

  return {
    handleCount: handles.length,
    thCount: ths.length,
    colCount: cols.length,
    rowCount: rows.length,
    handleOnNonLast:
      handles.length === Math.max(0, ths.length - 1) &&
      !ths[ths.length - 1]?.querySelector('.il-col-resize-handle'),
    descriptionHandleExists: Boolean(
      ths[descColIndex]?.querySelector('.il-col-resize-handle'),
    ),
    fin: measureFin(),
    heights,
    heightsConsistent: heights.length
      ? heights.every((h) => Math.abs(h - heights[0]) < 2)
      : false,
    zebraOk,
    zebra,
    storageRaw: storage,
    storageParsed: storage ? JSON.parse(storage) : null,
  }
}

/**
 * 下一列 sticky th 会盖住手柄右半（right:-3px 外伸部分），
 * 真实可点区域在手柄左侧约 3–4px。从该命中点起拖，避免中心点误点到下一列。
 */
async function dragDescHandle(page, deltaX) {
  const handle = page.locator('table thead th').nth(DESC_COL_INDEX).locator('.il-col-resize-handle')
  await handle.waitFor({ state: 'visible', timeout: 10000 })
  const hit = await page.evaluate((descIdx) => {
    const th = document.querySelectorAll('table thead th')[descIdx]
    const h = th?.querySelector('.il-col-resize-handle')
    if (!h) return null
    const r = h.getBoundingClientRect()
    const y = r.top + r.height / 2
    for (let dx = 0.5; dx < r.width; dx += 0.5) {
      const x = r.left + dx
      const el = document.elementFromPoint(x, y)
      if (el === h || el?.classList?.contains('il-col-resize-handle')) {
        return { x, y, hitWidthPx: dx, box: { left: r.left, width: r.width } }
      }
    }
    return { x: r.left + 1, y, hitWidthPx: 0, box: { left: r.left, width: r.width }, fallback: true }
  }, DESC_COL_INDEX)
  if (!hit) throw new Error('description resize handle not found')
  await page.mouse.move(hit.x, hit.y)
  await page.mouse.down()
  await page.mouse.move(hit.x + deltaX, hit.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  return hit
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  await login(page)
  // 仅首次进入后清列宽记忆，避免 addInitScript 在 reload 时把持久化清掉
  await page.evaluate((key) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }, STORAGE_KEY)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  const bootstrap = page.getByRole('button', { name: /灌入演示|演示数据|bootstrap/i })
  if ((await page.locator('table tbody tr').count()) === 0 && (await bootstrap.count())) {
    await bootstrap.first().click()
    await page.waitForTimeout(2000)
  }
  await page.waitForSelector('table tbody tr', { timeout: 20000 })

  const before = await page.evaluate(measurePage, DESC_COL_INDEX)
  await page.locator('table').first().screenshot({
    path: path.join(outDir, '01-before-resize.png'),
  })

  // 拖宽说明列：先 +80，若仍截断再补拖到足以解除截断
  await dragDescHandle(page, 80)
  let afterWiden = await page.evaluate(measurePage, DESC_COL_INDEX)
  if (afterWiden.fin?.isTruncated) {
    const need = Math.max(
      40,
      (afterWiden.fin.scrollWidth ?? 0) - (afterWiden.fin.clientWidth ?? 0) + 40,
    )
    await dragDescHandle(page, need)
    afterWiden = await page.evaluate(measurePage, DESC_COL_INDEX)
  }
  await page.locator('table').first().screenshot({
    path: path.join(outDir, '02-after-widen.png'),
  })

  // 拖窄说明列 -200px（相对当前）
  await dragDescHandle(page, -200)
  const afterNarrow = await page.evaluate(measurePage, DESC_COL_INDEX)
  await page.locator('table').first().screenshot({
    path: path.join(outDir, '03-after-narrow.png'),
  })
  await page.screenshot({
    path: path.join(outDir, '04-viewport-after-narrow.png'),
    fullPage: false,
  })

  // 刷新，检查 localStorage 持久化
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => {})
  const afterReload = await page.evaluate(measurePage, DESC_COL_INDEX)
  await page.locator('table').first().screenshot({
    path: path.join(outDir, '05-after-reload.png'),
  })

  const widthBefore = before.fin?.colStyleWidth ?? before.fin?.descTdWidth ?? 0
  const widthWiden = afterWiden.fin?.colStyleWidth ?? afterWiden.fin?.descTdWidth ?? 0
  const widthNarrow = afterNarrow.fin?.colStyleWidth ?? afterNarrow.fin?.descTdWidth ?? 0
  const deltaWiden = widthWiden - widthBefore
  const deltaNarrow = widthNarrow - widthWiden

  const checks = {
    c1_handleExists: before.descriptionHandleExists && before.handleOnNonLast,
    c1_widthDeltaWidenGte20: deltaWiden >= 20,
    c2_widenMoreVisibleOrUntruncated:
      (before.fin?.isTruncated === true && afterWiden.fin?.isTruncated === false) ||
      ((afterWiden.fin?.clientWidth ?? 0) - (before.fin?.clientWidth ?? 0) >= 20),
    c2_narrowNowrap: afterNarrow.fin?.whiteSpace === 'nowrap',
    c2_narrowSingleLine: (afterNarrow.fin?.descLineCount ?? 99) <= 1,
    c2_narrowHeightConsistent: afterNarrow.heightsConsistent,
    c2_narrowTruncated:
      afterNarrow.fin?.isTruncated === true &&
      (afterNarrow.fin?.scrollWidth ?? 0) > (afterNarrow.fin?.clientWidth ?? 0),
    c3_storageAfterDrag:
      Boolean(afterNarrow.storageParsed) &&
      typeof afterNarrow.storageParsed?.description === 'number',
    c3_storageSurvivesReload:
      Boolean(afterReload.storageParsed) &&
      typeof afterReload.storageParsed?.description === 'number' &&
      Math.abs(
        (afterReload.storageParsed?.description ?? 0) -
          (afterNarrow.storageParsed?.description ?? -1),
      ) < 1,
    c4_zebra: afterNarrow.zebraOk === true,
    c4_descNoWrap2Lines: (afterNarrow.fin?.descLineCount ?? 99) <= 1,
    c4_actionNoWrap:
      afterNarrow.fin?.actionWhiteSpace === 'nowrap' &&
      afterNarrow.fin?.actionFlexWrap === 'nowrap',
  }

  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k)
  const pass = failed.length === 0

  const report = {
    conclusion: pass ? 'PASS' : 'FAIL',
    failedChecks: failed,
    checks,
    widths: {
      before: widthBefore,
      afterWiden: widthWiden,
      afterNarrow: widthNarrow,
      deltaWiden,
      deltaNarrow,
    },
    truncation: {
      before: {
        isTruncated: before.fin?.isTruncated,
        clientWidth: before.fin?.clientWidth,
        scrollWidth: before.fin?.scrollWidth,
        visibleLen: before.fin?.visibleLen,
      },
      afterWiden: {
        isTruncated: afterWiden.fin?.isTruncated,
        clientWidth: afterWiden.fin?.clientWidth,
        scrollWidth: afterWiden.fin?.scrollWidth,
        visibleLen: afterWiden.fin?.visibleLen,
      },
      afterNarrow: {
        isTruncated: afterNarrow.fin?.isTruncated,
        clientWidth: afterNarrow.fin?.clientWidth,
        scrollWidth: afterNarrow.fin?.scrollWidth,
        visibleLen: afterNarrow.fin?.visibleLen,
        whiteSpace: afterNarrow.fin?.whiteSpace,
        descLineCount: afterNarrow.fin?.descLineCount,
      },
    },
    rowHeights: {
      before: before.fin?.rowHeight,
      afterWiden: afterWiden.fin?.rowHeight,
      afterNarrow: afterNarrow.fin?.rowHeight,
      actionHeightNarrow: afterNarrow.fin?.actionHeight,
      heightsNarrow: afterNarrow.heights,
    },
    localStorage: {
      afterNarrow: afterNarrow.storageParsed,
      afterReload: afterReload.storageParsed,
      rawAfterNarrow: afterNarrow.storageRaw,
    },
    handles: {
      count: before.handleCount,
      thCount: before.thCount,
      onNonLast: before.handleOnNonLast,
      descriptionExists: before.descriptionHandleExists,
      note: 'handle center may be covered by next sticky th; drag uses left hittable px',
    },
    zebra: afterNarrow.zebra,
    screenshots: {
      before: path.join(outDir, '01-before-resize.png'),
      widen: path.join(outDir, '02-after-widen.png'),
      narrow: path.join(outDir, '03-after-narrow.png'),
      viewport: path.join(outDir, '04-viewport-after-narrow.png'),
      reload: path.join(outDir, '05-after-reload.png'),
    },
    finSysId: before.fin?.sysId ?? afterNarrow.fin?.sysId,
  }

  const reportPath = path.join(outDir, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  process.exit(pass ? 0 : 2)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
