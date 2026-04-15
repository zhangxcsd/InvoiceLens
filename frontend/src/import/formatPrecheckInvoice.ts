import {
  postHeaderCoverage,
  type FieldMappingConfig,
  type FieldMappingFieldEntry,
} from '../config/localApi'

export type { FieldMappingConfig, FieldMappingFieldEntry } from '../config/localApi'

/**
 * 发票 Excel 格式预审（浏览器端 .xlsx）
 * - 必要工作表规则对齐业务：必有「发票基础信息」；「信息汇总表」与「货物清单」至少其一
 * - 表头字段映射对齐 `config/field_mapping.yaml` + `get_field_mapping_for_sheet` / `_infer_field_columns`：
 *   命中 `sheets` 某类型时**仅检查该块列出的字段**（与后端一致），故「发票基础信息」不会要求明细列如「税收分类编码」。
 * - 若本地 API 可用：额外调用 `/api/header-coverage`，提示 YAML 未收录的列名及建议英文 slug
 */

function fallbackEntry(aliases: readonly string[]): FieldMappingFieldEntry {
  const al = [...aliases]
  return { label_zh: al.length > 0 ? al[0]! : '', aliases: al }
}

/** 本地 API 不可用时的兜底；label_zh 与迁移脚本一致取首别名 */
export const FALLBACK_FIELD_MAPPING_CONFIG: FieldMappingConfig = {
  default_fields: {
    invoice_no: fallbackEntry(['发票号码']),
    invoice_code: fallbackEntry(['发票代码']),
    sdfphm: fallbackEntry(['数电发票号码', '数电票号码']),
    kprq: fallbackEntry(['开票日期', '日期']),
    seller_tax_no: fallbackEntry(['销方识别号']),
    buyer_tax_no: fallbackEntry(['购方识别号']),
    amount: fallbackEntry(['金额']),
    tax_amount: fallbackEntry(['税额']),
    total_amount: fallbackEntry(['价税合计']),
  },
  sheets: {
    '铁路电子客票': {
      kprq: fallbackEntry(['日期', '开票日期']),
    },
  },
}

/** 与 `excel_to_ods._normalize_colname` 对齐 */
export function normalizeColName(s: unknown): string {
  if (s == null) return ''
  return String(s).trim().replace(/\s+/g, '')
}

/** 与 `excel_to_ods._match_target_sheet` 一致：工作表名（去空格）包含目标 key（去空格） */
export function sheetNameMatchesTarget(sheetName: string, targetKey: string): boolean {
  const n = normalizeColName(sheetName)
  const kn = normalizeColName(targetKey)
  return Boolean(kn && n.includes(kn))
}

function resolveDisplayLabel(
  labelZh: string | undefined,
  aliases: readonly string[] | undefined,
  fallback: string,
): string {
  const lz = (labelZh ?? '').trim()
  if (lz) return lz
  const first = (aliases ?? []).map((a) => String(a).trim()).find((a) => a.length > 0)
  if (first) return first
  return fallback
}

/** 与格式预审一致：按命中的 sheet 覆盖顺序合并后，得到展示用业务名 */
export function effectiveLabelZhForSheet(
  cfg: FieldMappingConfig,
  sheetDisplayName: string,
  odsKey: string,
): string {
  const defEntry = cfg.default_fields[odsKey]
  const defLine = resolveDisplayLabel(defEntry?.label_zh, defEntry?.aliases, odsKey)
  let label = defLine
  const overrides = cfg.sheets ?? {}
  for (const [overrideSheetKey, overrideFields] of Object.entries(overrides)) {
    if (!sheetNameMatchesTarget(sheetDisplayName, overrideSheetKey)) continue
    const ent = overrideFields?.[odsKey]
    if (ent === undefined) continue
    const fromSheet = resolveDisplayLabel(ent.label_zh, ent.aliases, '')
    label = fromSheet || defLine
  }
  return label || odsKey
}

