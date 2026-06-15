import { FALLBACK_FIELD_MAPPING_CONFIG } from '../import/formatPrecheckInvoice'
import type { FieldMappingConfig as ApiFieldMappingConfig } from '../config/localApi'

export type ContextMode = 'global' | 'sheet'

export type MappingRow = {
  id: string
  odsKey: string
  titleZh: string
  aliases: string[]
  valueType: 'string' | 'date' | 'amount'
  required: boolean
  matchMode: 'exact' | 'contains'
  status: 'aligned' | 'review'
  inheritsAliasesDefault?: boolean
  inheritsLabelDefault?: boolean
  defaultLabelPlaceholder?: string
  defaultAliasesPlaceholder?: string
}

export function cloneMapping(raw: ApiFieldMappingConfig): ApiFieldMappingConfig {
  const default_fields: ApiFieldMappingConfig['default_fields'] = {}
  for (const [k, v] of Object.entries(raw.default_fields)) {
    default_fields[k] = { label_zh: v.label_zh, aliases: [...v.aliases] }
  }
  const sheets: Record<string, Record<string, { label_zh: string; aliases: string[] }>> = {}
  if (raw.sheets) {
    for (const [sk, fm] of Object.entries(raw.sheets)) {
      sheets[sk] = {}
      for (const [fk, ent] of Object.entries(fm)) {
        sheets[sk][fk] = { label_zh: ent.label_zh, aliases: [...ent.aliases] }
      }
    }
  }
  return { default_fields, sheets }
}

export function fromFallback(): ApiFieldMappingConfig {
  return cloneMapping(FALLBACK_FIELD_MAPPING_CONFIG)
}

export function getSheetStoredAliases(cfg: ApiFieldMappingConfig, sheetKey: string, odsKey: string): string[] {
  const ent = cfg.sheets?.[sheetKey]?.[odsKey]
  const oa = ent?.aliases
  return Array.isArray(oa) ? [...oa] : []
}

export function getEffectiveMapBlock(cfg: ApiFieldMappingConfig, sheetKey: string | null): Record<string, string[]> {
  const mapBlock: Record<string, string[]> = {}
  const base = cfg.default_fields
  if (!sheetKey) {
    for (const [k, v] of Object.entries(base)) mapBlock[k] = [...(v?.aliases ?? [])]
    return mapBlock
  }
  const over = cfg.sheets?.[sheetKey]
  for (const k of Object.keys(base)) {
    const oa = over?.[k]?.aliases
    const useSheet = oa !== undefined && oa.length > 0
    mapBlock[k] = useSheet ? [...oa!] : [...(base[k]?.aliases ?? [])]
  }
  if (over) {
    for (const k of Object.keys(over)) {
      if (k in mapBlock) continue
      const oa = over[k]?.aliases ?? []
      mapBlock[k] = oa.length > 0 ? [...oa] : [...(base[k]?.aliases ?? [])]
    }
  }
  return mapBlock
}

export function resolveDisplayLabel(
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

export function getEffectiveLabelZh(
  cfg: ApiFieldMappingConfig,
  mode: ContextMode,
  sheetKey: string,
  odsKey: string,
): string {
  const defEntry = cfg.default_fields[odsKey]
  const defLine = resolveDisplayLabel(defEntry?.label_zh, defEntry?.aliases, odsKey)
  if (mode === 'global') return defLine
  const ent = cfg.sheets?.[sheetKey]?.[odsKey]
  if (ent !== undefined) {
    const fromSheet = resolveDisplayLabel(ent.label_zh, ent.aliases, '')
    if (fromSheet) return fromSheet
    return defLine
  }
  return defLine
}

export function parseAliasInputLines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
}

export function aliasListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

export function mappingConfigsEqual(a: ApiFieldMappingConfig, b: ApiFieldMappingConfig): boolean {
  return (
    JSON.stringify(a.default_fields) === JSON.stringify(b.default_fields) &&
    JSON.stringify(a.sheets ?? {}) === JSON.stringify(b.sheets ?? {})
  )
}

const ODS_KEY_PATTERN = /^[a-z][a-z0-9_]*$/

export function normalizeOdsKeyInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

export function odsKeyErrorKind(key: string): 'empty' | 'long' | 'invalid' | null {
  if (!key) return 'empty'
  if (key.length > 120) return 'long'
  if (!ODS_KEY_PATTERN.test(key)) return 'invalid'
  return null
}

