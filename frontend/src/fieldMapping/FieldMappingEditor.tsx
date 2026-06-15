import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import { fetchImportLimits, postHeaderCoverage, type FieldMappingConfig as ApiFieldMappingConfig } from '../config/localApi'
import { sheetMappingOptionsFallback } from '../config/sheetMappingOptions'
import {
  aliasListsEqual,
  applyAliasChange,
  applyLabelZhChange,
  buildRowsFromConfig,
  cloneMapping,
  fromFallback,
  getEffectiveMapBlock,
  getSheetStoredAliases,
  labelDraftKey,
  mappingConfigsEqual,
  mergeDefaultFieldEntry,
  mergeDraftsForContext,
  mergeSheetFieldEntry,
  normalizeOdsKeyInput,
  odsKeyErrorKind,
  parseAliasInputLines,
  putSheetExplicitInherit,
  sheetEntryHasLocalValue,
  slugFallbackFromHeader,
  type ContextMode,
  type CoverageRow,
} from './fieldMappingEditorModel'

const ALIAS_TEXTAREA_MAX_PX = 280

function syncAliasTextareaHeight(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = '0px'
  const h = Math.max(40, Math.min(ALIAS_TEXTAREA_MAX_PX, el.scrollHeight))
  el.style.height = `${h}px`
  el.style.overflowY = h >= ALIAS_TEXTAREA_MAX_PX ? 'auto' : 'hidden'
}