export function inferSeqColumn(columns: unknown[]): string | null {
  const normToCol = new Map<string, string>()
  for (const c of columns) {
    const col = String(c ?? '')
    const nc = normalizeColName(col)
    if (nc) normToCol.set(nc, col)
  }
  if (normToCol.has('序号')) return normToCol.get('序号') ?? null
  for (const c of columns) {
    const col = String(c ?? '')
    if (normalizeColName(col).includes('序号')) return col
  }
  return null
}

export function inferFieldColumns(
  columns: unknown[],
  fieldMapping: Record<string, readonly string[]>,
): Record<string, string | null> {
  const normToCol = new Map<string, string>()
  for (const c of columns) {
    const col = String(c ?? '')
    const nc = normalizeColName(col)
    if (nc) normToCol.set(nc, col)
  }
  const results: Record<string, string | null> = {}
  for (const [field, aliases] of Object.entries(fieldMapping)) {
    let chosen: string | null = null
    for (const alias of aliases) {
      const aliasNorm = normalizeColName(alias)
      if (aliasNorm && normToCol.has(aliasNorm)) {
        chosen = normToCol.get(aliasNorm)!
        break
      }
    }
    if (chosen == null) {
      for (const c of columns) {
        const col = String(c ?? '')
        const cNorm = normalizeColName(col)
        for (const alias of aliases) {
          const an = normalizeColName(alias)
          if (an && cNorm.includes(an)) {
            chosen = col
            break
          }
        }
        if (chosen != null) break
      }
    }
    results[field] = chosen
  }
  return results
}

/**
 * 金税常见结构：必有「发票基础信息」；「信息汇总表」「货物清单」二选一（近年多为信息汇总表）。
 * 返回 null 表示通过。
 */
export function evaluateCoreInvoiceSheetRule(sheetNames: string[]): string | null {
  const hit = (key: string) => sheetNames.some((sn) => sheetNameMatchesTarget(sn, key))
  if (!hit('发票基础信息')) return '缺少必要工作表「发票基础信息」'
  if (!hit('信息汇总表') && !hit('货物清单')) {
    return '「信息汇总表」与「货物清单」需至少存在其一（近年多为「信息汇总表」）'
  }
  return null
}

export function sheetsMatchingTargets(sheetNames: string[], targetKeys: string[]): string[] {
  return sheetNames.filter((sn) => targetKeys.some((k) => sheetNameMatchesTarget(sn, k)))
}

/**
 * 与后端 `get_field_mapping_for_sheet` 一致：用于表头列推断的「字段 → 别名」表。
 * - 工作表名未命中任何 `sheets` 键：使用全部 `default_fields`。
 * - 命中某一/多块：仅合并块内显式列出的字段；块内 `aliases` 为空则继承 default 中该字段别名。
 */
export function buildColumnInferFieldMapForSheet(
  sheetDisplayName: string,
  fieldMappingConfig: FieldMappingConfig,
): Record<string, readonly string[]> {
  const defaultEntries = fieldMappingConfig.default_fields
  const overrides = fieldMappingConfig.sheets ?? {}
  const matchingMaps: Record<string, FieldMappingFieldEntry>[] = []

  for (const [overrideSheetKey, overrideFields] of Object.entries(overrides)) {
    if (!sheetNameMatchesTarget(sheetDisplayName, overrideSheetKey)) continue
    matchingMaps.push(overrideFields ?? {})
  }

  if (matchingMaps.length === 0) {
    return Object.fromEntries(Object.entries(defaultEntries).map(([k, v]) => [k, v.aliases]))
  }

  const out: Record<string, readonly string[]> = {}
  for (const fieldMap of matchingMaps) {
    for (const [field, ent] of Object.entries(fieldMap)) {
      const al = ent?.aliases ?? []
      const defAl = defaultEntries[field]?.aliases ?? []
      out[field] = al.length > 0 ? al : defAl
    }
  }
  return out
}

