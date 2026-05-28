import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import { clearDwdDimFocusTask, readDwdDimFocusTask, SUBJECT_DIM_TASK } from './dwdDimNav'
import {
  fetchDimTaskRuns,
  fetchSubjectLibraryRenameRebuildStatus,
  postDimEnterpriseMappingBuild,
  postDimEnterpriseMasterBuild,
  postDimEnterpriseProfileBuild,
  postSubjectCategoryRecompute,
  postSubjectLibraryIngestFromDwd,
  postSubjectLibraryRebuildRenameSignals,
} from '../config/localApi'

type TaskStatus = 'idle' | 'queued' | 'running' | 'failed'
type TriggerMode = 'manual' | 'chained' | 'scheduled'

type DimTask = {
  taskCode: string
  taskName: string
  domain: string
  subjectCategory: 'SC-ENT' | 'SC-BRANCH' | 'SC-TEMP'
  outputTable: string
  triggerMode: TriggerMode[]
  dependsOn: string[]
  queueDepth: number
  status: TaskStatus
  lastRunAt: string
  lastDuration: string
  owner: string
}

type FailedRun = {
  taskCode: string
  taskName: string
  errorType: string
  lastFailAt: string
  action: 'retry' | 'inspect'
}

const SUBJECT_TASK_CODES = new Set<string>(Object.values(SUBJECT_DIM_TASK))

function isSubjectLibraryTask(taskCode: string): boolean {
  return SUBJECT_TASK_CODES.has(taskCode)
}

const TASKS: DimTask[] = [
  {
    taskCode: 'subject_master_ingest_from_dwd',
    taskName: '主体库 · 从 DWD 归集',
    domain: '主体库',
    subjectCategory: 'SC-ENT',
    outputTable: 'dim_subject_master',
    triggerMode: ['manual', 'chained'],
    dependsOn: ['dwd_inv_header'],
    queueDepth: 0,
    status: 'idle',
    lastRunAt: '—',
    lastDuration: '—',
    owner: '维度组',
  },
  {
    taskCode: 'subject_category_recompute',
    taskName: '主体库 · 重算（分类+关联）',
    domain: '主体库',
    subjectCategory: 'SC-ENT',
    outputTable: 'dim_subject_master / dim_subject_category_snapshot',
    triggerMode: ['manual', 'chained'],
    dependsOn: ['subject_master_ingest_from_dwd'],
    queueDepth: 0,
    status: 'idle',
    lastRunAt: '—',
    lastDuration: '—',
    owner: '维度组',
  },
  {
    taskCode: SUBJECT_DIM_TASK.rename,
    taskName: '主体库 · 重建更名信号',
    domain: '主体库',
    subjectCategory: 'SC-ENT',
    outputTable: 'dim_subject_rename_signal',
    triggerMode: ['manual'],
    dependsOn: ['dim_subject_master'],
    queueDepth: 0,
    status: 'idle',
    lastRunAt: '—',
    lastDuration: '—',
    owner: '维度组',
  },
  {
    taskCode: SUBJECT_DIM_TASK.pipeline,
    taskName: '主体库 · 一键全流程（归集→重算→更名）',
    domain: '主体库',
    subjectCategory: 'SC-ENT',
    outputTable: 'dim_subject_master / dim_subject_rename_signal',
    triggerMode: ['manual', 'chained'],
    dependsOn: ['dwd_inv_header'],
    queueDepth: 0,
    status: 'idle',
    lastRunAt: '—',
    lastDuration: '—',
    owner: '维度组',
  },
  {
    taskCode: 'enterprise_master_build',
    taskName: '全量企业主数据构建',
    domain: '企业组织维度',
    subjectCategory: 'SC-ENT',
    outputTable: 'dim_enterprise_master',
    triggerMode: ['manual', 'chained', 'scheduled'],
    dependsOn: ['dwd_inv_header'],
    queueDepth: 2,
    status: 'queued',
    lastRunAt: '2026-04-26 12:18',
    lastDuration: '4m 11s',
    owner: '维度组',
  },
  {
    taskCode: 'enterprise_mapping_check',
    taskName: '企业↔票主体映射检查',
    domain: '企业组织维度',
    subjectCategory: 'SC-BRANCH',
    outputTable: 'dwd_enterprise_mapping_status',
    triggerMode: ['manual', 'chained'],
    dependsOn: ['enterprise_master_build'],
    queueDepth: 0,
    status: 'idle',
    lastRunAt: '2026-04-26 11:42',
    lastDuration: '2m 08s',
    owner: '风控组',
  },
  {
    taskCode: 'enterprise_profile_agg',
    taskName: '企业发票画像聚合',
    domain: '企业组织维度',
    subjectCategory: 'SC-TEMP',
    outputTable: 'dws_enterprise_invoice_profile',
    triggerMode: ['manual', 'scheduled'],
    dependsOn: ['enterprise_master_build'],
    queueDepth: 1,
    status: 'running',
    lastRunAt: '2026-04-26 13:02',
    lastDuration: '进行中',
    owner: '数据平台组',
  },
]

