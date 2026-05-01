import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  deleteDwdPreviewLoad,
  fetchDwdPreviewTablePage,
  fetchDwdPreviewTabs,
  fetchOdsPreviewBatches,
  type DwdPreviewTabMeta,
  type OdsPreviewBatchMeta,
} from '../config/localApi'
import type { NavKey } from '../types'

function uniqueBatchIds(list: OdsPreviewBatchMeta[]): string[] {
  const s = new Set<string>()
  for (const m of list) s.add(m.batch_id)
  // 默认按批次号降序，优先显示最新批次（常见格式：YYYYMMDD）
  return [...s].sort((a, b) => b.localeCompare(a, 'zh-CN'))
}

function sessionsForBatch(list: OdsPreviewBatchMeta[], bid: string): OdsPreviewBatchMeta[] {
  return list.filter((m) => m.batch_id === bid)
}

function formatWatermark(iso: string | undefined): string {
  if (!iso || !String(iso).trim()) return t.dwdPreviewUi.watermarkNone
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19).replace('T', ' ')
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

type DwdColFilter = { field: string; value: string }

/** 与后端 `/api/dwd-preview/table-page` 单页上限一致 */
const DWD_LOAD_ALL_CHUNK = 500
/** 防止一次塞满浏览器内存；超出后可继续「加载更多」 */
const DWD_LOAD_ALL_MAX = 20000

function filterDwdRows(
  rows: Array<Record<string, string>>,
  columns: { field: string }[],
  globalSearch: string,
  columnFilters: DwdColFilter[],
): Array<Record<string, string>> {
  let out = rows
  const g = globalSearch.trim().toLowerCase()
  if (g) {
    out = out.filter((row) =>
      columns.some((c) => (row[c.field] ?? '').toLowerCase().includes(g)),
    )
  }
  for (const { field, value } of columnFilters) {
    const needle = value.trim().toLowerCase()
    if (!needle) continue
    out = out.filter((row) => (row[field] ?? '').toLowerCase().includes(needle))
  }
  return out
}

