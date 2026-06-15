import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import { deleteOdsPreviewImport, fetchOdsPreviewBatches, odsPreviewBatchKey, postDwdBuild, postDwdForceRebuild, type OdsPreviewBatchMeta } from '../config/localApi'
import type { NavKey } from '../types'

type BatchGroup = {
  batchId: string
  hasExcelToOds: boolean
  hasOdsToDwd: boolean
  sessions: Array<{
    id: string
    meta: OdsPreviewBatchMeta
    loadedAtLabel: string
  }>
  latestLoadTime: string
  fileCount: number
  successCount: number
  failCount: number
  warnCount: number
  parquetPathCount: number
}

type HistoryType = 'excel_to_ods' | 'ods_to_dwd'

type HistoryRecord = {
  id: string
  type: HistoryType
  batchId: string
  group: BatchGroup
  successNumerator: number
  successDenominator: number
  failCount: number
  warnCount: number
  latestLoadTime: string
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

function groupByBatch(list: OdsPreviewBatchMeta[]): BatchGroup[] {
  const by: Record<string, OdsPreviewBatchMeta[]> = {}
  for (const m of list) {
    const b = String(m.batch_id ?? '').trim()
    if (!b) continue
    if (!by[b]) by[b] = []
    by[b].push(m)
  }
  const out: BatchGroup[] = []
  for (const [batchId, rows] of Object.entries(by)) {
    const sorted = [...rows].sort((a, b) => String(b.load_time ?? '').localeCompare(String(a.load_time ?? ''), 'zh-CN'))
    const hasOdsToDwd = rows.some((x) => {
      const wm = String(x.dwd_session_processed_at ?? '').trim()
      const dwdRows = Number(x.dwd_header_rows ?? 0) + Number(x.dwd_detail_rows ?? 0)
      return wm.length > 0 || dwdRows > 0
    })
    const sessions = sorted.map((m) => ({
      id: odsPreviewBatchKey(m),
      meta: m,
      loadedAtLabel: formatLoadTime(String(m.load_time ?? '')),
    }))
    const latest = sorted[0]
    out.push({
      batchId,
      hasExcelToOds: true,
      hasOdsToDwd,
      sessions,
      latestLoadTime: String(latest?.load_time ?? ''),
      fileCount: rows.reduce((s, x) => s + Number(x.file_count ?? 0), 0),
      successCount: rows.reduce((s, x) => s + Number(x.success_count ?? 0), 0),
      failCount: rows.reduce((s, x) => s + Number(x.fail_count ?? 0), 0),
      warnCount: rows.reduce((s, x) => s + Number(x.warn_count ?? 0), 0),
      parquetPathCount: rows.reduce((s, x) => s + Number(x.parquet_path_count ?? 0), 0),
    })
  }
  out.sort((a, b) => String(b.latestLoadTime).localeCompare(String(a.latestLoadTime), 'zh-CN'))
  return out
}

function recordsFromGroups(groups: BatchGroup[]): HistoryRecord[] {
  const out: HistoryRecord[] = []
  for (const g of groups) {
    out.push({
      id: `${g.batchId}::excel_to_ods`,
      type: 'excel_to_ods',
      batchId: g.batchId,
      group: g,
      successNumerator: g.successCount,
      successDenominator: g.fileCount,
      failCount: g.failCount,
      warnCount: g.warnCount,
      latestLoadTime: g.latestLoadTime,
    })
    if (g.hasOdsToDwd) {
      const builtSessions = g.sessions.filter((s) => {
        const wm = String(s.meta.dwd_session_processed_at ?? '').trim()
        const dwdRows = Number(s.meta.dwd_header_rows ?? 0) + Number(s.meta.dwd_detail_rows ?? 0)
        return wm.length > 0 || dwdRows > 0
      }).length
      out.push({
        id: `${g.batchId}::ods_to_dwd`,
        type: 'ods_to_dwd',
        batchId: g.batchId,
        group: g,
        successNumerator: builtSessions,
        successDenominator: g.sessions.length,
        failCount: Math.max(0, g.sessions.length - builtSessions),
        warnCount: 0,
        latestLoadTime: g.latestLoadTime,
      })
    }
  }
  out.sort((a, b) => String(b.latestLoadTime).localeCompare(String(a.latestLoadTime), 'zh-CN'))
  return out
}

export function ImportHistoryPage(props: { onNav: (k: NavKey) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [odsRootPath, setOdsRootPath] = useState<string>('')
  const [list, setList] = useState<OdsPreviewBatchMeta[]>([])
  const [selectedRecordId, setSelectedRecordId] = useState<string>('')
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | HistoryType>('all')

  const [deleteDialog, setDeleteDialog] = useState<'session' | 'batch' | null>(null)
  const [deleteAck, setDeleteAck] = useState(false)
  const [batchConfirmInput, setBatchConfirmInput] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [rerunBusy, setRerunBusy] = useState(false)
  const [rerunMsg, setRerunMsg] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const reload = useCallback(async () => {
    const my = ++seqRef.current
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setError(null)
    try {
      const r = await fetchOdsPreviewBatches(ac.signal, 120)
      if (my !== seqRef.current) return
      if (r.ods_dir_hint) setOdsRootPath(r.ods_dir_hint)
      if (!r.ok) {
        setList([])
        setError(r.error?.message ?? r.error?.detail ?? t.importHistoryUi.listLoadError)
        return
      }
      setList(r.batches ?? [])
    } finally {
      if (my !== seqRef.current) return
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    return () => abortRef.current?.abort()
  }, [reload])

  const groups = useMemo(() => groupByBatch(list), [list])
  const records = useMemo(() => recordsFromGroups(groups), [groups])

  const filteredRecords = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return records.filter((r) => {
      if (typeFilter !== 'all' && r.type !== typeFilter) return false
      if (!qq) return true
      return (
        r.batchId.toLowerCase().includes(qq) ||
        r.group.sessions.some((s) => s.meta.session_id.toLowerCase().includes(qq))
      )
    })
  }, [records, q, typeFilter])

  useEffect(() => {
    if (filteredRecords.length === 0) return
    if (!selectedRecordId || !filteredRecords.some((r) => r.id === selectedRecordId)) {
      setSelectedRecordId(filteredRecords[0]!.id)
      setSelectedSessionId(filteredRecords[0]!.group.sessions[0]?.meta.session_id ?? '')
      return
    }
    const rec = filteredRecords.find((x) => x.id === selectedRecordId)
    if (!rec) return
    if (!selectedSessionId || !rec.group.sessions.some((s) => s.meta.session_id === selectedSessionId)) {
      setSelectedSessionId(rec.group.sessions[0]?.meta.session_id ?? '')
    }
  }, [filteredRecords, selectedRecordId, selectedSessionId])

  const currentRecord = useMemo(
    () => filteredRecords.find((r) => r.id === selectedRecordId) ?? null,
    [filteredRecords, selectedRecordId],
  )
  const currentGroup = useMemo(() => currentRecord?.group ?? null, [currentRecord])
  const currentSession = useMemo(() => {
    if (!currentGroup) return null
    return currentGroup.sessions.find((s) => s.meta.session_id === selectedSessionId) ?? null
  }, [currentGroup, selectedSessionId])

  const openPreviewInNewWindow = () => {
    if (!currentGroup || !currentRecord) return
    const url = new URL(window.location.href)
    url.searchParams.set('nav', currentRecord.type === 'ods_to_dwd' ? 'dwd_data_preview' : 'import_wizard_preview')
    url.searchParams.set('batch_id', currentGroup.batchId)
    if (currentSession?.meta.session_id) url.searchParams.set('session_id', currentSession.meta.session_id)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  const openDeleteSession = () => {
    setDeleteError(null)
    setDeleteAck(false)
    setBatchConfirmInput('')
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

  const runRerun = async (mode: 'failed' | 'all') => {
    if (!currentGroup || !currentSession) return
    setRerunBusy(true)
    setRerunMsg('')
    try {
      const params = {
        import_batch_id: currentGroup.batchId,
        import_session_id: currentSession.meta.session_id,
      }
      const res =
        mode === 'all'
          ? await postDwdForceRebuild(params)
          : await postDwdBuild(params)
      if (!res.ok) {
        setRerunMsg((res as { message?: string }).message ?? res.error?.message ?? t.importHistoryUi.rerunFailed)
        return
      }
      setRerunMsg(mode === 'all' ? t.importHistoryUi.rerunAllOk : t.importHistoryUi.rerunFailedOk)
      await reload()
    } finally {
      setRerunBusy(false)
    }
  }

  const runDelete = async () => {
    if (!currentGroup || !deleteDialog) return
    if (!deleteAck) {
      setDeleteError(t.importHistoryUi.deleteNeedAck)
      return
    }
    if (deleteDialog === 'batch' && batchConfirmInput.trim() !== currentGroup.batchId.trim()) {
      setDeleteError(t.importHistoryUi.deleteConfirmMismatch)
      return
    }
    if (deleteDialog === 'session' && !currentSession) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const r =
        deleteDialog === 'session'
          ? await deleteOdsPreviewImport({
              scope: 'session',
              batch_id: currentGroup.batchId,
              session_id: currentSession!.meta.session_id,
            })
          : await deleteOdsPreviewImport({
              scope: 'batch',
              batch_id: currentGroup.batchId,
            })
      if (!r.ok) {
        setDeleteError(r.error?.message ?? r.error?.detail ?? t.importHistoryUi.deleteError)
        return
      }
      closeDeleteDialog()
      await reload()
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-[22px]">
      <div className="mb-4 flex min-h-0 shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-il-page-title font-semibold text-text">{t.importHistoryUi.pageTitle}</span>
          </div>
          <p className="w-full text-il-page-desc leading-relaxed text-text-2">{t.importHistoryUi.pageBody}</p>
          {odsRootPath ? (
            <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-text-2">
              <span className="text-il-meta text-text-3">{t.importHistoryUi.kpiSource}：</span>
              {odsRootPath}
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 w-full rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">
              {t.importHistoryUi.listLoadErrorTitle}：{error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void reload()}
            className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {busy ? t.importHistoryUi.refreshing : t.importHistoryUi.refresh}
          </button>
          <button
            type="button"
            onClick={() => props.onNav('import_wizard_upload')}
            className="rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white hover:bg-accent-mid"
          >
            {t.importHistoryUi.ctaUpload}
          </button>
        </div>
      </div>

      {filteredRecords.length === 0 ? (
        <Card title={t.importHistoryUi.emptyCardTitle} className="shrink-0">
          <p className="text-il-page-desc text-text-3">{t.importHistoryUi.emptyBody}</p>
        </Card>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Card
            title={t.importHistoryUi.listCardTitle}
            className="min-h-0"
            bodyClassName="min-h-0 flex flex-col overflow-hidden !p-0"
          >
            <div className="shrink-0 border-b border-border-light px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-[12rem] flex-1 flex-wrap items-center gap-2">
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t.importHistoryUi.searchPlaceholder}
                    className="min-w-[12rem] flex-1 rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent sm:max-w-md"
                  />
                  <label className="inline-flex items-center gap-1.5 text-il-meta text-text-3">
                    <span>{t.importHistoryUi.typeFilterLabel}</span>
                    <select
                      value={typeFilter}
                      onChange={(e) => setTypeFilter((e.target.value as 'all' | HistoryType) || 'all')}
                      className="rounded-[7px] border border-border bg-[#fafbfc] px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                    >
                      <option value="all">{t.importHistoryUi.typeAll}</option>
                      <option value="excel_to_ods">{t.importHistoryUi.typeExcelToOds}</option>
                      <option value="ods_to_dwd">{t.importHistoryUi.typeOdsToDwd}</option>
                    </select>
                  </label>
                </div>
                <span className="text-il-meta text-text-3">
                  {t.importHistoryUi.totalHint.replace('{n}', String(filteredRecords.length))}
                </span>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-max min-w-full border-collapse text-left text-[12px]">
                <thead className="sticky top-0 z-[1] bg-[#f5f8fc] text-text-2 shadow-sm">
                  <tr>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium first:pl-4">
                      {t.importHistoryUi.colType}
                    </th>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium first:pl-4">
                      {t.importHistoryUi.colBatch}
                    </th>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                      {t.importHistoryUi.colSessions}
                    </th>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                      {t.importHistoryUi.colSuccess}
                    </th>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                      {t.importHistoryUi.colFailed}
                    </th>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                      {t.importHistoryUi.colWarn}
                    </th>
                    <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium last:pr-4">
                      {t.importHistoryUi.colLastTime}
                    </th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {filteredRecords.map((r) => {
                    const g = r.group
                    const active = r.id === selectedRecordId
                    return (
                      <tr
                        key={r.id}
                        className={[
                          'border-b border-border-light/80 cursor-pointer hover:bg-[#fafbfc]',
                          active ? 'bg-[#EBF4FF]' : '',
                        ].join(' ')}
                        onClick={() => {
                          setSelectedRecordId(r.id)
                          setSelectedSessionId(g.sessions[0]?.meta.session_id ?? '')
                        }}
                        title={`${g.batchId} · ${r.type}`}
                      >
                        <td className="whitespace-nowrap px-2.5 py-2 first:pl-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {r.type === 'excel_to_ods' ? (
                              <span className="inline-flex items-center rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-[1px] text-[11px] text-accent-mid">
                                {t.importHistoryUi.typeExcelToOds}
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded border border-[#b7e4c8] bg-[#f0fdf4] px-2 py-[1px] text-[11px] text-[#0d5c2e]">
                                {t.importHistoryUi.typeOdsToDwd}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-2 font-mono text-[11px] text-text first:pl-4">
                          {g.batchId}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-2 text-text-2">{g.sessions.length}</td>
                        <td className="whitespace-nowrap px-2.5 py-2 text-text-2">
                          {r.successNumerator}/{r.successDenominator}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-2 text-text-2">
                          <span className={r.failCount > 0 ? 'text-danger font-medium' : ''}>{r.failCount}</span>
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-2 text-text-2">{r.warnCount}</td>
                        <td className="whitespace-nowrap px-2.5 py-2 text-text-3 last:pr-4">
                          {formatLoadTime(r.latestLoadTime)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="min-h-0 space-y-4">
            <Card title={t.importHistoryUi.detailCardTitle} className="shrink-0">
              {!currentGroup ? (
                <div className="text-il-page-desc text-text-3">{t.importHistoryUi.detailEmpty}</div>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <div className="text-il-meta text-text-3">{t.importHistoryUi.kpiBatchId}</div>
                      <div className="mt-0.5 font-mono text-[12px] font-semibold text-text">{currentGroup.batchId}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {currentRecord?.type === 'excel_to_ods' ? (
                          <span className="inline-flex items-center rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-[1px] text-[11px] text-accent-mid">
                            {t.importHistoryUi.typeExcelToOds}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded border border-[#b7e4c8] bg-[#f0fdf4] px-2 py-[1px] text-[11px] text-[#0d5c2e]">
                            {t.importHistoryUi.typeOdsToDwd}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                        onClick={openPreviewInNewWindow}
                        title={t.importHistoryUi.gotoPreviewHint}
                      >
                        {t.importHistoryUi.gotoPreview}
                      </button>
                      <button
                        type="button"
                        className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-danger hover:text-danger"
                        onClick={openDeleteBatch}
                      >
                        {t.importHistoryUi.deleteBatchBtn}
                      </button>
                    </div>
                  </div>

                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.importHistoryUi.kpiSessions}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">{currentGroup.sessions.length}</div>
                    </div>
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.importHistoryUi.kpiOdsFiles}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">{currentGroup.parquetPathCount}</div>
                    </div>
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.importHistoryUi.kpiSuccess}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">
                        {currentGroup.successCount}/{currentGroup.fileCount}
                      </div>
                    </div>
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.importHistoryUi.kpiFailed}</div>
                      <div className={['mt-0.5 text-[13px] font-semibold', currentGroup.failCount > 0 ? 'text-danger' : 'text-text-2'].join(' ')}>
                        {currentGroup.failCount}
                      </div>
                    </div>
                  </div>

                  <div className="mb-3 flex flex-col gap-2">
                    <label className="text-il-meta text-text-2">
                      <span className="mb-1 block text-il-label font-medium text-text-2">{t.importHistoryUi.sessionSelectLabel}</span>
                      <select
                        value={selectedSessionId}
                        onChange={(e) => setSelectedSessionId(e.target.value)}
                        className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent focus:bg-white"
                      >
                        {currentGroup.sessions.map((s) => (
                          <option key={s.meta.session_id} value={s.meta.session_id}>
                            {s.meta.session_id} · {s.loadedAtLabel} · {s.meta.success_count}/{s.meta.file_count}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="rounded-[8px] border border-border-light bg-white px-3 py-2.5">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-il-meta text-text-3">{t.importHistoryUi.sessionKpiTitle}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-text-2">
                          {currentSession ? `${currentSession.meta.batch_id} :: ${currentSession.meta.session_id}` : '—'}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={rerunBusy || !currentSession}
                          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                          onClick={() => void runRerun('failed')}
                        >
                          {rerunBusy ? '…' : t.importHistoryUi.rerunFailed}
                        </button>
                        <button
                          type="button"
                          disabled={rerunBusy || !currentSession}
                          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                          onClick={() => void runRerun('all')}
                        >
                          {rerunBusy ? '…' : t.importHistoryUi.rerunAll}
                        </button>
                        <button
                          type="button"
                          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-danger hover:text-danger"
                          onClick={openDeleteSession}
                          disabled={!currentSession}
                        >
                          {t.importHistoryUi.deleteSessionBtn}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 text-[12px]">
                      <div>
                        <div className="text-text-3">{t.importHistoryUi.kpiLoadedAt}</div>
                        <div className="mt-0.5 text-text-2">{currentSession ? currentSession.loadedAtLabel : '—'}</div>
                      </div>
                      <div>
                        <div className="text-text-3">{t.importHistoryUi.kpiFilesOk}</div>
                        <div className="mt-0.5 text-text-2">
                          {currentSession ? `${currentSession.meta.success_count}/${currentSession.meta.file_count}` : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-text-3">{t.importHistoryUi.kpiParquet}</div>
                        <div className="mt-0.5 text-text-2">{currentSession ? currentSession.meta.parquet_path_count : '—'}</div>
                      </div>
                    </div>
                    <div className="mt-3 text-il-meta leading-relaxed text-text-3">
                      {rerunMsg || t.importHistoryUi.detailFootnote}
                    </div>
                  </div>
                </>
              )}
            </Card>
          </div>
        </div>
      )}

      {deleteDialog ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-delete-dialog-title"
          onClick={closeDeleteDialog}
        >
          <div
            className="max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-[10px] border border-border bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="history-delete-dialog-title" className="mb-2 text-il-page-title font-semibold text-text">
              {deleteDialog === 'batch' ? t.importHistoryUi.deleteDialogBatchTitle : t.importHistoryUi.deleteDialogSessionTitle}
            </h3>
            <p className="mb-3 text-il-page-desc leading-relaxed text-text-2">
              {deleteDialog === 'batch' ? t.importHistoryUi.deleteDialogBatchBody : t.importHistoryUi.deleteDialogSessionBody}
            </p>
            <label className="mb-3 flex cursor-pointer items-start gap-2 text-il-meta text-text-2">
              <input
                type="checkbox"
                checked={deleteAck}
                onChange={(e) => setDeleteAck(e.target.checked)}
                disabled={deleteBusy}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
              />
              <span>{t.importHistoryUi.deleteAckCheckbox}</span>
            </label>
            {deleteDialog === 'batch' ? (
              <div className="mb-3">
                <label className="mb-1 block text-il-label font-medium text-text-2">{t.importHistoryUi.deleteConfirmInputLabel}</label>
                <input
                  value={batchConfirmInput}
                  onChange={(e) => setBatchConfirmInput(e.target.value)}
                  placeholder={t.importHistoryUi.deleteConfirmInputPlaceholder}
                  disabled={deleteBusy}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent focus:bg-white"
                />
              </div>
            ) : null}
            {deleteError ? (
              <div className="mb-3 rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">
                {deleteError}
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-60"
                onClick={closeDeleteDialog}
                disabled={deleteBusy}
              >
                {t.importHistoryUi.deleteCancel}
              </button>
              <button
                type="button"
                className="rounded-[7px] bg-danger px-4 py-1.5 text-il-btn font-medium text-white hover:opacity-90 disabled:opacity-60"
                onClick={() => void runDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? t.importHistoryUi.deleteBusy : t.importHistoryUi.deleteSubmit}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

