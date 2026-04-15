import type { PickedExcel } from '../components/UploadZone'
import { sheetNameMatchesTarget } from './formatPrecheckInvoice'

export type FileSheetCoverageDetail = {
  fileName: string
  ok: boolean
  error?: string
  allSheetNames: string[]
  /** 每个 yaml / sheet_mapping 类型 key → 该文件中命中的实际工作表标签名 */
  hitsByKey: Record<string, string[]>
  /** 无任何已知类型 key 能匹配的物理工作表名 */
  unmatchedInFile: string[]
}

export type AggregatedSheetCoverage = {
  perFile: FileSheetCoverageDetail[]
  /** 全局：类型 key → 出现过的实际工作表名（去重、按 zh 排序） */
  globalHitsByKey: Record<string, string[]>
  /** 未在已知类型中识别的物理表（含来源文件） */
  globalUnmatched: { file: string; sheet: string }[]
}

function sortZh(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN')
}

/**
 * 读取单个工作簿的全部工作表名，并按 `knownKeys`（与 sheet_mapping.yaml 一致的 key 列表）做包含匹配归类。
 * 匹配规则与 `sheetNameMatchesTarget` / 后端 `_match_target_sheet` 一致。
 */
export async function scanOneWorkbookSheetCoverage(
  file: File,
  knownKeys: string[],
): Promise<FileSheetCoverageDetail> {
  const keys = knownKeys.map((k) => String(k).trim()).filter(Boolean)
  const lower = file.name.toLowerCase()
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
    return {
      fileName: file.name,
      ok: false,
      error: '非 .xlsx / .xls，跳过工作表扫描',
      allSheetNames: [],
      hitsByKey: {},
      unmatchedInFile: [],
    }
  }

  let XLSX: typeof import('xlsx')
  try {
    XLSX = await import('xlsx')
  } catch {
    return {
      fileName: file.name,
      ok: false,
      error: '无法加载表格解析组件（xlsx）',
      allSheetNames: [],
      hitsByKey: {},
      unmatchedInFile: [],
    }
  }

  let wb: import('xlsx').WorkBook
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: 8 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      fileName: file.name,
      ok: false,
      error: `无法解析（${msg}）`,
      allSheetNames: [],
      hitsByKey: {},
      unmatchedInFile: [],
    }
  }

  const sheetNames = wb.SheetNames ?? []
  const hitsByKey: Record<string, string[]> = {}
  for (const k of keys) hitsByKey[k] = []

  const unmatchedInFile: string[] = []

  for (const sn of sheetNames) {
    const matched = keys.filter((k) => sheetNameMatchesTarget(sn, k))
    if (matched.length === 0) {
      unmatchedInFile.push(sn)
      continue
    }
    for (const k of matched) {
      const arr = hitsByKey[k] ?? (hitsByKey[k] = [])
      if (!arr.includes(sn)) arr.push(sn)
    }
  }

  for (const k of keys) hitsByKey[k].sort(sortZh)

  return {
    fileName: file.name,
    ok: true,
    allSheetNames: [...sheetNames],
    hitsByKey,
    unmatchedInFile: unmatchedInFile.sort(sortZh),
  }
}

/**
 * 对队列内全部 Excel 做工作表覆盖扫描并汇总（全局视角：类型 → 实际表名；未识别表按文件列出）。
 */
export async function aggregateSheetCoverage(
  queue: PickedExcel[],
  knownSheetKeys: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<AggregatedSheetCoverage> {
  const keys = knownSheetKeys.map((k) => String(k).trim()).filter(Boolean)
  const perFile: FileSheetCoverageDetail[] = []
  const total = queue.length

  for (let i = 0; i < total; i++) {
    perFile.push(await scanOneWorkbookSheetCoverage(queue[i]!.file, keys))
    onProgress?.(i + 1, total)
  }

  const globalSets: Record<string, Set<string>> = {}
  for (const k of keys) globalSets[k] = new Set()

  const globalUnmatched: { file: string; sheet: string }[] = []

  for (const d of perFile) {
    if (!d.ok) continue
    for (const [k, names] of Object.entries(d.hitsByKey)) {
      const s = globalSets[k]
      if (!s) continue
      for (const n of names) s.add(n)
    }
    for (const sn of d.unmatchedInFile) {
      globalUnmatched.push({ file: d.fileName, sheet: sn })
    }
  }

  globalUnmatched.sort((a, b) => {
    const c = a.file.localeCompare(b.file, 'zh-CN')
    if (c !== 0) return c
    return a.sheet.localeCompare(b.sheet, 'zh-CN')
  })

  const globalHitsByKey: Record<string, string[]> = {}
  for (const k of keys) {
    globalHitsByKey[k] = [...globalSets[k]!].sort(sortZh)
  }

  return { perFile, globalHitsByKey, globalUnmatched }
}
