import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  defaultDimTaskCode,
  readDimRunLogsCache,
  readDimTasksSessionCache,
  writeDimRunLogsCache,
  writeDimTasksSessionCache,
} from './dimTasksSessionCache'
import { clearDwdDimFocusTask, readDwdDimFocusTask, SUBJECT_DIM_TASK } from './dwdDimNav'
import { DIM_TASK_CATALOG, mergeDimTaskRows } from './mergeDimTasks'
import { liveElapsedMs, useLiveElapsedTick } from './useLiveElapsed'
import {
  fetchDimTaskRunStatus,
  fetchDimTaskRuns,
  fetchDimTasks,
  fetchSubjectLibraryPipelineStatus,
  fetchSubjectLibraryRenameRebuildStatus,
  postDimEnterpriseMappingBuild,
  postDimEnterpriseMasterBuild,
  postDimEnterpriseProfileBuild,
  postGroupEnterpriseYearRebuild,
  postSubjectCategoryRecompute,
  postSubjectLibraryIngestFromDwd,
  postSubjectLibraryPipeline,
  postSubjectLibraryRebuildRenameSignals,
  type DimActiveRunRow,
  type DimTasksResponse,
  type DimUnifiedTaskRow,
} from '../config/localApi'

type TaskStatus = 'idle' | 'queued' | 'running' | 'failed'
type TriggerMode = 'manual' | 'chained' | 'scheduled'

type DimTask = {
  taskNo: number
  taskCode: string
  taskName: string
  domain: string
  subjectCategory: 'SC-ENT' | 'SC-BRANCH' | 'SC-TEMP'
  layer: string
  queryGroup: string
  queryGroupLabel: string
  purpose: string
  outputDesc: string
  queryDesc: string
  outputTable: string
  triggerMode: TriggerMode[]
  dependsOn: string[]
  softDependsOn: string[]
  queueDepth: number
  status: TaskStatus
  lastRunAt: string
  lastDuration: string
  owner: string
  progressMessage: string
  elapsedMs: number
  runningRunId: string
}

type FailedRun = {
  taskCode: string
  taskName: string
  errorType: string
  lastFailAt: string
  action: 'retry' | 'inspect'
  runId: string
}

const SUBJECT_TASK_CODES = new Set<string>(Object.values(SUBJECT_DIM_TASK))

function isSubjectLibraryTask(taskCode: string): boolean {
  return SUBJECT_TASK_CODES.has(taskCode)
}

function formatDurationMs(ms: number): string {
  if (ms <= 0) return '—'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return `${min}m ${rem}s`
}

function normalizeTaskStatus(raw: string): TaskStatus {
  if (raw === 'running' || raw === 'queued' || raw === 'failed') return raw
  return 'idle'
}

function mapApiTask(raw: DimUnifiedTaskRow): DimTask {
  const status = normalizeTaskStatus(String(raw.status ?? ''))
  const lastStarted = String(raw.last_started_at ?? '').trim()
  const durationMs = Number(raw.last_duration_ms ?? 0)
  const progressMessage = String(raw.progress_message ?? '').trim()
  return {
    taskNo: Number(raw.task_no ?? 0),
    taskCode: String(raw.task_code ?? ''),
    taskName: String(raw.task_name ?? ''),
    domain: String(raw.domain ?? ''),
    subjectCategory: (raw.subject_category as DimTask['subjectCategory']) || 'SC-ENT',
    layer: String(raw.layer ?? 'DIM'),
    queryGroup: String(raw.query_group ?? ''),
    queryGroupLabel: String(raw.query_group_label ?? ''),
    purpose: String(raw.purpose ?? ''),
    outputDesc: String(raw.output_desc ?? ''),
    queryDesc: String(raw.query_desc ?? ''),
    outputTable: String(raw.output_table ?? ''),
    triggerMode: (Array.isArray(raw.trigger_modes) ? raw.trigger_modes : []) as TriggerMode[],
    dependsOn: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
    softDependsOn: Array.isArray(raw.soft_depends_on) ? raw.soft_depends_on.map(String) : [],
    queueDepth: Number(raw.queue_depth ?? 0),
    status,
    lastRunAt: lastStarted || '—',
    lastDuration:
      status === 'running'
        ? progressMessage || t.dwdToDimCenterUi.statusRunning
        : formatDurationMs(durationMs),
    owner: String(raw.owner ?? ''),
    progressMessage,
    elapsedMs: Number(raw.elapsed_ms ?? 0),
    runningRunId: String(raw.running_run_id ?? ''),
  }
}

function buildDagRows(tasks: DimTask[]): Array<{ from: string; to: string }> {
  const rows: Array<{ from: string; to: string }> = []
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      rows.push({ from: dep, to: task.taskCode })
    }
  }
  return rows
}

function statusTag(status: TaskStatus) {
  if (status === 'running') return 'border-[#c8dff7] bg-[#f0f7ff] text-accent-mid'
  if (status === 'queued') return 'border-[#f2c078] bg-[#fff7ea] text-warn'
  if (status === 'failed') return 'border-danger/30 bg-[#fff5f5] text-danger'
  return 'border-[#d8dee7] bg-[#f8fafc] text-text-2'
}

function statusText(status: TaskStatus) {
  if (status === 'running') return t.dwdToDimCenterUi.statusRunning
  if (status === 'queued') return t.dwdToDimCenterUi.statusQueued
  if (status === 'failed') return t.dwdToDimCenterUi.statusFailed
  return t.dwdToDimCenterUi.statusIdle
}

function triggerText(mode: TriggerMode) {
  if (mode === 'manual') return t.dwdToDimCenterUi.triggerManual
  if (mode === 'chained') return t.dwdToDimCenterUi.triggerChained
  return t.dwdToDimCenterUi.triggerScheduled
}

function runStatusText(status: string) {
  if (status === 'success') return t.dwdToDimCenterUi.runStatusSuccess
  if (status === 'failed') return t.dwdToDimCenterUi.runStatusFailed
  if (status === 'running') return t.dwdToDimCenterUi.runStatusRunning
  return status || '—'
}

function runStatusClass(status: string) {
  if (status === 'success') return 'border-[#b7e4c8] bg-[#f0fdf4] text-[#0d5c2e]'
  if (status === 'failed') return 'border-danger/30 bg-[#fff5f5] text-danger'
  if (status === 'running') return 'border-[#c8dff7] bg-[#f0f7ff] text-accent-mid'
  return 'border-[#d8dee7] bg-[#f8fafc] text-text-2'
}

type RunLogRow = {
  run_id: string
  status: string
  rows_affected: number
  started_at: string
  duration_ms: number
  error_message: string
}

function mapTasksFromResponse(
  response: Pick<DimTasksResponse, 'ok' | 'tasks' | 'registry'> & Partial<DimTasksResponse>,
): DimTask[] {
  const mergedRows = mergeDimTaskRows(response.ok ? response : { ok: false, tasks: [], registry: DIM_TASK_CATALOG })
  return mergedRows.map((row) => mapApiTask(row))
}

function mapRunLogRows(
  runs: Array<{
    run_id?: string
    status?: string
    rows_affected?: number
    started_at?: string
    duration_ms?: number
    error_message?: string
  }>,
): RunLogRow[] {
  return runs.map((x) => ({
    run_id: String(x.run_id ?? ''),
    status: String(x.status ?? ''),
    rows_affected: Number(x.rows_affected ?? 0),
    started_at: String(x.started_at ?? ''),
    duration_ms: Number(x.duration_ms ?? 0),
    error_message: String(x.error_message ?? ''),
  }))
}

function initialTasksState(): DimTask[] {
  const cached = readDimTasksSessionCache()
  if (cached?.ok) return mapTasksFromResponse(cached)
  return mapTasksFromResponse({ ok: false, tasks: [], registry: DIM_TASK_CATALOG })
}

