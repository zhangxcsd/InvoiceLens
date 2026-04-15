import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  deleteOdsPreviewImport,
  fetchOdsPreviewBatches,
  fetchOdsPreviewSessionMeta,
  fetchOdsPreviewTablePage,
  odsPreviewBatchKey,
  type OdsPreviewBatchMeta,
} from '../config/localApi'
import type { NavKey } from '../types'

type PreviewColumn = { field: string; labelZh: string }
type TabMeta = { title: string; tableType: string }

export type PreviewBatch = {
  id: string
  batchId: string
  sessionId: string
  loadedAtLabel: string
  successFiles: number
  totalFiles: number
  failedFiles: number
  attachmentCount: number
  /** 与 sheet_mapping.yaml 顺序一致、且本批次有数据的 Tab 标题（由 API tab_order 提供） */
  tabOrder?: string[]
  tabOrderMeta?: TabMeta[]
  tables: Record<
    string,
    {
      columns: PreviewColumn[]
      rows: Array<Record<string, string>>
      fieldMappingSheetKey?: string
      pageLoaded?: boolean
      hasMore?: boolean
      nextCursor?: Record<string, unknown> | null
      pageSize?: number
    }
  >
}

function visibleTableKeys(batch: PreviewBatch): string[] {
  // 懒加载：Tab 列表来自后端 meta（不依赖是否已加载 rows）
  if (batch.tabOrder && batch.tabOrder.length > 0) return batch.tabOrder
  if (batch.tabOrderMeta && batch.tabOrderMeta.length > 0) return batch.tabOrderMeta.map((x) => x.title)
  const keys = Object.keys(batch.tables ?? {})
  return keys.sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function formatLoadTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace('T', ' ')
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

function batchOptionLabel(b: PreviewBatch): string {
  return `${b.batchId} · ${b.sessionId} · ${b.loadedAtLabel} · ${b.successFiles}/${b.totalFiles} ${t.dataPreviewUi.optionFilesOk}`
}

export function DataPreviewPage(props: { onNav: (k: NavKey) => void }) {
  const [liveList, setLiveList] = useState<OdsPreviewBatchMeta[]>([])
  const [liveTables, setLiveTables] = useState<Record<string, PreviewBatch['tables']>>({})
  const [liveTabOrder, setLiveTabOrder] = useState<Record<string, string[]>>({})
  const [liveTabMeta, setLiveTabMeta] = useState<Record<string, TabMeta[]>>({})
  const [odsRootPath, setOdsRootPath] = useState<string>('')
  const [previewListError, setPreviewListError] = useState<string | null>(null)
  const [sessionWarnings, setSessionWarnings] = useState<string[]>([])
  const [rowLimitCap, setRowLimitCap] = useState(200)
  const [loadMoreBusyKey, setLoadMoreBusyKey] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [activeTab, setActiveTab] = useState<string>('')
  const [fileFilter, setFileFilter] = useState<string>('__all__')
  const [tableSearch, setTableSearch] = useState('')
  const [viewMode, setViewMode] = useState<'std' | 'raw'>('std')
  const [busy, setBusy] = useState(false)
  const [bootstrapDone, setBootstrapDone] = useState(false)
  const [deleteDialog, setDeleteDialog] = useState<'session' | 'batch' | null>(null)
  const [deleteAck, setDeleteAck] = useState(false)
  const [batchConfirmInput, setBatchConfirmInput] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const listReqSeqRef = useRef(0)
  const listAbortRef = useRef<AbortController | null>(null)

  const batches: PreviewBatch[] = useMemo(() => {
    if (!bootstrapDone) return []
    if (liveList.length === 0) return []
    return liveList.map((m) => {
      const kid = odsPreviewBatchKey(m)
      const cacheKey = `${kid}::${viewMode}`
      return {
        id: kid,
        batchId: m.batch_id,
        sessionId: m.session_id,
        loadedAtLabel: formatLoadTime(m.load_time),
        successFiles: m.success_count,
        totalFiles: m.file_count,
        failedFiles: m.fail_count,
        attachmentCount: 0,
        tabOrder: liveTabOrder[cacheKey],
        tabOrderMeta: liveTabMeta[cacheKey],
        tables: liveTables[cacheKey] ?? {},
      }
    })
  }, [bootstrapDone, liveList, liveTables, liveTabOrder, liveTabMeta, viewMode])

  const current = useMemo(() => batches.find((b) => b.id === selectedId) ?? null, [batches, selectedId])

  const sessionsInSameBatch = useMemo(() => {
    if (!current) return 0
    return liveList.filter((m) => m.batch_id === current.batchId).length
  }, [liveList, current])

  const visibleTabs = useMemo(() => (current ? visibleTableKeys(current) : []), [current])

  useEffect(() => {
    if (visibleTabs.length === 0) return
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0]!)
    }
  }, [visibleTabs, activeTab])

  useEffect(() => {
    setFileFilter('__all__')
  }, [selectedId, activeTab])
  useEffect(() => {
    setTableSearch('')
  }, [viewMode, selectedId, activeTab])

  const reloadFromApi = useCallback(async () => {
    const mySeq = ++listReqSeqRef.current
    if (listAbortRef.current) {
      try {
        listAbortRef.current.abort()
      } catch {
        // ignore
      }
    }
    const ac = new AbortController()
    listAbortRef.current = ac

    setBusy(true)
    setSessionWarnings([])
    try {
      const rb = await fetchOdsPreviewBatches(ac.signal, 80)
      if (mySeq !== listReqSeqRef.current) return
      if (rb.ods_dir_hint) setOdsRootPath(rb.ods_dir_hint)
      if (rb.ok && rb.batches.length > 0) {
        setPreviewListError(null)
        setLiveList(rb.batches)
        setLiveTables({})
        setLiveTabOrder({})
        let targetFromUrl: string | null = null
        try {
          const sp = new URL(window.location.href).searchParams
          const b = (sp.get('batch_id') ?? '').trim()
          const s = (sp.get('session_id') ?? '').trim()
          if (b && s) targetFromUrl = `${b}::${s}`
        } catch {
          // ignore
        }
        setSelectedId((prev) => {
          const pick =
            targetFromUrl && rb.batches!.some((m) => odsPreviewBatchKey(m) === targetFromUrl)
              ? targetFromUrl
              : prev && rb.batches!.some((m) => odsPreviewBatchKey(m) === prev)
                ? prev
                : odsPreviewBatchKey(rb.batches![0]!)
          return pick
        })
      } else {
        setLiveList([])
        setLiveTables({})
        setLiveTabOrder({})
        setSelectedId('')
        setPreviewListError(
          rb.ok ? null : (rb.error?.message ?? rb.error?.detail ?? '无法加载批次列表'),
        )
      }
    } finally {
      if (mySeq !== listReqSeqRef.current) return
      setBusy(false)
      setBootstrapDone(true)
    }
  }, [])

  const openDeleteSession = () => {
    setDeleteError(null)
    setDeleteAck(false)
    setDeleteDialog('session')
  }

  const openDeleteBatch = () => {
    setDeleteError(null)
    setDeleteAck(false)
    setBatchConfirmInput('')
    setDeleteDialog('batch')
  }

  const closeDeleteDialog = () => {
    if (deleteBusy) return
    setDeleteDialog(null)
    setDeleteError(null)
    setDeleteAck(false)
    setBatchConfirmInput('')
  }

  const runDelete = async () => {
    if (!current || !deleteDialog) return
    if (!deleteAck) {
      setDeleteError('请勾选确认项')
      return
    }
    if (deleteDialog === 'batch' && batchConfirmInput.trim() !== current.batchId.trim()) {
      setDeleteError(t.dataPreviewUi.deleteConfirmMismatch)
      return
    }
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const r =
        deleteDialog === 'session'
          ? await deleteOdsPreviewImport({
              scope: 'session',
              batch_id: current.batchId,
              session_id: current.sessionId,
            })
          : await deleteOdsPreviewImport({
              scope: 'batch',
              batch_id: current.batchId,
            })
      if (!r.ok) {
        setDeleteError(r.error?.message ?? r.error?.detail ?? t.dataPreviewUi.deleteErrorPrefix)
        return
      }
      setDeleteDialog(null)
      setDeleteError(null)
      setDeleteAck(false)
      setBatchConfirmInput('')
      await reloadFromApi()
    } finally {
      setDeleteBusy(false)
    }
  }

  useEffect(() => {
    void reloadFromApi()
  }, [reloadFromApi])

  useEffect(() => {
    return () => {
      try {
        listAbortRef.current?.abort()
      } catch {
        // ignore
      }
    }
  }, [])

  useEffect(() => {
    if (liveList.length === 0) return
    const meta = liveList.find((m) => odsPreviewBatchKey(m) === selectedId)
    if (!meta) return
    const cacheKey = `${selectedId}::${viewMode}`
    // 先加载 Tab 元信息（不读 parquet），再按需加载当前 Tab 的表数据
    if (cacheKey in liveTabMeta && cacheKey in liveTables) return

    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      const rm = await fetchOdsPreviewSessionMeta(meta.batch_id, meta.session_id, ac.signal, viewMode)
      if (cancelled) return
      if (!rm.ok) {
        setSessionWarnings([rm.error?.message ?? '加载会话失败'])
        setLiveTables((p) => ({ ...p, [cacheKey]: {} }))
        setLiveTabOrder((p) => ({ ...p, [cacheKey]: [] }))
        setLiveTabMeta((p) => ({ ...p, [cacheKey]: [] }))
        return
      }
      setSessionWarnings(rm.warnings ?? [])

      const metaArr: TabMeta[] = (rm.tab_order_meta ?? []).map((x) => ({
        title: x.title,
        tableType: x.table_type,
      }))
      setLiveTabMeta((p) => ({ ...p, [cacheKey]: metaArr }))
      setLiveTabOrder((p) => ({ ...p, [cacheKey]: rm.tab_order ?? [] }))
      // 初始化本会话缓存容器（后续按 Tab 填充）
      setLiveTables((p) => ({ ...p, [cacheKey]: p[cacheKey] ?? {} }))
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [selectedId, liveList, liveTables, liveTabMeta, viewMode])

  // 当前 Tab：首屏游标分页第一页（切换 Tab / 视图后重新拉取）
  useEffect(() => {
    if (!current || !activeTab) return
    const meta = liveList.find((m) => odsPreviewBatchKey(m) === selectedId)
    if (!meta) return
    const cacheKey = `${selectedId}::${viewMode}`
    const pack = liveTables[cacheKey]?.[activeTab]
    if (pack?.pageLoaded) return

    const tabMeta = liveTabMeta[cacheKey] ?? []
    const tt = tabMeta.find((x) => x.title === activeTab)?.tableType
    if (!tt) return

    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      const r = await fetchOdsPreviewTablePage({
        batchId: meta.batch_id,
        sessionId: meta.session_id,
        tableType: tt,
        signal: ac.signal,
        view: viewMode,
        limit: 200,
        tabTitleHint: activeTab,
      })
      if (cancelled) return
      if (!r.ok) {
        setSessionWarnings([r.error?.message ?? '加载表失败'])
        setLiveTables((prev) => ({
          ...prev,
          [cacheKey]: {
            ...(prev[cacheKey] ?? {}),
            [activeTab]: {
              columns: [],
              rows: [],
              pageLoaded: true,
              hasMore: false,
              nextCursor: null,
            },
          },
        }))
        return
      }
      setSessionWarnings(r.warnings ?? [])
      if (r.limit != null && Number.isFinite(r.limit)) setRowLimitCap(Math.floor(r.limit))

      const tabPack = {
        table_type: tt,
        columns: (r.columns ?? []).map((c) => ({
          field: c.field,
          labelZh: (c.label_zh || '').trim(),
        })),
        rows: r.rows ?? [],
        fieldMappingSheetKey: r.field_mapping_sheet_key,
        pageLoaded: true as const,
        hasMore: Boolean(r.has_more),
        nextCursor: r.next_cursor ?? null,
        pageSize: r.limit != null && Number.isFinite(r.limit) ? Math.floor(r.limit) : 200,
      }
      setLiveTables((prev) => ({
        ...prev,
        [cacheKey]: { ...(prev[cacheKey] ?? {}), [activeTab]: tabPack },
      }))
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [current, activeTab, selectedId, viewMode, liveList, liveTables, liveTabMeta])

  const handleLoadMore = useCallback(async () => {
    if (!current) return
    const tab = activeTab
    if (!tab) return
    const meta = liveList.find((m) => odsPreviewBatchKey(m) === selectedId)
    if (!meta) return
    const cacheKey = `${selectedId}::${viewMode}`
    const busyKey = `${cacheKey}::${tab}`
    const tabMeta = liveTabMeta[cacheKey] ?? []
    const tt = tabMeta.find((x) => x.title === tab)?.tableType
    if (!tt) return

    const pack = liveTables[cacheKey]?.[tab]
    if (!pack?.pageLoaded || !pack.hasMore || !pack.nextCursor) return
    if (loadMoreBusyKey) return

    setLoadMoreBusyKey(busyKey)
    try {
      const r = await fetchOdsPreviewTablePage({
        batchId: meta.batch_id,
        sessionId: meta.session_id,
        tableType: tt,
        cursor: pack.nextCursor,
        view: viewMode,
        limit: pack.pageSize ?? 200,
        tabTitleHint: tab,
      })
      if (!r.ok) {
        setSessionWarnings([r.error?.message ?? '加载更多失败'])
        return
      }
      setSessionWarnings(r.warnings ?? [])
      const moreRows = r.rows ?? []
      setLiveTables((prev) => {
        const cur = prev[cacheKey]?.[tab]
        if (!cur) return prev
        return {
          ...prev,
          [cacheKey]: {
            ...prev[cacheKey],
            [tab]: {
              ...cur,
              rows: [...cur.rows, ...moreRows],
              hasMore: Boolean(r.has_more),
              nextCursor: r.next_cursor ?? null,
            },
          },
        }
      })
    } finally {
      setLoadMoreBusyKey(null)
    }
  }, [
    current,
    activeTab,
    selectedId,
    viewMode,
    liveList,
    liveTables,
    liveTabMeta,
    loadMoreBusyKey,
  ])

  const tablePack = current && activeTab ? current.tables[activeTab] : undefined
  const activeTableType = useMemo(() => {
    if (tablePack?.table_type) return tablePack.table_type
    if (!selectedId || !activeTab) return ''
    const meta = liveTabMeta[`${selectedId}::${viewMode}`] ?? []
    return meta.find((x) => x.title === activeTab)?.tableType ?? ''
  }, [tablePack, selectedId, activeTab, liveTabMeta, viewMode])

  const filteredRows = useMemo(() => {
    if (!tablePack) return []
    let rows = tablePack.rows
    if (fileFilter !== '__all__') {
      rows = rows.filter((r) => (r.source_excel_file ?? '').trim() === fileFilter)
    }
    const q = tableSearch.trim().toLowerCase()
    if (q) {
      const declared = new Set(tablePack.columns.map((c) => c.field))
      rows = rows.filter((r) => {
        const chunks: string[] = []
        for (const c of tablePack.columns) {
          chunks.push(String(r[c.field] ?? ''))
        }
        for (const [k, v] of Object.entries(r)) {
          if (!declared.has(k)) chunks.push(String(v ?? ''))
        }
        return chunks.join(' ').toLowerCase().includes(q)
      })
    }
    return rows
  }, [tablePack, tableSearch, fileFilter])

  const mockFiles = useMemo(() => {
    if (!current) return []
    const allOpt = { id: '__all__', name: t.dataPreviewUi.fileFilterAll }
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = [allOpt]
    for (const r of tablePack?.rows ?? current.tables[activeTab]?.rows ?? []) {
      const p = (r.source_excel_file ?? '').trim()
      if (!p || seen.has(p)) continue
      seen.add(p)
      const name = p.split(/[/\\]/).pop() ?? p
      out.push({ id: p, name })
    }
    return out.length > 1 ? out : [allOpt]
  }, [current, tablePack, activeTab])

  const cacheKey = selectedId ? `${selectedId}::${viewMode}` : ''
  const metaLoading =
    liveList.length > 0 && current != null && selectedId !== '' && cacheKey !== '' && !(cacheKey in liveTabMeta)
  const tableLoading =
    !metaLoading &&
    liveList.length > 0 &&
    current != null &&
    selectedId !== '' &&
    activeTab !== '' &&
    cacheKey !== '' &&
    !liveTables[cacheKey]?.[activeTab]?.pageLoaded
  const detailLoading = metaLoading || tableLoading

  if (!bootstrapDone) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-[22px] text-il-page-desc text-text-2">
        <span className="text-text">{t.dataPreviewUi.bootstrapLoading}</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-[22px]">
      <div className="mb-4 flex min-h-0 shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-il-page-title font-semibold text-text">{t.dataPreviewUi.pageTitle}</span>
          </div>
          <p className="w-full text-il-page-desc leading-relaxed text-text-2">{t.dataPreviewUi.pageBody}</p>
          {previewListError ? (
            <p className="mt-2 w-full rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">
              {t.dataPreviewUi.listLoadErrorTitle}：{previewListError}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reloadFromApi()}
          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {busy ? t.dataPreviewUi.refreshing : t.dataPreviewUi.refresh}
        </button>
      </div>

      {!current ? (
        <Card title={t.dataPreviewUi.emptyCardTitle} className="shrink-0">
          {odsRootPath ? (
            <p className="mb-3 break-all font-mono text-[11px] leading-relaxed text-text-2">
              <span className="text-il-meta text-text-3">{t.dataPreviewUi.kpiSource}：</span>
              {odsRootPath}
            </p>
          ) : null}
          <p className="mb-4 text-il-page-desc text-text-3">
            {liveList.length === 0 && !previewListError
              ? t.dataPreviewUi.apiListEmptyHint
              : previewListError
                ? t.dataPreviewUi.emptyBodyAfterError
                : t.dataPreviewUi.emptyBody}
          </p>
          <button
            type="button"
            onClick={() => props.onNav('import_wizard_upload')}
            className="rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white hover:bg-accent-mid"
          >
            {t.dataPreviewUi.ctaUpload}
          </button>
        </Card>
      ) : (
        <>
          <Card title={t.dataPreviewUi.batchCardTitle} className="mb-4 shrink-0">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-4">
              <label className="block w-full min-w-0 flex-1">
                <span className="mb-1 block text-il-label font-medium text-text-2">{t.dataPreviewUi.batchSelectLabel}</span>
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  disabled={busy || deleteBusy}
                  className="box-border w-full max-w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-2 font-mono text-[12px] text-text outline-none focus:border-accent focus:bg-white disabled:opacity-60"
                >
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {batchOptionLabel(b)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
                <button
                  type="button"
                  disabled={busy || deleteBusy}
                  onClick={openDeleteSession}
                  className="rounded-[7px] border border-border bg-white px-3 py-2 text-il-btn text-text-2 hover:border-danger hover:text-danger disabled:opacity-50"
                >
                  {t.dataPreviewUi.deleteSessionBtn}
                </button>
                <button
                  type="button"
                  disabled={busy || deleteBusy}
                  onClick={openDeleteBatch}
                  className="rounded-[7px] border border-danger/50 bg-[#fff5f5] px-3 py-2 text-il-btn font-medium text-danger hover:bg-[#ffe8e8] disabled:opacity-50"
                >
                  {t.dataPreviewUi.deleteBatchBtn}
                </button>
              </div>
            </div>
            {sessionsInSameBatch > 1 ? (
              <p className="mt-2 text-il-meta text-text-3">
                {t.dataPreviewUi.deleteSessionSessionsInBatch.replace('{n}', String(sessionsInSameBatch))}
              </p>
            ) : null}
          </Card>

          <div className="mb-4 grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,2.5fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,4fr)]">
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dataPreviewUi.kpiBatchId}</div>
              <div className="mt-0.5 font-mono text-[13px] font-semibold text-text">{current.batchId}</div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dataPreviewUi.kpiSession}</div>
              <div className="mt-0.5 truncate font-mono text-[11px] font-medium leading-snug text-text" title={current.sessionId}>
                {current.sessionId}
              </div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-2.5 py-2.5">
              <div className="whitespace-nowrap text-il-meta text-text-3">{t.dataPreviewUi.kpiSuccess}</div>
              <div className="mt-0.5 text-[13px] font-semibold text-[#0d7a3e]">
                {current.successFiles}/{current.totalFiles}
              </div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-2.5 py-2.5">
              <div className="text-il-meta text-text-3">{t.dataPreviewUi.kpiFailed}</div>
              <div
                className={[
                  'mt-0.5 text-[13px] font-semibold',
                  current.failedFiles > 0 ? 'text-danger' : 'text-text-2',
                ].join(' ')}
              >
                {current.failedFiles}
              </div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-2.5 py-2.5">
              <div className="text-il-meta text-text-3">{t.dataPreviewUi.kpiAttachments}</div>
              <div className="mt-0.5 text-[13px] font-semibold text-text-2">{current.attachmentCount}</div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dataPreviewUi.kpiSource}</div>
              <div
                className="mt-0.5 truncate font-mono text-[11px] font-medium leading-snug text-text"
                title={
                  activeTableType && current
                    ? `data/ods/批次=${current.batchId}/表类型=${activeTableType}/`
                    : odsRootPath || undefined
                }
              >
                {activeTableType && current
                  ? `data/ods/批次=${current.batchId}/表类型=${activeTableType}/`
                  : odsRootPath || t.dataPreviewUi.kpiSourcePathUnknown}
              </div>
            </div>
          </div>

          {sessionWarnings.length > 0 ? (
            <div className="mb-4 shrink-0 rounded-[8px] border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-il-meta text-[#92400e]">
              {sessionWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          ) : null}

          {detailLoading ? (
            <Card title={t.dataPreviewUi.tableCardTitle} className="mb-4 shrink-0">
              <p className="px-1 py-8 text-center text-il-page-desc text-text-3">{t.dataPreviewUi.loadDetailHint}</p>
            </Card>
          ) : visibleTabs.length === 0 ? (
            <Card title={t.dataPreviewUi.tableCardTitle} className="mb-4 shrink-0">
              <p className="text-il-page-desc text-text-3">{t.dataPreviewUi.noTabsHint}</p>
            </Card>
          ) : (
            <>
              <div className="mb-3 flex min-h-0 shrink-0 flex-col gap-3">
                <div className="flex min-h-0 flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
                  {visibleTabs.length >= 6 ? (
                    <label className="flex shrink-0 items-center gap-2 text-[13px] text-text-2">
                      <span className="shrink-0 text-[13px]">{t.dataPreviewUi.tabsQuickSwitch}</span>
                      <select
                        value={visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0]}
                        onChange={(e) => setActiveTab(e.target.value)}
                        className="min-w-[8rem] max-w-[12rem] rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent"
                      >
                        {visibleTabs.map((tab) => (
                          <option key={tab} value={tab}>
                            {tab}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <div
                    className={[
                      'flex min-w-0 flex-1 flex-nowrap gap-1.5 overflow-x-auto overflow-y-hidden pb-0.5 pr-1',
                    ].join(' ')}
                  >
                    {visibleTabs.map((tab) => {
                      const active = activeTab === tab
                      return (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setActiveTab(tab)}
                          className={[
                            'shrink-0 rounded-[7px] px-3 py-1.5 text-[13px] transition-colors',
                            active
                              ? 'bg-accent font-medium text-white'
                              : 'border border-border bg-white text-text-2 hover:border-accent hover:text-accent',
                          ].join(' ')}
                        >
                          {tab}
                        </button>
                      )
                    })}
                  </div>
                </div>
                {visibleTabs.length > 1 ? (
                  <p className="w-full text-[10px] leading-snug text-text-3">{t.dataPreviewUi.tabsBarHint}</p>
                ) : null}
                <div className="flex min-h-0 flex-col gap-2 lg:flex-row lg:items-center lg:gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <input
                      type="search"
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      placeholder={t.dataPreviewUi.searchPlaceholder}
                      className="min-w-[16rem] flex-1 rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent sm:max-w-md"
                    />
                    <label className="flex items-center gap-2 text-il-meta text-text-2">
                      <span className="shrink-0">{t.dataPreviewUi.viewModeLabel}</span>
                      <select
                        value={viewMode}
                        onChange={(e) => setViewMode((e.target.value as 'std' | 'raw') || 'std')}
                        className="min-w-[10rem] rounded-[7px] border border-border bg-[#fafbfc] px-2 py-1.5 text-il-input text-text outline-none focus:border-accent"
                      >
                        <option value="std">{t.dataPreviewUi.viewModeStd}</option>
                        <option value="raw">{t.dataPreviewUi.viewModeRaw}</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-il-meta text-text-2">
                      <span className="shrink-0">{t.dataPreviewUi.fileFilterLabel}</span>
                      <select
                        value={fileFilter}
                        onChange={(e) => setFileFilter(e.target.value)}
                        className="min-w-[10rem] rounded-[7px] border border-border bg-[#fafbfc] px-2 py-1.5 text-il-input text-text outline-none focus:border-accent"
                      >
                        {mockFiles.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </div>

              <Card
                title={`${t.dataPreviewUi.tableCardTitle} · ${activeTab}${
                  tablePack?.table_type ? `（表类型=${tablePack.table_type}）` : ''
                }`}
                className="mb-4 min-w-0 shrink-0"
                bodyClassName="!p-0"
              >
                {!tablePack || tablePack.columns.length === 0 ? (
                  <div className="px-5 py-10 text-center text-il-page-desc text-text-3">{t.dataPreviewUi.tableNoColumns}</div>
                ) : filteredRows.length === 0 ? (
                  <div className="px-5 py-10 text-center text-il-page-desc text-text-3">
                    {tablePack.rows.length === 0 ? t.dataPreviewUi.tableEmptyNoData : t.dataPreviewUi.tableEmptyFilter}
                  </div>
                ) : (
                  <div className="max-h-[min(70vh,720px)] w-full overflow-auto">
                    <table className="w-max min-w-full border-collapse text-left text-[12px]">
                      <thead className="sticky top-0 z-[1] bg-[#f5f8fc] text-text-2 shadow-sm">
                        <tr>
                          {tablePack.columns.map((c) => {
                            const sub = c.labelZh.trim()
                            const showSub = sub.length > 0 && sub !== c.field
                            return (
                              <th
                                key={c.field}
                                className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium first:pl-4 last:pr-4"
                              >
                                <span className="block font-mono text-[10px] text-text-3">{c.field}</span>
                                {showSub ? <span className="text-text-2">{sub}</span> : null}
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody className="text-text-2">
                        {filteredRows.map((row, ri) => (
                          <tr key={ri} className="border-b border-border-light/80 hover:bg-[#fafbfc]">
                            {tablePack.columns.map((c) => (
                              <td
                                key={c.field}
                                className="max-w-[220px] truncate px-2.5 py-2 first:pl-4 last:pr-4"
                                title={(row[c.field] ?? '').trim() || '—'}
                              >
                                {(row[c.field] ?? '').trim() || '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="shrink-0 space-y-2 border-t border-border-light px-4 py-2 text-il-meta text-text-3">
                  {tablePack && tablePack.columns.length > 0 && tablePack.pageLoaded ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {tablePack.hasMore ? (
                        <button
                          type="button"
                          disabled={loadMoreBusyKey === `${cacheKey}::${activeTab}`}
                          onClick={() => void handleLoadMore()}
                          className="rounded-[7px] border border-border bg-white px-3 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {loadMoreBusyKey === `${cacheKey}::${activeTab}`
                            ? t.dataPreviewUi.loadMoreLoading
                            : t.dataPreviewUi.loadMore}
                        </button>
                      ) : tablePack.rows.length > 0 ? (
                        <span className="text-text-3">{t.dataPreviewUi.loadMoreEnd}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <div>
                    {t.dataPreviewUi.tableFootnote
                      .replace('{n}', String(tablePack?.rows.length ?? 0))
                      .replace('{cap}', String(rowLimitCap))}
                  </div>
                </div>
              </Card>
            </>
          )}

          <div className="shrink-0 rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5 text-il-meta leading-relaxed text-text-2">
            {t.dataPreviewUi.footerHint}
          </div>
          <div className="mt-3 flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={() => props.onNav('import_wizard_upload')}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            >
              {t.dataPreviewUi.linkUpload}
            </button>
            <button
              type="button"
              onClick={() => props.onNav('import_history')}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            >
              {t.dataPreviewUi.linkHistory}
            </button>
          </div>

          {deleteDialog ? (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ods-delete-dialog-title"
              onClick={() => closeDeleteDialog()}
            >
              <div
                className="max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-[10px] border border-border bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 id="ods-delete-dialog-title" className="mb-2 text-il-page-title font-semibold text-text">
                  {deleteDialog === 'session'
                    ? t.dataPreviewUi.deleteDialogSessionTitle
                    : t.dataPreviewUi.deleteDialogBatchTitle}
                </h3>
                <p className="mb-3 text-il-page-desc leading-relaxed text-text-2">
                  {deleteDialog === 'session'
                    ? t.dataPreviewUi.deleteDialogSessionBody
                    : t.dataPreviewUi.deleteDialogBatchBody}
                </p>
                {deleteDialog === 'batch' ? (
                  <label className="mb-3 block">
                    <span className="mb-1 block text-il-label font-medium text-text-2">
                      {t.dataPreviewUi.deleteConfirmInputLabel}
                    </span>
                    <input
                      type="text"
                      value={batchConfirmInput}
                      onChange={(e) => setBatchConfirmInput(e.target.value)}
                      placeholder={t.dataPreviewUi.deleteConfirmInputPlaceholder}
                      autoComplete="off"
                      className="box-border w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 font-mono text-[12px] text-text outline-none focus:border-accent"
                    />
                  </label>
                ) : null}
                <label className="mb-4 flex cursor-pointer items-start gap-2 text-il-meta text-text-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={deleteAck}
                    onChange={(e) => setDeleteAck(e.target.checked)}
                  />
                  <span>{t.dataPreviewUi.deleteAckCheckbox}</span>
                </label>
                {deleteError ? (
                  <p className="mb-3 rounded-[6px] border border-danger/30 bg-[#fff5f5] px-2.5 py-2 text-il-meta text-danger">
                    {t.dataPreviewUi.deleteErrorPrefix}：{deleteError}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2 border-t border-border-light pt-4">
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => closeDeleteDialog()}
                    className="rounded-[7px] border border-border bg-white px-4 py-2 text-il-btn text-text-2 hover:border-accent disabled:opacity-50"
                  >
                    {t.dataPreviewUi.deleteCancel}
                  </button>
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => void runDelete()}
                    className="rounded-[7px] bg-danger px-4 py-2 text-il-btn font-medium text-white hover:opacity-95 disabled:opacity-50"
                  >
                    {deleteBusy ? t.dataPreviewUi.deleteBusy : t.dataPreviewUi.deleteSubmit}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