/** 浏览器端结构/标准字段预审 vs 本地 API 的 YAML 表头覆盖检查（分开展示） */
export type InvoiceFormatPrecheckResult = {
  /** 工作表规则、解析失败、前端映射下的缺字段/序号等 */
  browserIssues: string[]
  /** 与 excel_to_ods + sheet_header_slugs 对齐的「多出来的列」及 API 错误 */
  yamlCoverageIssues: string[]
}

/**
 * 对当前勾选目标所命中的工作表读取首行表头，检查标准字段映射与序号列（轻量：仅读前若干行）
 */
export async function runInvoiceXlsxFormatPrecheck(
  file: File,
  targetKeys: string[],
  fieldMappingConfig: FieldMappingConfig,
  options?: { maxUploadMb?: number },
): Promise<InvoiceFormatPrecheckResult> {
  const browserIssues: string[] = []
  const yamlCoverageIssues: string[] = []
  if (targetKeys.length === 0) return { browserIssues, yamlCoverageIssues }

  let XLSX: typeof import('xlsx')
  try {
    XLSX = await import('xlsx')
  } catch {
    browserIssues.push(`${file.name}：无法加载表格解析组件（xlsx）`)
    return { browserIssues, yamlCoverageIssues }
  }

  let wb: import('xlsx').WorkBook
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: 24 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    browserIssues.push(`${file.name}：无法解析 .xlsx（${msg}）`)
    return { browserIssues, yamlCoverageIssues }
  }

  const sheetNames = wb.SheetNames
  const coreMsg = evaluateCoreInvoiceSheetRule(sheetNames)
  if (coreMsg) browserIssues.push(`${file.name}：${coreMsg}`)

  const toInspect = sheetsMatchingTargets(sheetNames, targetKeys)
  for (const sheet of toInspect) {
    const ws = wb.Sheets[sheet]
    if (!ws) {
      browserIssues.push(`${file.name}：未读到工作表「${sheet}」`)
      continue
    }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][]
    const headerRow = rows[0] ?? []

    const sheetFieldMapping = buildColumnInferFieldMapForSheet(sheet, fieldMappingConfig)

    const fieldCols = inferFieldColumns(headerRow, sheetFieldMapping)
    const missingZh = Object.entries(fieldCols)
      .filter(([, v]) => v == null)
      .map(([k]) => effectiveLabelZhForSheet(fieldMappingConfig, sheet, k))

    const parts: string[] = []
    if (missingZh.length > 0) {
      parts.push(`表头未识别字段：${missingZh.join('、')}（对照 config/field_mapping.yaml 的 Sheet 覆盖别名）`)
    }
    if (inferSeqColumn(headerRow) == null) {
      parts.push('未识别「序号」列（导入仍可进行，拒收行不易按 Excel 定位）')
    }
    if (parts.length > 0) browserIssues.push(`${file.name} · 「${sheet}」：${parts.join('；')}`)
  }

  const cov = await postHeaderCoverage(file, targetKeys, undefined, options?.maxUploadMb)
  if (cov && !cov.ok && cov.error?.message) {
    yamlCoverageIssues.push(`${file.name}：表头覆盖检查（本地 API）失败：${cov.error.message}`)
  }
  if (cov?.ok && Array.isArray(cov.sheets)) {
    for (const s of cov.sheets) {
      const um = s.unmapped_headers ?? []
      if (um.length === 0) continue
      const sug = s.suggested_slugs ?? {}
      const pairs = um.map((h) => `${h}→${sug[h] ?? '?'}`).join('，')
      yamlCoverageIssues.push(
        `${file.name} · 「${s.sheet_name}」：YAML 未覆盖表头：${um.join('、')}（建议英文 key：${pairs}；可写入 config/field_mapping.yaml 的 sheet_header_slugs，或对样例目录运行 tools/sync_sheet_block_from_samples.py）`,
      )
    }
  }

  return { browserIssues, yamlCoverageIssues }
}