function initialActiveTaskCode(): string {
  const cached = readDimTasksSessionCache()
  if (cached?.ok && cached.tasks?.length) {
    return String(cached.tasks[0]?.task_code ?? defaultDimTaskCode())
  }
  return defaultDimTaskCode()
}

function initialRunLogs(taskCode: string): RunLogRow[] {
  return readDimRunLogsCache(taskCode) ?? []
}

export function DwdToDimCenterPage({ visible = true }: { visible?: boolean }) {
  const bootTaskCode = useMemo(() => initialActiveTaskCode(), [])
  const [tasks, setTasks] = useState<DimTask[]>(initialTasksState)
  const [activeRuns, setActiveRuns] = useState<DimActiveRunRow[]>(
    () => readDimTasksSessionCache()?.active_runs ?? [],
  )
  const [failedRuns, setFailedRuns] = useState<FailedRun[]>(() => {
    const cached = readDimTasksSessionCache()
    if (!cached?.ok) return []
    return (cached.failed_recent ?? []).map((row) => ({
      taskCode: String(row.task_code ?? ''),
      taskName: String(row.task_name ?? ''),
      errorType: String(row.error_message ?? '任务失败'),
      lastFailAt: String(row.last_fail_at ?? ''),
      action: 'inspect' as const,
      runId: String(row.run_id ?? ''),
    }))
  })
  const [taskStats, setTaskStats] = useState(() => {
    const stats = readDimTasksSessionCache()?.stats
    return {
      running_count: Number(stats?.running_count ?? 0),
      queued_count: Number(stats?.queued_count ?? 0),
      queue_depth_total: Number(stats?.queue_depth_total ?? 0),
    }
  })
  const [statusSyncing, setStatusSyncing] = useState(() => !readDimTasksSessionCache()?.ok)
  const [tasksFetchedAtMs, setTasksFetchedAtMs] = useState(() =>
    readDimTasksSessionCache()?.ok ? Date.now() : 0,
  )
  const [statusRefreshSeq, setStatusRefreshSeq] = useState(0)
  const [activeTaskCode, setActiveTaskCode] = useState(bootTaskCode)
  const [queryGroupFilter, setQueryGroupFilter] = useState<string>('all')
  const [failureFocus, setFailureFocus] = useState<FailedRun | null>(null)
  const [showRunDialog, setShowRunDialog] = useState(false)
  const [runMode, setRunMode] = useState<'incremental' | 'full'>('incremental')
  const [selectedDepend, setSelectedDepend] = useState<'auto' | 'ignore'>('auto')
  const [submitBusy, setSubmitBusy] = useState(false)
  const [runLive, setRunLive] = useState<{
    runId: string
    message: string
    step: string
    status: string
    startedAtMs: number
  } | null>(null)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)
  const [runLogsBusy, setRunLogsBusy] = useState(() => !readDimRunLogsCache(bootTaskCode))
  const [runLogs, setRunLogs] = useState<RunLogRow[]>(() => initialRunLogs(bootTaskCode))
  const [showRunLogsDialog, setShowRunLogsDialog] = useState(false)
  const [allRunsBusy, setAllRunsBusy] = useState(false)
  const [allRuns, setAllRuns] = useState<
    Array<{
      run_id: string
      task_code: string
      status: string
      rows_affected: number
      started_at: string
      duration_ms: number
      error_message: string
    }>
  >([])
  const [allRunsTaskFilter, setAllRunsTaskFilter] = useState<string>('all')
  const [allRunsStatusFilter, setAllRunsStatusFilter] = useState<string>('all')
  const [allRunsPage, setAllRunsPage] = useState(1)
  const [runLogRefreshSeq, setRunLogRefreshSeq] = useState(0)
  const taskDetailCardRef = useRef<HTMLDivElement>(null)
  const runLogSectionRef = useRef<HTMLDivElement>(null)

  const taskCodeToName = useMemo(
    () =>
      Object.fromEntries(
        tasks.map((x) => [x.taskCode, x.taskNo > 0 ? `${x.taskNo}. ${x.taskName}` : x.taskName]),
      ),
    [tasks],
  )
  const liveTick = useLiveElapsedTick(
    activeRuns.length > 0 || tasks.some((x) => x.status === 'running') || submitBusy,
  )
  const runLiveElapsed = useMemo(() => {
    if (!runLive) return 0
    return Math.max(0, Date.now() - runLive.startedAtMs)
  }, [runLive, liveTick])

  const applyTasksResponse = useCallback((r: Awaited<ReturnType<typeof fetchDimTasks>>) => {
    const mapped = mapTasksFromResponse(r)
    setTasks(mapped)
    if (!r.ok) return mapped
    writeDimTasksSessionCache(r)
    setActiveRuns(Array.isArray(r.active_runs) ? r.active_runs : [])
    setFailedRuns(
      (r.failed_recent ?? []).map((row) => ({
        taskCode: String(row.task_code ?? ''),
        taskName: String(row.task_name ?? ''),
        errorType: String(row.error_message ?? '任务失败'),
        lastFailAt: String(row.last_fail_at ?? ''),
        action: 'inspect' as const,
        runId: String(row.run_id ?? ''),
      })),
    )
    setTaskStats({
      running_count: Number(r.stats?.running_count ?? 0),
      queued_count: Number(r.stats?.queued_count ?? 0),
      queue_depth_total: Number(r.stats?.queue_depth_total ?? 0),
    })
    setTasksFetchedAtMs(Date.now())
    setActiveTaskCode((prev) => {
      if (prev && mapped.some((x) => x.taskCode === prev)) return prev
      return mapped[0]?.taskCode ?? ''
    })
    return mapped
  }, [])

  const loadTasks = useCallback(
    async (signal?: AbortSignal) => {
      setStatusSyncing(true)
      try {
        const r = await fetchDimTasks(signal)
        applyTasksResponse(r)
        if (!r.ok) {
          setActiveRuns([])
          setFailedRuns([])
        }
      } finally {
        setStatusSyncing(false)
      }
    },
    [applyTasksResponse],
  )

  const prevVisibleRef = useRef(visible)

  useEffect(() => {
    const ac = new AbortController()
    void loadTasks(ac.signal)
    return () => ac.abort()
  }, [loadTasks, statusRefreshSeq])

  useEffect(() => {
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = visible
    if (visible && !wasVisible) {
      setStatusRefreshSeq((n) => n + 1)
    }
  }, [visible])

  useEffect(() => {
    const hasLive =
      activeRuns.length > 0 || tasks.some((x) => x.status === 'running' || x.status === 'queued')
    if (!hasLive) return undefined
    const timer = window.setInterval(() => setStatusRefreshSeq((n) => n + 1), 1500)
    return () => window.clearInterval(timer)
  }, [activeRuns.length, tasks])

  const [overwriteManualRepairs, setOverwriteManualRepairs] = useState(false)
  const [recomputeWithRelations, setRecomputeWithRelations] = useState(true)
  const activeTask = useMemo(
    () => tasks.find((x) => x.taskCode === activeTaskCode) ?? tasks[0] ?? null,
    [activeTaskCode, tasks],
  )
  const queryGroupOptions = useMemo(() => {
    const labels = new Map<string, string>()
    for (const task of tasks) {
      if (task.queryGroup) labels.set(task.queryGroup, task.queryGroupLabel || task.queryGroup)
    }
    return [...labels.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [tasks])

  const visibleTasks = useMemo(
    () =>
      tasks
        .filter((x) => queryGroupFilter === 'all' || x.queryGroup === queryGroupFilter)
        .sort((a, b) => a.taskNo - b.taskNo || a.taskCode.localeCompare(b.taskCode)),
    [queryGroupFilter, tasks],
  )
  const queueTotal = taskStats.queue_depth_total
  const runningCount = taskStats.running_count
  const queuedCount = taskStats.queued_count
  const queueWaiting = tasks.filter((x) => x.status === 'queued').map((x) => x.taskCode)
  const dagRows = useMemo(() => buildDagRows(tasks), [tasks])

  useEffect(() => {
    const focus = readDwdDimFocusTask()
    if (focus && SUBJECT_TASK_CODES.has(focus)) {
      setActiveTaskCode(focus)
      clearDwdDimFocusTask()
    }
  }, [])

  useEffect(() => {
    if (failureFocus && failureFocus.taskCode !== activeTaskCode) {
      setFailureFocus(null)
    }
  }, [activeTaskCode, failureFocus])

  const selectTaskFromDag = (taskCode: string) => {
    setActiveTaskCode(taskCode)
    setFailureFocus(null)
    requestAnimationFrame(() => {
      taskDetailCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  const selectTaskFromList = (taskCode: string) => {
    setActiveTaskCode(taskCode)
    setFailureFocus(null)
  }

  const selectFromFailureRow = (row: FailedRun) => {
    setActiveTaskCode(row.taskCode)
    setFailureFocus(row)
    requestAnimationFrame(() => {
      taskDetailCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      runLogSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  const edgeHighlighted = (from: string, to: string) => from === activeTaskCode || to === activeTaskCode

  const taskCodes = useMemo(() => new Set(tasks.map((x) => x.taskCode)), [tasks])

  const selectDownstreamFromEdge = (to: string) => {
    if (taskCodes.has(to)) {
      selectTaskFromDag(to)
    }
  }

  useEffect(() => {
    if (!activeTaskCode) return
    const cached = readDimRunLogsCache(activeTaskCode)
    if (cached) {
      setRunLogs(cached)
      setRunLogsBusy(false)
    } else {
      setRunLogs([])
      setRunLogsBusy(true)
    }
    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      try {
        const r = await fetchDimTaskRuns({ task_code: activeTaskCode, limit: 6 }, ac.signal)
        if (cancelled) return
        if (!r.ok) {
          if (!cached) setRunLogs([])
          return
        }
        const rows = mapRunLogRows(r.runs)
        writeDimRunLogsCache(activeTaskCode, rows)
        setRunLogs(rows)
      } finally {
        if (!cancelled) setRunLogsBusy(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [activeTaskCode, runLogRefreshSeq])

  useEffect(() => {
    if (!showRunLogsDialog) return
    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      setAllRunsBusy(true)
      try {
        const r = await fetchDimTaskRuns({ limit: 80 }, ac.signal)
        if (cancelled) return
        if (!r.ok) {
          setAllRuns([])
          return
        }
        setAllRuns(
          r.runs.map((x) => ({
            run_id: String(x.run_id ?? ''),
            task_code: String(x.task_code ?? ''),
            status: String(x.status ?? ''),
            rows_affected: Number(x.rows_affected ?? 0),
            started_at: String(x.started_at ?? ''),
            duration_ms: Number(x.duration_ms ?? 0),
            error_message: String(x.error_message ?? ''),
          })),
        )
      } finally {
        if (!cancelled) setAllRunsBusy(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [showRunLogsDialog])

  const allRunsFiltered = useMemo(
    () =>
      allRuns.filter((r) => {
        if (allRunsTaskFilter !== 'all' && r.task_code !== allRunsTaskFilter) return false
        if (allRunsStatusFilter !== 'all' && r.status !== allRunsStatusFilter) return false
        return true
      }),
    [allRuns, allRunsTaskFilter, allRunsStatusFilter],
  )
  const allRunsPageSize = 10
  const allRunsTotalPages = Math.max(1, Math.ceil(allRunsFiltered.length / allRunsPageSize))
  const allRunsPageSafe = Math.min(allRunsPage, allRunsTotalPages)
  const allRunsPageRows = useMemo(
    () => allRunsFiltered.slice((allRunsPageSafe - 1) * allRunsPageSize, allRunsPageSafe * allRunsPageSize),
    [allRunsFiltered, allRunsPageSafe],
  )

  const pollDimTaskRun = async (
    runId: string,
    startedAtMs: number,
  ): Promise<{ ok: true; message?: string; rows?: number } | { ok: false; message: string }> => {
    const pollMs = 1500
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    const endStates = new Set(['success', 'failed'])
    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false, message: '等待任务结果超时' }
      }
      const st = await fetchDimTaskRunStatus(runId)
      if (!st.ok) {
        return { ok: false, message: String(st.error?.message ?? 'unknown') }
      }
      setRunLive({
        runId,
        message: String(st.progress_message ?? st.error_message ?? '执行中…'),
        step: String(st.progress_step ?? st.status ?? 'running'),
        status: String(st.status ?? 'running'),
        startedAtMs,
      })
      setStatusRefreshSeq((n) => n + 1)
      if (endStates.has(String(st.status ?? ''))) {
        if (st.status === 'success') {
          return {
            ok: true,
            message: st.progress_message ? String(st.progress_message) : undefined,
            rows: Number(st.rows_affected ?? 0),
          }
        }
        return { ok: false, message: String(st.error_message ?? st.progress_message ?? 'failed') }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  const pollPipeline = async (
    runId: string,
    startedAtMs: number,
  ): Promise<{ ok: true; message?: string } | { ok: false; message: string }> => {
    const pollMs = 1500
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    const endStates = new Set(['success', 'failed'])
    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false, message: '等待全流程结果超时' }
      }
      const st = await fetchDimTaskRunStatus(runId)
      if (st.ok) {
        setRunLive({
          runId,
          message: String(st.progress_message ?? '执行中…'),
          step: String(st.progress_step ?? st.status ?? 'running'),
          status: String(st.status ?? 'running'),
          startedAtMs,
        })
        setStatusRefreshSeq((n) => n + 1)
        if (endStates.has(String(st.status ?? ''))) {
          if (st.status === 'success') {
            return { ok: true, message: st.progress_message ? String(st.progress_message) : undefined }
          }
          return { ok: false, message: String(st.error_message ?? st.progress_message ?? 'failed') }
        }
      } else {
        const legacy = await fetchSubjectLibraryPipelineStatus(runId)
        if (!legacy.ok) {
          return { ok: false, message: String(legacy.error?.message ?? st.error?.message ?? 'unknown') }
        }
        if (endStates.has(String(legacy.status ?? ''))) {
          if (legacy.status === 'success') {
            return { ok: true, message: legacy.message ? String(legacy.message) : undefined }
          }
          return { ok: false, message: String(legacy.message ?? 'failed') }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  const pollRenameRebuild = async (runId: string): Promise<{ ok: true; message?: string } | { ok: false; message: string }> => {
    const pollMs = 1500
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    const endStates = new Set(['success', 'failed'])
    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false, message: '等待重建结果超时' }
      }
      const st = await fetchSubjectLibraryRenameRebuildStatus(runId)
      if (!st.ok) {
        return { ok: false, message: String(st.error?.message ?? 'unknown') }
      }
      if (endStates.has(String(st.status ?? ''))) {
        if (st.status === 'success') {
          return { ok: true, message: st.message ? String(st.message) : undefined }
        }
        const em =
          st.error && typeof st.error === 'object' && 'message' in st.error
            ? String((st.error as { message?: string }).message)
            : st.message
        return { ok: false, message: String(em ?? 'failed') }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  const handleConfirmRun = async () => {
    if (!activeTask) return
    const enterpriseScoped = new Set([
      'enterprise_master_build',
      'enterprise_mapping_check',
      'enterprise_profile_agg',
    ])
    const effectiveScope = enterpriseScoped.has(activeTask.taskCode) ? 'ALL' : 'SC-ENT'
    const scopeSuffix = t.dwdToDimCenterUi.runSubmitScopeSuffix.replace('{scope}', effectiveScope)
    const startedAtMs = Date.now()
    setSubmitMsg(null)
    setRunLive(null)
    setSubmitBusy(true)
    try {
      if (activeTask.taskCode === SUBJECT_DIM_TASK.pipeline) {
        const start = await postSubjectLibraryPipeline({
          overwrite_manual_repairs: overwriteManualRepairs,
          with_relations: recomputeWithRelations,
        })
        if (!start.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(start.error?.message ?? 'unknown')))
        } else if (!start.run_id) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', '未返回 run_id'))
        } else {
          setRunLive({
            runId: start.run_id,
            message: start.message ?? t.dwdToDimCenterUi.subjectPipelineStarted.replace('{runId}', start.run_id),
            step: 'queued',
            status: 'running',
            startedAtMs,
          })
          setStatusRefreshSeq((n) => n + 1)
          const polled = await pollPipeline(start.run_id, startedAtMs)
          if (polled.ok) {
            setSubmitMsg(
              t.dwdToDimCenterUi.subjectPipelineFinished.replace(
                '{extra}',
                polled.message ? `：${polled.message}` : '',
              ),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
          setStatusRefreshSeq((n) => n + 1)
          setRunLogRefreshSeq((n) => n + 1)
        }
      } else if (activeTask.taskCode === 'subject_master_ingest_from_dwd') {
        const r = await postSubjectLibraryIngestFromDwd({ overwrite_manual_repairs: overwriteManualRepairs })
        if (r.ok) {
          const n = r.result?.subjects_upserted ?? 0
          const runId = r.result?.run_id ?? '—'
          const extra = r.message ? `；${r.message}` : ''
          setSubmitMsg(
            t.dwdToDimCenterUi.subjectIngestSuccess
              .replace('{count}', String(n))
              .replace('{runId}', String(runId))
              .replace('{extra}', extra),
          )
        } else {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        }
      } else if (activeTask.taskCode === 'subject_category_recompute') {
        const r = await postSubjectCategoryRecompute({
          with_relations: recomputeWithRelations,
          overwrite_manual_repairs: overwriteManualRepairs,
          async: true,
        })
        if (!r.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        } else if (!r.run_id) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', '未返回 run_id'))
        } else {
          setRunLive({
            runId: r.run_id,
            message: r.message ?? '已启动主体分类重算…',
            step: 'queued',
            status: 'running',
            startedAtMs,
          })
          setStatusRefreshSeq((n) => n + 1)
          const polled = await pollDimTaskRun(r.run_id, startedAtMs)
          if (polled.ok) {
            const extra = polled.message ? `；${polled.message}` : ''
            setSubmitMsg(
              t.dwdToDimCenterUi.subjectRecomputeSuccess.replace('{runId}', r.run_id).replace('{extra}', extra),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
          setStatusRefreshSeq((n) => n + 1)
          setRunLogRefreshSeq((n) => n + 1)
        }
      } else if (activeTask.taskCode === 'group_enterprise_year_build') {
        const r = await postGroupEnterpriseYearRebuild({ async: true })
        if (!r.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        } else if (!r.run_id) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', '未返回 run_id'))
        } else {
          setRunLive({
            runId: r.run_id,
            message: r.message ?? '已从管理与产权台账启动集团成员表计算…',
            step: 'queued',
            status: 'running',
            startedAtMs,
          })
          setStatusRefreshSeq((n) => n + 1)
          const polled = await pollDimTaskRun(r.run_id, startedAtMs)
          if (polled.ok) {
            const extra = polled.message ? `；${polled.message}` : ''
            setSubmitMsg(
              t.dwdToDimCenterUi.groupEnterpriseRebuildSuccess
                .replace('{runId}', r.run_id)
                .replace('{rows}', String(polled.rows ?? 0))
                .replace('{extra}', extra),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
          setStatusRefreshSeq((n) => n + 1)
          setRunLogRefreshSeq((n) => n + 1)
        }
      } else if (activeTask.taskCode === SUBJECT_DIM_TASK.rename) {
        const start = await postSubjectLibraryRebuildRenameSignals()
        if (!start.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(start.error?.message ?? 'unknown')))
        } else if (start.async !== true) {
          setSubmitMsg(
            t.dwdToDimCenterUi.subjectRenameSuccess.replace(
              '{extra}',
              start.message ? `：${start.message}` : '',
            ),
          )
        } else if (!start.run_id) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', '未返回 run_id'))
        } else {
          const polled = await pollRenameRebuild(start.run_id)
          if (polled.ok) {
            setSubmitMsg(
              t.dwdToDimCenterUi.subjectRenameSuccess.replace(
                '{extra}',
                polled.message ? `：${polled.message}` : '',
              ),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
        }
      } else if (activeTask.taskCode === 'enterprise_profile_agg') {
        const sourceScope = runMode === 'full' ? 'manual_full' : 'manual_incremental'
        const r = await postDimEnterpriseProfileBuild({ source_scope: sourceScope, subject_category_scope: effectiveScope })
        if (!r.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        } else if (r.async === true && r.run_id) {
          setRunLive({
            runId: r.run_id,
            message: t.dwdToDimCenterUi.runSubmitAsyncStarted.replace('{runId}', String(r.run_id)),
            step: 'queued',
            status: 'running',
            startedAtMs,
          })
          setStatusRefreshSeq((n) => n + 1)
          const polled = await pollDimTaskRun(r.run_id, startedAtMs)
          if (polled.ok) {
            setSubmitMsg(
              `${t.dwdToDimCenterUi.runSubmitSuccess
                .replace('{runId}', String(r.run_id))
                .replace('{rows}', String(polled.rows ?? 0))
                .replace('{ents}', '—')} ${scopeSuffix}`.trim(),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
          setStatusRefreshSeq((n) => n + 1)
          setRunLogRefreshSeq((n) => n + 1)
        } else {
          setSubmitMsg(
            `${t.dwdToDimCenterUi.runSubmitSuccess
              .replace('{runId}', String(r.run_id ?? 'N/A'))
              .replace('{rows}', String(r.profile_rows_written ?? 0))
              .replace('{ents}', String(r.enterprise_upserted ?? 0))} ${scopeSuffix}`.trim(),
          )
        }
      } else if (activeTask.taskCode === 'enterprise_master_build') {
        const r = await postDimEnterpriseMasterBuild({ subject_category_scope: effectiveScope })
        if (!r.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        } else if (r.async === true && r.run_id) {
          setRunLive({
            runId: r.run_id,
            message: t.dwdToDimCenterUi.runSubmitAsyncStarted.replace('{runId}', String(r.run_id)),
            step: 'queued',
            status: 'running',
            startedAtMs,
          })
          setStatusRefreshSeq((n) => n + 1)
          const polled = await pollDimTaskRun(r.run_id, startedAtMs)
          if (polled.ok) {
            setSubmitMsg(
              `${t.dwdToDimCenterUi.runSubmitSuccessRows
                .replace('{runId}', String(r.run_id))
                .replace('{rows}', String(polled.rows ?? 0))} ${scopeSuffix}`.trim(),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
          setStatusRefreshSeq((n) => n + 1)
          setRunLogRefreshSeq((n) => n + 1)
        } else {
          setSubmitMsg(
            `${t.dwdToDimCenterUi.runSubmitSuccessRows
              .replace('{runId}', String(r.run_id ?? 'N/A'))
              .replace('{rows}', String(r.rows_affected ?? 0))} ${scopeSuffix}`.trim(),
          )
        }
      } else if (activeTask.taskCode === 'enterprise_mapping_check') {
        const r = await postDimEnterpriseMappingBuild({ subject_category_scope: effectiveScope })
        if (!r.ok) {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        } else if (r.async === true && r.run_id) {
          setRunLive({
            runId: r.run_id,
            message: t.dwdToDimCenterUi.runSubmitAsyncStarted.replace('{runId}', String(r.run_id)),
            step: 'queued',
            status: 'running',
            startedAtMs,
          })
          setStatusRefreshSeq((n) => n + 1)
          const polled = await pollDimTaskRun(r.run_id, startedAtMs)
          if (polled.ok) {
            setSubmitMsg(
              `${t.dwdToDimCenterUi.runSubmitSuccessRows
                .replace('{runId}', String(r.run_id))
                .replace('{rows}', String(polled.rows ?? 0))} ${scopeSuffix}`.trim(),
            )
          } else {
            setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
          }
          setStatusRefreshSeq((n) => n + 1)
          setRunLogRefreshSeq((n) => n + 1)
        } else {
          setSubmitMsg(
            `${t.dwdToDimCenterUi.runSubmitSuccessRows
              .replace('{runId}', String(r.run_id ?? 'N/A'))
              .replace('{rows}', String(r.rows_affected ?? 0))} ${scopeSuffix}`.trim(),
          )
        }
      } else {
        setSubmitMsg(t.dwdToDimCenterUi.runNotImplementedHint)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'network error'
      setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', msg))
      setRunLogRefreshSeq((n) => n + 1)
    } finally {
      setSubmitBusy(false)
      setRunLive(null)
      setShowRunDialog(false)
      setStatusRefreshSeq((n) => n + 1)
      setRunLogRefreshSeq((n) => n + 1)
    }
  }

  return (
    <div className="space-y-4 p-6">
      {submitMsg ? (
        <Card compact className="border-accent/30 bg-[#f0f7ff]">
          <div className="text-il-page-desc text-accent-mid">{submitMsg}</div>
        </Card>
      ) : null}
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{t.dwdToDimCenterUi.pageTitle}</h1>
            {statusSyncing ? (
              <span className="rounded-full border border-border-light bg-[#f8fafc] px-2 py-[1px] text-il-pill font-semibold text-text-3">
                {t.dwdToDimCenterUi.tasksLoading}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
            onClick={() => setStatusRefreshSeq((n) => n + 1)}
            disabled={statusSyncing}
          >
            {t.dwdToDimCenterUi.refresh}
          </button>
        </div>
        <p className="text-il-page-desc leading-relaxed text-text-2">{t.dwdToDimCenterUi.pageBody}</p>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <Card compact>
          <div className="text-il-label text-text-3">{t.dwdToDimCenterUi.kpiTaskCount}</div>
          <div className="mt-1 text-2xl font-semibold text-text">{tasks.length}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{t.dwdToDimCenterUi.kpiRunningCount}</div>
          <div className="mt-1 text-2xl font-semibold text-text">{runningCount}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{t.dwdToDimCenterUi.kpiQueueDepth}</div>
          <div className="mt-1 text-2xl font-semibold text-text">{queueTotal}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{t.dwdToDimCenterUi.kpiQueuedTaskCount}</div>
          <div className="mt-1 text-2xl font-semibold text-text">{queuedCount}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card title={t.dwdToDimCenterUi.dagTitle}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-il-label text-text-3">
            <span>{t.dwdToDimCenterUi.dagHint}</span>
            <span className="text-text-3">{t.dwdToDimCenterUi.dagNodeClickHint}</span>
          </div>
          <div className="rounded-[8px] border border-border-light bg-white p-3">
            <div className="mb-2 flex items-center justify-end">
              <label className="flex items-center gap-2 text-il-meta text-text-2">
                <span>{t.dwdToDimCenterUi.querySourceFilter}</span>
                <select
                  value={queryGroupFilter}
                  onChange={(e) => setQueryGroupFilter(e.target.value)}
                  className="rounded-[7px] border border-border bg-[#fafbfc] px-2 py-1 text-il-input text-text outline-none focus:border-accent"
                >
                  <option value="all">{t.dwdToDimCenterUi.querySourceAll}</option>
                  {queryGroupOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {visibleTasks.map((task) => (
                <button
                  key={task.taskCode}
                  type="button"
                  onClick={() => selectTaskFromDag(task.taskCode)}
                  className={[
                    'w-full rounded-[8px] border p-2.5 text-left transition-colors',
                    task.taskCode === activeTaskCode
                      ? 'border-accent/50 bg-[#f0f7ff] ring-1 ring-accent/25'
                      : 'border-border-light bg-[#f8fafc] hover:border-accent/30 hover:bg-[#fafcff]',
                  ].join(' ')}
                >
                  <div className="text-il-card-title font-semibold text-text">
                    {task.taskNo > 0 ? `${task.taskNo}. ` : ''}
                    {task.taskName}
                  </div>
                  <div className="font-mono text-il-meta text-text-3">{task.taskCode}</div>
                  {task.purpose ? (
                    <div className="mt-1 line-clamp-2 text-il-meta leading-snug text-text-3">{task.purpose}</div>
                  ) : null}
                  <div className="mt-1 text-il-label text-text-2">
                    {t.dwdToDimCenterUi.dagNodeOutput}：{task.outputTable}
                    {task.layer ? ` · ${task.layer}` : ''}
                  </div>
                  <div className="mt-1 text-il-label text-text-2">
                    {t.dwdToDimCenterUi.dagNodeDependsOn}：{task.dependsOn.join(' , ')}
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-il-label text-text-3">
              <span>{t.dwdToDimCenterUi.dagEdgeHighlightNote}</span>
              <span>{t.dwdToDimCenterUi.dagEdgeClickHint}</span>
            </div>
            <div className="mt-1 rounded-[8px] border border-border-light bg-[#f8fafc] p-2.5 text-il-label text-text-2">
              {dagRows.map((edge, idx) => {
                const hi = edgeHighlighted(edge.from, edge.to)
                const downstreamKnown = taskCodes.has(edge.to)
                return (
                  <button
                    key={`${edge.from}-${edge.to}-${idx}`}
                    type="button"
                    disabled={!downstreamKnown}
                    title={downstreamKnown ? edge.to : undefined}
                    onClick={() => selectDownstreamFromEdge(edge.to)}
                    className={[
                      'flex w-full rounded-[4px] py-[4px] px-1 text-left',
                      hi ? 'bg-[#e8f2ff] font-medium text-accent-mid' : '',
                      downstreamKnown
                        ? 'cursor-pointer hover:bg-[#dceeff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/40'
                        : 'cursor-not-allowed opacity-60',
                    ].join(' ')}
                  >
                    <span className="font-mono text-il-meta text-text-2">{edge.from}</span>
                    <span className="mx-1 text-text-3">→</span>
                    <span
                      className={
                        downstreamKnown ? 'font-mono text-il-meta font-semibold text-text' : 'font-mono text-il-meta'
                      }
                    >
                      {edge.to}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </Card>

        <Card title={t.dwdToDimCenterUi.activeRunsTitle}>
          <div className="mb-2 text-il-label text-text-3">{t.dwdToDimCenterUi.activeRunsHint}</div>
          {activeRuns.length === 0 ? (
            <div className="rounded-[8px] border border-border-light bg-[#f8fafc] p-3 text-il-label text-text-2">
              {t.dwdToDimCenterUi.activeRunsEmpty}
            </div>
          ) : (
            <div className="space-y-2">
              {activeRuns.map((run) => {
                const elapsed = liveElapsedMs(run, tasksFetchedAtMs, liveTick)
                return (
                  <button
                    key={run.run_id}
                    type="button"
                    onClick={() => selectTaskFromDag(String(run.task_code ?? ''))}
                    className="w-full rounded-[8px] border border-border-light bg-[#f8fafc] p-3 text-left hover:border-accent/30 hover:bg-[#fafcff]"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="font-medium text-text">{run.task_name || run.task_code}</div>
                      <span className="text-il-label text-accent-mid">{statusText('running')}</span>
                    </div>
                    <div className="font-mono text-il-meta text-text-3">{run.run_id}</div>
                    <div className="mt-1 text-il-label text-text-2">
                      {run.progress_message || t.dwdToDimCenterUi.statusRunning}
                    </div>
                    <div className="mt-1 text-il-meta text-text-3">
                      {t.dwdToDimCenterUi.detailDuration}：{formatDurationMs(elapsed)}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          <div className="mt-3 rounded-[8px] border border-border-light bg-white p-3 text-il-label text-text-2">
            {t.dwdToDimCenterUi.queueWaitingLabel}：{queueWaiting.length > 0 ? queueWaiting.join(' , ') : '—'}
          </div>
        </Card>

        <Card title={t.dwdToDimCenterUi.taskListTitle}>
          <div className="mb-2 flex items-center justify-between text-il-label text-text-3">
            <span>{t.dwdToDimCenterUi.taskListHint}</span>
            <span>{t.dwdToDimCenterUi.queueHint.replace('{count}', String(queueTotal))}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-il-page-desc">
              <thead>
                <tr className="border-b border-border-light text-il-meta font-semibold text-text-3">
                  <th className="w-10 py-2 pr-2 text-center">{t.dwdToDimCenterUi.colTaskNo}</th>
                  <th className="py-2 pr-3">{t.dwdToDimCenterUi.colTaskName}</th>
                  <th className="py-2 pr-3">{t.dwdToDimCenterUi.colQuerySource}</th>
                  <th className="py-2 pr-3">{t.dwdToDimCenterUi.colOutput}</th>
                  <th className="py-2 pr-3">{t.dwdToDimCenterUi.colTriggerMode}</th>
                  <th className="py-2 pr-3 text-right">{t.dwdToDimCenterUi.colQueue}</th>
                  <th className="py-2">{t.dwdToDimCenterUi.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((row) => (
                  <tr
                    key={row.taskCode}
                    className={[
                      'cursor-pointer border-b border-border-light/70',
                      row.taskCode === activeTaskCode ? 'bg-[#f8fbff]' : 'hover:bg-[#fafcff]',
                    ].join(' ')}
                    onClick={() => selectTaskFromList(row.taskCode)}
                  >
                    <td className="py-2 pr-2 align-top text-center tabular-nums font-semibold text-text">
                      {row.taskNo}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <div className="font-medium text-text">{row.taskName}</div>
                      <div className="font-mono text-il-meta text-text-3">{row.taskCode}</div>
                      {row.purpose ? (
                        <div className="mt-0.5 line-clamp-2 text-il-meta leading-snug text-text-3">{row.purpose}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 align-top text-text-2">
                      <div>{row.queryGroupLabel || '—'}</div>
                      {row.queryGroup ? (
                        <div className="font-mono text-il-meta text-text-3">{row.queryGroup}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <div className="font-mono text-text-2">{row.outputTable}</div>
                      {row.layer ? (
                        <div className="mt-0.5 text-il-meta text-text-3">{row.layer}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 align-top text-text-2">{row.triggerMode.map(triggerText).join(' / ')}</td>
                    <td className="py-2 pr-3 align-top text-right tabular-nums text-text-2">{row.queueDepth}</td>
                    <td className="py-2 align-top">
                      <span className={['inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold', statusTag(row.status)].join(' ')}>
                        {statusText(row.status)}
                      </span>
                      {row.status === 'running' && row.progressMessage ? (
                        <div className="mt-1 max-w-[220px] text-il-meta text-text-3">{row.progressMessage}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title={t.dwdToDimCenterUi.taskDetailTitle} className="scroll-mt-4">
          <div ref={taskDetailCardRef}>
          {!activeTask ? (
            <div className="text-il-page-desc text-text-3">{t.dwdToDimCenterUi.emptyTaskDetail}</div>
          ) : (
            <div className="space-y-3 text-il-page-desc">
              <div className="rounded-[8px] border border-border-light bg-[#f8fafc] p-3">
                <div className="mb-1 font-semibold text-text">
                  {activeTask.taskNo > 0 ? `${activeTask.taskNo}. ` : ''}
                  {activeTask.taskName}
                </div>
                <div className="font-mono text-il-meta text-text-3">{activeTask.taskCode}</div>
              </div>
              {activeTask.purpose || activeTask.outputDesc || activeTask.queryDesc ? (
                <div className="rounded-[8px] border border-border-light bg-white p-3 text-il-meta leading-relaxed text-text-2">
                  {activeTask.purpose ? (
                    <p>
                      <span className="font-semibold text-text">{t.dwdToDimCenterUi.detailPurpose}：</span>
                      {activeTask.purpose}
                    </p>
                  ) : null}
                  {activeTask.outputDesc ? (
                    <p className={activeTask.purpose ? 'mt-2' : ''}>
                      <span className="font-semibold text-text">{t.dwdToDimCenterUi.detailOutputDesc}：</span>
                      {activeTask.outputDesc}
                    </p>
                  ) : null}
                  {activeTask.queryDesc ? (
                    <p className={activeTask.purpose || activeTask.outputDesc ? 'mt-2' : ''}>
                      <span className="font-semibold text-text">{t.dwdToDimCenterUi.detailQueryDesc}：</span>
                      {activeTask.queryDesc}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailDomain}</div>
                <div className="text-text">{activeTask.domain}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailLayer}</div>
                <div className="font-mono text-text">{activeTask.layer || '—'}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.colQuerySource}</div>
                <div className="text-text">
                  {activeTask.queryGroupLabel || '—'}
                  {activeTask.queryGroup ? (
                    <span className="ml-1 font-mono text-il-meta text-text-3">({activeTask.queryGroup})</span>
                  ) : null}
                </div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailOwner}</div>
                <div className="text-text">{activeTask.owner}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailOutput}</div>
                <div className="font-mono text-text">{activeTask.outputTable}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailDependsOn}</div>
                <div className="font-mono text-text">{activeTask.dependsOn.length ? activeTask.dependsOn.join(' , ') : '—'}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailSoftDependsOn}</div>
                <div className="font-mono text-text">
                  {activeTask.softDependsOn.length ? activeTask.softDependsOn.join(' , ') : '—'}
                </div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailLastRun}</div>
                <div className="text-text">{activeTask.lastRunAt}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailDuration}</div>
                <div className="text-text">
                  {activeTask.status === 'running'
                    ? `${formatDurationMs(
                        liveElapsedMs(
                          { started_at: activeTask.lastRunAt !== '—' ? activeTask.lastRunAt : '', elapsed_ms: activeTask.elapsedMs },
                          tasksFetchedAtMs,
                          liveTick,
                        ),
                      )}${activeTask.progressMessage ? ` · ${activeTask.progressMessage}` : ''}`
                    : activeTask.lastDuration}
                </div>
                {activeTask.status === 'running' && activeTask.progressMessage ? (
                  <>
                    <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailProgress}</div>
                    <div className="text-text">{activeTask.progressMessage}</div>
                  </>
                ) : null}
              </div>
              <div
                ref={runLogSectionRef}
                className={[
                  'rounded-[8px] border bg-white p-3',
                  failureFocus && failureFocus.taskCode === activeTask.taskCode
                    ? 'border-accent/40 ring-1 ring-accent/20'
                    : 'border-border-light',
                ].join(' ')}
              >
                <div className="mb-2 text-il-card-title font-semibold text-text">
                  {failureFocus && failureFocus.taskCode === activeTask.taskCode
                    ? t.dwdToDimCenterUi.logFailureTitle
                    : t.dwdToDimCenterUi.runLogTitle}
                </div>
                {isSubjectLibraryTask(activeTask.taskCode) ? (
                  <p className="mb-2 text-il-meta leading-relaxed text-text-3">
                    {t.dwdToDimCenterUi.subjectTaskRunLogHint}
                  </p>
                ) : null}
                <div className="space-y-1 text-il-meta leading-relaxed text-text-2">
                  {failureFocus && failureFocus.taskCode === activeTask.taskCode ? (
                    <>
                      <div>
                        {t.dwdToDimCenterUi.logFailureLine1.replace(/\{errorType\}/g, failureFocus.errorType)}
                      </div>
                      <div>
                        {t.dwdToDimCenterUi.logFailureLine2.replace(/\{lastFailAt\}/g, failureFocus.lastFailAt)}
                      </div>
                      <div>{t.dwdToDimCenterUi.logFailureLine3}</div>
                    </>
                  ) : (
                    <>
                      {runLogsBusy ? (
                        <div>{t.dwdToDimCenterUi.runLogLoading}</div>
                      ) : runLogs.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-left text-il-meta">
                            <thead>
                              <tr className="border-b border-border-light text-text-3">
                                <th className="py-1.5 pr-2">{t.dwdToDimCenterUi.runLogColStatus}</th>
                                <th className="py-1.5 pr-2">{t.dwdToDimCenterUi.runLogColStartedAt}</th>
                                <th className="py-1.5 pr-2 text-right">{t.dwdToDimCenterUi.runLogColDuration}</th>
                                <th className="py-1.5 pr-2 text-right">{t.dwdToDimCenterUi.runLogColRows}</th>
                                <th className="py-1.5">{t.dwdToDimCenterUi.runLogColError}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {runLogs.slice(0, 3).map((row) => (
                                <tr key={row.run_id} className="border-b border-border-light/60">
                                  <td className="py-1.5 pr-2">
                                    <span
                                      className={[
                                        'inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold',
                                        runStatusClass(row.status),
                                      ].join(' ')}
                                      title={row.run_id}
                                    >
                                      {runStatusText(row.status)}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-2 tabular-nums text-text-2">{row.started_at || '—'}</td>
                                  <td className="py-1.5 pr-2 text-right tabular-nums text-text-2">{Math.max(0, row.duration_ms)}ms</td>
                                  <td className="py-1.5 pr-2 text-right tabular-nums text-text-2">{row.rows_affected}</td>
                                  <td className="py-1.5 text-text-2">{row.error_message || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div>{t.dwdToDimCenterUi.runLogEmpty}</div>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
                  onClick={() => {
                    setAllRunsTaskFilter(activeTaskCode || 'all')
                    setAllRunsStatusFilter('all')
                    setAllRunsPage(1)
                    setShowRunLogsDialog(true)
                  }}
                >
                  {t.dwdToDimCenterUi.viewRuns}
                </button>
                <button
                  type="button"
                  className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:bg-accent-mid"
                  onClick={() => setShowRunDialog(true)}
                >
                  {t.dwdToDimCenterUi.triggerNow}
                </button>
              </div>
            </div>
          )}
          </div>
        </Card>
      </div>

      <Card title={t.dwdToDimCenterUi.failurePanelTitle}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-il-label text-text-3">
          <span>{t.dwdToDimCenterUi.failurePanelHint}</span>
          <span>{t.dwdToDimCenterUi.failureRowClickHint}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light text-il-meta font-semibold text-text-3">
                <th className="py-2 pr-3">{t.dwdToDimCenterUi.failureColTask}</th>
                <th className="py-2 pr-3">{t.dwdToDimCenterUi.failureColErrorType}</th>
                <th className="py-2 pr-3">{t.dwdToDimCenterUi.failureColLastFail}</th>
                <th className="py-2">{t.dwdToDimCenterUi.failureColAction}</th>
              </tr>
            </thead>
            <tbody>
              {failedRuns.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-text-3">
                    {t.dwdToDimCenterUi.failurePanelEmpty}
                  </td>
                </tr>
              ) : (
              failedRuns.map((row) => (
                <tr
                  key={`${row.taskCode}-${row.lastFailAt}`}
                  role="button"
                  tabIndex={0}
                  className={[
                    'cursor-pointer border-b border-border-light/70 outline-none hover:bg-[#fafcff]',
                    failureFocus?.taskCode === row.taskCode && failureFocus?.lastFailAt === row.lastFailAt
                      ? 'bg-[#f0f7ff]'
                      : '',
                  ].join(' ')}
                  onClick={() => selectFromFailureRow(row)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      selectFromFailureRow(row)
                    }
                  }}
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium text-text">{row.taskName}</div>
                    <div className="font-mono text-il-meta text-text-3">{row.taskCode}</div>
                  </td>
                  <td className="py-2 pr-3 text-text-2">{row.errorType}</td>
                  <td className="py-2 pr-3 text-text-2">{row.lastFailAt}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      className="rounded-[7px] border border-border-light bg-white px-2.5 py-1 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
                      onClick={(e) => {
                        e.stopPropagation()
                        selectFromFailureRow(row)
                      }}
                    >
                      {row.action === 'retry' ? t.dwdToDimCenterUi.failureActionRetry : t.dwdToDimCenterUi.failureActionInspect}
                    </button>
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {showRunDialog ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-[620px] rounded-[10px] border border-border-light bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,.14)]">
            <div className="mb-3 text-il-page-title font-semibold text-text">{t.dwdToDimCenterUi.runDialogTitle}</div>
            <div className="mb-3 text-il-page-desc leading-relaxed text-text-2">{t.dwdToDimCenterUi.runDialogBody}</div>
            <div className="space-y-3">
              {activeTask && isSubjectLibraryTask(activeTask.taskCode) ? (
                <>
                  {(activeTask.taskCode === 'subject_master_ingest_from_dwd' ||
                    activeTask.taskCode === 'subject_category_recompute' ||
                    activeTask.taskCode === SUBJECT_DIM_TASK.pipeline) && (
                    <label className="flex cursor-pointer items-start gap-2 text-il-page-desc text-text-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={overwriteManualRepairs}
                        onChange={(e) => setOverwriteManualRepairs(e.target.checked)}
                      />
                      <span>
                        <span className="font-medium text-text">{t.dwdToDimCenterUi.overwriteManualRepairsLabel}</span>
                        <span className="mt-0.5 block text-il-meta text-text-3">
                          {t.dwdToDimCenterUi.overwriteManualRepairsHint}
                        </span>
                      </span>
                    </label>
                  )}
                  {activeTask.taskCode === 'subject_category_recompute' ||
                  activeTask.taskCode === SUBJECT_DIM_TASK.pipeline ? (
                    <label className="flex cursor-pointer items-center gap-2 text-il-page-desc text-text-2">
                      <input
                        type="checkbox"
                        checked={recomputeWithRelations}
                        onChange={(e) => setRecomputeWithRelations(e.target.checked)}
                      />
                      {t.dwdToDimCenterUi.recomputeWithRelationsLabel}
                    </label>
                  ) : null}
                </>
              ) : (
                <>
              <div>
                <div className="mb-1 text-il-label font-medium text-text-2">{t.dwdToDimCenterUi.runModeLabel}</div>
                <div className="flex gap-3 text-il-page-desc text-text-2">
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      checked={runMode === 'incremental'}
                      onChange={() => setRunMode('incremental')}
                    />
                    {t.dwdToDimCenterUi.runModeIncremental}
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="radio" checked={runMode === 'full'} onChange={() => setRunMode('full')} />
                    {t.dwdToDimCenterUi.runModeFull}
                  </label>
                </div>
              </div>
              <div>
                <div className="mb-1 text-il-label font-medium text-text-2">{t.dwdToDimCenterUi.dependStrategyLabel}</div>
                <div className="flex gap-3 text-il-page-desc text-text-2">
                  <label className="inline-flex items-center gap-1">
                    <input type="radio" checked={selectedDepend === 'auto'} onChange={() => setSelectedDepend('auto')} />
                    {t.dwdToDimCenterUi.dependStrategyAuto}
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      checked={selectedDepend === 'ignore'}
                      onChange={() => setSelectedDepend('ignore')}
                    />
                    {t.dwdToDimCenterUi.dependStrategyIgnore}
                  </label>
                </div>
              </div>
                </>
              )}
              <div className="rounded-[8px] border border-border-light bg-[#f8fafc] p-2 text-il-label text-text-2">
                {t.dwdToDimCenterUi.runQueueNote}
              </div>
              {activeTask?.taskCode === 'group_enterprise_year_build' ? (
                <div className="rounded-[8px] border border-[#c8dff7] bg-[#f0f7ff] p-2 text-il-label text-accent-mid">
                  {t.dwdToDimCenterUi.groupEnterpriseTaskHint}
                </div>
              ) : null}
              {submitBusy && runLive ? (
                <div className="rounded-[8px] border border-[#c8dff7] bg-[#f0f7ff] p-3 text-il-page-desc text-text">
                  <div className="font-semibold text-accent-mid">{t.dwdToDimCenterUi.runDialogProgressTitle}</div>
                  <div className="mt-2 font-mono text-il-meta text-text-3">
                    {t.dwdToDimCenterUi.runDialogProgressRunId.replace('{runId}', runLive.runId)}
                  </div>
                  <div className="mt-1 text-text">
                    {t.dwdToDimCenterUi.runDialogProgressStep.replace('{step}', runLive.step || '—')}
                  </div>
                  <div className="mt-1 font-medium text-text">{runLive.message || '—'}</div>
                  <div className="mt-1 text-il-meta text-text-3">
                    {t.dwdToDimCenterUi.runDialogProgressElapsed.replace('{elapsed}', formatDurationMs(runLiveElapsed))}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#dbeafe]">
                    <div className="h-full w-2/5 animate-pulse rounded-full bg-accent" />
                  </div>
                  <p className="mt-2 text-il-meta text-text-3">{t.dwdToDimCenterUi.runDialogProgressHint}</p>
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
                onClick={() => setShowRunDialog(false)}
                disabled={submitBusy}
              >
                {t.dwdToDimCenterUi.cancel}
              </button>
              <button
                type="button"
                disabled={submitBusy}
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:bg-accent-mid disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => {
                  void handleConfirmRun()
                }}
              >
                {submitBusy
                  ? runLive
                    ? t.dwdToDimCenterUi.runSubmitRunning
                    : t.dwdToDimCenterUi.runSubmitBusy
                  : t.dwdToDimCenterUi.confirmRun}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRunLogsDialog ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4">
          <div className="flex max-h-[82vh] w-full max-w-[1100px] flex-col rounded-[10px] border border-border-light bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,.14)]">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-il-page-title font-semibold text-text">{t.dwdToDimCenterUi.runLogDialogTitle}</div>
              <button
                type="button"
                className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
                onClick={() => setShowRunLogsDialog(false)}
              >
                {t.dwdToDimCenterUi.cancel}
              </button>
            </div>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="text-il-label text-text-3">
                <span className="mb-1 block">{t.dwdToDimCenterUi.runLogFilterTask}</span>
                <select
                  className="rounded-[7px] border border-border-light bg-white px-2 py-1.5 text-il-page-desc text-text"
                  value={allRunsTaskFilter}
                  onChange={(e) => {
                    setAllRunsTaskFilter(e.target.value)
                    setAllRunsPage(1)
                  }}
                >
                  <option value="all">{t.dwdToDimCenterUi.runLogFilterTaskAll}</option>
                  {tasks.map((tk) => (
                    <option key={tk.taskCode} value={tk.taskCode}>
                      {tk.taskName} · {tk.taskCode}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-il-label text-text-3">
                <span className="mb-1 block">{t.dwdToDimCenterUi.runLogFilterStatus}</span>
                <select
                  className="rounded-[7px] border border-border-light bg-white px-2 py-1.5 text-il-page-desc text-text"
                  value={allRunsStatusFilter}
                  onChange={(e) => {
                    setAllRunsStatusFilter(e.target.value)
                    setAllRunsPage(1)
                  }}
                >
                  <option value="all">{t.dwdToDimCenterUi.runLogFilterStatusAll}</option>
                  <option value="success">{t.dwdToDimCenterUi.runLogStatusSuccess}</option>
                  <option value="failed">{t.dwdToDimCenterUi.runLogStatusFailed}</option>
                  <option value="running">{t.dwdToDimCenterUi.runLogStatusRunning}</option>
                </select>
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {allRunsBusy ? (
                <div className="text-il-page-desc text-text-2">{t.dwdToDimCenterUi.runLogLoading}</div>
              ) : allRunsPageRows.length === 0 ? (
                <div className="text-il-page-desc text-text-2">{t.dwdToDimCenterUi.runLogEmpty}</div>
              ) : (
                <table className="min-w-full text-left text-il-meta">
                  <thead>
                    <tr className="border-b border-border-light text-text-3">
                      <th className="py-1.5 pr-2">{t.dwdToDimCenterUi.runLogColTask}</th>
                      <th className="py-1.5 pr-2">{t.dwdToDimCenterUi.runLogColStatus}</th>
                      <th className="py-1.5 pr-2">{t.dwdToDimCenterUi.runLogColStartedAt}</th>
                      <th className="py-1.5 pr-2 text-right">{t.dwdToDimCenterUi.runLogColDuration}</th>
                      <th className="py-1.5 pr-2 text-right">{t.dwdToDimCenterUi.runLogColRows}</th>
                      <th className="py-1.5">{t.dwdToDimCenterUi.runLogColError}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allRunsPageRows.map((row) => (
                      <tr key={row.run_id} className="border-b border-border-light/60">
                        <td className="py-1.5 pr-2">
                          <div className="font-medium text-text">
                            {taskCodeToName[row.task_code] ?? t.dwdToDimCenterUi.runLogUnknownTask}
                          </div>
                          <div className="font-mono text-il-meta text-text-3">{row.task_code || '—'}</div>
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className={['inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold', runStatusClass(row.status)].join(' ')}>
                            {runStatusText(row.status)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-text-2">{row.started_at || '—'}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-text-2">{Math.max(0, row.duration_ms)}ms</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-text-2">{row.rows_affected}</td>
                        <td className="py-1.5 text-text-2">{row.error_message || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc] disabled:opacity-50"
                disabled={allRunsPageSafe <= 1}
                onClick={() => setAllRunsPage((p) => Math.max(1, p - 1))}
              >
                {t.dwdToDimCenterUi.runLogPagePrev}
              </button>
              <span className="text-il-label text-text-3">
                {t.dwdToDimCenterUi.runLogPageInfo
                  .replace('{page}', String(allRunsPageSafe))
                  .replace('{total}', String(allRunsTotalPages))}
              </span>
              <button
                type="button"
                className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc] disabled:opacity-50"
                disabled={allRunsPageSafe >= allRunsTotalPages}
                onClick={() => setAllRunsPage((p) => Math.min(allRunsTotalPages, p + 1))}
              >
                {t.dwdToDimCenterUi.runLogPageNext}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