function AliasesTextarea(props: {
  value: string
  placeholder?: string
  className: string
  disabled?: boolean
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
      disabled={props.disabled}
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

export type FieldMappingEditorMode = 'active' | 'template'

export type FieldMappingSaveMeta = {
  name?: string
  description?: string
}

export type FieldMappingEditorProps = {
  mode: FieldMappingEditorMode
  readOnly?: boolean
  initialConfig: ApiFieldMappingConfig
  /** 变更时从 initialConfig 重置编辑状态 */
  resetKey?: string
  onSave: (
    config: ApiFieldMappingConfig,
    meta?: FieldMappingSaveMeta,
  ) => Promise<{ ok: boolean; error?: string; hint?: string }>
  onSaveAsCopy?: () => void
  onRefresh?: () => Promise<ApiFieldMappingConfig | null>
  onNavUpload?: () => void
  loadError?: string | null
  saveMeta?: FieldMappingSaveMeta
  className?: string
}

const INITIAL_SHEET =
  Object.keys(fromFallback().sheets ?? {})[0] ?? String(sheetMappingOptionsFallback[0] ?? '')

export function FieldMappingEditor(props: FieldMappingEditorProps) {
  const ui = t.fieldMappingUi
  const readOnly = Boolean(props.readOnly)
  const [mode, setMode] = useState<ContextMode>('global')
  const [sheetKey, setSheetKey] = useState<string>(INITIAL_SHEET)
  const [query, setQuery] = useState('')
  const [config, setConfig] = useState<ApiFieldMappingConfig>(() => cloneMapping(props.initialConfig))
  const [baselineConfig, setBaselineConfig] = useState<ApiFieldMappingConfig>(() => cloneMapping(props.initialConfig))
  const [drafts, setDrafts] = useState<Record<string, string>>({})
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
    const next = cloneMapping(props.initialConfig)
    setConfig(next)
    setBaselineConfig(cloneMapping(next))
    setDrafts({})
    setSaveError(null)
    setHint(null)
    setAddPanelOpen(false)
    setCoverageOpen(false)
    setCoverageRows([])
  }, [props.resetKey, props.initialConfig])

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
    if (!props.onRefresh) return
    setBusy('load')
    setSaveError(null)
    setHint(null)
    const next = await props.onRefresh()
    setBusy('idle')
    if (next) {
      setConfig(cloneMapping(next))
      setBaselineConfig(cloneMapping(next))
      setDrafts({})
    } else {
      setSaveError(props.mode === 'active' ? ui.refreshFailed : ui.templatesLoadFailed)
    }
  }

  const handleSave = async () => {
    setBusy('save')
    setSaveError(null)
    setHint(null)
    const merged = mergeDraftsForContext(config, drafts, mode, sheetKey)
    setConfig(merged)
    setDrafts({})
    const r = await props.onSave(merged, props.saveMeta)
    setBusy('idle')
    if (r.ok) {
      setBaselineConfig(cloneMapping(merged))
      setHint(
        r.hint ?? (props.mode === 'template' ? ui.templatesSaveSuccess : ui.saveSuccess),
      )
    } else {
      setSaveError(r.error ?? (props.mode === 'template' ? ui.saveFailed : ui.saveFailed))
    }
  }

  const submitAddField = () => {
    setAddFieldError(null)
    const key = normalizeOdsKeyInput(newOdsKey)
    const kind = odsKeyErrorKind(key)
    if (kind) {
      setAddFieldError(ui.addFieldErr[kind])
      return
    }
    const lz = newLabelZh.trim()
    const aliases = parseAliasInputLines(newAliasesText)
    const finalAliases = aliases.length > 0 ? aliases : lz ? [lz] : []
    if (!lz && finalAliases.length === 0) {
      setAddFieldError(ui.addFieldErr.needContent)
      return
    }
    const labelForStore = lz || finalAliases[0] || key
    const mergedBase = mergeDraftsForContext(config, drafts, mode, sheetKey)
    let next: ApiFieldMappingConfig
    if (mode === 'global') {
      const r = mergeDefaultFieldEntry(mergedBase, key, labelForStore, finalAliases, false)
      if ('err' in r) {
        setAddFieldError(ui.addFieldErr.duplicate)
        return
      }
      next = r.cfg
    } else if (addAlsoToDefault) {
      if (mergedBase.default_fields[key]) {
        setAddFieldError(ui.addFieldErr.duplicateDefault)
        return
      }
      if (mergedBase.sheets?.[sheetKey]?.[key]) {
        setAddFieldError(ui.addFieldErr.duplicateSheet)
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
        setAddFieldError(ui.addFieldErr.duplicate)
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
    setHint(ui.addFieldSuccess)
  }

  const runCoverageOnFile = async (file: File | null) => {
    if (!file) return
    setCoverageBusy(true)
    setCoverageError(null)
    setCoverageRows([])
    const cov = await postHeaderCoverage(file, [sheetKey], undefined, maxUploadMbCap)
    setCoverageBusy(false)
    if (!cov || !cov.ok) {
      setCoverageError(cov?.error?.message ?? ui.coverageFailed)
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
    if (list.length === 0) setCoverageError(ui.coverageEmpty)
    else setHint(ui.coverageHint.replace('{n}', String(list.length)))
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
        setCoverageError(ui.coverageAbortedInvalidKeys)
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
          const rs = mergeSheetFieldEntry(next, sheetKey, keyRaw, labelForStore, aliases, true)
          if ('cfg' in rs) next = rs.cfg
        } else if (hasDefault) {
          const rd = mergeDefaultFieldEntry(next, keyRaw, labelForStore, aliases, true)
          if ('cfg' in rd) next = rd.cfg
        } else {
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
    setHint(ui.coverageImported)
  }

  const saveLabel = props.mode === 'template' ? ui.templatesSaveBtn : ui.saveToYaml
  const canEdit = !readOnly
  const showRefresh = Boolean(props.onRefresh)
  const apiBlocked = props.loadError != null

  return (
    <div className={['flex min-h-0 flex-col', props.className ?? ''].join(' ')}>
      {readOnly ? (
        <div className="mb-4 shrink-0 rounded-[10px] border border-[#ffe0b2] bg-[#fff8e1] px-4 py-3 text-il-meta leading-relaxed text-[#8a6d00]">
          <p>{ui.templatesBuiltinReadOnlyBanner}</p>
          {props.onSaveAsCopy ? (
            <button
              type="button"
              className="mt-2 rounded-[7px] border border-accent bg-accent px-3 py-1.5 text-il-btn font-medium text-white hover:opacity-90"
              onClick={props.onSaveAsCopy}
            >
              {ui.templatesSaveAsCopyBtn}
            </button>
          ) : null}
        </div>
      ) : null}

      {saveError ? <p className="mb-2 text-il-meta text-danger">{saveError}</p> : null}
      {hint ? <p className="mb-2 text-il-meta text-[#0d7a3e]">{hint}</p> : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:items-stretch">
        <Card
          title={ui.contextCardTitle}
          className="shrink-0 lg:w-[min(100%,260px)] lg:shrink-0"
          bodyClassName="space-y-3"
        >
          <div className="flex rounded-[8px] border border-border-light bg-[#fafbfc] p-0.5">
            <button
              type="button"
              disabled={readOnly}
              className={[
                'flex-1 rounded-[6px] px-2 py-1.5 text-il-btn transition-colors',
                mode === 'global' ? 'bg-white font-medium text-accent shadow-sm' : 'text-text-2 hover:text-text',
                readOnly ? 'cursor-default opacity-70' : '',
              ].join(' ')}
              onClick={() => {
                if (readOnly) return
                setConfig((prev) => mergeDraftsForContext(prev, draftsRef.current, mode, sheetKey))
                setDrafts({})
                setMode('global')
              }}
            >
              {ui.modeGlobal}
            </button>
            <button
              type="button"
              disabled={readOnly}
              className={[
                'flex-1 rounded-[6px] px-2 py-1.5 text-il-btn transition-colors',
                mode === 'sheet' ? 'bg-white font-medium text-accent shadow-sm' : 'text-text-2 hover:text-text',
                readOnly ? 'cursor-default opacity-70' : '',
              ].join(' ')}
              onClick={() => {
                if (readOnly) return
                setConfig((prev) => mergeDraftsForContext(prev, draftsRef.current, mode, sheetKey))
                setDrafts({})
                setMode('sheet')
              }}
            >
              {ui.modeSheet}
            </button>
          </div>

          {mode === 'sheet' ? (
            <div>
              <div className="mb-1.5 text-il-label font-medium text-text-2">{ui.sheetPickLabel}</div>
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
                              {ui.sheetHasOverride}
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
            <p className="text-il-meta leading-relaxed text-text-3">{ui.modeGlobalHint}</p>
          )}

          {props.onNavUpload ? (
            <div className="border-t border-border-light pt-3">
              <button
                type="button"
                className="w-full rounded-[7px] border border-border bg-white px-2 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={() => props.onNavUpload!()}
              >
                {ui.gotoUpload}
              </button>
            </div>
          ) : null}
        </Card>

        <Card
          title={ui.tableCardTitle}
          className="min-h-0 min-w-0 flex-1"
          bodyClassName="flex min-h-0 flex-col gap-3"
        >
          <div className="flex flex-col gap-2">
            {mode === 'sheet' ? (
              <p className="text-il-meta leading-snug text-accent-mid">
                {ui.sheetContextBanner.replace('{name}', sheetKey)}
              </p>
            ) : (
              <p className="text-il-meta leading-snug text-text-3">{ui.globalCoverageHint}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                placeholder={ui.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-[160px] flex-1 rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent focus:bg-white sm:max-w-xs"
              />
              {showRefresh ? (
                <button
                  type="button"
                  disabled={busy !== 'idle'}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                  title={ui.refreshTooltip}
                  onClick={() => void handleRefresh()}
                >
                  {busy === 'load' ? ui.busyLoading : ui.refreshFromServer}
                </button>
              ) : null}
              {canEdit ? (
                <button
                  type="button"
                  disabled={busy !== 'idle' || !dirty}
                  className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-medium text-white disabled:opacity-50"
                  title={!dirty ? ui.saveDisabledNoChanges : ui.saveTooltip}
                  onClick={() => void handleSave()}
                >
                  {busy === 'save' ? (props.mode === 'template' ? ui.templatesSaving : ui.busySaving) : saveLabel}
                </button>
              ) : null}
              {canEdit ? (
                <button
                  type="button"
                  disabled={busy !== 'idle'}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                  onClick={() => {
                    setAddFieldError(null)
                    setAddPanelOpen((o) => !o)
                  }}
                >
                  {ui.addFieldToggle}
                </button>
              ) : null}
              {canEdit && mode === 'sheet' ? (
                <button
                  type="button"
                  disabled={busy !== 'idle' || apiBlocked}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                  title={apiBlocked ? ui.loadFromApiFailed : undefined}
                  onClick={() => {
                    setCoverageError(null)
                    setCoverageOpen((o) => !o)
                  }}
                >
                  {ui.coverageToggle}
                </button>
              ) : null}
            </div>

            {canEdit && addPanelOpen ? (
              <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-3 text-[12px]">
                <div className="mb-2 font-medium text-text">{ui.addFieldTitle}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-0.5 block text-il-meta text-text-3">{ui.addFieldOdsLabel}</span>
                    <input
                      type="text"
                      value={newOdsKey}
                      onChange={(e) => setNewOdsKey(e.target.value)}
                      placeholder={ui.addFieldOdsPlaceholder}
                      className="box-border w-full rounded-[6px] border border-border-light bg-white px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-il-meta text-text-3">{ui.addFieldZhLabel}</span>
                    <input
                      type="text"
                      value={newLabelZh}
                      onChange={(e) => setNewLabelZh(e.target.value)}
                      className="box-border w-full rounded-[6px] border border-border-light bg-white px-2 py-1.5 outline-none focus:border-accent"
                    />
                  </label>
                </div>
                <label className="mt-2 block">
                  <span className="mb-0.5 block text-il-meta text-text-3">{ui.addFieldAliasesLabel}</span>
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
                      {ui.addFieldAlsoDefault}
                    </label>
                    {addAlsoToDefault ? (
                      <p className="mt-1.5 pl-6 text-il-meta leading-snug text-text-3">
                        {ui.addFieldAlsoDefaultHint}
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
                    {ui.addFieldSubmit}
                  </button>
                  <button
                    type="button"
                    className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2"
                    onClick={() => {
                      setAddPanelOpen(false)
                      setAddFieldError(null)
                    }}
                  >
                    {ui.addFieldCancel}
                  </button>
                </div>
              </div>
            ) : null}

            {canEdit && mode === 'sheet' && coverageOpen ? (
              <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-3 text-[12px]">
                <div className="mb-2 font-medium text-text">{ui.coverageTitle}</div>
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
                    disabled={coverageBusy || apiBlocked}
                    className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent disabled:opacity-50"
                    onClick={() => coverageFileRef.current?.click()}
                  >
                    {coverageBusy ? ui.coverageRunning : ui.coveragePickFile}
                  </button>
                  <span className="text-il-meta text-text-3">{ui.coverageImportTo}</span>
                  <label className="inline-flex cursor-pointer items-center gap-1 text-il-meta">
                    <input
                      type="radio"
                      name="covdest"
                      checked={coverageDest === 'sheet'}
                      onChange={() => setCoverageDest('sheet')}
                    />
                    {ui.coverageImportSheet}
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1 text-il-meta">
                    <input
                      type="radio"
                      name="covdest"
                      checked={coverageDest === 'sheet_and_default'}
                      onChange={() => setCoverageDest('sheet_and_default')}
                    />
                    {ui.coverageImportSheetAndDefault}
                  </label>
                </div>
                {coverageError ? <p className="mt-2 text-il-meta text-danger">{coverageError}</p> : null}
                <p className="mt-2 text-il-meta text-text-3">{ui.coverageAlsoNote}</p>
                {coverageRows.length > 0 ? (
                  <div className="mt-2 max-h-[220px] overflow-auto rounded-[6px] border border-border-light bg-white">
                    <div className="sticky top-0 flex gap-2 border-b border-border-light bg-[#f5f8fc] px-2 py-1.5 text-[11px] text-text-2">
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => setCoverageRows((rs) => rs.map((r) => ({ ...r, selected: true })))}
                      >
                        {ui.coverageSelectAll}
                      </button>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => setCoverageRows((rs) => rs.map((r) => ({ ...r, selected: false })))}
                      >
                        {ui.coverageSelectNone}
                      </button>
                    </div>
                    <table className="w-full border-collapse text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-border-light bg-[#fafbfc] text-text-2">
                          <th className="w-8 px-1 py-1" />
                          <th className="px-2 py-1">{ui.coverageSheetCol}</th>
                          <th className="px-2 py-1">{ui.coverageHeaderCol}</th>
                          <th className="px-2 py-1">{ui.coverageSlugCol}</th>
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
                                    rs.map((x) => (x.id === row.id ? { ...x, selected: e.target.checked } : x)),
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
                        {ui.coverageApply}
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
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{ui.colOds}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{ui.colZhTitle}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium leading-snug">
                    {ui.colAliases}
                  </th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{ui.colType}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{ui.colMatch}</th>
                  <th className="border-b border-border-light px-2.5 py-2 font-medium">{ui.colStatus}</th>
                </tr>
              </thead>
              <tbody
                key={`ctx-${mode}-${mode === 'sheet' ? sheetKey : 'global'}`}
                className="text-text-2"
              >
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-il-meta leading-relaxed text-text-3">
                      {mode === 'sheet' && rows.length === 0
                        ? ui.sheetNoBlockRows
                        : ui.tableSearchNoMatch}
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
                  const labelDisplay = drafts[ldKey] !== undefined ? drafts[ldKey]! : committedLabelRaw
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
                        rowTouched && canEdit ? 'bg-[#fffbf5]' : '',
                      ].join(' ')}
                    >
                      <td className="align-top px-2.5 py-2 font-mono text-[11px] text-text">{r.odsKey}</td>
                      <td className="align-top px-2.5 py-2">
                        <input
                          type="text"
                          value={labelDisplay}
                          placeholder={labelPh}
                          spellCheck={false}
                          readOnly={readOnly}
                          disabled={readOnly}
                          className="box-border w-full max-w-full rounded-[6px] border border-border-light bg-[#fafbfc] px-2 py-1 text-[12px] font-medium text-text outline-none placeholder:text-text-3 focus:border-accent focus:bg-white disabled:cursor-default disabled:opacity-90"
                          onFocus={() => {
                            if (readOnly) return
                            setDrafts((d) =>
                              d[ldKey] !== undefined ? d : { ...d, [ldKey]: committedLabelRaw },
                            )
                          }}
                          onChange={(e) => {
                            if (readOnly) return
                            setDrafts((d) => ({ ...d, [ldKey]: e.target.value }))
                            setHint(null)
                            setSaveError(null)
                          }}
                          onBlur={() => {
                            if (readOnly) return
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
                          disabled={readOnly}
                          className="box-border w-full max-w-full resize-none break-words rounded-[6px] border border-border-light bg-[#fafbfc] px-2 py-1 font-mono text-[11px] leading-snug text-text outline-none placeholder:text-text-3 focus:border-accent focus:bg-white disabled:cursor-default disabled:opacity-90"
                          onFocus={() => {
                            if (readOnly) return
                            setDrafts((d) =>
                              d[draftKey] !== undefined ? d : { ...d, [draftKey]: r.aliases.join('\n') },
                            )
                          }}
                          onChangeText={(s) => {
                            if (readOnly) return
                            setDrafts((d) => ({ ...d, [draftKey]: s }))
                            setHint(null)
                            setSaveError(null)
                          }}
                          onBlur={() => {
                            if (readOnly) return
                            setDrafts((d) => {
                              const raw = d[draftKey] !== undefined ? d[draftKey]! : r.aliases.join('\n')
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
                        <span className="text-text-3">{ui.valueType[r.valueType]}</span>
                        {r.required ? (
                          <span className="ml-1 text-[10px] text-danger">{ui.requiredTag}</span>
                        ) : null}
                      </td>
                      <td className="align-top px-2.5 py-2 text-text-3">{ui.matchMode[r.matchMode]}</td>
                      <td className="align-top px-2.5 py-2">
                        {canEdit && (draftAliasDirty || draftLabelDirty) ? (
                          <span className="rounded bg-[#fff4e5] px-1.5 py-0.5 text-[11px] text-[#b35900]">
                            {ui.statusEditing}
                          </span>
                        ) : canEdit && (committedAliasDirty || committedLabelDirty) ? (
                          <span className="rounded bg-[#fdecea] px-1.5 py-0.5 text-[11px] text-[#c42b2b]">
                            {ui.statusModified}
                          </span>
                        ) : r.status === 'aligned' ? (
                          <span className="rounded bg-[#e8f5ec] px-1.5 py-0.5 text-[11px] text-[#0d7a3e]">
                            {ui.statusAligned}
                          </span>
                        ) : (
                          <span className="rounded bg-[#fff9e9] px-1.5 py-0.5 text-[11px] text-[#8a6d00]">
                            {ui.statusReview}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-il-meta leading-snug text-text-3">{ui.tableFootnote}</p>
        </Card>
      </div>
    </div>
  )
}
