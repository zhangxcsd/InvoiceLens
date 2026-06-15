import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import {
  fetchDimTaxCodeFilterOptions,
  fetchDimTaxCodeRows,
  postDimTaxCodeImport,
  postDimTaxCodeReapplyRiskRules,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { TaxTreeGrid } from './TaxTreeGrid'
import { useDimDictDomain } from './useDimDict'

type CleanStatus = 'ok' | 'invalid' | 'duplicate'
type RiskLabel = 'NORMAL' | 'HIGH'
type TreeMode = 'code' | 'category'

type TaxCodeRow = {
  taxCode: string
  displayTaxCode?: string
  aggregateCount?: number
  goodsName: string
  goodsShortName: string
  description: string
  parentCode: string | null
  levelDepth: number
  isLeaf: boolean
  fullPath: string
  cleanStatus: CleanStatus
  auditRiskLabel: RiskLabel
  dataVersion: string
  importBatchId: string
  importSessionId: string
  sourceSheet: string
  sourceExcelFile: string
}
type DimTaxImportReceipt = {
  at: string
  ok: boolean
  dryRun: boolean
  message: string
  importBatchId: string
  importSessionId: string
  insertRows: number
  parsedCodes: number
  invalidRows: number
  duplicateRows: number
}

const DIM_TAX_IMPORT_STORAGE_KEY = 'invoicelens_dim_tax_code_import_v1'

type DimTaxImportStrategy = 'full_rebuild' | 'dry_run'

type DimTaxImportForm = {
  dataVersion: string
  strategy: DimTaxImportStrategy
}

const DEFAULT_DIM_TAX_IMPORT_FORM: DimTaxImportForm = {
  dataVersion: '税务总局20171218',
  strategy: 'full_rebuild',
}

function loadDimTaxImportForm(): DimTaxImportForm {
  try {
    const raw = sessionStorage.getItem(DIM_TAX_IMPORT_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_DIM_TAX_IMPORT_FORM }
    const j = JSON.parse(raw) as Record<string, unknown>
    const strategy: DimTaxImportStrategy = j.strategy === 'dry_run' ? 'dry_run' : 'full_rebuild'
    return {
      dataVersion:
        typeof j.dataVersion === 'string' && j.dataVersion.length > 0
          ? j.dataVersion
          : DEFAULT_DIM_TAX_IMPORT_FORM.dataVersion,
      strategy,
    }
  } catch {
    return { ...DEFAULT_DIM_TAX_IMPORT_FORM }
  }
}

function cleanStatusLabel(v: CleanStatus) {
  const ui = t.taxCodeLibraryUi
  if (v === 'ok') return ui.cleanStatusOk
  if (v === 'invalid') return ui.cleanStatusInvalid
  return ui.cleanStatusDuplicate
}

function dedupeByTaxCode(rows: TaxCodeRow[]): TaxCodeRow[] {
  const seen = new Set<string>()
  const out: TaxCodeRow[] = []
  for (const r of rows) {
    if (seen.has(r.taxCode)) continue
    seen.add(r.taxCode)
    out.push(r)
  }
  return out
}

function buildTaxCodeForest(rows: TaxCodeRow[]): {
  roots: TaxCodeRow[]
  byCode: Map<string, TaxCodeRow>
  childMap: Map<string, TaxCodeRow[]>
} {
  const byCode = new Map<string, TaxCodeRow>()
  for (const r of dedupeByTaxCode(rows)) {
    byCode.set(r.taxCode, r)
  }
  const childMap = new Map<string, TaxCodeRow[]>()
  for (const r of byCode.values()) {
    const p = r.parentCode
    if (!p || !byCode.has(p)) continue
    if (!childMap.has(p)) childMap.set(p, [])
    childMap.get(p)!.push(r)
  }
  for (const [, list] of childMap) {
    list.sort((a, b) => a.taxCode.localeCompare(b.taxCode, 'zh-CN'))
  }
  const roots = [...byCode.values()].filter((r) => !r.parentCode || !byCode.has(r.parentCode))
  roots.sort((a, b) => a.taxCode.localeCompare(b.taxCode, 'zh-CN'))
  return { roots, byCode, childMap }
}

function collectExpandableParentCodes(childMap: Map<string, TaxCodeRow[]>): Set<string> {
  const s = new Set<string>()
  for (const [p, kids] of childMap) {
    if (kids.length > 0) s.add(p)
  }
  return s
}

function depthByParentChain(row: TaxCodeRow, byCode: Map<string, TaxCodeRow>): number {
  let d = 1
  let cur: TaxCodeRow | undefined = row
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) {
    const p = cur?.parentCode
    if (!p || seen.has(p)) break
    seen.add(p)
    const parent = byCode.get(p)
    if (!parent) break
    d += 1
    cur = parent
  }
  return d
}

function rowStatusTone(row: Pick<TaxCodeRow, 'cleanStatus' | 'auditRiskLabel'>): 'invalid' | 'duplicate' | 'high' | 'ok' {
  if (row.cleanStatus === 'invalid') return 'invalid'
  if (row.cleanStatus === 'duplicate') return 'duplicate'
  if (row.auditRiskLabel === 'HIGH') return 'high'
  return 'ok'
}

