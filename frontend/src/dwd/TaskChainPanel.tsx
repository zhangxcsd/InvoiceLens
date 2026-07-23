import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import {
  fetchDimTaskChainRuns,
  fetchDimTaskChainStatus,
  fetchSettingsInstance,
  fetchSettingsThresholds,
  postDimTaskChainRetryStep,
  postDimTaskChainRun,
  type DimTaskChainStepRow,
} from '../config/localApi'
import { useDimDictDomain } from '../dim/useDimDict'

const ui = t.taskChainUi

const STEP_NAV: Record<string, NavKey> = {
  subject_library_pipeline: 'dwd_to_dim_center',
  enterprise_year_roster_build: 'dim_enterprise_year_roster',
  'dim.org_hier.build': 'dim_org_hier_tree',
  dm_audit_flag_scan: 'flags_list',
  'dm.audit_flag.scan': 'flags_list',
  'ads.scorecard.refresh': 'health_score',
}

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
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
  if (s === 'partial') return 'border-[#fde68a] bg-[#fffbeb] text-[#92400e]'
  return 'border-[#d8dee7] bg-[#f8fafc] text-text-2'
}

function stepStatusLabel(status: string, getLabel: (code: string) => string): string {
  const s = (status || '').toLowerCase()
  const fromDict = getLabel(s)
  if (fromDict && fromDict !== s) return fromDict
  if (s === 'success') return ui.stepSuccess
  if (s === 'failed') return ui.stepFailed
  if (s === 'running') return ui.stepRunning
  if (s === 'skipped') return ui.stepSkipped
  if (s === 'partial') return ui.stepPartial
  return ui.stepPending
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', { hour12: false })
}

function stepSkipMessage(row: DimTaskChainStepRow): string {
  const result = row.result
  if (result && typeof result === 'object') {
    const msg = (result as { message?: string }).message
    if (msg) return msg
  }
  return row.error_message ?? ''
}

function stepId(row: DimTaskChainStepRow): string {
  return String(row.step_id ?? row.step_code ?? '')
}