export function DwdPreviewPage(props: { onNav: (k: NavKey) => void }) {
  const [list, setList] = useState<OdsPreviewBatchMeta[]>([])
  const [listBusy, setListBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [batchId, setBatchId] = useState('')
  /** 空字符串 = 该批次全部会话 */
  const [sessionId, setSessionId] = useState('')
  const [dwdTabs, setDwdTabs] = useState<DwdPreviewTabMeta[]>([])
  const [tabsBusy, setTabsBusy] = useState(false)
  const [dwdTable, setDwdTable] = useState('')

  const [columns, setColumns] = useState<{ field: string; label_zh: string }[]>([])
  const [rows, setRows] = useState<Array<Record<string, string>>>([])
  const [nextCursor, setNextCursor] = useState<Record<string, unknown> | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalRows, setTotalRows] = useState<number | null>(null)
  const [pageBusy, setPageBusy] = useState(false)
  /** 记录当前筛选键是否已自动拉取过首屏，避免空结果时重复自动请求 */
  const [autoLoadedKey, setAutoLoadedKey] = useState('')

  const [deleteDialog, setDeleteDialog] = useState<'session' | 'batch' | null>(null)
  const [deleteAck, setDeleteAck] = useState(false)
  const [batchConfirmInput, setBatchConfirmInput] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  /** 仅在已加载到内存的行上筛选（见文案 searchScopeNote） */
  const [globalSearch, setGlobalSearch] = useState('')
  const [columnFilters, setColumnFilters] = useState<DwdColFilter[]>([])
  const [colPick, setColPick] = useState('')
  const [colVal, setColVal] = useState('')

  const loadBatchList = useCallback(async () => {
    setListBusy(true)
    setError(null)
    try {
      const r = await fetchOdsPreviewBatches(undefined, 120)
      if (!r.ok) {
        setList([])
        setError(r.error?.message ?? '无法加载批次')
        return
      }
      const batches = r.batches ?? []
      setList(batches)
      setBatchId((prev) => {
        if (prev && batches.some((m) => m.batch_id === prev)) return prev
        const u = uniqueBatchIds(batches)
        return u[0] ?? ''
      })
    } finally {
      setListBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadBatchList()
  }, [loadBatchList])

  const batchIds = useMemo(() => uniqueBatchIds(list), [list])
  const sessionChoices = useMemo(() => sessionsForBatch(list, batchId), [list, batchId])

  const currentMeta = useMemo(() => {
    if (!batchId) return null
    if (sessionId) return sessionChoices.find((m) => m.session_id === sessionId) ?? null
    return null
  }, [batchId, sessionId, sessionChoices])

  const kpiHeaderSum = useMemo(() => {
    if (sessionId && currentMeta) return Number(currentMeta.dwd_header_rows ?? 0)
    return sessionChoices.reduce((a, m) => a + Number(m.dwd_header_rows ?? 0), 0)
  }, [sessionId, currentMeta, sessionChoices])

  const kpiDetailSum = useMemo(() => {
    if (sessionId && currentMeta) return Number(currentMeta.dwd_detail_rows ?? 0)
    return sessionChoices.reduce((a, m) => a + Number(m.dwd_detail_rows ?? 0), 0)
  }, [sessionId, currentMeta, sessionChoices])

  const watermarkLabel = useMemo(() => {
    if (sessionId && currentMeta) return formatWatermark(currentMeta.dwd_session_processed_at)
    if (!sessionChoices.length) return '—'
    const built = sessionChoices.filter((m) => (m.dwd_session_processed_at ?? '').trim()).length
    if (built === 0) return t.dwdPreviewUi.watermarkNone
    return `${built}/${sessionChoices.length} 个会话已记录水位`
  }, [sessionId, currentMeta, sessionChoices])

  useEffect(() => {
    setSessionId('')
  }, [batchId])

  const loadDwdTabs = useCallback(async () => {
    if (!batchId) {
      setDwdTabs([])
      setDwdTable('')
      return
    }
    setTabsBusy(true)
    setError(null)
    try {
      const r = await fetchDwdPreviewTabs({ batchId, sessionId })
      if (!r.ok) {
        setDwdTabs([])
        setDwdTable('')
        setError(r.error?.message ?? '无法加载 DWD Tab')
        return
      }
      const tabs = r.tabs ?? []
      setDwdTabs(tabs)
      setDwdTable((prev) => {
        if (prev && tabs.some((x) => x.dwd_table === prev)) return prev
        return tabs[0]?.dwd_table ?? ''
      })
    } finally {
      setTabsBusy(false)
    }
  }, [batchId, sessionId])

  useEffect(() => {
    void loadDwdTabs()
  }, [loadDwdTabs])

  useEffect(() => {
    setRows([])
    setNextCursor(null)
    setHasMore(false)
    setColumns([])
    setTotalRows(null)
    setGlobalSearch('')
    setColumnFilters([])
    setColVal('')
    setAutoLoadedKey('')
  }, [batchId, sessionId, dwdTable])

  useEffect(() => {
    if (!columns.length) {
      setColPick('')
      return
    }
    if (!colPick || !columns.some((c) => c.field === colPick)) {
      setColPick(columns[0].field)
    }
  }, [columns, colPick])

  const selectedTab = useMemo(
    () => dwdTabs.find((x) => x.dwd_table === dwdTable) ?? null,
    [dwdTabs, dwdTable],
  )

  const fetchPage = useCallback(
    async (append: boolean) => {
      if (!batchId || !dwdTable) return
      setPageBusy(true)
      setError(null)
      if (!append) {
        setGlobalSearch('')
        setColumnFilters([])
        setColVal('')
      }
      try {
        const r = await fetchDwdPreviewTablePage({
          batchId,
          sessionId,
          dwdTable,
          layer: selectedTab?.layer ?? 'detail',
          limit: 150,
          cursor: append ? nextCursor : null,
        })
        if (!r.ok) {
          setError(r.error?.message ?? '加载失败')
          return
        }
        setColumns(r.columns ?? [])
        setTotalRows(r.total_rows != null && !Number.isNaN(r.total_rows) ? r.total_rows : null)
        const chunk = r.rows ?? []
        setRows((prev) => (append ? [...prev, ...chunk] : chunk))
        setHasMore(Boolean(r.has_more))
        setNextCursor(r.next_cursor ?? null)
      } finally {
        setPageBusy(false)
      }
    },
    [batchId, sessionId, dwdTable, selectedTab?.layer, nextCursor],
  )

  const onLoadMore = () => void fetchPage(true)

  const onLoadAll = useCallback(async () => {
    if (!batchId || !dwdTable || pageBusy || deleteBusy) return
    if (rows.length > 0 && !hasMore) return

    setPageBusy(true)
    setError(null)
    setGlobalSearch('')
    setColumnFilters([])
    setColVal('')

    let acc: Array<Record<string, string>> = rows.length > 0 ? [...rows] : []
    let cursor: Record<string, unknown> | null =
      rows.length > 0 && hasMore ? (nextCursor ?? null) : null
    let cols = columns.length > 0 ? [...columns] : []
    let totalVal: number | null = totalRows

    try {
      while (true) {
        const r = await fetchDwdPreviewTablePage({
          batchId,
          sessionId,
          dwdTable,
          layer: selectedTab?.layer ?? 'detail',
          limit: DWD_LOAD_ALL_CHUNK,
          cursor,
        })
        if (!r.ok) {
          setColumns(cols)
          setRows(acc)
          setTotalRows(totalVal)
          const canMore =
            cursor != null || (totalVal != null && acc.length < totalVal)
          setHasMore(canMore)
          setNextCursor(cursor)
          setError(r.error?.message ?? '加载失败')
          return
        }
        if (!cols.length) cols = r.columns ?? []
        if (r.total_rows != null && !Number.isNaN(Number(r.total_rows))) {
          totalVal = Number(r.total_rows)
        }
        const chunk = r.rows ?? []
        acc = acc.concat(chunk)

        if (!r.has_more) {
          setColumns(cols)
          setRows(acc)
          setTotalRows(totalVal)
          setHasMore(false)
          setNextCursor(null)
          return
        }

        const nextC = r.next_cursor ?? null
        if (!nextC) {
          setColumns(cols)
          setRows(acc)
          setTotalRows(totalVal)
          setHasMore(false)
          setNextCursor(null)
          return
        }

        if (acc.length >= DWD_LOAD_ALL_MAX) {
          setColumns(cols)
          setRows(acc)
          setTotalRows(totalVal)
          setHasMore(true)
          setNextCursor(nextC)
          setError(t.dwdPreviewUi.loadAllCapped.replace(/\{max\}/g, String(DWD_LOAD_ALL_MAX)))
          return
        }

        cursor = nextC
      }
    } finally {
      setPageBusy(false)
    }
  }, [
    batchId,
    sessionId,
    dwdTable,
    selectedTab?.layer,
    pageBusy,
    deleteBusy,
    rows,
    hasMore,
    nextCursor,
    columns,
    totalRows,
  ])

  const canLoadAll =
    Boolean(batchId && dwdTable) && !(rows.length > 0 && !hasMore) && !pageBusy && !deleteBusy

  useEffect(() => {
    const key = `${batchId}::${sessionId}::${dwdTable}`
    if (!batchId || !dwdTable) return
    if (tabsBusy || deleteBusy || pageBusy) return
    if (autoLoadedKey === key) return
    setAutoLoadedKey(key)
    void fetchPage(false)
  }, [batchId, sessionId, dwdTable, tabsBusy, deleteBusy, pageBusy, autoLoadedKey, fetchPage])

  const clearTableAfterMutation = useCallback(() => {
    setRows([])
    setNextCursor(null)
    setHasMore(false)
    setColumns([])
    setTotalRows(null)
    setGlobalSearch('')
    setColumnFilters([])
    setColVal('')
  }, [])

  const displayRows = useMemo(
    () => filterDwdRows(rows, columns, globalSearch, columnFilters),
    [rows, columns, globalSearch, columnFilters],
  )

  const filterActive =
    globalSearch.trim() !== '' || columnFilters.some((x) => x.value.trim() !== '')

  const addColumnFilter = () => {
    const f = colPick.trim()
    const val = colVal.trim()
    if (!f || !val) return
    setColumnFilters((prev) => {
      const rest = prev.filter((x) => x.field !== f)
      return [...rest, { field: f, value: val }]
    })
    setColVal('')
  }

  const removeColumnFilter = (field: string) => {
    setColumnFilters((prev) => prev.filter((x) => x.field !== field))
  }

  const openDeleteSession = () => {
    if (!sessionId) {
      setError(t.dwdPreviewUi.deleteSessionNeedPick)
      return
    }
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
    if (!batchId || !deleteDialog) return
    if (!deleteAck) {
      setDeleteError(t.dwdPreviewUi.deleteNeedAck)
      return
    }
    if (deleteDialog === 'batch' && batchConfirmInput.trim() !== batchId.trim()) {
      setDeleteError(t.dwdPreviewUi.deleteConfirmMismatch)
      return
    }
    if (deleteDialog === 'session' && !sessionId) {
      setDeleteError(t.dwdPreviewUi.deleteSessionNeedPick)
      return
    }

    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const r =
        deleteDialog === 'session'
          ? await deleteDwdPreviewLoad({
              scope: 'session',
              batch_id: batchId,
              session_id: sessionId,
            })
          : await deleteDwdPreviewLoad({ scope: 'batch', batch_id: batchId })
      if (!r.ok) {
        const parts = [r.error?.message, r.error?.detail].filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0,
        )
        setDeleteError(parts.length ? parts.join(' — ') : t.dwdPreviewUi.deleteErrorPrefix)
        return
      }
      setDeleteDialog(null)
      setDeleteAck(false)
      setBatchConfirmInput('')
      clearTableAfterMutation()
      await loadBatchList()
      await loadDwdTabs()
    } finally {
      setDeleteBusy(false)
    }
  }

  const totalLabel = useMemo(() => {
    if (totalRows == null) return t.dwdPreviewUi.totalUnknown
    return t.dwdPreviewUi.totalRows.replace(/\{n\}/g, String(totalRows))
  }, [totalRows])

  const sessionsInBatch = sessionChoices.length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-[22px]">
      <div className="mb-4 flex min-h-0 shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-il-page-title font-semibold text-text">{t.dwdPreviewUi.pageTitle}</div>
          <p className="w-full text-il-page-desc leading-relaxed text-text-2">{t.dwdPreviewUi.pageBody}</p>
          {error ? (
            <p className="mt-2 w-full rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={listBusy}
          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
          onClick={() => {
            void loadBatchList()
            void loadDwdTabs()
          }}
        >
          {listBusy ? t.dwdPreviewUi.refreshing : t.dwdPreviewUi.refresh}
        </button>
      </div>

      {batchIds.length === 0 && !listBusy ? (
        <Card title={t.dwdPreviewUi.emptyListTitle} className="shrink-0">
          <p className="text-il-meta text-text-2">{t.dwdPreviewUi.emptyListBody}</p>
        </Card>
      ) : (
        <>
          <Card title={t.dwdPreviewUi.batchCardTitle} className="mb-4 shrink-0">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-4">
              <label className="block w-full min-w-0 flex-1 sm:max-w-[17rem]">
                <span className="mb-1 block text-il-label font-semibold text-accent">{t.dwdPreviewUi.labelBatch}</span>
                <select
                  className="box-border w-full rounded-[7px] border-2 border-accent/65 bg-[#eef6ff] px-2 py-2 font-mono text-[12px] font-semibold text-text outline-none ring-2 ring-accent/20 focus:border-accent focus:bg-white focus:ring-accent/35 disabled:opacity-60"
                  value={batchId}
                  disabled={listBusy || deleteBusy}
                  onChange={(e) => setBatchId(e.target.value)}
                >
                  {batchIds.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block w-full min-w-0 flex-1 sm:max-w-md">
                <span className="mb-1 block text-il-label font-medium text-text-2">{t.dwdPreviewUi.labelSession}</span>
                <select
                  className="box-border w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-2 font-mono text-[11px] text-text outline-none focus:border-accent focus:bg-white disabled:opacity-60"
                  value={sessionId}
                  disabled={listBusy || deleteBusy}
                  onChange={(e) => setSessionId(e.target.value)}
                >
                  <option value="">{t.dwdPreviewUi.sessionAll}</option>
                  {sessionChoices.map((m) => (
                    <option key={m.session_id} value={m.session_id}>
                      {m.session_id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
                <button
                  type="button"
                  disabled={listBusy || deleteBusy || !sessionId}
                  title={!sessionId ? t.dwdPreviewUi.deleteSessionNeedPick : undefined}
                  onClick={openDeleteSession}
                  className="rounded-[7px] border border-border bg-white px-3 py-2 text-il-btn text-text-2 hover:border-danger hover:text-danger disabled:opacity-50"
                >
                  {t.dwdPreviewUi.deleteSessionBtn}
                </button>
                <button
                  type="button"
                  disabled={listBusy || deleteBusy}
                  onClick={openDeleteBatch}
                  className="rounded-[7px] border border-danger/50 bg-[#fff5f5] px-3 py-2 text-il-btn font-medium text-danger hover:bg-[#ffe8e8] disabled:opacity-50"
                >
                  {t.dwdPreviewUi.deleteBatchBtn}
                </button>
              </div>
            </div>
            {sessionsInBatch > 1 ? (
              <p className="mt-2 text-il-meta text-text-3">
                {t.dwdPreviewUi.deleteSessionSessionsInBatch.replace('{n}', String(sessionsInBatch))}
              </p>
            ) : null}
          </Card>

          <div className="mb-4 grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dwdPreviewUi.kpiBatchId}</div>
              <div className="mt-0.5 font-mono text-[13px] font-semibold text-text">{batchId || '—'}</div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dwdPreviewUi.kpiSession}</div>
              <div
                className="mt-0.5 break-all font-mono text-[11px] font-medium leading-snug text-text"
                title={sessionId || t.dwdPreviewUi.sessionAll}
              >
                {sessionId || t.dwdPreviewUi.sessionAll}
              </div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dwdPreviewUi.kpiDwdHeader}</div>
              <div className="mt-0.5 text-[13px] font-semibold text-text">{kpiHeaderSum}</div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dwdPreviewUi.kpiDwdDetail}</div>
              <div className="mt-0.5 text-[13px] font-semibold text-text">{kpiDetailSum}</div>
            </div>
            <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
              <div className="text-il-meta text-text-3">{t.dwdPreviewUi.kpiDwdWatermark}</div>
              <div className="mt-0.5 break-words text-[12px] font-medium leading-snug text-text-2">{watermarkLabel}</div>
            </div>
          </div>

          <Card title={t.dwdPreviewUi.filterCardTitle} className="mb-4 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              {tabsBusy ? (
                <span className="text-il-meta text-text-3">{t.dwdPreviewUi.tabsLoading}</span>
              ) : dwdTabs.length === 0 ? (
                <span className="text-il-meta text-text-3">{t.dwdPreviewUi.noTabsHint}</span>
              ) : (
                dwdTabs.map((tab) => {
                  const baseBtn =
                    'inline-flex box-border h-9 shrink-0 items-center justify-center rounded-[7px] border px-3 py-0 text-[13px] leading-none'
                  const cls =
                    dwdTable === tab.dwd_table
                      ? `${baseBtn} border-accent bg-[#f0f7ff] text-accent`
                      : `${baseBtn} border-border bg-white text-text-2 hover:border-accent`
                  return (
                    <button
                      key={tab.dwd_table}
                      type="button"
                      className={cls}
                      onClick={() => setDwdTable(tab.dwd_table)}
                      title={tab.dwd_table}
                    >
                      {tab.title}
                    </button>
                  )
                })
              )}
            </div>
          </Card>

          <Card
            title={`数据表 · ${selectedTab?.title ?? t.dwdPreviewUi.filterCardTitle}${
              dwdTable ? `（表=${dwdTable}）` : ''
            }`}
            className="shrink-0"
          >
            {rows.length > 0 ? (
              <div className="mb-3 rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
                  <span className="shrink-0 text-il-meta text-text-3">{t.dwdPreviewUi.searchLabelFulltext}</span>
                  <input
                    type="search"
                    value={globalSearch}
                    onChange={(e) => setGlobalSearch(e.target.value)}
                    placeholder={t.dwdPreviewUi.searchPlaceholder}
                    autoComplete="off"
                    title={t.dwdPreviewUi.searchPlaceholder}
                    className="box-border h-9 w-[12.2rem] shrink-0 rounded-[7px] border border-border bg-white px-2.5 font-mono text-[12px] text-text outline-none focus:border-accent sm:w-[15.5rem]"
                  />
                  <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden />
                  <span
                    className="shrink-0 text-il-meta text-text-3"
                    title={t.dwdPreviewUi.columnFilterTitle}
                  >
                    {t.dwdPreviewUi.columnFilterInline}
                  </span>
                  <select
                    value={colPick}
                    onChange={(e) => setColPick(e.target.value)}
                    title={t.dwdPreviewUi.columnPick}
                    className="box-border h-9 max-w-[min(100%,11rem)] shrink-0 rounded-[7px] border border-border bg-white px-2 text-[12px] text-text outline-none focus:border-accent"
                  >
                    {columns.map((c) => (
                      <option key={c.field} value={c.field}>
                        {c.field.slice(0, 48)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={colVal}
                    onChange={(e) => setColVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addColumnFilter()
                    }}
                    autoComplete="off"
                    placeholder={`${t.dwdPreviewUi.columnContains}…`}
                    title={`${t.dwdPreviewUi.columnContains}（${t.dwdPreviewUi.columnPick}：${colPick}）`}
                    className="box-border h-9 w-32 min-w-0 rounded-[7px] border border-border bg-white px-2.5 font-mono text-[12px] text-text outline-none focus:border-accent sm:w-40"
                  />
                  <button
                    type="button"
                    onClick={() => addColumnFilter()}
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-[7px] border border-border bg-white px-3 py-0 text-il-btn leading-none text-text-2 hover:border-accent"
                  >
                    {t.dwdPreviewUi.addColumnFilter}
                  </button>
                  {filterActive ? (
                    <button
                      type="button"
                      onClick={() => {
                        setGlobalSearch('')
                        setColumnFilters([])
                        setColVal('')
                      }}
                      className="inline-flex h-9 shrink-0 items-center justify-center rounded-[7px] border border-border bg-white px-3 py-0 text-il-btn leading-none text-text-2 hover:border-accent"
                    >
                      {t.dwdPreviewUi.clearFilters}
                    </button>
                  ) : null}
                </div>
                {columnFilters.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {columnFilters.map((cf) => {
                      const lab = cf.field
                      return (
                        <button
                          key={cf.field}
                          type="button"
                          title={t.dwdPreviewUi.filterChipRemove}
                          onClick={() => removeColumnFilter(cf.field)}
                          className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/40 bg-[#f0f7ff] px-2 py-0.5 text-[11px] text-accent hover:bg-[#e6f2ff]"
                        >
                          <span className="truncate font-medium">{lab}</span>
                          <span className="text-text-2">·</span>
                          <span className="truncate font-mono text-text">{cf.value}</span>
                          <span className="text-text-3">×</span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-il-meta text-text-2">{totalLabel}</p>
                  {filterActive ? (
                    <p className="text-il-meta text-accent">
                      {t.dwdPreviewUi.filteredCount
                        .replace(/\{loaded\}/g, String(rows.length))
                        .replace(/\{shown\}/g, String(displayRows.length))}
                    </p>
                  ) : (
                    <p className="text-il-meta text-text-3">
                      {t.dwdPreviewUi.filteredCount
                        .replace(/\{loaded\}/g, String(rows.length))
                        .replace(/\{shown\}/g, String(rows.length))}
                    </p>
                  )}
                  <span className="text-text-3">|</span>
                  <p className="text-[10px] leading-snug text-text-3">{t.dwdPreviewUi.searchScopeNote}</p>
                </div>
              </div>
            ) : null}
            {rows.length === 0 && !pageBusy ? (
              <div>
                <p className="text-il-meta text-text-2">{t.dwdPreviewUi.noRows}</p>
              </div>
            ) : null}
            {rows.length > 0 && displayRows.length === 0 && filterActive ? (
              <p className="mb-2 text-il-meta text-text-2">{t.dwdPreviewUi.filterNoMatch}</p>
            ) : null}
            {rows.length > 0 && displayRows.length > 0 ? (
              <div className="max-h-[min(560px,70vh)] w-full overflow-auto">
                <table className="w-max min-w-full border-collapse text-left text-[12px]">
                  <thead className="sticky top-0 z-[1] border-b border-border-light bg-[#f5f8fc] text-text-2 shadow-sm">
                    <tr>
                      {columns.map((c) => {
                        const note = (c.label_zh || '').trim()
                        const hasNote = note.length > 0 && note !== c.field
                        return (
                          <th
                            key={c.field}
                            title={hasNote ? `注释：${note}` : c.field}
                            className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium first:pl-4 last:pr-4"
                          >
                            <span className={hasNote ? 'block cursor-help font-mono text-[11px] text-text-2' : 'block font-mono text-[11px] text-text-2'}>
                              {c.field}
                            </span>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody className="text-text-2">
                    {displayRows.map((row, i) => (
                      <tr key={i} className="border-b border-border-light/80 hover:bg-[#fafbfc]">
                        {columns.map((c) => (
                          <td
                            key={c.field}
                            className={[
                              'px-2.5 py-2 text-text-2 first:pl-4 last:pr-4',
                              c.field === 'header_uuid' || c.field === 'detail_uuid'
                                ? 'whitespace-nowrap font-mono'
                                : 'max-w-[220px] truncate',
                            ].join(' ')}
                            title={(row[c.field] ?? '').trim()}
                          >
                            {(row[c.field] ?? '').trim()}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {pageBusy && rows.length === 0 ? (
              <p className="text-il-meta text-text-2">{t.dwdPreviewUi.loading}</p>
            ) : null}
            {pageBusy && rows.length > 0 ? (
              <p className="mt-2 text-il-meta text-text-2">{t.dwdPreviewUi.loading}</p>
            ) : null}
            {rows.length > 0 && !hasMore ? (
              <p className="mt-2 text-[11px] text-text-3">{t.dwdPreviewUi.alreadyFullyLoaded}</p>
            ) : null}
            <div className="mt-3 shrink-0 space-y-2 border-t border-border-light px-1 pt-2 text-il-meta text-text-3">
              <div className="flex flex-wrap items-center gap-2">
                {hasMore ? (
                  <button
                    type="button"
                    disabled={pageBusy}
                    className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent disabled:opacity-50"
                    onClick={onLoadMore}
                  >
                    {pageBusy ? t.dwdPreviewUi.loading : t.dwdPreviewUi.loadMore}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!canLoadAll || tabsBusy}
                  title={t.dwdPreviewUi.loadAllHint.replace(/\{max\}/g, String(DWD_LOAD_ALL_MAX))}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent disabled:opacity-50"
                  onClick={() => void onLoadAll()}
                >
                  {pageBusy && rows.length > 0 ? t.dwdPreviewUi.loading : t.dwdPreviewUi.loadAll}
                </button>
              </div>
            </div>
          </Card>

          <div className="mt-4 shrink-0 space-y-2.5 rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
            <p className="w-full break-words font-mono text-[11px] leading-relaxed text-text-3">{t.dwdPreviewUi.apiHint}</p>
            <p className="w-full text-[11px] leading-relaxed text-text-3">
              {t.dwdPreviewUi.loadAllHint.replace(/\{max\}/g, String(DWD_LOAD_ALL_MAX))}
            </p>
            <p className="border-t border-border-light/70 pt-2.5 text-il-meta leading-relaxed text-text-2">{t.dwdPreviewUi.footerHint}</p>
          </div>
          <div className="mt-3 flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={() => props.onNav('ods_to_dwd_center')}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            >
              {t.dwdPreviewUi.linkOdsToDwd}
            </button>
            <button
              type="button"
              onClick={() => props.onNav('import_wizard_preview')}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            >
              {t.dwdPreviewUi.linkOdsPreview}
            </button>
          </div>

          {deleteDialog ? (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="dwd-delete-dialog-title"
              onClick={() => closeDeleteDialog()}
            >
              <div
                className="max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-[10px] border border-border bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 id="dwd-delete-dialog-title" className="mb-2 text-il-page-title font-semibold text-text">
                  {deleteDialog === 'session'
                    ? t.dwdPreviewUi.deleteDialogSessionTitle
                    : t.dwdPreviewUi.deleteDialogBatchTitle}
                </h3>
                <p className="mb-3 text-il-page-desc leading-relaxed text-text-2">
                  {deleteDialog === 'session'
                    ? t.dwdPreviewUi.deleteDialogSessionBody
                    : t.dwdPreviewUi.deleteDialogBatchBody}
                </p>
                {deleteDialog === 'batch' ? (
                  <label className="mb-3 block">
                    <span className="mb-1 block text-il-label font-medium text-text-2">
                      {t.dwdPreviewUi.deleteConfirmInputLabel}
                    </span>
                    <input
                      type="text"
                      value={batchConfirmInput}
                      onChange={(e) => setBatchConfirmInput(e.target.value)}
                      placeholder={t.dwdPreviewUi.deleteConfirmInputPlaceholder}
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
                  <span>{t.dwdPreviewUi.deleteAckCheckbox}</span>
                </label>
                {deleteError ? (
                  <p className="mb-3 rounded-[6px] border border-danger/30 bg-[#fff5f5] px-2.5 py-2 text-il-meta text-danger">
                    {t.dwdPreviewUi.deleteErrorPrefix}：{deleteError}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2 border-t border-border-light pt-4">
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => closeDeleteDialog()}
                    className="rounded-[7px] border border-border bg-white px-4 py-2 text-il-btn text-text-2 hover:border-accent disabled:opacity-50"
                  >
                    {t.dwdPreviewUi.deleteCancel}
                  </button>
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => void runDelete()}
                    className="rounded-[7px] bg-danger px-4 py-2 text-il-btn font-medium text-white hover:opacity-95 disabled:opacity-50"
                  >
                    {deleteBusy ? t.dwdPreviewUi.deleteBusy : t.dwdPreviewUi.deleteSubmit}
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