export function TaxCodeLibraryPage(props?: {
  mode?: 'manage' | 'result'
  onOpenResult?: () => void
  onOpenManage?: () => void
}) {
  const ui = t.taxCodeLibraryUi
  const riskLabelDict = useDimDictDomain('audit_risk_label')
  const resultOnly = props?.mode === 'result'
  const viewMode: 'list' | 'hierarchy' = resultOnly ? 'hierarchy' : 'list'
  const pageTitleText = resultOnly ? ui.resultPageTitle : ui.pageTitle
  const pageDescText = resultOnly ? ui.resultPageDesc : ui.pageDesc
  const [keyword, setKeyword] = useState('')
  const [importBatchIdFilter, setImportBatchIdFilter] = useState('all')
  const [importSessionIdFilter, setImportSessionIdFilter] = useState('all')
  const [importBatchOptions, setImportBatchOptions] = useState<string[]>([])
  const [importSessionOptions, setImportSessionOptions] = useState<string[]>([])
  const [cleanFilter, setCleanFilter] = useState<'all' | CleanStatus>('all')
  const [riskFilter, setRiskFilter] = useState<'all' | string>('all')
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [showQualityColumn, setShowQualityColumn] = useState(false)

  const [dimImportForm, setDimImportForm] = useState<DimTaxImportForm>(() => loadDimTaxImportForm())
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const dimImportFileRef = useRef<HTMLInputElement>(null)
  const pickFileBtnRef = useRef<HTMLButtonElement>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importFeedback, setImportFeedback] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [showPickFileHint, setShowPickFileHint] = useState(false)
  const [latestImportReceipt, setLatestImportReceipt] = useState<DimTaxImportReceipt | null>(null)

  const [taxRows, setTaxRows] = useState<TaxCodeRow[]>([])
  const [rowTotal, setRowTotal] = useState(0)
  const [rowsLoading, setRowsLoading] = useState(true)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [kwDebounced, setKwDebounced] = useState('')
  const [reapplyBusy, setReapplyBusy] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setKwDebounced(keyword), 400)
    return () => window.clearTimeout(t)
  }, [keyword])

  const loadDimTaxRows = useCallback(async () => {
    setRowsLoading(true)
    setRowsError(null)
    const effectiveRisk = abnormalOnly ? 'HIGH' : riskFilter
    const res = await fetchDimTaxCodeRows({
      keyword: kwDebounced,
      cleanStatus: cleanFilter,
      risk: effectiveRisk,
      importBatchId: importBatchIdFilter === 'all' ? '' : importBatchIdFilter,
      importSessionId: importSessionIdFilter === 'all' ? '' : importSessionIdFilter,
      abnormalOnly: false,
    })
    if (!res.ok) {
      setRowsError(res.error?.message ?? ui.taxRowsLoadError)
      setTaxRows([])
      setRowTotal(0)
    } else {
      setTaxRows(res.rows as TaxCodeRow[])
      setRowTotal(res.total)
    }
    setRowsLoading(false)
  }, [kwDebounced, cleanFilter, riskFilter, importBatchIdFilter, importSessionIdFilter, abnormalOnly, ui.taxRowsLoadError])

  useEffect(() => {
    void loadDimTaxRows()
  }, [loadDimTaxRows])

  useEffect(() => {
    let mounted = true
    const run = async () => {
      const r = await fetchDimTaxCodeFilterOptions({
        importBatchId: importBatchIdFilter === 'all' ? '' : importBatchIdFilter,
      })
      if (!mounted || !r.ok) return
      setImportBatchOptions(r.importBatchOptions)
      setImportSessionOptions(r.importSessionOptions)
      if (importSessionIdFilter !== 'all' && !r.importSessionOptions.includes(importSessionIdFilter)) {
        setImportSessionIdFilter('all')
      }
    }
    void run()
    return () => {
      mounted = false
    }
  }, [importBatchIdFilter, importSessionIdFilter])

  // 兜底：若后端筛选项接口返回空，则从当前已加载数据中提取可选项，避免下拉框无项可选。
  useEffect(() => {
    if (taxRows.length === 0) return
    if (importBatchOptions.length > 0 && importSessionOptions.length > 0) return

    const batchSet = new Set<string>()
    const sessionSet = new Set<string>()
    for (const row of taxRows) {
      const batch = String(row.importBatchId ?? '').trim()
      const session = String(row.importSessionId ?? '').trim()
      if (batch) batchSet.add(batch)
      if (session && (importBatchIdFilter === 'all' || batch === importBatchIdFilter)) {
        sessionSet.add(session)
      }
    }

    if (importBatchOptions.length === 0 && batchSet.size > 0) {
      setImportBatchOptions([...batchSet].sort((a, b) => b.localeCompare(a, 'zh-CN')))
    }
    if (importSessionOptions.length === 0 && sessionSet.size > 0) {
      setImportSessionOptions([...sessionSet].sort((a, b) => b.localeCompare(a, 'zh-CN')))
    }
  }, [taxRows, importBatchIdFilter, importBatchOptions.length, importSessionOptions.length])

  useEffect(() => {
    if (importBatchIdFilter === 'all' && importBatchOptions.length === 1) {
      setImportBatchIdFilter(importBatchOptions[0])
    }
  }, [importBatchIdFilter, importBatchOptions])

  useEffect(() => {
    if (importSessionIdFilter === 'all' && importSessionOptions.length === 1) {
      setImportSessionIdFilter(importSessionOptions[0])
    }
  }, [importSessionIdFilter, importSessionOptions])

  useEffect(() => {
    sessionStorage.setItem(DIM_TAX_IMPORT_STORAGE_KEY, JSON.stringify(dimImportForm))
  }, [dimImportForm])

  useEffect(() => {
    if (!showPickFileHint) return
    const onFocusIn = (evt: FocusEvent) => {
      if (!pickFileBtnRef.current) {
        setShowPickFileHint(false)
        return
      }
      const targetNode = evt.target as Node | null
      if (!targetNode || !pickFileBtnRef.current.contains(targetNode)) {
        setShowPickFileHint(false)
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [showPickFileHint])

  const runDimTaxImport = useCallback(async () => {
    const v = dimImportForm.dataVersion.trim()
    if (!v) {
      setImportFeedback({ kind: 'err', text: ui.importErrVersion })
      return
    }
    if (!pickedFile) {
      setImportFeedback(null)
      setShowPickFileHint(true)
      return
    }
    setImportFeedback(null)
    setShowPickFileHint(false)
    setImportBusy(true)
    try {
      const r = await postDimTaxCodeImport({
        data_version: v,
        source_path: '',
        strategy: dimImportForm.strategy,
        file: pickedFile,
      })
      if (r.error?.message) {
        setImportFeedback({ kind: 'err', text: r.error.message })
      } else if (r.message) {
        setImportFeedback({ kind: r.ok ? 'ok' : 'info', text: r.message })
      } else {
        setImportFeedback({ kind: 'info', text: ui.importResponseEmpty })
      }
      const stats = r.stats ?? {}
      const recv = r.received ?? {}
      const asNum = (v: unknown) => {
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      }
      setLatestImportReceipt({
        at: new Date().toLocaleString('zh-CN', { hour12: false }),
        ok: !!r.ok,
        dryRun: r.dry_run === true,
        message: r.message ?? '',
        importBatchId: String(recv.import_batch_id ?? ''),
        importSessionId: String(recv.import_session_id ?? ''),
        insertRows: asNum(stats.insert_rows),
        parsedCodes: asNum(stats.parsed_codes),
        invalidRows: asNum(stats.invalid_code_rows),
        duplicateRows: asNum(stats.duplicate_rows),
      })
      if (r.ok && r.dry_run !== true) {
        await loadDimTaxRows()
      }
    } finally {
      setImportBusy(false)
    }
  }, [dimImportForm.dataVersion, dimImportForm.strategy, pickedFile, ui, loadDimTaxRows])

  const displayRows = useMemo(() => dedupeByTaxCode(taxRows), [taxRows])

  const stats = useMemo(() => {
    const total = rowTotal
    const leafOnly = displayRows.filter((r) => r.isLeaf).length
    const invalid = displayRows.filter((r) => r.cleanStatus === 'invalid').length
    const duplicate = displayRows.filter((r) => r.cleanStatus === 'duplicate').length
    return { total, leafOnly, invalid, duplicate }
  }, [displayRows, rowTotal])
  const uniqueGoodsCategoryCount = useMemo(() => {
    const s = new Set<string>()
    for (const row of displayRows) {
      const name = String(row.goodsShortName ?? '').trim() || '（未分类）'
      s.add(name)
    }
    return s.size
  }, [displayRows])
  const uniqueGoodsNameCount = useMemo(() => {
    const s = new Set<string>()
    for (const row of displayRows) {
      const name = String(row.goodsName ?? '').trim() || '（未命名）'
      s.add(name)
    }
    return s.size
  }, [displayRows])

  const { roots, byCode, childMap } = useMemo(() => buildTaxCodeForest(displayRows), [displayRows])
  const importHistoryRows = useMemo(() => {
    const m = new Map<
      string,
      { batch: string; session: string; rows: number; version: string; latestTs: string; latestRaw: number }
    >()
    for (const r of displayRows) {
      const batch = String(r.importBatchId ?? '').trim()
      const session = String(r.importSessionId ?? '').trim()
      if (!batch || !session) continue
      const key = `${batch}__${session}`
      const raw = Date.parse(String(r.dataVersion ?? '')) || 0
      const prev = m.get(key)
      if (!prev) {
        m.set(key, {
          batch,
          session,
          rows: 1,
          version: String(r.dataVersion ?? ''),
          latestTs: String(r.dataVersion ?? ''),
          latestRaw: raw,
        })
      } else {
        prev.rows += 1
        if (raw > prev.latestRaw) {
          prev.latestRaw = raw
          prev.latestTs = String(r.dataVersion ?? '')
          prev.version = String(r.dataVersion ?? '')
        }
      }
    }
    return [...m.values()].sort((a, b) => b.rows - a.rows).slice(0, 8)
  }, [displayRows])

  const runReapplyRiskFromYaml = useCallback(async () => {
    setReapplyBusy(true)
    setImportFeedback(null)
    try {
      const r = await postDimTaxCodeReapplyRiskRules()
      if (!r.ok) {
        setImportFeedback({ kind: 'err', text: r.error?.message ?? ui.reapplyRiskFail })
      } else {
        setImportFeedback({ kind: 'ok', text: r.message ?? ui.reapplyRiskDone })
        await loadDimTaxRows()
      }
    } finally {
      setReapplyBusy(false)
    }
  }, [loadDimTaxRows, ui.reapplyRiskDone, ui.reapplyRiskFail])

  const treePanelRef = useRef<HTMLDivElement>(null)
  const listPanelRef = useRef<HTMLDivElement>(null)
  const [treeMode, setTreeMode] = useState<TreeMode>('code')
  const [hierExpanded, setHierExpanded] = useState<Set<string>>(() => new Set())
  const [categoryExpanded, setCategoryExpanded] = useState<Set<string>>(new Set())
  const allExpandable = useMemo(() => collectExpandableParentCodes(childMap), [childMap])
  const rawMaxHierarchyDepth = useMemo(() => {
    let max = 1
    for (const row of displayRows) {
      max = Math.max(max, depthByParentChain(row, byCode))
    }
    return max
  }, [displayRows, byCode])
  const maxHierarchyDepth = useMemo(() => Math.min(5, Math.max(1, rawMaxHierarchyDepth)), [rawMaxHierarchyDepth])
  const [expandToLevel, setExpandToLevel] = useState(1)
  const quickLevelCandidates = useMemo(() => [2, 3, 4].filter((n) => n <= Math.max(1, maxHierarchyDepth)), [maxHierarchyDepth])
  const [listVisibleDepth, setListVisibleDepth] = useState(1)
  const [listFullscreen, setListFullscreen] = useState(false)
  const [listExpanded, setListExpanded] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setExpandToLevel((prev) => {
      if (maxHierarchyDepth < 1) return 1
      if (prev < 1) return 1
      if (prev > maxHierarchyDepth) return maxHierarchyDepth
      return prev
    })
  }, [maxHierarchyDepth])
  useEffect(() => {
    setListVisibleDepth((prev) => {
      if (maxHierarchyDepth < 1) return 1
      if (prev < 1) return 1
      if (prev > maxHierarchyDepth) return maxHierarchyDepth
      return prev
    })
  }, [maxHierarchyDepth])
  const toggleHierExpand = useCallback((code: string) => {
    setHierExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(code)) n.delete(code)
      else n.add(code)
      return n
    })
  }, [])

  const expandAllHier = useCallback(() => {
    setHierExpanded(new Set(allExpandable))
  }, [allExpandable])

  const collapseAllHier = useCallback(() => {
    setHierExpanded(new Set())
  }, [])

  const expandedSetByLevel = useCallback(
    (targetLevel: number, sourceExpandable: Set<string>, sourceByCode: Map<string, TaxCodeRow>) => {
      const target = Math.max(1, Math.min(targetLevel, maxHierarchyDepth))
      const byLevel = new Set<string>()
      for (const code of sourceExpandable) {
        const row = sourceByCode.get(code)
        if (!row) continue
        if (row.levelDepth < target) byLevel.add(code)
      }
      return byLevel
    },
    [maxHierarchyDepth],
  )

  const expandToTargetLevel = useCallback((targetLevel?: number) => {
    const rawTarget = typeof targetLevel === 'number' ? targetLevel : expandToLevel
    setHierExpanded(expandedSetByLevel(rawTarget, allExpandable, byCode))
  }, [allExpandable, byCode, expandToLevel, expandedSetByLevel])

  const expandCategoryToTargetLevel = useCallback(
    (targetLevel?: number) => {
      const rawTarget = typeof targetLevel === 'number' ? targetLevel : expandToLevel
      setCategoryExpanded(expandedSetByLevel(rawTarget, allExpandable, byCode))
    },
    [allExpandable, byCode, expandToLevel, expandedSetByLevel],
  )
  const toggleListExpand = useCallback((code: string) => {
    setListExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(code)) n.delete(code)
      else n.add(code)
      return n
    })
  }, [])
  useEffect(() => {
    if (viewMode !== 'list') return
    setListExpanded(expandedSetByLevel(listVisibleDepth, allExpandable, byCode))
  }, [viewMode, listVisibleDepth, expandedSetByLevel, allExpandable, byCode])
  const listVisibleRows = useMemo(() => {
    const withinDepth = displayRows.filter((row) => row.levelDepth <= listVisibleDepth)
    return withinDepth.filter((row) => {
      let cur = row
      for (let i = 0; i < 24; i++) {
        const p = cur.parentCode
        if (!p || !byCode.has(p)) return true
        if (!listExpanded.has(p)) return false
        const parent = byCode.get(p)
        if (!parent) return true
        cur = parent
      }
      return true
    })
  }, [displayRows, listVisibleDepth, byCode, listExpanded])

  const [treeFullscreen, setTreeFullscreen] = useState(false)
  useEffect(() => {
    if (viewMode !== 'hierarchy') return
    setExpandToLevel(1)
    if (treeMode === 'category') setCategoryExpanded(new Set())
    else setHierExpanded(new Set())
  }, [viewMode, treeMode])
  useEffect(() => {
    const onFs = () => setTreeFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])
  useEffect(() => {
    const onFs = () => setListFullscreen(document.fullscreenElement === listPanelRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggleCategoryExpand = useCallback((code: string) => {
    setCategoryExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(code)) n.delete(code)
      else n.add(code)
      return n
    })
  }, [])

  const toggleTreeFullscreen = useCallback(async () => {
    const el = treePanelRef.current
    if (!el) return
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch {
      /* 部分浏览器策略下可能失败，忽略 */
    }
  }, [])
  const toggleListFullscreen = useCallback(async () => {
    const el = listPanelRef.current
    if (!el) return
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen()
      } else if (!document.fullscreenElement) {
        await el.requestFullscreen()
      }
    } catch {
      /* 部分浏览器策略下可能失败，忽略 */
    }
  }, [])

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{pageTitleText}</h1>
        </div>
        <p className="mt-2 w-full whitespace-nowrap text-il-page-desc text-text-2">
          {pageDescText}
        </p>
        {resultOnly ? (
          <p className="mt-2 text-il-meta text-text-3">{ui.resultPageNote}</p>
        ) : (
          <p className="mt-2 text-il-meta text-text-3">{ui.prototypeNote}</p>
        )}
      </div>

      {!resultOnly ? (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: ui.kpiTotal, value: stats.total, cls: 'text-text' },
            { label: ui.kpiLeafOnly, value: stats.leafOnly, cls: 'text-accent' },
            { label: ui.kpiInvalidCode, value: stats.invalid, cls: 'text-warn' },
            { label: ui.kpiDuplicateCode, value: stats.duplicate, cls: 'text-[#6b5cb3]' },
          ].map((item) => (
            <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
              <div className="text-il-label text-text-3">{item.label}</div>
              <div className={['mt-1 text-[20px] font-bold tabular-nums', item.cls].join(' ')}>{item.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {stats.invalid + stats.duplicate > 0 ? (
        <div className="mb-5 rounded-[10px] border border-[#ffd9d9] bg-[#fff6f6] px-3 py-2.5 text-il-page-desc text-danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {ui.qualityAlert
                .replace('{invalid}', String(stats.invalid))
                .replace('{duplicate}', String(stats.duplicate))}
            </span>
            <button
              type="button"
              className="rounded-sm border border-danger bg-white px-2.5 py-1 text-il-soon font-semibold text-danger"
              onClick={() => setAbnormalOnly(true)}
            >
              {ui.qualityAlertAction}
            </button>
          </div>
        </div>
      ) : null}

      {!resultOnly ? (
        <Card title={ui.importCardTitle} compact>
          <div className="flex flex-col gap-1.5">
            <div className="flex min-h-[28px] min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-0.5">
              <div className="flex shrink-0 items-center gap-2">
                <label className="w-[4.25rem] shrink-0 text-right text-[12px] font-medium leading-none text-text-2">
                  {ui.importDataVersionLabel}
                </label>
                <input
                  className="h-7 w-[12.5rem] shrink-0 rounded-sm border border-border bg-white px-2 text-[13px] leading-tight text-text outline-none focus:border-accent sm:w-[14rem] md:w-[15rem]"
                  value={dimImportForm.dataVersion}
                  onChange={(e) => setDimImportForm((prev) => ({ ...prev, dataVersion: e.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="w-[4.25rem] shrink-0 text-right text-[12px] font-medium leading-none text-text-2">
                  {ui.importStrategyLabel}
                </label>
                <select
                  className="h-7 w-[22.5rem] shrink-0 rounded-sm border border-border bg-white px-1.5 py-0 text-[12px] leading-tight text-text outline-none focus:border-accent"
                  value={dimImportForm.strategy}
                  onChange={(e) =>
                    setDimImportForm((prev) => ({
                      ...prev,
                      strategy: e.target.value === 'dry_run' ? 'dry_run' : 'full_rebuild',
                    }))
                  }
                  title={
                    dimImportForm.strategy === 'dry_run'
                      ? ui.importStrategyDryRun
                      : ui.importStrategyFullRebuild
                  }
                >
                  <option value="full_rebuild">{ui.importStrategyFullRebuild}</option>
                  <option value="dry_run">{ui.importStrategyDryRun}</option>
                </select>
              </div>
              <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden />
              <div className="flex min-w-0 flex-1 basis-[8rem] items-center gap-x-1.5">
                <input
                  ref={dimImportFileRef}
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    setPickedFile(f ?? null)
                    setShowPickFileHint(false)
                  }}
                />
                <button
                  ref={pickFileBtnRef}
                  type="button"
                  className="shrink-0 rounded-sm border border-accent bg-accent px-2 py-0.5 text-[12px] font-semibold text-white shadow-sm transition hover:brightness-95"
                  onClick={() => {
                    setShowPickFileHint(false)
                    dimImportFileRef.current?.click()
                  }}
                >
                  {ui.importPickFile}
                </button>
                {pickedFile ? (
                  <>
                    <span
                      className="min-w-0 flex-1 basis-0 truncate text-[11px] leading-tight text-text-2"
                      title={pickedFile.name}
                    >
                      {pickedFile.name}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-[11px] font-semibold leading-tight text-accent underline decoration-accent/40 underline-offset-2 hover:brightness-95"
                      onClick={() => {
                        setPickedFile(null)
                        const el = dimImportFileRef.current
                        if (el) el.value = ''
                      }}
                    >
                      {ui.importClearPickedFile}
                    </button>
                  </>
                ) : null}
              </div>
              <button
                type="button"
                disabled={importBusy}
                className={[
                  'shrink-0 rounded-sm border px-2.5 py-1 text-[12px] font-semibold shadow-sm transition',
                  importBusy
                    ? 'cursor-not-allowed border-border bg-[#e8eaee] text-text-3'
                    : 'border-accent bg-accent text-white hover:brightness-95',
                ].join(' ')}
                onClick={() => void runDimTaxImport()}
              >
                {importBusy ? ui.importSubmitting : ui.importAction}
              </button>
            </div>
            {importFeedback ? (
              <div
                className={[
                  'rounded-sm border px-2 py-1.5 text-[12px] leading-snug',
                  importFeedback.kind === 'err'
                    ? 'border-danger bg-[#fff6f6] text-danger'
                    : importFeedback.kind === 'ok'
                      ? 'border-[#2e9b57] bg-[#f4faf6] text-[#1f6d3d]'
                      : 'border-[#c8dff7] bg-[#f0f7ff] text-text',
                ].join(' ')}
              >
                {importFeedback.text}
              </div>
            ) : null}
            {showPickFileHint && !pickedFile ? (
              <div className="rounded-sm border border-[#ffc074] bg-[#fff8ee] px-2 py-1.5 text-[12px] leading-snug text-[#9f5600]">
                {ui.importErrFile} {ui.importErrFileDismissHint}
              </div>
            ) : null}
            <p className="text-[11px] leading-snug text-text-3">
              {ui.importHint} {ui.importPersistHint}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                className="rounded-sm border border-border bg-white px-2.5 py-1 text-[12px] font-semibold text-text hover:border-accent hover:text-accent"
                onClick={() => props?.onOpenResult?.()}
              >
                {ui.openResultPage}
              </button>
              <span className="text-[11px] leading-snug text-text-3">{ui.openResultHint}</span>
            </div>
          </div>
        </Card>
      ) : null}
      {!resultOnly ? (
        <div className="mb-5 flex flex-col gap-3">
          <Card title={ui.importReceiptTitle} compact>
            {latestImportReceipt ? (
              <div className="space-y-1.5 text-[12px] text-text-2">
                <div>{latestImportReceipt.message || '-'}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <div><span className="text-text-3">{ui.importReceiptAt}：</span>{latestImportReceipt.at}</div>
                  <div><span className="text-text-3">{ui.importReceiptRows}：</span>{latestImportReceipt.insertRows}</div>
                  <div className="truncate" title={latestImportReceipt.importBatchId}><span className="text-text-3">{ui.importReceiptBatch}：</span>{latestImportReceipt.importBatchId || '-'}</div>
                  <div className="truncate" title={latestImportReceipt.importSessionId}><span className="text-text-3">{ui.importReceiptSession}：</span>{latestImportReceipt.importSessionId || '-'}</div>
                  <div><span className="text-text-3">{ui.importReceiptParsed}：</span>{latestImportReceipt.parsedCodes}</div>
                  <div><span className="text-text-3">{ui.importReceiptInvalid}：</span>{latestImportReceipt.invalidRows}</div>
                  <div><span className="text-text-3">{ui.importReceiptDuplicate}：</span>{latestImportReceipt.duplicateRows}</div>
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-text-3">{ui.importReceiptEmpty}</div>
            )}
          </Card>
          <Card title={ui.importHistoryTitle} compact>
            {importHistoryRows.length === 0 ? (
              <div className="text-[12px] text-text-3">{ui.importHistoryEmpty}</div>
            ) : (
              <div className="overflow-x-auto rounded-sm border border-border-light">
                <table className="w-full min-w-[620px] border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-border-light bg-[#fafbfd] text-left text-text-3">
                      <th className="px-2 py-1.5 font-medium">{ui.importHistoryBatchCol}</th>
                      <th className="px-2 py-1.5 font-medium">{ui.importHistorySessionCol}</th>
                      <th className="px-2 py-1.5 font-medium">{ui.importHistoryRowsCol}</th>
                      <th className="px-2 py-1.5 font-medium">{ui.importHistoryVersionCol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importHistoryRows.map((row) => (
                      <tr key={`${row.batch}_${row.session}`} className="border-b border-border-light last:border-b-0 text-text-2">
                        <td className="px-2 py-1.5 font-mono">{row.batch}</td>
                        <td className="px-2 py-1.5 font-mono">{row.session}</td>
                        <td className="px-2 py-1.5">{row.rows}</td>
                        <td className="px-2 py-1.5">{row.version || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {resultOnly ? <Card title={ui.filterTitle}>
        <div className="flex flex-nowrap items-end gap-3 overflow-x-auto pb-1">
          <div className="min-w-[320px] shrink-0">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.keywordLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
            />
          </div>
          <div className="min-w-[140px] shrink-0">
            <label className="mb-1 flex items-center gap-1 text-il-label font-medium text-text-2">
              <span>{ui.cleanStatusLabel}</span>
              <span
                className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] text-text-3"
                title={ui.cleanStatusHelp}
                aria-label={ui.cleanStatusHelp}
              >
                ?
              </span>
            </label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={cleanFilter}
              onChange={(e) => setCleanFilter(e.target.value as 'all' | CleanStatus)}
            >
              <option value="all">{ui.cleanStatusAll}</option>
              <option value="ok">{ui.cleanStatusOk}</option>
              <option value="invalid">{ui.cleanStatusInvalid}</option>
              <option value="duplicate">{ui.cleanStatusDuplicate}</option>
            </select>
          </div>
          <div className="min-w-[140px] shrink-0">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.riskLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value)}
            >
              <option value="all">{ui.riskAll}</option>
              {riskLabelDict.options.map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[140px] shrink-0 self-center pt-5">
            <label className="inline-flex cursor-pointer items-center gap-2 text-il-page-desc text-text-2">
              <input type="checkbox" checked={abnormalOnly} onChange={(e) => setAbnormalOnly(e.target.checked)} />
              <span>{ui.abnormalOnlyToggle}</span>
            </label>
          </div>
          <div className="min-w-[220px] shrink-0">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.filterImportBatchLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={importBatchIdFilter}
              onChange={(e) => setImportBatchIdFilter(e.target.value)}
            >
              <option value="all">{ui.filterImportBatchPlaceholder}</option>
              {importBatchOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[220px] shrink-0">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.filterImportSessionLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={importSessionIdFilter}
              onChange={(e) => setImportSessionIdFilter(e.target.value)}
            >
              <option value="all">{ui.filterImportSessionPlaceholder}</option>
              {importSessionOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          {viewMode === 'list' ? (
            <div className="min-w-[220px] shrink-0 self-center pt-5">
              <label className="inline-flex cursor-pointer items-center gap-2 text-il-page-desc text-text-2">
                <input
                  type="checkbox"
                  checked={showQualityColumn}
                  onChange={(e) => setShowQualityColumn(e.target.checked)}
                />
                <span>{ui.showQualityColumnToggle}</span>
                <span
                  className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] text-text-3"
                  title={ui.cleanStatusHelp}
                  aria-label={ui.cleanStatusHelp}
                >
                  ?
                </span>
              </label>
            </div>
          ) : null}
        </div>
        {viewMode === 'list' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-light pt-3">
            <button
              type="button"
              disabled={reapplyBusy || rowsLoading}
              className={[
                'rounded-sm border px-2.5 py-1 text-[12px] font-semibold shadow-sm transition',
                reapplyBusy || rowsLoading
                  ? 'cursor-not-allowed border-border bg-[#e8eaee] text-text-3'
                  : 'border-accent bg-accent text-white hover:brightness-95',
              ].join(' ')}
              onClick={() => void runReapplyRiskFromYaml()}
            >
              {reapplyBusy ? ui.reapplyRiskBusy : ui.reapplyRiskBtn}
            </button>
            <span className="max-w-[640px] text-[11px] leading-snug text-text-3">{ui.reapplyRiskHint}</span>
          </div>
        ) : null}
      </Card> : null}

      {resultOnly && viewMode === 'list' ? (
        <Card title={ui.tableTitle}>
            <div
              ref={listPanelRef}
              data-testid="tax-list-panel"
              className="rounded-sm border border-border-light bg-white p-2 [&:fullscreen]:flex [&:fullscreen]:h-screen [&:fullscreen]:max-h-screen [&:fullscreen]:flex-col [&:fullscreen]:overflow-hidden [&:fullscreen]:bg-white [&:fullscreen]:p-4"
            >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border-light pb-2 [&:fullscreen]:sticky [&:fullscreen]:top-0 [&:fullscreen]:z-10 [&:fullscreen]:bg-white">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-sm border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text hover:border-accent hover:text-accent"
                  onClick={() => {
                    const depth = Math.max(1, maxHierarchyDepth)
                    setListVisibleDepth(depth)
                    setListExpanded(expandedSetByLevel(depth, allExpandable, byCode))
                  }}
                >
                  {ui.hierarchyToolbarExpandAll}
                </button>
                <button
                  type="button"
                  className="rounded-sm border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text hover:border-accent hover:text-accent"
                  onClick={() => {
                    setListVisibleDepth(1)
                    setListExpanded(new Set())
                  }}
                >
                  {ui.hierarchyToolbarCollapseAll}
                </button>
                <div className="inline-flex items-center gap-1.5 rounded-sm border border-border-light bg-[#fafbfd] px-2 py-1.5">
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, maxHierarchyDepth)}
                    className="h-7 w-16 rounded-sm border border-border bg-white px-2 text-[12px] text-text outline-none focus:border-accent"
                    value={listVisibleDepth}
                    onChange={(e) => {
                      const parsed = Number(e.target.value)
                      if (!Number.isFinite(parsed)) return
                      const next = Math.max(1, Math.min(Math.trunc(parsed), Math.max(1, maxHierarchyDepth)))
                      setListVisibleDepth(next)
                      setListExpanded(expandedSetByLevel(next, allExpandable, byCode))
                    }}
                  />
                </div>
                {quickLevelCandidates.length > 0 ? (
                  <div className="inline-flex items-center gap-1.5 rounded-sm border border-border-light bg-white px-2 py-1.5">
                    <span className="text-[12px] text-text-3">{ui.hierarchyToolbarQuickLevelPrefix}</span>
                    {quickLevelCandidates.map((lvl) => (
                      <button
                        key={`list_quick_${lvl}`}
                        type="button"
                        className="rounded-sm border border-border px-2 py-1 text-[12px] font-semibold text-text-2 hover:border-accent hover:text-accent"
                        onClick={() => {
                          setListVisibleDepth(lvl)
                          setListExpanded(expandedSetByLevel(lvl, allExpandable, byCode))
                        }}
                      >
                        {lvl}层
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-sm border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-text-2 hover:border-accent hover:text-accent"
                onClick={toggleListFullscreen}
              >
                {listFullscreen ? ui.hierarchyToolbarExitFullscreen : ui.hierarchyToolbarFullscreen}
              </button>
            </div>
            <div className="mb-2 text-il-meta text-text-3">
              {ui.tableHint.replace('{count}', String(rowTotal))}
              {rowsLoading ? ` · ${ui.taxRowsLoading}` : ''}
            </div>
            <div className="overflow-x-auto rounded-sm border border-border-light [&:fullscreen]:flex-1">
              <table className="w-full min-w-[1720px] border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="w-[220px] min-w-[220px] px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colTaxCode}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">tax_code</span></th>
                    <th className="w-[180px] min-w-[180px] px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colGoodsName}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">goods_name</span></th>
                    <th className="w-[100px] min-w-[100px] px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colGoodsCategory}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">goods_short_name</span></th>
                    <th className="w-[360px] min-w-[360px] px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colRemark}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">description</span></th>
                    <th className="px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colDepth}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">level_depth</span></th>
                    <th className="px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colLeaf}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">is_leaf</span></th>
                    <th className="px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colPath}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">full_path</span></th>
                    {showQualityColumn ? <th className="px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colCleanStatus}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">clean_status</span></th> : null}
                    <th className="px-3 py-2 font-medium"><span className="block leading-tight text-text-2">{ui.colRisk}</span><span className="mt-0.5 inline-block rounded bg-[#f1f4f8] px-1.5 py-px font-mono text-[10px] font-normal tracking-wide text-text-3/80">audit_risk_label</span></th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {rowsLoading ? (
                    <tr>
                      <td
                        colSpan={showQualityColumn ? 9 : 8}
                        className="px-3 py-8 text-center text-text-3"
                      >
                        {ui.taxRowsLoading}
                      </td>
                    </tr>
                  ) : rowsError ? (
                    <tr>
                      <td colSpan={showQualityColumn ? 9 : 8} className="px-3 py-8 text-center text-danger">
                        {rowsError}
                      </td>
                    </tr>
                  ) : listVisibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={showQualityColumn ? 9 : 8} className="px-3 py-8 text-center text-text-3">
                        {ui.taxRowsEmpty}
                      </td>
                    </tr>
                  ) : (
                    listVisibleRows.map((row, idx) => {
                      const hasVisibleKids = (childMap.get(row.taxCode) ?? []).some((kid) => kid.levelDepth <= listVisibleDepth)
                      const open = hasVisibleKids ? listExpanded.has(row.taxCode) : false
                      return (
                      <tr
                        key={`${row.taxCode}_${idx}`}
                        className={[
                          'border-b border-border-light last:border-b-0',
                          hasVisibleKids ? 'cursor-pointer hover:bg-[#f7f9fc]' : '',
                        ].join(' ')}
                        onClick={() => {
                          if (hasVisibleKids) toggleListExpand(row.taxCode)
                        }}
                      >
                        <td className="px-3 py-2.5 font-mono text-[12px] text-text">
                          <div className="relative flex min-h-[20px] items-center">
                            {Array.from({ length: Math.max(0, row.levelDepth - 1) }).map((_, idx) => (
                              <span
                                key={`guide_${row.taxCode}_${idx}`}
                                aria-hidden
                                className="absolute top-[-8px] bottom-[-8px] border-l border-border-light"
                                style={{ left: idx * 16 + 8 }}
                              />
                            ))}
                            <span
                              aria-hidden
                              className="inline-block shrink-0"
                              style={{ width: Math.max(0, row.levelDepth - 1) * 16 }}
                            />
                            {row.levelDepth > 1 ? (
                              <span
                                aria-hidden
                                className="mr-1 inline-block h-0 w-2 shrink-0 border-t border-border-light"
                              />
                            ) : null}
                            {hasVisibleKids ? (
                              <span className="mr-1 inline-flex h-3 w-3 items-center justify-center text-[9px] text-text-3">
                                {open ? '▼' : '▶'}
                              </span>
                            ) : (
                              <span className="mr-1 inline-block w-3" aria-hidden />
                            )}
                            <span className="inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-[#d2d8e1]" />
                            <span className="ml-1">{row.taxCode}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-medium text-text">{row.goodsName}</td>
                        <td className="w-[100px] min-w-[100px] px-3 py-2.5" title={row.goodsShortName || '-'}>
                          <span className="block truncate">{row.goodsShortName || '-'}</span>
                        </td>
                        <td
                          className={[
                            'w-[360px] min-w-[360px] px-3 py-2.5',
                            String(row.description ?? '').trim() ? 'text-text-2' : 'text-text-3',
                          ].join(' ')}
                          title={String(row.description ?? '').trim() || '无'}
                        >
                          {String(row.description ?? '').trim() || '无'}
                        </td>
                        <td className="px-3 py-2.5">{row.levelDepth}</td>
                        <td className="px-3 py-2.5">{row.isLeaf ? ui.leafYes : ui.leafNo}</td>
                        <td className="max-w-[360px] px-3 py-2.5">{row.fullPath}</td>
                        {showQualityColumn ? (
                          <td className="px-3 py-2.5">{cleanStatusLabel(row.cleanStatus as CleanStatus)}</td>
                        ) : null}
                        <td className="px-3 py-2.5">
                          <span
                            className={[
                              'rounded px-1.5 py-0.5 text-il-soon font-semibold',
                              row.auditRiskLabel === 'HIGH'
                                ? 'bg-[#fff2f2] text-danger'
                                : 'bg-[#f3f6fa] text-text-2',
                            ].join(' ')}
                          >
                            {riskLabelDict.getLabel(row.auditRiskLabel)}
                          </span>
                        </td>
                      </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            </div>
        </Card>
      ) : resultOnly ? (
        <Card title={resultOnly ? '' : ui.hierarchyCardTitle}>
          {resultOnly ? null : <p className="mb-2 text-[12px] leading-snug text-text-3">{ui.hierarchyHint}</p>}
          <div
            ref={treePanelRef}
            data-testid="tax-tree-panel"
            className="rounded-sm border border-border-light bg-white px-0.5 py-0.5 [&:fullscreen]:flex [&:fullscreen]:h-screen [&:fullscreen]:max-h-screen [&:fullscreen]:flex-col [&:fullscreen]:overflow-hidden [&:fullscreen]:bg-white [&:fullscreen]:p-4"
          >
            <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-light pb-3 [&:fullscreen]:sticky [&:fullscreen]:top-0 [&:fullscreen]:z-10 [&:fullscreen]:bg-white">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-sm border border-border bg-white p-1">
                  <button
                    type="button"
                    className={[
                      'rounded-sm px-2.5 py-1.5 text-[12px] font-semibold transition',
                      treeMode === 'code' ? 'bg-[#f0f7ff] text-accent' : 'text-text-2 hover:text-accent',
                    ].join(' ')}
                    onClick={() => setTreeMode('code')}
                  >
                    {ui.hierarchyTreeModeCode}
                  </button>
                  <button
                    type="button"
                    className={[
                      'rounded-sm px-2.5 py-1.5 text-[12px] font-semibold transition',
                      treeMode === 'category' ? 'bg-[#f0f7ff] text-accent' : 'text-text-2 hover:text-accent',
                    ].join(' ')}
                    onClick={() => setTreeMode('category')}
                  >
                    {ui.hierarchyTreeModeCategory}
                  </button>
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className="ml-1 border-l border-border-light pl-3 rounded-sm border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text hover:border-accent hover:text-accent"
                  onClick={() => {
                    if (treeMode === 'category') setCategoryExpanded(new Set())
                    else collapseAllHier()
                  }}
                >
                  {ui.hierarchyToolbarCollapseAll}
                </button>
                <div className="inline-flex items-center gap-1.5 rounded-sm border border-border-light bg-[#fafbfd] px-2 py-1.5">
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, maxHierarchyDepth)}
                    className="h-7 w-16 rounded-sm border border-border bg-white px-2 text-[12px] text-text outline-none focus:border-accent"
                    value={expandToLevel}
                    onChange={(e) => {
                      const parsed = Number(e.target.value)
                      if (!Number.isFinite(parsed)) return
                      const next = Math.max(1, Math.min(Math.trunc(parsed), Math.max(1, maxHierarchyDepth)))
                      setExpandToLevel(next)
                      if (treeMode === 'category') expandCategoryToTargetLevel(next)
                      else expandToTargetLevel(next)
                    }}
                  />
                </div>
                {quickLevelCandidates.length > 0 ? (
                  <div className="inline-flex items-center gap-1.5 rounded-sm border border-border-light bg-white px-2 py-1.5">
                    <span className="text-[12px] text-text-3">{ui.hierarchyToolbarQuickLevelPrefix}</span>
                    {quickLevelCandidates.map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        className="rounded-sm border border-border px-2 py-1 text-[12px] font-semibold text-text-2 hover:border-accent hover:text-accent"
                        onClick={() => {
                          setExpandToLevel(lvl)
                          if (treeMode === 'category') expandCategoryToTargetLevel(lvl)
                          else expandToTargetLevel(lvl)
                        }}
                      >
                        {lvl}层
                      </button>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="rounded-sm border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text hover:border-accent hover:text-accent"
                  onClick={() => {
                    const depth = Math.max(1, maxHierarchyDepth)
                    setExpandToLevel(depth)
                    if (treeMode === 'category') setCategoryExpanded(new Set(allExpandable))
                    else expandAllHier()
                  }}
                >
                  {ui.hierarchyToolbarExpandAll}
                </button>
                <button
                  type="button"
                  className="rounded-sm border border-border bg-white px-3 py-1.5 text-[13px] font-semibold text-text-2 hover:border-accent hover:text-accent"
                  onClick={toggleTreeFullscreen}
                >
                  {treeFullscreen ? ui.hierarchyToolbarExitFullscreen : ui.hierarchyToolbarFullscreen}
                </button>
              </div>
            </div>

            <div className="mb-2 shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-3 [&:fullscreen]:sticky [&:fullscreen]:top-[42px] [&:fullscreen]:z-10 [&:fullscreen]:bg-white [&:fullscreen]:pb-2">
              <span className="font-medium text-text-2">{ui.hierarchyLegendTitle}</span>
              {treeMode === 'category' ? (
                <span className="rounded-sm border border-border-light bg-[#f7f9fc] px-2 py-0.5 text-[11px] text-text-2">
                  {ui.hierarchyCategoryUniqueCount.replace('{n}', String(uniqueGoodsCategoryCount))}
                </span>
              ) : (
                <span className="rounded-sm border border-border-light bg-[#f7f9fc] px-2 py-0.5 text-[11px] text-text-2">
                  {ui.hierarchyGoodsNameUniqueCount.replace('{n}', String(uniqueGoodsNameCount))}
                </span>
              )}
              {[
                { dot: 'bg-[#2e9b57]', label: ui.hierarchyLegendOk },
                { dot: 'bg-warn', label: ui.hierarchyLegendInvalid },
                { dot: 'bg-[#6b5cb3]', label: ui.hierarchyLegendDuplicate },
                { dot: 'bg-danger', label: ui.hierarchyLegendHigh },
              ].map((leg) => (
                <span key={leg.label} className="inline-flex items-center gap-1">
                  <span className={['inline-block h-1.5 w-1.5 rounded-full', leg.dot].join(' ')} />
                  {leg.label}
                </span>
              ))}
            </div>
            <div className="mb-1 flex items-center border-b border-border-light pb-1 text-[12px] font-medium text-text-2">
              <div className="min-w-0 flex-1">{ui.hierarchyNodeColTitle}</div>
              {treeMode === 'code' ? (
                <>
                  <div className="min-w-[140px] w-[18%] max-w-[260px] border-l border-border-light pl-3">
                    {ui.hierarchyTaxCategoryColTitle}
                  </div>
                  <div className="min-w-[220px] w-[30%] max-w-[560px] border-l border-border-light pl-3">{ui.colRemark}</div>
                </>
              ) : (
                <>
                  <div className="min-w-[220px] w-[22%] max-w-[360px] border-l border-border-light pl-3">{ui.colTaxCode}</div>
                  <div className="min-w-[260px] w-[26%] max-w-[420px] border-l border-border-light pl-3">{ui.colGoodsName}</div>
                  <div className="min-w-[220px] w-[30%] max-w-[560px] border-l border-border-light pl-3">{ui.colRemark}</div>
                </>
              )}
            </div>

            <div className="min-h-0 overflow-auto [&:fullscreen]:flex-1">
              {treeMode === 'code' ? (
                <TaxTreeGrid
                  roots={roots}
                  childMap={childMap}
                  byCode={byCode}
                  expanded={hierExpanded}
                  onToggleExpand={toggleHierExpand}
                  compareColumns={['goodsShortName', 'description']}
                  cleanStatusLabel={cleanStatusLabel}
                  rowStatusTone={rowStatusTone}
                />
              ) : (
                <TaxTreeGrid
                  roots={roots}
                  childMap={childMap}
                  byCode={byCode}
                  expanded={categoryExpanded}
                  onToggleExpand={toggleCategoryExpand}
                  nodeTitleField="goodsShortName"
                  hideDuplicateTitleWithParent
                  showInlineTaxCode={false}
                  compareColumns={['taxCode', 'goodsName', 'description']}
                  cleanStatusLabel={cleanStatusLabel}
                  rowStatusTone={rowStatusTone}
                />
              )}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
