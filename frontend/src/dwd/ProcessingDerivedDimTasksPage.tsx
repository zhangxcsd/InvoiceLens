import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import {
  DIM_ENTERPRISE_YEAR_REL_TASK_CODE,
  fetchDimEnterpriseYearRelMeta,
  fetchDimTaskRuns,
  postDimEnterpriseYearRelRebuild,
  type DimTaskRunLogRow,
  type EnterpriseYearRelMetaResult,
} from '../config/localApi'
import { TaskChainPanel } from './TaskChainPanel'

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs}s`
}

function statusClass(status: string): string {
  const s = (status || '').toLowerCase()
  if (s === 'success') return 'border-[#b7e4c8] bg-[#f0fdf4] text-[#0d5c2e]'
  if (s === 'failed') return 'border-danger/30 bg-[#fff5f5] text-danger'
  if (s === 'running') return 'border-[#c8dff7] bg-[#f0f7ff] text-accent-mid'
  return 'border-[#d8dee7] bg-[#f8fafc] text-text-2'
}

export function ProcessingDerivedDimTasksPage(props: { onNav?: (k: NavKey) => void }) {
  const ui = t.processingDerivedTasksUi
  const [meta, setMeta] = useState<EnterpriseYearRelMetaResult | null>(null)
  const [metaBusy, setMetaBusy] = useState(false)
  const [runsTask, setRunsTask] = useState<DimTaskRunLogRow[]>([])
  const [runsAll, setRunsAll] = useState<DimTaskRunLogRow[]>([])
  const [runsBusy, setRunsBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [selectedYears, setSelectedYears] = useState<Set<string>>(() => new Set())
  const [rebuildBusy, setRebuildBusy] = useState(false)
  const [lastJson, setLastJson] = useState<string | null>(null)

  const dwdYears = useMemo(() => meta?.dwd_stat_years ?? [], [meta])
  const rosterYears = useMemo(
    () => meta?.roster_stat_years ?? meta?.group_stat_years ?? [],
    [meta],
  )
  const unionYears = useMemo(() => {
    const u = meta?.rel_rebuild_union_stat_years
    if (u && u.length) return u
    const s = new Set<string>([...dwdYears, ...rosterYears])
    return [...s].sort((a, b) => Number(b) - Number(a))
  }, [meta, dwdYears, rosterYears])

  const loadMeta = useCallback(async () => {
    setMetaBusy(true)
    setErr(null)
    try {
      const r = await fetchDimEnterpriseYearRelMeta()
      if (!r.ok) {
        setErr(r.error?.message ?? `${ui.errPrefix}HTTP ${r.httpStatus}`)
        setMeta(null)
        return
      }
      setMeta(r)
    } catch (e) {
      setErr(`${ui.errPrefix}${e instanceof Error ? e.message : '网络错误'}`)
      setMeta(null)
    } finally {
      setMetaBusy(false)
    }
  }, [ui.errPrefix])

  const loadRuns = useCallback(async () => {
    setRunsBusy(true)
    try {
      const [a, b] = await Promise.all([
        fetchDimTaskRuns({ task_code: DIM_ENTERPRISE_YEAR_REL_TASK_CODE, limit: 30 }),
        fetchDimTaskRuns({ limit: 40 }),
      ])
      setRunsTask(a.ok ? a.runs : [])
      setRunsAll(b.ok ? b.runs : [])
    } finally {
      setRunsBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadMeta()
    void loadRuns()
  }, [loadMeta, loadRuns])

  const toggleYear = (y: string) => {
    setSelectedYears((prev) => {
      const n = new Set(prev)
      if (n.has(y)) n.delete(y)
      else n.add(y)
      return n
    })
  }

  const selectAllDwd = () => {
    setSelectedYears(new Set(unionYears))
  }

  const runRebuild = async (params: { stat_years?: number[] | null; dry_run?: boolean }) => {
    setRebuildBusy(true)
    setErr(null)
    setLastJson(null)
    try {
      const r = await postDimEnterpriseYearRelRebuild({
        stat_years: params.stat_years === undefined ? undefined : params.stat_years,
        dry_run: params.dry_run,
        trigger_source: 'processing_center_ui',
      })
      setLastJson(JSON.stringify(r, null, 2))
      if (!r.ok && !r.skipped && r.httpStatus >= 400) {
        setErr(r.error?.message ?? `${ui.errPrefix}HTTP ${r.httpStatus}`)
      }
      await loadMeta()
      await loadRuns()
    } catch (e) {
      setErr(`${ui.errPrefix}${e instanceof Error ? e.message : '网络错误'}`)
    } finally {
      setRebuildBusy(false)
    }
  }

  const dimCounts = meta?.dim_enterprise_year_rel_row_counts_by_year ?? {}

  return (
    <div className="flex flex-col gap-4 p-4">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />

      {err ? (
        <div className="rounded-md border border-danger/30 bg-[#fff5f5] px-3 py-2 text-sm text-danger">{err}</div>
      ) : null}

      <TaskChainPanel
        disabled={rebuildBusy}
        statYears={selectedYears.size > 0 ? [...selectedYears].map((x) => Number(x)).sort((a, b) => a - b) : null}
        onNav={props.onNav}
        onRunComplete={() => {
          void loadMeta()
          void loadRuns()
        }}
        compact
      />

      <Card title={ui.taskRegistryTitle}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-text-3">
                <th className="py-2 pr-3 font-medium">{ui.taskNameCol}</th>
                <th className="py-2 pr-3 font-medium">{ui.taskCodeCol}</th>
                <th className="py-2 pr-3 font-medium">{ui.dependsCol}</th>
                <th className="py-2 pr-3 font-medium">{ui.outputCol}</th>
                <th className="py-2 font-medium">{ui.triggerHintCol}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/80 align-top">
                <td className="py-2 pr-3 font-medium text-text">{ui.enterpriseYearRosterName}</td>
                <td className="py-2 pr-3 font-mono text-xs text-text-2">{ui.enterpriseYearRosterCode}</td>
                <td className="py-2 pr-3 text-text-2">{ui.enterpriseYearRosterDepends}</td>
                <td className="py-2 pr-3 font-mono text-xs text-text-2">{ui.enterpriseYearRosterOutput}</td>
                <td className="py-2 text-text-2">{ui.enterpriseYearRosterTriggers}</td>
              </tr>
              <tr className="border-b border-line/80 align-top">
                <td className="py-2 pr-3 font-medium text-text">{ui.enterpriseYearRelName}</td>
                <td className="py-2 pr-3 font-mono text-xs text-text-2">{ui.enterpriseYearRelCode}</td>
                <td className="py-2 pr-3 text-text-2">{ui.enterpriseYearRelDepends}</td>
                <td className="py-2 pr-3 font-mono text-xs text-text-2">{ui.enterpriseYearRelOutput}</td>
                <td className="py-2 text-text-2">{ui.enterpriseYearRelTriggers}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-text-3">{ui.enterpriseYearRosterWhy}</p>
        <p className="mt-2 text-xs leading-relaxed text-text-3">{ui.enterpriseYearRelWhy}</p>
      </Card>

      <Card title={ui.metaCardTitle}>
        {metaBusy ? (
          <div className="text-sm text-text-2">{ui.busyMeta}</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <div className="mb-1 text-xs font-medium text-text-3">{ui.metaDwdYears}</div>
              <div className="text-sm text-text">
                {dwdYears.length ? dwdYears.join('、') : ui.metaEmpty}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-text-3">{ui.metaRosterYears}</div>
              <div className="text-sm text-text">
                {rosterYears.length ? rosterYears.join('、') : ui.metaEmpty}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-text-3">{ui.metaUnionYears}</div>
              <div className="text-sm text-text">
                {unionYears.length ? unionYears.join('、') : ui.metaEmpty}
              </div>
            </div>
            <div className="lg:col-span-3">
              <div className="mb-1 text-xs font-medium text-text-3">{ui.metaDimCounts}</div>
              <div className="max-h-40 overflow-y-auto font-mono text-xs text-text">
                {Object.keys(dimCounts).length
                  ? Object.entries(dimCounts)
                      .sort((a, b) => Number(b[0]) - Number(a[0]))
                      .map(([y, n]) => (
                        <div key={y}>
                          {y}：{n}
                        </div>
                      ))
                  : ui.metaEmpty}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title={ui.yearPickTitle}>
        <p className="mb-3 text-xs text-text-3">{ui.yearPickHint}</p>
        <div className="flex flex-wrap gap-2">
          {unionYears.map((y) => (
            <label
              key={y}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-line bg-white px-2 py-1 text-sm"
            >
              <input type="checkbox" checked={selectedYears.has(y)} onChange={() => toggleYear(y)} />
              {y}
            </label>
          ))}
          {unionYears.length === 0 ? <span className="text-sm text-text-2">{ui.metaEmpty}</span> : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={selectAllDwd}
            disabled={!unionYears.length || rebuildBusy}
          >
            {ui.selectAllDwdYears}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={() => setSelectedYears(new Set())}
            disabled={rebuildBusy}
          >
            {ui.clearYears}
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={rebuildBusy || selectedYears.size === 0}
            onClick={() =>
              void runRebuild({
                stat_years: [...selectedYears].map((x) => Number(x)).sort((a, b) => a - b),
              })
            }
          >
            {ui.rebuildSelected}
          </button>
          <button
            type="button"
            className="rounded border border-accent-mid bg-[#f0f7ff] px-3 py-1.5 text-sm font-medium text-accent-mid hover:bg-[#e6f2ff] disabled:opacity-50"
            disabled={rebuildBusy}
            onClick={() => void runRebuild({ stat_years: null })}
          >
            {ui.rebuildAll}
          </button>
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-sm text-text-2 hover:bg-[#f8fafc] disabled:opacity-50"
            disabled={rebuildBusy}
            onClick={() =>
              void runRebuild({
                stat_years:
                  selectedYears.size > 0
                    ? [...selectedYears].map((x) => Number(x)).sort((a, b) => a - b)
                    : null,
                dry_run: true,
              })
            }
          >
            {ui.dryRunBtn}
          </button>
          {props.onNav ? (
            <button
              type="button"
              className="ml-auto rounded border border-line px-3 py-1.5 text-sm text-accent hover:bg-[#f8fafc]"
              onClick={() => props.onNav?.('ods_to_dwd_center')}
            >
              {ui.linkOdsToDwd}
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-text-3">{ui.dryRunHint}</p>
        {rebuildBusy ? <div className="mt-2 text-sm text-text-2">{ui.busyRebuild}</div> : null}
      </Card>

      {lastJson ? (
        <Card title={ui.lastResultTitle}>
          <pre className="max-h-64 overflow-auto rounded border border-line bg-[#0b1020] p-3 text-xs text-[#c8d0e0]">
            {lastJson}
          </pre>
        </Card>
      ) : null}

      <Card title={ui.runsTitle}>
        <div className="mb-3 flex items-center justify-end">
          <button
            type="button"
            className="rounded border border-line bg-white px-2 py-1 text-xs hover:bg-[#f8fafc] disabled:opacity-50"
            onClick={() => void loadRuns()}
            disabled={runsBusy}
          >
            {ui.refreshRuns}
          </button>
        </div>
        {runsBusy ? <div className="text-sm text-text-2">{ui.busyRuns}</div> : null}
        <RunsTable rows={runsTask} ui={ui} />
      </Card>

      <Card title={ui.runsAllTitle}>
        <p className="mb-2 text-xs text-text-3">{ui.runsAllHint}</p>
        <RunsTable rows={runsAll} ui={ui} />
      </Card>
    </div>
  )
}

function RunsTable({
  rows,
  ui,
}: {
  rows: DimTaskRunLogRow[]
  ui: (typeof t)['processingDerivedTasksUi']
}) {
  if (!rows.length) {
    return <div className="text-sm text-text-2">{ui.metaEmpty}</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-line text-text-3">
            <th className="py-2 pr-2 font-medium">{ui.colTime}</th>
            <th className="py-2 pr-2 font-medium">{ui.colTask}</th>
            <th className="py-2 pr-2 font-medium">{ui.colStatus}</th>
            <th className="py-2 pr-2 font-medium">{ui.colDuration}</th>
            <th className="py-2 pr-2 font-medium">{ui.colTrigger}</th>
            <th className="py-2 pr-2 font-medium">{ui.colRows}</th>
            <th className="py-2 font-medium">{ui.colError}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.run_id}-${r.started_at}`} className="border-b border-line/70 align-top">
              <td className="py-2 pr-2 whitespace-nowrap text-text-2">{r.started_at || '—'}</td>
              <td className="py-2 pr-2 font-mono text-[11px] text-text-2">{r.task_code}</td>
              <td className="py-2 pr-2">
                <span className={`inline-block rounded border px-1.5 py-0.5 ${statusClass(r.status)}`}>
                  {r.status || '—'}
                </span>
              </td>
              <td className="py-2 pr-2 text-text-2">{formatDurationMs(r.duration_ms)}</td>
              <td className="py-2 pr-2 text-text-2">{r.trigger_source || '—'}</td>
              <td className="py-2 pr-2 text-text-2">{r.rows_affected}</td>
              <td className="py-2 break-all text-danger">{r.error_message || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