type FieldMergeResult = { cfg: ApiFieldMappingConfig } | { err: 'duplicate' }

export function mergeDefaultFieldEntry(
  cfg: ApiFieldMappingConfig,
  odsKey: string,
  label_zh: string,
  aliases: string[],
  mergeIfExists: boolean,
): FieldMergeResult {
  const ex = cfg.default_fields[odsKey]
  if (ex && !mergeIfExists) return { err: 'duplicate' }
  const nextAliases =
    ex && mergeIfExists ? [...new Set([...ex.aliases.map(String), ...aliases])] : [...aliases]
  const nextLabel = ((ex?.label_zh ?? '').trim() || label_zh).trim()
  return {
    cfg: {
      ...cfg,
      default_fields: {
        ...cfg.default_fields,
        [odsKey]: { label_zh: nextLabel, aliases: nextAliases },
      },
    },
  }
}

export function mergeSheetFieldEntry(
  cfg: ApiFieldMappingConfig,
  sheetKey: string,
  odsKey: string,
  label_zh: string,
  aliases: string[],
  mergeIfExists: boolean,
): FieldMergeResult {
  const prevSheet = { ...(cfg.sheets?.[sheetKey] ?? {}) }
  const ex = prevSheet[odsKey]
  if (ex && !mergeIfExists) return { err: 'duplicate' }
  const nextAliases =
    ex && mergeIfExists ? [...new Set([...ex.aliases.map(String), ...aliases])] : [...aliases]
  const nextLabel = ((ex?.label_zh ?? '').trim() || label_zh).trim()
  prevSheet[odsKey] = { label_zh: nextLabel, aliases: nextAliases }
  return {
    cfg: {
      ...cfg,
      sheets: { ...(cfg.sheets ?? {}), [sheetKey]: prevSheet },
    },
  }
}

export function putSheetExplicitInherit(
  cfg: ApiFieldMappingConfig,
  sheetKey: string,
  odsKey: string,
): ApiFieldMappingConfig {
  const prevSheet = { ...(cfg.sheets?.[sheetKey] ?? {}) }
  prevSheet[odsKey] = { label_zh: '', aliases: [] }
  return {
    ...cfg,
    sheets: { ...(cfg.sheets ?? {}), [sheetKey]: prevSheet },
  }
}

export function sheetEntryHasLocalValue(ent: { label_zh: string; aliases: string[] } | undefined): boolean {
  if (ent === undefined) return false
  if ((ent.label_zh ?? '').trim().length > 0) return true
  return (ent.aliases ?? []).length > 0
}

export function slugFallbackFromHeader(header: string, idx: number): string {
  const ascii = header
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  if (ascii.length >= 2 && /^[a-z]/.test(ascii)) return ascii.slice(0, 80)
  return `extra_col_${idx}`
}

export type CoverageRow = {
  id: string
  sheetName: string
  header: string
  slug: string
  selected: boolean
}

function rowMetaForOdsKey(odsKey: string): Pick<MappingRow, 'valueType' | 'required' | 'matchMode' | 'status'> {
  return {
    valueType:
      odsKey.includes('date') || odsKey === 'kprq'
        ? 'date'
        : odsKey.includes('amount') || odsKey === 'amount' || odsKey.includes('total')
          ? 'amount'
          : 'string',
    required: ['invoice_no', 'invoice_code', 'sdfphm'].some((k) => odsKey.includes(k) || odsKey === k),
    matchMode: 'contains' as const,
    status: 'aligned' as const,
  }
}

