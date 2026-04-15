import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchFieldMapping,
  saveFieldMapping,
  fetchImportLimits,
  postHeaderCoverage,
  type FieldMappingConfig as ApiFieldMappingConfig,
} from '../config/localApi'
import { FALLBACK_FIELD_MAPPING_CONFIG } from '../import/formatPrecheckInvoice'
import { sheetMappingOptionsFallback } from '../config/sheetMappingOptions'

type ContextMode = 'global' | 'sheet'

type MappingRow = {
  id: string
  odsKey: string
  titleZh: string
  aliases: string[]
  valueType: 'string' | 'date' | 'amount'
  required: boolean
  matchMode: 'exact' | 'contains'
  status: 'aligned' | 'review'
  /** Sheet 模式：本块 aliases 为空，运行时别名继承 default */
  inheritsAliasesDefault?: boolean
  /** Sheet 模式：本块 label_zh 为空，业务含义展示继承 default */
  inheritsLabelDefault?: boolean
  /** Sheet 继承 default 时：占位符 = 全局 default 业务含义原文（与 resolveDisplayLabel 一致） */
  defaultLabelPlaceholder?: string
  /** Sheet 继承 default 时：占位符 = 全局 default 别名原文（一行一个，与输入框格式一致） */
  defaultAliasesPlaceholder?: string
}