export function TaskChainPanel(props: {
  disabled?: boolean
  statYears?: number[] | null
  onNav?: (k: NavKey) => void
  onRunComplete?: () => void
  compact?: boolean
}) {
  const { disabled = false, statYears = null, onNav, onRunComplete, compact = false } = props
  const runStatusDict = useDimDictDomain('dim_task_run_status')
  const statusLabel = (code: string) => runStatusDict.getLabel(code) || code
  const [chainBusy, setChainBusy] = useState(false)
  const [retryStepId, setRetryStepId] = useState<string | null>(null)
  const [chainMsg, setChainMsg] = useState('')
  const [chainStep, setChainStep] = useState('')
  const [skipSubjectPipeline, setSkipSubjectPipeline] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [steps, setSteps] = useState<DimTaskChainStepRow[]>([])
  const [overallStatus, setOverallStatus] = useState('')
  const [instanceHint, setInstanceHint] = useState('')
  const [recentRuns, setRecentRuns] = useState<
    { run_id?: string; overall_status?: string; status?: string; started_at?: string | null }[]
  >([])
  const [runsBusy, setRunsBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadInstanceHint = useCallback(async () => {
    const [instRes, thrRes] = await Promise.all([fetchSettingsInstance(), fetchSettingsThresholds()])
    if (!instRes.ok || !instRes.config) return
    let n = 10
    if (thrRes.ok && thrRes.items) {
      const item = thrRes.items.find((i) => i.key === 'min_analysis_subject_invoice_count')
      if (item?.effective_value != null) n = Number(item.effective_value)
    }
    const year = instRes.config.default_stat_year
    if (year != null && Number.isFinite(year)) {
      setInstanceHint(ui.instanceHint.replace('{year}', String(year)).replace('{n}', String(n)))
    } else {
      setInstanceHint(ui.instanceHintNoYear.replace('{n}', String(n)))
    }
  }, [])

  const loadRecentRuns = useCallback(async () => {
    setRunsBusy(true)
    try {
      const res = await fetchDimTaskChainRuns({ limit: 8 })
      if (res.ok) setRecentRuns(res.runs ?? [])
    } finally {
      setRunsBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadInstanceHint()
    void loadRecentRuns()
  }, [loadInstanceHint, loadRecentRuns])

  const pollTaskChain = useCallback(async (runId: string) => {
    let pollMs = 1000
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    const endStates = new Set(['success', 'failed', 'partial'])
    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false as const, message: '等待任务链结果超时' }
      }
      const st = await fetchDimTaskChainStatus(runId)
      if (!st.ok) {
        return { ok: false as const, message: String(st.error?.message ?? 'unknown') }
      }
      const step = String(st.step ?? '')
      const msg = String(st.message ?? ui.running)
      setChainStep(step)
      setChainMsg(ui.currentStep.replace('{step}', step || '—').replace('{message}', msg))
      setSteps(st.steps ?? [])
      setOverallStatus(String(st.overall_status ?? st.status ?? ''))
      const status = String(st.overall_status ?? st.status ?? '').toLowerCase()
      if (endStates.has(status)) {
        if (status === 'success') {
          return { ok: true as const, message: msg }
        }
        return { ok: false as const, message: msg, partial: status === 'partial' }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      pollMs = Math.min(3000, pollMs + 250)
    }
  }, [])

  const runTaskChain = async () => {
    setChainBusy(true)
    setErr(null)
    setChainMsg('')
    setChainStep('')
    setSteps([])
    setOverallStatus('')
    try {
      const start = await postDimTaskChainRun({
        statYears,
        skipSubjectPipeline,
      })
      if (!start.ok) {
        setErr(ui.conflict.replace('{message}', String(start.error?.message ?? 'unknown')))
        return
      }
      if (!start.run_id) {
        setErr(ui.failed.replace('{message}', '未返回 run_id'))
        return
      }
      setActiveRunId(start.run_id)
      setChainMsg(ui.running)
      const polled = await pollTaskChain(start.run_id)
      if (polled.ok) {
        setChainMsg(ui.success)
      } else if ('partial' in polled && polled.partial) {
        setChainMsg(ui.overallPartial)
      } else {
        setErr(ui.failed.replace('{message}', polled.message))
      }
      onRunComplete?.()
      await loadRecentRuns()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '网络错误')
    } finally {
      setChainBusy(false)
      setRetryStepId(null)
    }
  }

  const retryStep = async (stepRow: DimTaskChainStepRow, continueChain: boolean) => {
    const sid = stepId(stepRow)
    const rid = activeRunId
    if (!rid || !sid) return
    setRetryStepId(sid)
    setChainBusy(true)
    setErr(null)
    try {
      const start = await postDimTaskChainRetryStep({ runId: rid, stepId: sid, continueChain })
      if (!start.ok) {
        setErr(ui.conflict.replace('{message}', String(start.error?.message ?? 'unknown')))
        return
      }
      setChainMsg(start.message ?? ui.retryBusy)
      const polled = await pollTaskChain(rid)
      if (polled.ok) {
        setChainMsg(ui.success)
      } else if ('partial' in polled && polled.partial) {
        setChainMsg(ui.overallPartial)
      } else {
        setErr(ui.failed.replace('{message}', polled.message))
      }
      onRunComplete?.()
      await loadRecentRuns()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '网络错误')
    } finally {
      setChainBusy(false)
      setRetryStepId(null)
    }
  }

  const loadRunDetail = async (runId: string) => {
    setActiveRunId(runId)
    const st = await fetchDimTaskChainStatus(runId)
    if (st.ok) {
      setSteps(st.steps ?? [])
      setOverallStatus(String(st.overall_status ?? st.status ?? ''))
      setChainMsg(String(st.message ?? ''))
      setChainStep(String(st.step ?? ''))
    }
  }

  const showStepTable = steps.length > 0
  const busy = chainBusy || disabled

  const stepRows = useMemo(
    () =>
      steps.map((row) => {
        const sid = stepId(row)
        const navKey = STEP_NAV[sid]
        const linkLabel =
          sid === 'enterprise_year_roster_build'
            ? ui.linkRoster
            : sid === 'dm.audit_flag.scan'
              ? ui.linkFlags
              : sid === 'ads.scorecard.refresh'
                ? ui.linkHealthScore
                : sid === 'subject_library_pipeline'
                  ? ui.linkDwdDim
                  : ui.viewRelated
        return { row, sid, navKey, linkLabel }
      }),
    [steps],
  )

  return (
    <Card title={ui.title}>
      <p className={`mb-3 leading-relaxed text-text-3 ${compact ? 'text-xs' : 'text-il-page-desc'}`}>{ui.desc}</p>
      {instanceHint ? <p className="mb-3 text-xs text-text-3">{instanceHint}</p> : null}
      {err ? (
        <div className="mb-3 rounded-md border border-danger/30 bg-[#fff5f5] px-3 py-2 text-sm text-danger">{err}</div>
      ) : null}
      <label className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm text-text-2">
        <input
          type="checkbox"
          checked={skipSubjectPipeline}
          onChange={(e) => setSkipSubjectPipeline(e.target.checked)}
          disabled={busy}
        />
        {ui.skipSubject}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void runTaskChain()}
        >
          {chainBusy && !retryStepId ? ui.running : ui.runBtn}
        </button>
        <button
          type="button"
          className="rounded border border-line px-3 py-1.5 text-sm text-text-2 hover:bg-[#f8fafc] disabled:opacity-50"
          disabled={runsBusy}
          onClick={() => void loadRecentRuns()}
        >
          {runsBusy ? ui.loadRunsBusy : ui.refreshRuns}
        </button>
      </div>
      {chainMsg ? (
        <p
          className={`mt-2 text-sm ${
            chainBusy
              ? 'text-accent-mid'
              : overallStatus === 'failed'
                ? 'text-danger'
                : overallStatus === 'partial'
                  ? 'text-[#92400e]'
                  : 'text-[#1b6b3a]'
          }`}
        >
          {chainMsg}
        </p>
      ) : null}
      {activeRunId ? (
        <p className="mt-1 font-mono text-xs text-text-3">
          {ui.runIdLabel}：{activeRunId}
        </p>
      ) : null}
      {showStepTable ? (
        <div className="mt-4 overflow-x-auto">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text">
            {ui.stepsTitle}
            {overallStatus ? (
              <span className={`rounded border px-2 py-0.5 text-xs font-normal ${statusClass(overallStatus)}`}>
                {overallStatus === 'partial' ? ui.overallPartial : stepStatusLabel(overallStatus, statusLabel)}
              </span>
            ) : null}
          </div>
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-text-3">
                <th className="py-2 pr-3 font-medium">{ui.colStep}</th>
                <th className="py-2 pr-3 font-medium">{ui.colLabel}</th>
                <th className="py-2 pr-3 font-medium">{ui.colStatus}</th>
                <th className="py-2 pr-3 font-medium">{ui.colStarted}</th>
                <th className="py-2 pr-3 font-medium">{ui.colFinished}</th>
                <th className="py-2 pr-3 font-medium">{ui.colDuration}</th>
                <th className="py-2 pr-3 font-medium">{ui.colError}</th>
                <th className="py-2 font-medium">{ui.colAction}</th>
              </tr>
            </thead>
            <tbody>
              {stepRows.map(({ row, sid, navKey, linkLabel }) => {
                const st = String(row.status ?? (row.ok === true ? 'success' : row.ok === false ? 'failed' : 'pending'))
                const skipMsg = st === 'skipped' ? stepSkipMessage(row) : ''
                const canRetry = st === 'failed' && activeRunId && !chainBusy
                return (
                  <tr key={sid} className="border-b border-line/80 align-top">
                    <td className="py-2 pr-3 font-mono text-xs text-text-2">{sid}</td>
                    <td className="py-2 pr-3 text-text">{row.label ?? sid}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${statusClass(st)}`}>
                        {stepStatusLabel(st, statusLabel)}
                        {(row.retry_count ?? 0) > 0 ? ` · ${row.retry_count}` : ''}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-3">{formatTimestamp(row.started_at)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-3">{formatTimestamp(row.finished_at)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-2">{formatDurationMs(row.duration_ms)}</td>
                    <td className="max-w-[200px] py-2 pr-3 text-xs">
                      {st === 'failed' ? (
                        <span className="text-danger">{row.error_message ?? '—'}</span>
                      ) : st === 'skipped' ? (
                        <span className="text-warn">
                          {ui.skipReasonPrefix}
                          {skipMsg || ui.stepSkipped}
                        </span>
                      ) : (
                        <span className="text-text-3">—</span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {canRetry ? (
                          <>
                            <button
                              type="button"
                              className="rounded border border-danger/40 px-2 py-0.5 text-xs text-danger hover:bg-[#fff5f5] disabled:opacity-50"
                              disabled={busy}
                              onClick={() => void retryStep(row, false)}
                            >
                              {retryStepId === sid ? ui.retryBusy : ui.retryStepOnlyBtn}
                            </button>
                            <button
                              type="button"
                              className="rounded border border-line px-2 py-0.5 text-xs text-text-2 hover:bg-[#f8fafc] disabled:opacity-50"
                              disabled={busy}
                              onClick={() => void retryStep(row, true)}
                            >
                              {retryStepId === sid ? ui.retryBusy : ui.retryContinueBtn}
                            </button>
                          </>
                        ) : null}
                        {st === 'success' && navKey && onNav ? (
                          <button
                            type="button"
                            className="rounded border border-line px-2 py-0.5 text-xs text-accent-mid hover:bg-[#f0f7ff]"
                            onClick={() => onNav(navKey)}
                          >
                            {linkLabel}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : chainStep && chainBusy ? (
        <p className="mt-1 font-mono text-xs text-text-3">
          {ui.stepsTitle}：{chainStep}
        </p>
      ) : null}
      {recentRuns.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-xs font-medium text-text-3">{ui.recentRunsTitle}</div>
          <ul className="space-y-1 text-xs">
            {recentRuns.map((r) => (
              <li key={r.run_id}>
                <button
                  type="button"
                  className="font-mono text-accent-mid hover:underline"
                  onClick={() => r.run_id && void loadRunDetail(r.run_id)}
                >
                  {r.run_id}
                </button>
                <span className="ml-2 text-text-3">{r.started_at ?? '—'}</span>
                <span className={`ml-2 rounded border px-1 ${statusClass(String(r.overall_status ?? r.status ?? ''))}`}>
                  {stepStatusLabel(String(r.overall_status ?? r.status ?? ''), statusLabel)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}