export function buildRowsFromConfig(cfg: ApiFieldMappingConfig, mode: ContextMode, sheetKey: string): MappingRow[] {
  if (mode === 'sheet' && sheetKey !== '') {
    const over = cfg.sheets?.[sheetKey]
    if (!over || Object.keys(over).length === 0) return []
    return Object.keys(over).map((odsKey, i) => {
      const ent = over[odsKey]!
      const aliases = [...(ent.aliases ?? [])]
      const inheritsAliases = aliases.length === 0
      const inheritsLabel = !(ent.label_zh ?? '').trim()
      const defEntry = cfg.default_fields[odsKey]
      const defAliases = defEntry?.aliases ?? []
      const defLine = resolveDisplayLabel(defEntry?.label_zh, defEntry?.aliases, odsKey)
      const sheetLine = resolveDisplayLabel(ent.label_zh, ent.aliases, '')
      const titleZh = sheetLine || defLine
      const defaultAliasesPlaceholder = defAliases.map((a) => String(a).trim()).filter(Boolean).join('\n')
      return {
        id: `${mode}-${sheetKey}-${odsKey}-${i}`,
        odsKey,
        titleZh,
        aliases,
        inheritsAliasesDefault: inheritsAliases,
        inheritsLabelDefault: inheritsLabel,
        defaultLabelPlaceholder: defLine,
        defaultAliasesPlaceholder,
        ...rowMetaForOdsKey(odsKey),
      }
    })
  }
  const mapBlock = getEffectiveMapBlock(cfg, null)
  return Object.entries(mapBlock).map(([odsKey, aliases], i) => ({
    id: `${mode}-${sheetKey || 'global'}-${odsKey}-${i}`,
    odsKey,
    titleZh: getEffectiveLabelZh(cfg, mode, sheetKey, odsKey),
    aliases: [...aliases],
    ...rowMetaForOdsKey(odsKey),
  }))
}

export function applyAliasChange(
  cfg: ApiFieldMappingConfig,
  mode: ContextMode,
  sheetKey: string,
  odsKey: string,
  aliases: string[],
): ApiFieldMappingConfig {
  if (mode === 'global') {
    const prev = cfg.default_fields[odsKey] ?? { label_zh: '', aliases: [] }
    return {
      ...cfg,
      default_fields: { ...cfg.default_fields, [odsKey]: { ...prev, aliases: [...aliases] } },
    }
  }
  const prevSheet = cfg.sheets?.[sheetKey] ?? {}
  const prevField = prevSheet[odsKey]
  const nextLabel = prevField?.label_zh ?? ''
  return {
    ...cfg,
    sheets: {
      ...(cfg.sheets ?? {}),
      [sheetKey]: {
        ...prevSheet,
        [odsKey]: { label_zh: nextLabel, aliases: [...aliases] },
      },
    },
  }
}

export function applyLabelZhChange(
  cfg: ApiFieldMappingConfig,
  mode: ContextMode,
  sheetKey: string,
  odsKey: string,
  labelZh: string,
): ApiFieldMappingConfig {
  const trimmed = labelZh.trim()
  if (mode === 'global') {
    const prev = cfg.default_fields[odsKey] ?? { label_zh: '', aliases: [] }
    return {
      ...cfg,
      default_fields: { ...cfg.default_fields, [odsKey]: { ...prev, label_zh: trimmed } },
    }
  }
  const prevSheet = cfg.sheets?.[sheetKey] ?? {}
  const prevField = prevSheet[odsKey]
  const nextAliases = [...(prevField?.aliases ?? [])]
  return {
    ...cfg,
    sheets: {
      ...(cfg.sheets ?? {}),
      [sheetKey]: {
        ...prevSheet,
        [odsKey]: { label_zh: trimmed, aliases: nextAliases },
      },
    },
  }
}

export function mergeDraftsForContext(
  base: ApiFieldMappingConfig,
  draftMap: Record<string, string>,
  m: ContextMode,
  contextSheetKey: string,
): ApiFieldMappingConfig {
  const expectSk = m === 'global' ? '_' : contextSheetKey
  let out = base
  for (const [dk, raw] of Object.entries(draftMap)) {
    if (dk.startsWith('L:')) {
      const rest = dk.slice(2)
      const parts = rest.split(':')
      if (parts.length < 3) continue
      const dm = parts[0] as ContextMode
      const dsk = parts[1]
      const odsKey = parts.slice(2).join(':')
      if (dm !== m || dsk !== expectSk || !odsKey) continue
      out = applyLabelZhChange(out, m, contextSheetKey, odsKey, raw)
      continue
    }
    const parts = dk.split(':')
    if (parts.length < 3) continue
    const [dm, dsk, odsKey] = parts
    if (dm !== m || dsk !== expectSk) continue
    out = applyAliasChange(out, m, contextSheetKey, odsKey, parseAliasInputLines(raw))
  }
  return out
}

export function labelDraftKey(mode: ContextMode, sheetKey: string, odsKey: string) {
  return `L:${mode}:${mode === 'global' ? '_' : sheetKey}:${odsKey}`
}
