import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchOdsInventoryOverview,
  type OdsInventoryBatchRow,
  type OdsInventoryKpi,
  type OdsInventorySessionRow,
  type OdsInventoryTableTypeRow,
} from '../config/localApi'
import { navigateWithQuery, readNavQueryParams } from '../utils/navHelpers'
import type { NavKey } from '../types'

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

function formatInt(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN')
}

function KpiCell(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-[6.5rem] flex-1 rounded border border-border-light bg-surface px-3 py-2">
      <div className="text-il-meta text-text-3">{props.label}</div>
      <div className="mt-0.5 text-il-card-title font-semibold tabular-nums text-text">{props.value}</div>
      {props.hint ? <div className="mt-0.5 text-il-meta text-text-3">{props.hint}</div> : null}
    </div>
  )
}

function readTableTypeFromUrl(): string {
  try {
    return (readNavQueryParams().table_type || '').trim()
  } catch {
    return ''
  }
}

export function OdsOverviewPage(props: { onNav: (k: NavKey) => void }) {
  const ui = t.odsOverviewUi
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [odsDir, setOdsDir] = useState('')
  const [kpi, setKpi] = useState<OdsInventoryKpi | null>(null)
  const [tableTypes, setTableTypes] = useState<OdsInventoryTableTypeRow[]>([])
  const [batches, setBatches] = useState<OdsInventoryBatchRow[]>([])
  const [sessions, setSessions] = useState<OdsInventorySessionRow[]>([])
  const [filterTableType, setFilterTableType] = useState<string>(() => readTableTypeFromUrl())
  const abortRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const setFilter = useCallback(
    (tt: string) => {
      const next = (tt || '').trim()
      setFilterTableType(next)
      navigateWithQuery(props.onNav, 'import_wizard_ods_overview', {
        table_type: next || undefined,
      })
    },
    [props.onNav],
  )

  const load = useCallback(async () => {
    const mySeq = ++seqRef.current
    if (abortRef.current) {
      try {
        abortRef.current.abort()
      } catch {
        // ignore
      }
    }
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setError(null)
    try {
      const r = await fetchOdsInventoryOverview(ac.signal, 500)
      if (mySeq !== seqRef.current) return
      if (r.ods_dir_hint) setOdsDir(r.ods_dir_hint)
      if (!r.ok) {
        setKpi(null)
        setTableTypes([])
        setBatches([])
        setSessions([])
        setError(r.error?.message || r.error?.detail || ui.loadError)
        return
      }
      setKpi(r.kpi ?? null)
      setTableTypes(r.table_types)
      setBatches(r.batches)
      setSessions(r.sessions)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      if (mySeq !== seqRef.current) return
      setError(e instanceof Error ? e.message : ui.loadError)
    } finally {
      if (mySeq === seqRef.current) setBusy(false)
    }
  }, [ui.loadError])

  useEffect(() => {
    void load()
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort()
        } catch {
          // ignore
        }
      }
    }
  }, [load])

  const filterTitle = useMemo(() => {
    if (!filterTableType) return ''
    const hit = tableTypes.find((x) => x.table_type === filterTableType)
    return hit?.title || filterTableType
  }, [filterTableType, tableTypes])

  const filteredBatches = useMemo(() => {
    if (!filterTableType) return batches
    return batches.filter((b) => b.table_types.includes(filterTableType))
  }, [batches, filterTableType])

  const filteredSessions = useMemo(() => {
    if (!filterTableType) return []
    return sessions.filter((s) => s.table_types.includes(filterTableType))
  }, [sessions, filterTableType])

  const openPreview = (batchId: string, sessionId?: string) => {
    navigateWithQuery(props.onNav, 'import_wizard_preview', {
      batch_id: batchId,
      session_id: sessionId || undefined,
      table_type: undefined,
    })
  }

  const openHistory = (batchId?: string, sessionId?: string) => {
    navigateWithQuery(props.onNav, 'import_history', {
      batch_id: batchId,
      session_id: sessionId,
      table_type: undefined,
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <div>
        <h2 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h2>
        <p className="mt-1 max-w-4xl text-il-page-desc leading-relaxed text-text-2">{ui.pageBody}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:bg-surface disabled:opacity-60"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? ui.refreshing : ui.refresh}
        </button>
        <button
          type="button"
          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:bg-surface"
          onClick={() => props.onNav('import_wizard_preview')}
        >
          {ui.linkDataPreview}
        </button>
        <button
          type="button"
          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:bg-surface"
          onClick={() => openHistory()}
        >
          {ui.linkImportHistory}
        </button>
      </div>

      {error ? (
        <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-il-meta text-warn">
          {ui.loadErrorTitle}：{error}
        </div>
      ) : null}

      <Card title={ui.kpiTitle} compact>
        {kpi ? (
          <div className="flex flex-wrap gap-2">
            <KpiCell label={ui.kpiBatches} value={formatInt(kpi.batch_count)} />
            <KpiCell
              label={ui.kpiSessions}
              value={formatInt(kpi.session_count)}
              hint={ui.kpiSessionsWithPq.replace('{n}', formatInt(kpi.sessions_with_parquet))}
            />
            <KpiCell label={ui.kpiTableTypes} value={formatInt(kpi.table_type_count)} />
            <KpiCell label={ui.kpiTotalRows} value={formatInt(kpi.total_rows)} />
            <KpiCell label={ui.kpiParquetPaths} value={formatInt(kpi.parquet_path_count)} />
            <KpiCell label={ui.kpiFiles} value={formatInt(kpi.file_count)} />
            <KpiCell label={ui.kpiLatest} value={formatLoadTime(kpi.latest_load_time)} />
          </div>
        ) : (
          <p className="text-il-meta text-text-3">{busy ? ui.loading : ui.emptyKpi}</p>
        )}
        <p className="mt-2 break-all text-il-meta text-text-3">
          {ui.odsDirLabel}：{odsDir || ui.odsDirUnknown}
        </p>
        {kpi?.truncated ? (
          <p className="mt-1 text-il-meta text-warn">
            {ui.truncatedHint
              .replace('{scanned}', formatInt(kpi.scanned_sessions))
              .replace('{limit}', formatInt(kpi.scan_limit))}
          </p>
        ) : null}
      </Card>

      <Card title={ui.tableTypesTitle} compact>
        <p className="mb-2 text-il-meta text-text-3">{ui.tableTypesHint}</p>
        {tableTypes.length === 0 ? (
          <p className="text-il-meta text-text-3">{busy ? ui.loading : ui.emptyTableTypes}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-il-meta">
              <thead>
                <tr className="border-b border-border-light text-left text-text-3">
                  <th className="px-2 py-1.5 font-medium">{ui.colTitle}</th>
                  <th className="px-2 py-1.5 font-medium">{ui.colTableType}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colPaths}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colBatches}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colSessions}</th>
                  <th className="px-2 py-1.5 font-medium">{ui.colAction}</th>
                </tr>
              </thead>
              <tbody>
                {tableTypes.map((row) => {
                  const active = filterTableType === row.table_type
                  return (
                    <tr
                      key={row.table_type}
                      className={[
                        'border-b border-border-light/80 text-text-2',
                        active ? 'bg-accent/5' : '',
                      ].join(' ')}
                    >
                      <td className="px-2 py-1.5 text-text">{row.title}</td>
                      <td className="px-2 py-1.5 font-mono text-[12px]">{row.table_type}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatInt(row.parquet_path_count)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatInt(row.batch_count)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatInt(row.session_count)}</td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => setFilter(active ? '' : row.table_type)}
                        >
                          {active ? ui.clearFilter : ui.filterByType}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {filterTableType ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-il-meta text-text-2">
          <span>
            {ui.filterActive.replace('{title}', filterTitle).replace('{code}', filterTableType)}
          </span>
          <button type="button" className="text-accent hover:underline" onClick={() => setFilter('')}>
            {ui.clearFilter}
          </button>
        </div>
      ) : null}

      <Card title={ui.batchesTitle} compact>
        <p className="mb-2 text-il-meta text-text-3">
          {filterTableType ? ui.batchesFilteredHint : ui.batchesHint}
        </p>
        {filteredBatches.length === 0 ? (
          <p className="text-il-meta text-text-3">{busy ? ui.loading : ui.emptyBatches}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-il-meta">
              <thead>
                <tr className="border-b border-border-light text-left text-text-3">
                  <th className="px-2 py-1.5 font-medium">{ui.colBatchId}</th>
                  <th className="px-2 py-1.5 font-medium">{ui.colLatest}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colSessions}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colPaths}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colRows}</th>
                  <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colTableTypes}</th>
                  <th className="px-2 py-1.5 font-medium">{ui.colAction}</th>
                </tr>
              </thead>
              <tbody>
                {filteredBatches.map((b) => (
                  <tr key={b.batch_id} className="border-b border-border-light/80 text-text-2">
                    <td className="max-w-[14rem] truncate px-2 py-1.5 font-mono text-[12px] text-text" title={b.batch_id}>
                      {b.batch_id}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">{formatLoadTime(b.latest_load_time)}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {formatInt(b.session_count)}
                      {b.sessions_with_parquet !== b.session_count
                        ? ` (${ui.withPqShort.replace('{n}', formatInt(b.sessions_with_parquet))})`
                        : ''}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{formatInt(b.parquet_path_count)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatInt(b.total_rows)}</td>
                    <td className="px-2 py-1.5 tabular-nums" title={b.table_types.join(', ')}>
                      {formatInt(b.table_type_count)}
                    </td>
                    <td className="space-x-2 px-2 py-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        className="text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-3 disabled:no-underline"
                        disabled={!b.latest_session_id}
                        onClick={() => openPreview(b.batch_id, b.latest_session_id)}
                      >
                        {ui.openPreview}
                      </button>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => openHistory(b.batch_id, b.latest_session_id)}
                      >
                        {ui.openHistory}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {filterTableType ? (
        <Card title={ui.sessionsTitle} compact>
          <p className="mb-2 text-il-meta text-text-3">{ui.sessionsHint}</p>
          {filteredSessions.length === 0 ? (
            <p className="text-il-meta text-text-3">{ui.emptySessions}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] border-collapse text-il-meta">
                <thead>
                  <tr className="border-b border-border-light text-left text-text-3">
                    <th className="px-2 py-1.5 font-medium">{ui.colBatchId}</th>
                    <th className="px-2 py-1.5 font-medium">{ui.colSessionId}</th>
                    <th className="px-2 py-1.5 font-medium">{ui.colLatest}</th>
                    <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colPaths}</th>
                    <th className="px-2 py-1.5 font-medium tabular-nums">{ui.colRows}</th>
                    <th className="px-2 py-1.5 font-medium">{ui.colAction}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((s) => (
                    <tr
                      key={`${s.batch_id}::${s.session_id}`}
                      className="border-b border-border-light/80 text-text-2"
                    >
                      <td
                        className="max-w-[12rem] truncate px-2 py-1.5 font-mono text-[12px] text-text"
                        title={s.batch_id}
                      >
                        {s.batch_id}
                      </td>
                      <td
                        className="max-w-[12rem] truncate px-2 py-1.5 font-mono text-[12px]"
                        title={s.session_id}
                      >
                        {s.session_id}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">{formatLoadTime(s.load_time)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatInt(s.parquet_path_count)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{formatInt(s.total_rows)}</td>
                      <td className="space-x-2 px-2 py-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => openPreview(s.batch_id, s.session_id)}
                        >
                          {ui.openPreview}
                        </button>
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => openHistory(s.batch_id, s.session_id)}
                        >
                          {ui.openHistory}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  )
}