const FAILED_RUNS: FailedRun[] = [
  {
    taskCode: 'enterprise_mapping_check',
    taskName: '企业↔票主体映射检查',
    errorType: '依赖未就绪',
    lastFailAt: '2026-04-26 12:07',
    action: 'retry',
  },
  {
    taskCode: 'enterprise_master_build',
    taskName: '全量企业主数据构建',
    errorType: '主键冲突策略告警',
    lastFailAt: '2026-04-26 10:33',
    action: 'inspect',
  },
]

/** 运行记录弹窗：task_code → 中文名（与 TASKS 注册表一致） */
const TASK_CODE_TO_NAME: Record<string, string> = Object.fromEntries(TASKS.map((x) => [x.taskCode, x.taskName]))

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

export function DwdToDimCenterPage() {
  const [activeTaskCode, setActiveTaskCode] = useState(TASKS[0]?.taskCode ?? '')
  const [subjectCategoryFilter, setSubjectCategoryFilter] = useState<'all' | 'SC-ENT' | 'SC-BRANCH' | 'SC-TEMP'>('all')
  const [failureFocus, setFailureFocus] = useState<FailedRun | null>(null)
  const [showRunDialog, setShowRunDialog] = useState(false)
  const [runMode, setRunMode] = useState<'incremental' | 'full'>('incremental')
  const [selectedDepend, setSelectedDepend] = useState<'auto' | 'ignore'>('auto')
  const [submitBusy, setSubmitBusy] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)
  const [runLogsBusy, setRunLogsBusy] = useState(false)
  const [runLogs, setRunLogs] = useState<
    Array<{
      run_id: string
      status: string
      rows_affected: number
      started_at: string
      duration_ms: number
      error_message: string
    }>
  >([])
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

  const [overwriteManualRepairs, setOverwriteManualRepairs] = useState(false)
  const [recomputeWithRelations, setRecomputeWithRelations] = useState(true)
  const activeTask = useMemo(
    () => TASKS.find((x) => x.taskCode === activeTaskCode) ?? TASKS[0] ?? null,
    [activeTaskCode],
  )
  const visibleTasks = useMemo(
    () =>
      TASKS.filter((x) => {
        if (x.domain === t.dwdToDimCenterUi.subjectTaskDomain) {
          return subjectCategoryFilter === 'all'
        }
        return subjectCategoryFilter === 'all' ? true : x.subjectCategory === subjectCategoryFilter
      }),
    [subjectCategoryFilter],
  )
  const queueTotal = TASKS.reduce((n, x) => n + x.queueDepth, 0)
  const runningCount = TASKS.filter((x) => x.status === 'running').length
  const queuedCount = TASKS.filter((x) => x.status === 'queued').length
  const queueWaiting = TASKS.filter((x) => x.status === 'queued').map((x) => x.taskCode)
  const slots = [
    { id: 'slot-a', status: 'busy' as const, taskCode: 'enterprise_profile_agg', priority: 'P1' },
    { id: 'slot-b', status: 'idle' as const, taskCode: '', priority: 'P2' },
  ]
  const dagRows = [
    { from: 'dwd_inv_header', to: 'subject_master_ingest_from_dwd' },
    { from: 'subject_master_ingest_from_dwd', to: 'subject_category_recompute' },
    { from: 'subject_category_recompute', to: SUBJECT_DIM_TASK.rename },
    { from: 'dwd_inv_header', to: SUBJECT_DIM_TASK.pipeline },
    { from: 'dwd_inv_header', to: 'enterprise_master_build' },
    { from: 'enterprise_master_build', to: 'enterprise_mapping_check' },
    { from: 'enterprise_master_build', to: 'enterprise_profile_agg' },
  ]

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

  const taskCodes = useMemo(() => new Set(TASKS.map((x) => x.taskCode)), [])

  const selectDownstreamFromEdge = (to: string) => {
    if (taskCodes.has(to)) {
      selectTaskFromDag(to)
    }
  }

  useEffect(() => {
    if (!activeTaskCode) return
    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      setRunLogsBusy(true)
      try {
        const r = await fetchDimTaskRuns({ task_code: activeTaskCode, limit: 6 }, ac.signal)
        if (cancelled) return
        if (!r.ok) {
          setRunLogs([])
          return
        }
        setRunLogs(
          r.runs.map((x) => ({
            run_id: String(x.run_id ?? ''),
            status: String(x.status ?? ''),
            rows_affected: Number(x.rows_affected ?? 0),
            started_at: String(x.started_at ?? ''),
            duration_ms: Number(x.duration_ms ?? 0),
            error_message: String(x.error_message ?? ''),
          })),
        )
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
    const effectiveScope = subjectCategoryFilter === 'all' ? activeTask.subjectCategory : subjectCategoryFilter
    const scopeSuffix = t.dwdToDimCenterUi.runSubmitScopeSuffix.replace('{scope}', effectiveScope)
    setSubmitMsg(null)
    setSubmitBusy(true)
    try {
      if (activeTask.taskCode === SUBJECT_DIM_TASK.pipeline) {
        setSubmitMsg(t.dwdToDimCenterUi.subjectPipelineStepIngest)
        const ingest = await postSubjectLibraryIngestFromDwd({ overwrite_manual_repairs: overwriteManualRepairs })
        if (!ingest.ok) {
          setSubmitMsg(
            t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(ingest.error?.message ?? 'unknown')),
          )
        } else {
          const ingestCount = ingest.result?.subjects_upserted ?? 0
          setSubmitMsg(t.dwdToDimCenterUi.subjectPipelineStepRecompute)
          const recompute = await postSubjectCategoryRecompute({
            with_relations: recomputeWithRelations,
            overwrite_manual_repairs: overwriteManualRepairs,
          })
          if (!recompute.ok) {
            setSubmitMsg(
              t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(recompute.error?.message ?? 'unknown')),
            )
          } else {
            const recomputeRunId =
              recompute.result?.run_id ??
              recompute.result?.category?.run_id ??
              (typeof recompute.result === 'object' && recompute.result
                ? String((recompute.result as { run_id?: string }).run_id ?? '—')
                : '—')
            setSubmitMsg(t.dwdToDimCenterUi.subjectPipelineStepRename)
            const start = await postSubjectLibraryRebuildRenameSignals()
            if (!start.ok) {
              setSubmitMsg(
                t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(start.error?.message ?? 'unknown')),
              )
            } else if (start.async !== true) {
              const renameExtra = start.message ? `：${start.message}` : ''
              setSubmitMsg(
                t.dwdToDimCenterUi.subjectPipelineSuccess
                  .replace('{ingestCount}', String(ingestCount))
                  .replace('{recomputeRunId}', String(recomputeRunId))
                  .replace('{renameExtra}', renameExtra),
              )
            } else if (!start.run_id) {
              setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', '未返回 run_id'))
            } else {
              const polled = await pollRenameRebuild(start.run_id)
              if (polled.ok) {
                const renameExtra = polled.message ? `：${polled.message}` : ''
                setSubmitMsg(
                  t.dwdToDimCenterUi.subjectPipelineSuccess
                    .replace('{ingestCount}', String(ingestCount))
                    .replace('{recomputeRunId}', String(recomputeRunId))
                    .replace('{renameExtra}', renameExtra),
                )
              } else {
                setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', polled.message))
              }
            }
          }
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
        })
        if (r.ok) {
          const runId =
            r.result?.run_id ??
            r.result?.category?.run_id ??
            (typeof r.result === 'object' && r.result ? String((r.result as { run_id?: string }).run_id ?? '—') : '—')
          const extra = r.message ? `；${r.message}` : ''
          setSubmitMsg(
            t.dwdToDimCenterUi.subjectRecomputeSuccess.replace('{runId}', String(runId)).replace('{extra}', extra),
          )
        } else {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
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
        if (r.ok) {
          setSubmitMsg(
            `${t.dwdToDimCenterUi.runSubmitSuccess
              .replace('{runId}', String(r.run_id ?? 'N/A'))
              .replace('{rows}', String(r.profile_rows_written ?? 0))
              .replace('{ents}', String(r.enterprise_upserted ?? 0))} ${scopeSuffix}`.trim(),
          )
        } else {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        }
      } else if (activeTask.taskCode === 'enterprise_master_build') {
        const r = await postDimEnterpriseMasterBuild({ subject_category_scope: effectiveScope })
        if (r.ok) {
          setSubmitMsg(
            `${t.dwdToDimCenterUi.runSubmitSuccessRows
              .replace('{runId}', String(r.run_id ?? 'N/A'))
              .replace('{rows}', String(r.rows_affected ?? 0))} ${scopeSuffix}`.trim(),
          )
        } else {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
        }
      } else if (activeTask.taskCode === 'enterprise_mapping_check') {
        const r = await postDimEnterpriseMappingBuild({ subject_category_scope: effectiveScope })
        if (r.ok) {
          setSubmitMsg(
            `${t.dwdToDimCenterUi.runSubmitSuccessRows
              .replace('{runId}', String(r.run_id ?? 'N/A'))
              .replace('{rows}', String(r.rows_affected ?? 0))} ${scopeSuffix}`.trim(),
          )
        } else {
          setSubmitMsg(t.dwdToDimCenterUi.runSubmitFailed.replace('{message}', String(r.error?.message ?? 'unknown')))
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
      setShowRunDialog(false)
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
            <span className="rounded-full border border-accent/25 bg-[#f0f7ff] px-2 py-[1px] text-il-pill font-semibold text-accent-mid">
              {t.dwdToDimCenterUi.prototypeBadge}
            </span>
          </div>
          <button
            type="button"
            className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
          >
            {t.dwdToDimCenterUi.refresh}
          </button>
        </div>
        <p className="text-il-page-desc leading-relaxed text-text-2">{t.dwdToDimCenterUi.pageBody}</p>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <Card compact>
          <div className="text-il-label text-text-3">{t.dwdToDimCenterUi.kpiTaskCount}</div>
          <div className="mt-1 text-2xl font-semibold text-text">{TASKS.length}</div>
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
                <span>{t.dwdToDimCenterUi.subjectCategoryFilter}</span>
                <select
                  value={subjectCategoryFilter}
                  onChange={(e) => setSubjectCategoryFilter(e.target.value as 'all' | 'SC-ENT' | 'SC-BRANCH' | 'SC-TEMP')}
                  className="rounded-[7px] border border-border bg-[#fafbfc] px-2 py-1 text-il-input text-text outline-none focus:border-accent"
                >
                  <option value="all">{t.dwdToDimCenterUi.subjectCategoryAll}</option>
                  <option value="SC-ENT">{t.dwdToDimCenterUi.subjectCategoryEnt}</option>
                  <option value="SC-BRANCH">{t.dwdToDimCenterUi.subjectCategoryBranch}</option>
                  <option value="SC-TEMP">{t.dwdToDimCenterUi.subjectCategoryTemp}</option>
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
                  <div className="text-il-card-title font-semibold text-text">{task.taskName}</div>
                  <div className="font-mono text-il-meta text-text-3">{task.taskCode}</div>
                  <div className="mt-1 text-il-label text-text-2">
                    {t.dwdToDimCenterUi.dagNodeOutput}：{task.outputTable}
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

        <Card title={t.dwdToDimCenterUi.queueSlotsTitle}>
          <div className="mb-2 text-il-label text-text-3">{t.dwdToDimCenterUi.queueSlotsHint}</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {slots.map((slot) => (
              <button
                key={slot.id}
                type="button"
                disabled={!slot.taskCode}
                onClick={() => {
                  if (slot.taskCode) selectTaskFromDag(slot.taskCode)
                }}
                className={[
                  'w-full rounded-[8px] border border-border-light bg-[#f8fafc] p-3 text-left',
                  slot.taskCode ? 'cursor-pointer hover:border-accent/30 hover:bg-[#fafcff]' : 'cursor-default opacity-90',
                ].join(' ')}
              >
                <div className="mb-1 flex items-center justify-between text-il-label text-text-3">
                  <span>{slot.id}</span>
                  <span className={slot.status === 'busy' ? 'text-accent-mid' : 'text-text-3'}>
                    {slot.status === 'busy' ? t.dwdToDimCenterUi.queueSlotBusy : t.dwdToDimCenterUi.queueSlotIdle}
                  </span>
                </div>
                <div className="font-mono text-il-meta text-text">{slot.taskCode || '—'}</div>
                <div className="mt-1 text-il-label text-text-3">
                  {t.dwdToDimCenterUi.queuePriorityLabel}: {slot.priority}
                </div>
              </button>
            ))}
          </div>
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
                  <th className="py-2 pr-3">{t.dwdToDimCenterUi.colTaskName}</th>
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
                    <td className="py-2 pr-3 align-top">
                      <div className="font-medium text-text">{row.taskName}</div>
                      <div className="font-mono text-il-meta text-text-3">{row.taskCode}</div>
                    </td>
                    <td className="py-2 pr-3 align-top font-mono text-text-2">{row.outputTable}</td>
                    <td className="py-2 pr-3 align-top text-text-2">{row.triggerMode.map(triggerText).join(' / ')}</td>
                    <td className="py-2 pr-3 align-top text-right tabular-nums text-text-2">{row.queueDepth}</td>
                    <td className="py-2 align-top">
                      <span className={['inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold', statusTag(row.status)].join(' ')}>
                        {statusText(row.status)}
                      </span>
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
                <div className="mb-1 font-semibold text-text">{activeTask.taskName}</div>
                <div className="font-mono text-il-meta text-text-3">{activeTask.taskCode}</div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailDomain}</div>
                <div className="text-text">{activeTask.domain}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.subjectCategoryLabel}</div>
                <div className="font-mono text-text">{activeTask.subjectCategory}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailOwner}</div>
                <div className="text-text">{activeTask.owner}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailOutput}</div>
                <div className="font-mono text-text">{activeTask.outputTable}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailDependsOn}</div>
                <div className="font-mono text-text">{activeTask.dependsOn.join(' , ')}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailLastRun}</div>
                <div className="text-text">{activeTask.lastRunAt}</div>
                <div className="text-il-meta text-text-3">{t.dwdToDimCenterUi.detailDuration}</div>
                <div className="text-text">{activeTask.lastDuration}</div>
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
              {FAILED_RUNS.map((row) => (
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
              ))}
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
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border-light bg-white px-3 py-1.5 text-il-btn font-medium text-text hover:bg-[#f8fafc]"
                onClick={() => setShowRunDialog(false)}
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
                {submitBusy ? t.dwdToDimCenterUi.runSubmitBusy : t.dwdToDimCenterUi.confirmRun}
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
                  {TASKS.map((tk) => (
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
                            {TASK_CODE_TO_NAME[row.task_code] ?? t.dwdToDimCenterUi.runLogUnknownTask}
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