function cloneMapping(raw: ApiFieldMappingConfig): ApiFieldMappingConfig {
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

function fromFallback(): ApiFieldMappingConfig {
  return cloneMapping(FALLBACK_FIELD_MAPPING_CONFIG)
}

/** Sheet 块内存储的别名（仅声明键；空数组表示继承 default） */
function getSheetStoredAliases(cfg: ApiFieldMappingConfig, sheetKey: string, odsKey: string): string[] {
  const ent = cfg.sheets?.[sheetKey]?.[odsKey]
  const oa = ent?.aliases
  return Array.isArray(oa) ? [...oa] : []
}

/** 与后端 get_field_mapping_for_sheet 一致的有效别名表（全局模式或合并继承视图） */
function getEffectiveMapBlock(cfg: ApiFieldMappingConfig, sheetKey: string | null): Record<string, string[]> {
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

/** 展示用：优先 label_zh；未配置时用首个别名；仍无则 fallback（常为 odsKey 或全局默认文案） */
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

function getEffectiveLabelZh(
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

function parseAliasInputLines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
}

function aliasListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

function mappingConfigsEqual(a: ApiFieldMappingConfig, b: ApiFieldMappingConfig): boolean {
  return (
    JSON.stringify(a.default_fields) === JSON.stringify(b.default_fields) &&
    JSON.stringify(a.sheets ?? {}) === JSON.stringify(b.sheets ?? {})
  )
}

const ODS_KEY_PATTERN = /^[a-z][a-z0-9_]*$/

function normalizeOdsKeyInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

function odsKeyErrorKind(key: string): 'empty' | 'long' | 'invalid' | null {
  if (!key) return 'empty'
  if (key.length > 120) return 'long'
  if (!ODS_KEY_PATTERN.test(key)) return 'invalid'
  return null
}

type FieldMergeResult = { cfg: ApiFieldMappingConfig } | { err: 'duplicate' }

function mergeDefaultFieldEntry(
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

function mergeSheetFieldEntry(
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

/** Sheet 子块中显式「引用 default」：label_zh 与 aliases 皆空（与 YAML 中 [] 语义一致） */
function putSheetExplicitInherit(
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

/** Sheet 子块是否含本地配置（有 label_zh 或非空 aliases；仅空继承项视为「sheet 无值」） */
function sheetEntryHasLocalValue(ent: { label_zh: string; aliases: string[] } | undefined): boolean {
  if (ent === undefined) return false
  if ((ent.label_zh ?? '').trim().length > 0) return true
  return (ent.aliases ?? []).length > 0
}

function slugFallbackFromHeader(header: string, idx: number): string {
  const ascii = header
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  if (ascii.length >= 2 && /^[a-z]/.test(ascii)) return ascii.slice(0, 80)
  return `extra_col_${idx}`
}

type CoverageRow = {
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
    /** 状态列：后续可对接校验/与 default 差异等；当前统一为已对齐，避免占位规则误导 */
    status: 'aligned' as const,
  }
}

function buildRowsFromConfig(cfg: ApiFieldMappingConfig, mode: ContextMode, sheetKey: string): MappingRow[] {
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

const ALIAS_TEXTAREA_MAX_PX = 280

function syncAliasTextareaHeight(el: HTMLTextAreaElement | null) {
  if (!el) return
  // 先压到 0 再读 scrollHeight，避免沿用旧 height 导致测量偏小（多行仍显示成一行高）
  el.style.height = '0px'
  const h = Math.max(40, Math.min(ALIAS_TEXTAREA_MAX_PX, el.scrollHeight))
  el.style.height = `${h}px`
  el.style.overflowY = h >= ALIAS_TEXTAREA_MAX_PX ? 'auto' : 'hidden'
}

/** 受控文本：编辑中保留原始换行与空行，失焦后再解析为别名数组写回 config */
function AliasesTextarea(props: {
  value: string
  placeholder?: string
  className: string
  onChangeText: (text: string) => void
  onBlur: () => void
  onFocus: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    syncAliasTextareaHeight(ref.current)
  }, [props.value])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncAliasTextareaHeight(el))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={props.value}
      placeholder={props.placeholder}
      spellCheck={false}
      className={props.className}
      onFocus={props.onFocus}
      onChange={(e) => {
        props.onChangeText(e.target.value)
        requestAnimationFrame(() => syncAliasTextareaHeight(ref.current))
      }}
      onBlur={props.onBlur}
    />
  )
}

function applyAliasChange(
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

function applyLabelZhChange(
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

/** 将某一上下文（全局 或 指定 Sheet）下的草稿键合并进 config；切换标签前调用，避免丢字且右侧列表随 config 更新 */
function mergeDraftsForContext(
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

function labelDraftKey(mode: ContextMode, sheetKey: string, odsKey: string) {
  return `L:${mode}:${mode === 'global' ? '_' : sheetKey}:${odsKey}`
}

const INITIAL_SHEET =
  Object.keys(FALLBACK_FIELD_MAPPING_CONFIG.sheets ?? {})[0] ?? String(sheetMappingOptionsFallback[0] ?? '')

function initialConfigSnapshot(): ApiFieldMappingConfig {
  return cloneMapping(fromFallback())
}

export function FieldMappingConfigPrototype(props: { onNavUpload: () => void }) {
  const [mode, setMode] = useState<ContextMode>('global')
  const [sheetKey, setSheetKey] = useState<string>(INITIAL_SHEET)
  const [query, setQuery] = useState('')
  const [config, setConfig] = useState<ApiFieldMappingConfig>(() => initialConfigSnapshot())
  const [baselineConfig, setBaselineConfig] = useState<ApiFieldMappingConfig>(() => initialConfigSnapshot())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sourceLabel, setSourceLabel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [busy, setBusy] = useState<'idle' | 'load' | 'save'>('idle')
  const [maxUploadMbCap, setMaxUploadMbCap] = useState(200)
  const [addPanelOpen, setAddPanelOpen] = useState(false)
  const [newOdsKey, setNewOdsKey] = useState('')
  const [newLabelZh, setNewLabelZh] = useState('')
  const [newAliasesText, setNewAliasesText] = useState('')
  const [addAlsoToDefault, setAddAlsoToDefault] = useState(false)
  const [addFieldError, setAddFieldError] = useState<string | null>(null)
  const [coverageOpen, setCoverageOpen] = useState(false)
  const [coverageBusy, setCoverageBusy] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [coverageRows, setCoverageRows] = useState<CoverageRow[]>([])
  const [coverageDest, setCoverageDest] = useState<'sheet' | 'sheet_and_default'>('sheet')
  const coverageFileRef = useRef<HTMLInputElement>(null)

  const dirty = useMemo(() => !mappingConfigsEqual(config, baselineConfig), [config, baselineConfig])

  const draftsRef = useRef<Record<string, string>>({})
  draftsRef.current = drafts

  const sheetOverrideKeys = useMemo(() => Object.keys(config.sheets ?? {}), [config.sheets])

  const sheetCandidates = useMemo(() => {
    const seen = new Set(sheetOverrideKeys)
    const rest = sheetMappingOptionsFallback.filter((k) => !seen.has(k))
    return [...sheetOverrideKeys, ...rest]
  }, [sheetOverrideKeys])

  useEffect(() => {
    if (sheetCandidates.length > 0 && !sheetCandidates.includes(sheetKey)) {
      setSheetKey(sheetCandidates[0]!)
    }
  }, [sheetCandidates, sheetKey])

  useEffect(() => {
    if (mode === 'global') {
      setCoverageOpen(false)
      setCoverageRows([])
      setCoverageError(null)
    }
  }, [mode])

  const bootstrap = useCallback(async () => {
    setBusy('load')
    setLoadError(null)
    const data = await fetchFieldMapping()
    setBusy('idle')
    if (data) {
      const { source, ...rest } = data
      const next = cloneMapping(rest)
      setConfig(next)
      setBaselineConfig(cloneMapping(next))
      setSourceLabel(source ?? '')
      setSaveError(null)
      setHint(null)
    } else {
      setLoadError(t.fieldMappingUi.loadFromApiFailed)
      setSourceLabel('builtin')
    }
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    void fetchImportLimits().then((r) => {
      if (r.ok && r.max_upload_mb >= 1) setMaxUploadMbCap(r.max_upload_mb)
    })
  }, [])

  const rows = useMemo(() => buildRowsFromConfig(config, mode, sheetKey), [config, mode, sheetKey])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        r.odsKey.toLowerCase().includes(q) ||
        r.titleZh.includes(q) ||
        r.aliases.some((a) => a.toLowerCase().includes(q)),
    )
  }, [rows, query])

  const handleRefresh = async () => {
    setBusy('load')
    setLoadError(null)
    setSaveError(null)
    setHint(null)
    const data = await fetchFieldMapping()
    setBusy('idle')
    if (data) {
      const { source, ...rest } = data
      const next = cloneMapping(rest)
      setConfig(next)
      setBaselineConfig(cloneMapping(next))
      setSourceLabel(source ?? '')
      setDrafts({})
    } else {
      setLoadError(t.fieldMappingUi.refreshFailed)
    }
  }

  const handleSave = async () => {
    setBusy('save')
    setSaveError(null)
    setHint(null)
    const merged = mergeDraftsForContext(config, drafts, mode, sheetKey)
    setConfig(merged)
    setDrafts({})
    const r = await saveFieldMapping(merged)
    setBusy('idle')
    if (r.ok) {
      setBaselineConfig(cloneMapping(merged))
      setHint(r.saved_to ? t.fieldMappingUi.saveSuccessWithPath.replace('{path}', r.saved_to) : t.fieldMappingUi.saveSuccess)
      if (r.source) setSourceLabel(r.source)
    } else {
      setSaveError(r.error ?? t.fieldMappingUi.saveFailed)
    }
  }

  const submitAddField = () => {
    setAddFieldError(null)
    const key = normalizeOdsKeyInput(newOdsKey)
    const kind = odsKeyErrorKind(key)
    if (kind) {
      setAddFieldError(t.fieldMappingUi.addFieldErr[kind])
      return
    }
    const lz = newLabelZh.trim()
    const aliases = parseAliasInputLines(newAliasesText)
    const finalAliases = aliases.length > 0 ? aliases : lz ? [lz] : []
    if (!lz && finalAliases.length === 0) {
      setAddFieldError(t.fieldMappingUi.addFieldErr.needContent)
      return
    }
    const labelForStore = lz || finalAliases[0] || key
    const mergedBase = mergeDraftsForContext(config, drafts, mode, sheetKey)
    let next: ApiFieldMappingConfig
    if (mode === 'global') {
      const r = mergeDefaultFieldEntry(mergedBase, key, labelForStore, finalAliases, false)
      if ('err' in r) {
        setAddFieldError(t.fieldMappingUi.addFieldErr.duplicate)
        return
      }
      next = r.cfg
    } else if (addAlsoToDefault) {
      if (mergedBase.default_fields[key]) {
        setAddFieldError(t.fieldMappingUi.addFieldErr.duplicateDefault)
        return
      }
      if (mergedBase.sheets?.[sheetKey]?.[key]) {
        setAddFieldError(t.fieldMappingUi.addFieldErr.duplicateSheet)
        return
      }
      next = putSheetExplicitInherit(
        {
          ...mergedBase,
          default_fields: {
            ...mergedBase.default_fields,
            [key]: { label_zh: labelForStore, aliases: finalAliases },
          },
        },
        sheetKey,
        key,
      )
    } else {
      const rs = mergeSheetFieldEntry(mergedBase, sheetKey, key, labelForStore, finalAliases, false)
      if ('err' in rs) {
        setAddFieldError(t.fieldMappingUi.addFieldErr.duplicate)
        return
      }
      next = rs.cfg
    }
    setConfig(next)
    setDrafts({})
    setNewOdsKey('')
    setNewLabelZh('')
    setNewAliasesText('')
    setAddPanelOpen(false)
    setHint(t.fieldMappingUi.addFieldSuccess)
  }

  const runCoverageOnFile = async (file: File | null) => {
    if (!file) return
    setCoverageBusy(true)
    setCoverageError(null)
    setCoverageRows([])
    const cov = await postHeaderCoverage(file, [sheetKey], undefined, maxUploadMbCap)
    setCoverageBusy(false)
    if (!cov || !cov.ok) {
      setCoverageError(cov?.error?.message ?? t.fieldMappingUi.coverageFailed)
      return
    }
    const list: CoverageRow[] = []
    let idx = 0
    for (const sh of cov.sheets ?? []) {
      for (const h of sh.unmapped_headers ?? []) {
        const sug = (sh.suggested_slugs ?? {})[h]
        const slug = sug && String(sug).trim() ? normalizeOdsKeyInput(String(sug)) : slugFallbackFromHeader(h, idx)
        list.push({
          id: `cov-${idx}`,
          sheetName: sh.sheet_name,
          header: h,
          slug,
          selected: true,
        })
        idx += 1
      }
    }
    setCoverageRows(list)
    if (list.length === 0) setCoverageError(t.fieldMappingUi.coverageEmpty)
    else setHint(t.fieldMappingUi.coverageHint.replace('{n}', String(list.length)))
  }

  const applyCoverageImport = () => {
    const picked = coverageRows.filter((r) => r.selected)
    if (picked.length === 0) {
      setCoverageRows([])
      return
    }
    for (const row of picked) {
      const keyRaw = normalizeOdsKeyInput(row.slug)
      if (odsKeyErrorKind(keyRaw)) {
        setCoverageError(t.fieldMappingUi.coverageAbortedInvalidKeys)
        return
      }
    }
    const mergedBase = mergeDraftsForContext(config, drafts, mode, sheetKey)
    let next = mergedBase
    for (let i = 0; i < picked.length; i += 1) {
      const row = picked[i]!
      const keyRaw = normalizeOdsKeyInput(row.slug)
      const header = row.header.trim()
      const aliases = header ? [header] : []
      const labelForStore = header || keyRaw
      if (coverageDest === 'sheet_and_default') {
        const hasDefault = Boolean(next.default_fields[keyRaw])
        const sheetEnt = next.sheets?.[sheetKey]?.[keyRaw]
        const sheetLocal = sheetEntryHasLocalValue(sheetEnt)
        if (sheetLocal) {
          // sheet 有本地含义/别名：不论 default，仅在 sheet 追加合并
          const rs = mergeSheetFieldEntry(next, sheetKey, keyRaw, labelForStore, aliases, true)
          if ('cfg' in rs) next = rs.cfg
        } else if (hasDefault) {
          // sheet 无本地值（无行或仅空继承），default 有：仅在 default 追加合并
          const rd = mergeDefaultFieldEntry(next, keyRaw, labelForStore, aliases, true)
          if ('cfg' in rd) next = rd.cfg
        } else {
          // default 与 sheet 均无有效值：仅在 sheet 追加（可新建该 key 的 sheet 项）
          const rs = mergeSheetFieldEntry(next, sheetKey, keyRaw, labelForStore, aliases, true)
          if ('cfg' in rs) next = rs.cfg
        }
      } else {
        const rs = mergeSheetFieldEntry(next, sheetKey, keyRaw, labelForStore, aliases, true)
        if ('cfg' in rs) next = rs.cfg
      }
    }
    setConfig(next)
    setDrafts({})
    setCoverageRows([])
    setCoverageError(null)
    setHint(t.fieldMappingUi.coverageImported)
  }

  const sourceBadge =
    sourceLabel.includes('yaml') || sourceLabel.includes('config/')
      ? t.fieldMappingUi.sourceLive
      : loadError
        ? t.fieldMappingUi.sourceOffline
        : t.fieldMappingUi.prototypeBadge

  return (
    <div className="flex min-h-0 flex-col p-[22px]">
      <div className="mb-5 shrink-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-il-page-title font-semibold text-text">{t.fieldMappingUi.configPageTitle}</span>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon text-accent-mid">
            {sourceBadge}
          </span>
          {sourceLabel ? (
            <span className="text-il-meta text-text-3">
              {t.fieldMappingUi.sourceLabelPrefix}
              {sourceLabel}
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-il-page-desc leading-relaxed text-text-2">
          {t.fieldMappingUi.configPageBody}
        </p>
        {loadError ? (
          <div className="mt-2 space-y-1.5 text-il-meta">
            <p className="text-danger">{loadError}</p>
            <p className="max-w-3xl leading-relaxed text-text-3">{t.fieldMappingUi.apiUnavailableHint}</p>
          </div>
        ) : null}
        {saveError ? (
          <p className="mt-2 text-il-meta text-danger">{saveError}</p>
        ) : null}
        {hint ? (
          <p className="mt-2 text-il-meta text-[#0d7a3e]">{hint}</p>
        ) : null}
      </div>

      <div className="mb-4 shrink-0 rounded-[10px] border border-[#c8dff7] bg-[#f7fbff] px-4 py-3 text-il-meta leading-relaxed text-text-2">
        <p>{t.fieldMappingUi.configYamlHint}</p>
        <p className="mt-2 text-text-3">{t.fieldMappingUi.configOdsDwdHint}</p>
        <p className="mt-2 text-text-3">{t.fieldMappingUi.toolsBatchHint}</p>
      </div>

      <div className="mb-4 flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:items-stretch">
        <Card
          title={t.fieldMappingUi.contextCardTitle}
          className="shrink-0 lg:w-[min(100%,260px)] lg:shrink-0"
          bodyClassName="space-y-3"
        >
          <div className="flex rounded-[8px] border border-border-light bg-[#fafbfc] p-0.5">
            <button
              type="button"
              className={[
                'flex-1 rounded-[6px] px-2 py-1.5 text-il-btn transition-colors',
                mode === 'global' ? 'bg-white font-medium text-accent shadow-sm' : 'text-text-2 hover:text-text',
              ].join(' ')}
              onClick={() => {
                setConfig((prev) => mergeDraftsForContext(prev, draftsRef.current, mode, sheetKey))
                setDrafts({})
                setMode('global')
              }}
            >
              {t.fieldMappingUi.modeGlobal}
            </button>
            <button
              type="button"
              className={[
                'flex-1 rounded-[6px] px-2 py-1.5 text-il-btn transition-colors',
                mode === 'sheet' ? 'bg-white font-medium text-accent shadow-sm' : 'text-text-2 hover:text-text',
              ].join(' ')}
              onClick={() => {
                setConfig((prev) => mergeDraftsForContext(prev, draftsRef.current, mode, sheetKey))
                setDrafts({})
                setMode('sheet')
              }}
            >
              {t.fieldMappingUi.modeSheet}
            </button>
          </div>

          {mode === 'sheet' ? (
            <div>
              <div className="mb-1.5 text-il-label font-medium text-text-2">{t.fieldMappingUi.sheetPickLabel}</div>
              <div className="max-h-[min(52vh,320px)] overflow-y-auto pr-1">
                <ul className="space-y-0.5">
                  {sheetCandidates.map((k) => {
                    const active = sheetKey === k
                    const hasOverride = sheetOverrideKeys.includes(k)
                    return (
                      <li key={k}>
                        <button
                          type="button"
                          className={[
                            'w-full rounded-[6px] px-2 py-1.5 text-left text-[12px] transition-colors',
                            active
                              ? 'bg-[#EBF4FF] font-medium text-accent'
                              : 'text-text-2 hover:bg-[#f5f7ff] hover:text-text',
                          ].join(' ')}
                          onClick={() => {
                            if (k === sheetKey) return
                            setConfig((prev) => mergeDraftsForContext(prev, draftsRef.current, 'sheet', sheetKey))
                            setDrafts({})
                            setSheetKey(k)
                          }}
                        >
                          <span className="block truncate">{k}</span>
                          {hasOverride ? (
                            <span className="mt-0.5 block text-[10px] font-normal text-accent-mid">
                              {t.fieldMappingUi.sheetHasOverride}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-il-meta leading-relaxed text-text-3">{t.fieldMappingUi.modeGlobalHint}</p>
          )}

          <div className="border-t border-border-light pt-3">
            <button
              type="button"
              className="w-full rounded-[7px] border border-border bg-white px-2 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => props.onNavUpload()}
            >
              {t.fieldMappingUi.gotoUpload}
            </button>
          </div>
        </Card>

        <Card
          title={t.fieldMappingUi.tableCardTitle}
          className="min-h-0 min-w-0 flex-1"
          bodyClassName="flex min-h-0 flex-col gap-3"
        >
          <div className="flex flex-col gap-2">
            {mode === 'sheet' ? (
              <p className="text-il-meta leading-snug text-accent-mid">
                {t.fieldMappingUi.sheetContextBanner.replace('{name}', sheetKey)}
              </p>
            ) : (
              <p className="text-il-meta leading-snug text-text-3">{t.fieldMappingUi.globalCoverageHint}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              placeholder={t.fieldMappingUi.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-[160px] flex-1 rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent focus:bg-white sm:max-w-xs"
            />
            <button
              type="button"
              disabled={busy !== 'idle'}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
              title={t.fieldMappingUi.refreshTooltip}
              onClick={() => void handleRefresh()}
            >
              {busy === 'load' ? t.fieldMappingUi.busyLoading : t.fieldMappingUi.refreshFromServer}
            </button>
            <button
              type="button"
              disabled={busy !== 'idle' || !dirty}
              className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-medium text-white disabled:opacity-50"
              title={!dirty ? t.fieldMappingUi.saveDisabledNoChanges : t.fieldMappingUi.saveTooltip}
              onClick={() => void handleSave()}
            >
              {busy === 'save' ? t.fieldMappingUi.busySaving : t.fieldMappingUi.saveToYaml}
            </button>
            <button
              type="button"
              disabled={busy !== 'idle'}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
              onClick={() => {
                setAddFieldError(null)
                setAddPanelOpen((o) => !o)
              }}
            >
              {t.fieldMappingUi.addFieldToggle}
            </button>
            {mode === 'sheet' ? (
              <button
                type="button"
                disabled={busy !== 'idle' || loadError !== null}
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                title={loadError ? t.fieldMappingUi.loadFromApiFailed : undefined}
                onClick={() => {
                  setCoverageError(null)
                  setCoverageOpen((o) => !o)
                }}
              >
                {t.fieldMappingUi.coverageToggle}
              </button>
            ) : null}
            </div>

            {addPanelOpen ? (
              <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-3 text-[12px]">
                <div className="mb-2 font-medium text-text">{t.fieldMappingUi.addFieldTitle}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-0.5 block text-il-meta text-text-3">{t.fieldMappingUi.addFieldOdsLabel}</span>
                    <input
                      type="text"
                      value={newOdsKey}
                      onChange={(e) => setNewOdsKey(e.target.value)}
                      placeholder={t.fieldMappingUi.addFieldOdsPlaceholder}
                      className="box-border w-full rounded-[6px] border border-border-light bg-white px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-il-meta text-text-3">{t.fieldMappingUi.addFieldZhLabel}</span>
                    <input
                      type="text"
                      value={newLabelZh}
                      onChange={(e) => setNewLabelZh(e.target.value)}
                      className="box-border w-full rounded-[6px] border border-border-light bg-white px-2 py-1.5 outline-none focus:border-accent"
                    />
                  </label>
                </div>
                <label className="mt-2 block">
                  <span className="mb-0.5 block text-il-meta text-text-3">{t.fieldMappingUi.addFieldAliasesLabel}</span>
                  <textarea
                    value={newAliasesText}
                    onChange={(e) => setNewAliasesText(e.target.value)}
                    rows={3}
                    className="box-border w-full resize-y rounded-[6px] border border-border-light bg-white px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
                  />
                </label>
                {mode === 'sheet' ? (
                  <div className="mt-2">
                    <label className="flex cursor-pointer items-center gap-2 text-il-meta text-text-2">
                      <input
                        type="checkbox"
                        checked={addAlsoToDefault}
                        onChange={(e) => setAddAlsoToDefault(e.target.checked)}
                      />
                      {t.fieldMappingUi.addFieldAlsoDefault}
                    </label>
                    {addAlsoToDefault ? (
                      <p className="mt-1.5 pl-6 text-il-meta leading-snug text-text-3">
                        {t.fieldMappingUi.addFieldAlsoDefaultHint}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {addFieldError ? <p className="mt-2 text-il-meta text-danger">{addFieldError}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-medium text-white"
                    onClick={() => submitAddField()}
                  >
                    {t.fieldMappingUi.addFieldSubmit}
                  </button>
                  <button
                    type="button"
                    className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2"
                    onClick={() => {
                      setAddPanelOpen(false)
                      setAddFieldError(null)
                    }}
                  >
                    {t.fieldMappingUi.addFieldCancel}
                  </button>
                </div>
              </div>
            ) : null}

            {mode === 'sheet' && coverageOpen ? (
              <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-3 text-[12px]">
                <div className="mb-2 font-medium text-text">{t.fieldMappingUi.coverageTitle}</div>
                <input
                  ref={coverageFileRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    void runCoverageOnFile(f)
                    e.target.value = ''
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={coverageBusy || loadError !== null}
                    className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent disabled:opacity-50"
                    onClick={() => coverageFileRef.current?.click()}
                  >
                    {coverageBusy ? t.fieldMappingUi.coverageRunning : t.fieldMappingUi.coveragePickFile}
                  </button>
                  <span className="text-il-meta text-text-3">{t.fieldMappingUi.coverageImportTo}</span>
                  <label className="inline-flex cursor-pointer items-center gap-1 text-il-meta">
                    <input
                      type="radio"
                      name="covdest"
                      checked={coverageDest === 'sheet'}
                      onChange={() => setCoverageDest('sheet')}
                    />
                    {t.fieldMappingUi.coverageImportSheet}
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1 text-il-meta">
                    <input
                      type="radio"
                      name="covdest"
                      checked={coverageDest === 'sheet_and_default'}
                      onChange={() => setCoverageDest('sheet_and_default')}
                    />
                    {t.fieldMappingUi.coverageImportSheetAndDefault}
                  </label>
                </div>
                {coverageError ? <p className="mt-2 text-il-meta text-danger">{coverageError}</p> : null}
                <p className="mt-2 text-il-meta text-text-3">{t.fieldMappingUi.coverageAlsoNote}</p>
                {coverageRows.length > 0 ? (
                  <div className="mt-2 max-h-[220px] overflow-auto rounded-[6px] border border-border-light bg-white">
                    <div className="sticky top-0 flex gap-2 border-b border-border-light bg-[#f5f8fc] px-2 py-1.5 text-[11px] text-text-2">
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() =>
                          setCoverageRows((rs) => rs.map((r) => ({ ...r, selected: true })))
                        }
                      >
                        {t.fieldMappingUi.coverageSelectAll}
                      </button>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() =>
                          setCoverageRows((rs) => rs.map((r) => ({ ...r, selected: false })))
                        }
                      >
                        {t.fieldMappingUi.coverageSelectNone}
                      </button>
                    </div>
                    <table className="w-full border-collapse text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-border-light bg-[#fafbfc] text-text-2">
                          <th className="w-8 px-1 py-1" />
                          <th className="px-2 py-1">{t.fieldMappingUi.coverageSheetCol}</th>
                          <th className="px-2 py-1">{t.fieldMappingUi.coverageHeaderCol}</th>
                          <th className="px-2 py-1">{t.fieldMappingUi.coverageSlugCol}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {coverageRows.map((row) => (
                          <tr key={row.id} className="border-b border-border-light/80">
                            <td className="px-1 py-1 text-center">
                              <input
                                type="checkbox"
                                checked={row.selected}
                                onChange={(e) =>
                                  setCoverageRows((rs) =>
                                    rs.map((x) =>
                                      x.id === row.id ? { ...x, selected: e.target.checked } : x,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td className="px-2 py-1 text-text-3">{row.sheetName}</td>
                            <td className="px-2 py-1">{row.header}</td>
                            <td className="px-2 py-1">
                              <input
                                type="text"
                                value={row.slug}
                                onChange={(e) =>
                                  setCoverageRows((rs) =>
                                    rs.map((x) => (x.id === row.id ? { ...x, slug: e.target.value } : x)),
                                  )
                                }
                                className="box-border w-full min-w-[100px] rounded border border-border-light px-1 py-0.5 font-mono text-[10px]"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="border-t border-border-light p-2">
                      <button
                        type="button"
                        className="rounded-[6px] bg-accent px-3 py-1.5 text-il-btn font-medium text-white"
                        onClick={() => applyCoverageImport()}
                      >
                        {t.fieldMappingUi.coverageApply}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-[8px] border border-border-light">
            <table className="w-full min-w-[680px] table-fixed border-collapse text-left text-[12px]">
              <colgroup>
                <col className="w-[14%]" />
                <col className="w-[14%]" />
                <col className="w-[30%]" />
                <col className="w-[12%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead className="sticky top-0 z-[1] bg-[#f5f8fc] text-text-2">
                <tr>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{t.fieldMappingUi.colOds}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{t.fieldMappingUi.colZhTitle}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium leading-snug">
                    {t.fieldMappingUi.colAliases}
                  </th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{t.fieldMappingUi.colType}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{t.fieldMappingUi.colMatch}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{t.fieldMappingUi.colStatus}</th>
                </tr>
              </thead>
              <tbody
                key={`ctx-${mode}-${mode === 'sheet' ? sheetKey : 'global'}`}
                className="text-text-2"
              >
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-il-meta leading-relaxed text-text-3"
                    >
                      {mode === 'sheet' && rows.length === 0
                        ? t.fieldMappingUi.sheetNoBlockRows
                        : t.fieldMappingUi.tableSearchNoMatch}
                    </td>
                  </tr>
                ) : null}
                {filtered.map((r) => {
                  const draftKey = `${mode}:${mode === 'global' ? '_' : sheetKey}:${r.odsKey}`
                  const ldKey = labelDraftKey(mode, sheetKey, r.odsKey)
                  const textValue = drafts[draftKey] !== undefined ? drafts[draftKey]! : r.aliases.join('\n')
                  const committedLabelRaw =
                    mode === 'global'
                      ? (config.default_fields[r.odsKey]?.label_zh ?? '')
                      : (config.sheets?.[sheetKey]?.[r.odsKey]?.label_zh ?? '')
                  const baselineLabelRaw =
                    mode === 'global'
                      ? (baselineConfig.default_fields[r.odsKey]?.label_zh ?? '')
                      : (baselineConfig.sheets?.[sheetKey]?.[r.odsKey]?.label_zh ?? '')
                  const labelDisplay =
                    drafts[ldKey] !== undefined ? drafts[ldKey]! : committedLabelRaw
                  const baselineAliases =
                    mode === 'sheet'
                      ? getSheetStoredAliases(baselineConfig, sheetKey, r.odsKey)
                      : [...(getEffectiveMapBlock(baselineConfig, null)[r.odsKey] ?? [])]
                  const committedAliasDirty = !aliasListsEqual(r.aliases, baselineAliases)
                  const draftRaw = drafts[draftKey]
                  const draftAliasDirty =
                    draftRaw !== undefined && !aliasListsEqual(parseAliasInputLines(draftRaw), r.aliases)
                  const draftLabelRaw = drafts[ldKey]
                  const committedLabelDirty = committedLabelRaw.trim() !== baselineLabelRaw.trim()
                  const draftLabelDirty =
                    draftLabelRaw !== undefined && draftLabelRaw.trim() !== committedLabelRaw.trim()
                  const rowTouched =
                    committedAliasDirty || draftAliasDirty || committedLabelDirty || draftLabelDirty
                  const labelPh =
                    mode === 'sheet' && r.inheritsLabelDefault
                      ? (r.defaultLabelPlaceholder ?? '').trim() || r.odsKey
                      : undefined
                  const aliasPh =
                    mode === 'sheet' && r.inheritsAliasesDefault
                      ? (r.defaultAliasesPlaceholder ?? '').trim() || undefined
                      : undefined

                  return (
                    <tr
                      key={`${mode}-${mode === 'sheet' ? sheetKey : 'g'}-${r.odsKey}`}
                      className={[
                        'border-b border-border-light/80 last:border-b-0',
                        rowTouched ? 'bg-[#fffbf5]' : '',
                      ].join(' ')}
                    >
                      <td className="align-top px-2.5 py-2 font-mono text-[11px] text-text">{r.odsKey}</td>
                      <td className="align-top px-2.5 py-2">
                        <input
                          type="text"
                          value={labelDisplay}
                          placeholder={labelPh}
                          spellCheck={false}
                          className="box-border w-full max-w-full rounded-[6px] border border-border-light bg-[#fafbfc] px-2 py-1 text-[12px] font-medium text-text outline-none placeholder:text-text-3 focus:border-accent focus:bg-white"
                          onFocus={() => {
                            setDrafts((d) =>
                              d[ldKey] !== undefined ? d : { ...d, [ldKey]: committedLabelRaw },
                            )
                          }}
                          onChange={(e) => {
                            setDrafts((d) => ({ ...d, [ldKey]: e.target.value }))
                            setHint(null)
                            setSaveError(null)
                          }}
                          onBlur={() => {
                            setDrafts((d) => {
                              const raw = d[ldKey] !== undefined ? d[ldKey]! : committedLabelRaw
                              setConfig((c) => applyLabelZhChange(c, mode, sheetKey, r.odsKey, raw))
                              if (d[ldKey] === undefined) return d
                              const next = { ...d }
                              delete next[ldKey]
                              return next
                            })
                          }}
                        />
                      </td>
                      <td className="align-top px-2.5 py-2">
                        <AliasesTextarea
                          value={textValue}
                          placeholder={aliasPh}
                          className="box-border w-full max-w-full resize-none break-words rounded-[6px] border border-border-light bg-[#fafbfc] px-2 py-1 font-mono text-[11px] leading-snug text-text outline-none placeholder:text-text-3 focus:border-accent focus:bg-white"
                          onFocus={() => {
                            setDrafts((d) =>
                              d[draftKey] !== undefined ? d : { ...d, [draftKey]: r.aliases.join('\n') },
                            )
                          }}
                          onChangeText={(s) => {
                            setDrafts((d) => ({ ...d, [draftKey]: s }))
                            setHint(null)
                            setSaveError(null)
                          }}
                          onBlur={() => {
                            setDrafts((d) => {
                              const raw =
                                d[draftKey] !== undefined ? d[draftKey]! : r.aliases.join('\n')
                              const lines = parseAliasInputLines(raw)
                              setConfig((c) => applyAliasChange(c, mode, sheetKey, r.odsKey, lines))
                              if (d[draftKey] === undefined) return d
                              const next = { ...d }
                              delete next[draftKey]
                              return next
                            })
                          }}
                        />
                      </td>
                      <td className="align-top px-2.5 py-2">
                        <span className="text-text-3">{t.fieldMappingUi.valueType[r.valueType]}</span>
                        {r.required ? (
                          <span className="ml-1 text-[10px] text-danger">{t.fieldMappingUi.requiredTag}</span>
                        ) : null}
                      </td>
                      <td className="align-top px-2.5 py-2 text-text-3">
                        {t.fieldMappingUi.matchMode[r.matchMode]}
                      </td>
                      <td className="align-top px-2.5 py-2">
                        {draftAliasDirty || draftLabelDirty ? (
                          <span className="rounded bg-[#fff4e5] px-1.5 py-0.5 text-[11px] text-[#b35900]">
                            {t.fieldMappingUi.statusEditing}
                          </span>
                        ) : committedAliasDirty || committedLabelDirty ? (
                          <span className="rounded bg-[#fdecea] px-1.5 py-0.5 text-[11px] text-[#c42b2b]">
                            {t.fieldMappingUi.statusModified}
                          </span>
                        ) : r.status === 'aligned' ? (
                          <span className="rounded bg-[#e8f5ec] px-1.5 py-0.5 text-[11px] text-[#0d7a3e]">
                            {t.fieldMappingUi.statusAligned}
                          </span>
                        ) : (
                          <span className="rounded bg-[#fff9e9] px-1.5 py-0.5 text-[11px] text-[#8a6d00]">
                            {t.fieldMappingUi.statusReview}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-il-meta leading-snug text-text-3">{t.fieldMappingUi.tableFootnote}</p>
        </Card>
      </div>
    </div>
  )
}
