import { Fragment, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchSubjectLibraryRenameTimeline,
  fetchSubjectLibraryRows,
  fetchSubjectLibrarySummary,
  postSubjectCategoryRecompute,
  postSubjectLibraryExternalImport,
  fetchSubjectLibraryRenameRebuildStatus,
  postSubjectLibraryIngestFromDwd,
  postSubjectLibraryRebuildRenameSignals,
  postSubjectLibraryRepair,
} from '../config/localApi'

type SubjectType = 'enterprise' | 'person'

type EnterpriseRow = {
  enterpriseId: string
  enterpriseName: string
  taxpayerId: string
  sourceType: 'platform' | 'external'
  subjectType: SubjectType
  subjectCategoryCode: string
  subjectCategoryName: string
  hasRenameSignal: boolean
  renameEdgeCount: number
  renameHint: string
  renameTimeline: string[]
  firstSeenBatchId: string
  lastSeenBatchId: string
  firstSeenDate: string
  lastSeenDate: string
  subjectSnapshotId: string
  qualityStatus: string
  categoryStatusNote: string
  subjectBuildRunId: string
  categoryRuleVersion: string
}

/** 列表「企业/个人」与库 subject_category（org/person）对齐 */
function subjectTypeToApi(st: SubjectType): 'org' | 'person' {
  return st === 'person' ? 'person' : 'org'
}

/**
 * dim_subject_master.first_source_system 在库中多为 invoice/external/manual；
 * 新 API 会把列表 source_type 归一成 platform|external，但旧进程或直连仍可能返回 invoice。
 * 仅 external 显示「外部导入」，其余一律按「平台计算」展示，避免发票主体被误判。
 */
function normalizeSubjectSourceType(api: string | undefined): 'platform' | 'external' {
  const s = String(api ?? '')
    .trim()
    .toLowerCase()
  if (s === 'external') return 'external'
  return 'platform'
}

export function EnterpriseLibraryPage() {
  const ui = t.enterpriseLibraryUi
  const [rows, setRows] = useState<EnterpriseRow[]>([])
  const [summary, setSummary] = useState({
    total: 0,
    enterprise_count: 0,
    person_count: 0,
    needs_review_count: 0,
    rename_signal_subject_count: 0,
  })
  const [loading, setLoading] = useState(false)
  const [loadingError, setLoadingError] = useState('')
  const [recomputeBusy, setRecomputeBusy] = useState(false)
  const [ingestBusy, setIngestBusy] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [subjectType, setSubjectType] = useState<'all' | SubjectType>('enterprise')
  const [sourceType, setSourceType] = useState<'all' | 'platform' | 'external'>('all')
  const [subjectCategory, setSubjectCategory] = useState('all')
  const [renameSignal, setRenameSignal] = useState<'all' | 'yes' | 'no'>('all')
  const [batchId, setBatchId] = useState('')
  const [expandedRenameId, setExpandedRenameId] = useState<string | null>(null)
  const [renameTimelineBySubject, setRenameTimelineBySubject] = useState<Record<string, string[]>>({})
  const [renameTimelineLoading, setRenameTimelineLoading] = useState<string | null>(null)
  const [showTechColumns, setShowTechColumns] = useState(false)
  const [renameRebuildBusy, setRenameRebuildBusy] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [repairRow, setRepairRow] = useState<EnterpriseRow | null>(null)
  const [repairSubjectCategoryApi, setRepairSubjectCategoryApi] = useState<'org' | 'person'>('org')
  const [repairOrgCategoryInput, setRepairOrgCategoryInput] = useState('')
  const [repairReason, setRepairReason] = useState('')
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairError, setRepairError] = useState('')
  const [repairSuccessFlash, setRepairSuccessFlash] = useState('')

  const canReset =
    keyword.trim().length > 0 ||
    subjectType !== 'enterprise' ||
    sourceType !== 'all' ||
    subjectCategory !== 'all' ||
    renameSignal !== 'all' ||
    batchId.trim().length > 0

  const resetFilters = () => {
    setKeyword('')
    setSubjectType('enterprise')
    setSourceType('all')
    setSubjectCategory('all')
    setRenameSignal('all')
    setBatchId('')
    setExpandedRenameId(null)
    setRenameTimelineBySubject({})
  }

  const toggleRenameExpand = async (subjectId: string) => {
    if (expandedRenameId === subjectId) {
      setExpandedRenameId(null)
      return
    }
    setExpandedRenameId(subjectId)
    setRenameTimelineLoading(subjectId)
    const res = await fetchSubjectLibraryRenameTimeline(subjectId)
    setRenameTimelineLoading(null)
    if (res.ok && res.timeline_lines) {
      setRenameTimelineBySubject((prev) => ({ ...prev, [subjectId]: res.timeline_lines ?? [] }))
    } else {
      setRenameTimelineBySubject((prev) => ({
        ...prev,
        [subjectId]: [res.error?.message ?? '加载失败'],
      }))
    }
  }

  const runRebuildRename = async () => {
    setRenameRebuildBusy(true)
    setLoadingError('')
    const start = await postSubjectLibraryRebuildRenameSignals()
    if (!start.ok) {
      setLoadingError(start.error?.message ?? '重建更名信号失败')
      setRenameRebuildBusy(false)
      return
    }
    if (start.async !== true) {
      setImportSuccess(start.message ?? '更名信号已重建')
      setReloadSeq((v) => v + 1)
      setRenameRebuildBusy(false)
      return
    }
    if (!start.run_id) {
      setLoadingError('未返回 run_id，无法轮询状态')
      setRenameRebuildBusy(false)
      return
    }
    const runId = start.run_id
    const pollMs = 1500
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    const endStates = new Set(['success', 'failed'])
    for (;;) {
      if (Date.now() > deadline) {
        setLoadingError('等待重建结果超时（2 小时），可稍后在「任务运行」中查看是否已完成。')
        break
      }
      const st = await fetchSubjectLibraryRenameRebuildStatus(runId)
      if (!st.ok) {
        setLoadingError(st.error?.message ?? '查询重建状态失败')
        break
      }
      if (endStates.has(String(st.status ?? ''))) {
        if (st.status === 'success') {
          setImportSuccess(st.message ?? '更名信号已重建')
          setReloadSeq((v) => v + 1)
        } else {
          const em =
            st.error && typeof st.error === 'object' && 'message' in st.error
              ? String((st.error as { message?: string }).message)
              : st.message
          setLoadingError(em ?? '重建更名信号失败')
        }
        break
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
    setRenameRebuildBusy(false)
  }

  const closeImportModal = () => {
    setShowImportModal(false)
    setImportFile(null)
    setImportError('')
  }

  const openRepairModal = (row: EnterpriseRow) => {
    setRepairError('')
    setRepairReason('')
    setRepairRow(row)
    setRepairSubjectCategoryApi(subjectTypeToApi(row.subjectType))
    setRepairOrgCategoryInput(row.subjectCategoryCode ?? '')
  }

  const closeRepairModal = () => {
    setRepairRow(null)
    setRepairError('')
    setRepairReason('')
    setRepairBusy(false)
  }

  const confirmRepair = async () => {
    if (!repairRow) return
    const rowCat = subjectTypeToApi(repairRow.subjectType)
    const prevOrg = (repairRow.subjectCategoryCode ?? '').trim()
    const nextOrg = repairOrgCategoryInput.trim()
    if (repairSubjectCategoryApi === rowCat && nextOrg === prevOrg) {
      setRepairError(ui.repairNeedChange)
      return
    }
    setRepairBusy(true)
    setRepairError('')
    try {
      const body: {
        subject_id: string
        subject_category: 'org' | 'person'
        org_category: string
        reason?: string
        client_hint: string
      } = {
        subject_id: repairRow.enterpriseId,
        subject_category: repairSubjectCategoryApi,
        org_category: nextOrg,
        client_hint: 'web-enterprise-library',
      }
      if (repairReason.trim()) body.reason = repairReason.trim()
      const res = await postSubjectLibraryRepair(body)
      if (!res.ok) {
        setRepairError(res.error?.message ?? ui.repairFailed)
        return
      }
      setRepairSuccessFlash(res.message ?? ui.repairSuccess)
      setReloadSeq((v) => v + 1)
      closeRepairModal()
    } catch (e) {
      setRepairError(e instanceof Error ? e.message : ui.repairFailed)
    } finally {
      setRepairBusy(false)
    }
  }

  const confirmImport = async () => {
    if (!importFile) {
      setImportError(ui.importNeedFile)
      return
    }
    setImportBusy(true)
    setImportError('')
    try {
      const res = await postSubjectLibraryExternalImport({
        file: importFile,
      })
      if (!res.ok) {
        const extra =
          res.reject_row_samples && res.reject_row_samples.length > 0
            ? `；行级拒收样例：${res.reject_row_samples
                .slice(0, 3)
                .map((s) => `序号${s.seq_no}${s.field ? `/${s.field}` : ''}:${s.reason}`)
                .join('；')}`
            : ''
        setImportError((res.error?.message ?? ui.importFailed) + extra)
        return
      }
      const n = res.subjects_upserted ?? 0
      const hint =
        res.reject_row_samples && res.reject_row_samples.length > 0
          ? `${ui.importSuccessHint.replace('{count}', String(n))}（${ui.importPartialRejectHint.replace('{n}', String(res.reject_row_samples.length))}）`
          : ui.importSuccessHint.replace('{count}', String(n))
      setImportSuccess(res.message ? `${res.message}；${hint}` : hint)
      setReloadSeq((v) => v + 1)
      closeImportModal()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : ui.importFailed)
    } finally {
      setImportBusy(false)
    }
  }

  const stats = useMemo(
    () => ({
      total: summary.total,
      enterpriseCount: summary.enterprise_count,
      personCount: summary.person_count,
      needsReviewCount: summary.needs_review_count,
      renameSignalSubjects: summary.rename_signal_subject_count ?? 0,
    }),
    [summary],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadingError('')
      const [rowsRes, sumRes] = await Promise.all([
        fetchSubjectLibraryRows({
          keyword,
          subjectType,
          sourceType,
          subjectCategory,
          renameSignal,
          batchId,
          limit: 1000,
        }),
        fetchSubjectLibrarySummary({
          subjectType,
          sourceType,
          keyword,
        }),
      ])
      if (cancelled) return
      if (!rowsRes.ok) {
        setLoadingError(rowsRes.error?.message ?? '主体库数据加载失败')
      } else {
        setRows(
          rowsRes.rows.map((r) => ({
            enterpriseId: r.enterprise_id,
            enterpriseName: r.enterprise_name,
            taxpayerId: r.taxpayer_id,
            sourceType: normalizeSubjectSourceType(r.source_type),
            subjectType: r.subject_type,
            subjectCategoryCode: r.subject_category_code,
            subjectCategoryName: r.subject_category_name ?? '',
            hasRenameSignal: Boolean(r.has_rename_signal),
            renameEdgeCount: Number(r.rename_edge_count ?? 0),
            renameHint: r.rename_hint,
            renameTimeline: r.rename_timeline ?? [],
            firstSeenBatchId: r.first_seen_batch_id,
            lastSeenBatchId: r.last_seen_batch_id,
            firstSeenDate: r.first_seen_date,
            lastSeenDate: r.last_seen_date,
            subjectSnapshotId: r.subject_snapshot_id ?? '',
            qualityStatus: r.quality_status ?? '',
            categoryStatusNote: r.category_status_note ?? '',
            subjectBuildRunId: r.subject_build_run_id ?? '',
            categoryRuleVersion: r.category_rule_version ?? '',
          })),
        )
      }
      if (sumRes.ok && sumRes.summary) {
        setSummary({
          total: sumRes.summary.total,
          enterprise_count: sumRes.summary.enterprise_count,
          person_count: sumRes.summary.person_count,
          needs_review_count: sumRes.summary.needs_review_count,
          rename_signal_subject_count: sumRes.summary.rename_signal_subject_count ?? 0,
        })
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [batchId, keyword, renameSignal, sourceType, subjectCategory, subjectType, reloadSeq])

  useEffect(() => {
    if (!repairSuccessFlash) return
    const id = window.setTimeout(() => setRepairSuccessFlash(''), 8000)
    return () => window.clearTimeout(id)
  }, [repairSuccessFlash])

  const runIngestFromDwd = async () => {
    setIngestBusy(true)
    setLoadingError('')
    const res = await postSubjectLibraryIngestFromDwd()
    if (!res.ok) {
      setLoadingError(res.error?.message ?? 'DWD 归集失败')
      setIngestBusy(false)
      return
    }
    setImportSuccess(res.message ?? 'DWD 归集完成')
    setReloadSeq((v) => v + 1)
    setIngestBusy(false)
  }

  const runRecompute = async () => {
    setRecomputeBusy(true)
    setLoadingError('')
    const res = await postSubjectCategoryRecompute({ with_relations: true })
    if (!res.ok) {
      setLoadingError(res.error?.message ?? '主体重算失败')
      setRecomputeBusy(false)
      return
    }
    setImportSuccess(res.message ?? '主体重算完成')
    setReloadSeq((v) => v + 1)
    setRecomputeBusy(false)
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.prototypeNote}
        expandLabel={ui.moreTipsToggle}
        collapseLabel={ui.lessTipsToggle}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc]"
              onClick={() => {
                setImportSuccess('')
                setShowImportModal(true)
              }}
            >
              {ui.importExternalBtn}
            </button>
            <button
              type="button"
              disabled={ingestBusy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={runIngestFromDwd}
            >
              {ingestBusy ? ui.ingestFromDwdBusy : ui.ingestFromDwdBtn}
            </button>
            <button
              type="button"
              disabled={recomputeBusy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={runRecompute}
            >
              {recomputeBusy ? '重算中…' : '重算（分类+关联）'}
            </button>
            <button
              type="button"
              disabled={renameRebuildBusy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={() => void runRebuildRename()}
            >
              {renameRebuildBusy ? ui.rebuildRenameBusy : ui.rebuildRenameBtn}
            </button>
          </div>
        }
      />
      <div className="mb-4 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">
        {ui.caliberHint}
      </div>
      {importSuccess ? <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{importSuccess}</div> : null}
      {repairSuccessFlash ? (
        <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{repairSuccessFlash}</div>
      ) : null}
      {loadingError ? <div className="mb-4 rounded-sm border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">{loadingError}</div> : null}
      {loading ? <div className="mb-4 rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2 text-il-meta text-text-3">主体库数据加载中…</div> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: ui.kpiTotal, value: stats.total, cls: 'text-text' },
          { label: ui.kpiEnterprise, value: stats.enterpriseCount, cls: 'text-accent' },
          { label: ui.kpiPerson, value: stats.personCount, cls: 'text-warn' },
          { label: ui.kpiCategoryNeedsReview, value: stats.needsReviewCount, cls: 'text-[#6b5cb3]' },
          { label: ui.kpiRenameSignalSubjects, value: stats.renameSignalSubjects, cls: 'text-[#0d6e5c]' },
        ].map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className={['mt-1 text-[20px] font-bold tabular-nums', item.cls].join(' ')}>{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.filterTitle}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-8">
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.subjectTypeLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={subjectType}
              onChange={(e) => setSubjectType(e.target.value as 'all' | SubjectType)}
            >
              <option value="all">{ui.subjectTypeAll}</option>
              <option value="enterprise">{ui.subjectTypeEnterprise}</option>
              <option value="person">{ui.subjectTypePerson}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.sourceTypeLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as 'all' | 'platform' | 'external')}
            >
              <option value="all">{ui.sourceTypeAll}</option>
              <option value="platform">{ui.sourceTypePlatform}</option>
              <option value="external">{ui.sourceTypeExternal}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.subjectCategoryLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={subjectCategory}
              onChange={(e) => setSubjectCategory(e.target.value)}
            >
              <option value="all">{ui.subjectCategoryAll}</option>
              <option value="SC-ENT">{ui.subjectCategoryEnt}</option>
              <option value="SC-BRANCH">{ui.subjectCategoryBranch}</option>
              <option value="SC-TEMP">{ui.subjectCategoryTemp}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2 xl:col-span-2">
            <span className="mb-1 block font-medium">{ui.keywordLabel}</span>
            <input
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
            />
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.renameSignalLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={renameSignal}
              onChange={(e) => setRenameSignal(e.target.value as 'all' | 'yes' | 'no')}
            >
              <option value="all">{ui.renameSignalAll}</option>
              <option value="yes">{ui.renameSignalYes}</option>
              <option value="no">{ui.renameSignalNo}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.batchLabel}</span>
            <input
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
              placeholder={ui.batchPlaceholder}
            />
          </label>
          <button
            type="button"
            className={[
              'h-9 rounded-sm border px-3 text-il-page-desc transition-colors xl:self-end',
              canReset
                ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
            ].join(' ')}
            disabled={!canReset}
            onClick={resetFilters}
          >
            {ui.filterReset}
          </button>
        </div>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-il-meta text-text-2">
          <input
            type="checkbox"
            checked={showTechColumns}
            onChange={(e) => setShowTechColumns(e.target.checked)}
            className="rounded-sm border border-border-light"
          />
          <span>{ui.showTechFieldsLabel}</span>
        </label>
      </Card>

      <Card title={ui.tableTitle}>
        <div className="mb-2 text-il-meta text-text-3">{ui.tableHint.replace('{count}', String(rows.length))}</div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table
            className={[
              'w-full border-collapse text-il-page-desc',
              showTechColumns ? 'min-w-[1580px]' : 'min-w-[1080px]',
            ].join(' ')}
          >
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colSubjectName}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectNo}</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{ui.colSourceType}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectType}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectCategory}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectCategoryName}</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium">{ui.colRepairAction}</th>
                <th className="px-3 py-2 font-medium">{ui.colRenameHint}</th>
                <th className="px-3 py-2 font-medium">{ui.colRenameAction}</th>
                <th className="px-3 py-2 font-medium">{ui.colLastBatch}</th>
                {showTechColumns ? (
                  <>
                    <th className="px-3 py-2 font-medium">{ui.colTechSnapshot}</th>
                    <th className="px-3 py-2 font-medium">{ui.colTechBuildRun}</th>
                    <th className="px-3 py-2 font-medium">{ui.colTechRuleVer}</th>
                    <th className="px-3 py-2 font-medium">{ui.colTechCategoryNote}</th>
                    <th className="px-3 py-2 font-medium">{ui.colTechQuality}</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody className="text-text-2">
              {rows.map((row) => {
                const isExpanded = expandedRenameId === row.enterpriseId
                const span = showTechColumns ? 15 : 10
                const lines = renameTimelineBySubject[row.enterpriseId] ?? []
                return (
                  <Fragment key={row.enterpriseId}>
                    <tr key={row.enterpriseId} className="border-b border-border-light">
                      <td className="px-3 py-2.5 font-medium text-text">{row.enterpriseName}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.taxpayerId}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-middle">
                        <span
                          className={[
                            'inline-block rounded-sm border px-2 py-0.5 text-il-meta whitespace-nowrap',
                            row.sourceType === 'platform'
                              ? 'border-[#c8e6d0] bg-[#f4fbf6] text-[#1b6b3a]'
                              : 'border-[#d7d8ff] bg-[#f5f5ff] text-[#4747a3]',
                          ].join(' ')}
                        >
                          {row.sourceType === 'platform' ? ui.sourceTypePlatform : ui.sourceTypeExternal}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {row.subjectType === 'enterprise' ? ui.subjectTypeEnterprise : ui.subjectTypePerson}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-il-meta text-text-2">{row.subjectCategoryCode || '—'}</td>
                      <td className="max-w-[200px] px-3 py-2.5 text-text-2" title={row.subjectCategoryName || undefined}>
                        {row.subjectCategoryName || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <button
                          type="button"
                          className="rounded-sm border border-border bg-white px-2 py-0.5 text-il-meta text-text-2 hover:border-accent hover:text-accent"
                          onClick={() => openRepairModal(row)}
                        >
                          {ui.colRepairAction}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">{row.renameHint}</td>
                      <td className="px-3 py-2.5">
                        {row.hasRenameSignal ? (
                          <button
                            type="button"
                            disabled={renameTimelineLoading === row.enterpriseId}
                            className="rounded-sm border border-border bg-white px-2 py-0.5 text-il-meta text-text-2 hover:border-accent hover:text-accent disabled:opacity-60"
                            onClick={() => void toggleRenameExpand(row.enterpriseId)}
                          >
                            {renameTimelineLoading === row.enterpriseId
                              ? '…'
                              : isExpanded
                                ? ui.renameActionCollapse
                                : ui.renameActionExpand}
                          </button>
                        ) : (
                          <span className="text-text-3">{ui.renameActionNone}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{row.lastSeenBatchId}</td>
                      {showTechColumns ? (
                        <>
                          <td className="max-w-[140px] truncate px-3 py-2.5 font-mono text-[11px] text-text-3" title={row.subjectSnapshotId}>
                            {row.subjectSnapshotId || '—'}
                          </td>
                          <td className="max-w-[120px] truncate px-3 py-2.5 font-mono text-[11px] text-text-3" title={row.subjectBuildRunId}>
                            {row.subjectBuildRunId || '—'}
                          </td>
                          <td className="max-w-[100px] truncate px-3 py-2.5 font-mono text-[11px] text-text-3" title={row.categoryRuleVersion}>
                            {row.categoryRuleVersion || '—'}
                          </td>
                          <td className="max-w-[160px] truncate px-3 py-2.5 text-il-meta text-text-3" title={row.categoryStatusNote}>
                            {row.categoryStatusNote || '—'}
                          </td>
                          <td className="px-3 py-2.5 text-il-meta">{row.qualityStatus}</td>
                        </>
                      ) : null}
                    </tr>
                    {isExpanded ? (
                      <tr className="border-b border-border-light bg-[#fafbfd]">
                        <td className="px-3 py-2.5" colSpan={span}>
                          <div className="text-il-label text-text-3">{ui.renameTimelineTitle}</div>
                          <ul className="mt-1 space-y-1 text-il-page-desc text-text-2">
                            {lines.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {showImportModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="w-full max-w-[640px] rounded-[12px] border border-border-light bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-text">{ui.importModalTitle}</h3>
              <button type="button" className="text-il-page-desc text-text-3 hover:text-text" onClick={closeImportModal}>
                {ui.modalClose}
              </button>
            </div>
            <div className="rounded-sm border border-dashed border-[#9fc5f5] bg-[#f8fbff] px-4 py-6 text-center">
              <div className="text-il-page-desc font-medium text-text">{ui.importDropTitle}</div>
              <div className="mt-1 text-il-meta text-text-3">{ui.importDropHint}</div>
              <label className="mt-3 inline-flex cursor-pointer rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent">
                {ui.importPickFile}
                <input
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] ?? null)
                    setImportError('')
                  }}
                />
              </label>
              {importFile ? <div className="mt-2 text-il-meta text-text-2">{importFile.name}</div> : null}
              {importError ? <div className="mt-2 text-il-meta text-[#c2410c]">{importError}</div> : null}
            </div>
            <div className="mt-3 rounded-sm border border-[#fff1c7] bg-[#fffaf0] px-3 py-2 text-il-meta text-[#946200]">{ui.importModalTip}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent" onClick={closeImportModal}>
                {ui.modalCancel}
              </button>
              <button
                type="button"
                disabled={importBusy}
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90 disabled:opacity-60"
                onClick={() => void confirmImport()}
              >
                {importBusy ? ui.importConfirmBusy : ui.importConfirmBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {repairRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="w-full max-w-[520px] rounded-[12px] border border-border-light bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-text">{ui.repairModalTitle}</h3>
              <button
                type="button"
                className="text-il-page-desc text-text-3 hover:text-text"
                onClick={closeRepairModal}
                disabled={repairBusy}
              >
                {ui.modalClose}
              </button>
            </div>
            <p className="mb-3 text-il-meta text-text-3">{ui.repairNoUndoNote}</p>
            <div className="mb-3 rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2 text-il-page-desc text-text-2">
              <div className="font-medium text-text">{repairRow.enterpriseName}</div>
              <div className="mt-0.5 font-mono text-il-meta">{repairRow.taxpayerId}</div>
            </div>
            <label className="mb-3 block text-il-label text-text-2">
              <span className="mb-1 block font-medium">{ui.repairSubjectTypeLabel}</span>
              <select
                className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
                value={repairSubjectCategoryApi}
                onChange={(e) => setRepairSubjectCategoryApi(e.target.value as 'org' | 'person')}
                disabled={repairBusy}
              >
                <option value="org">{ui.subjectTypeEnterprise}（org）</option>
                <option value="person">{ui.subjectTypePerson}（person）</option>
              </select>
            </label>
            <label className="mb-3 block text-il-label text-text-2">
              <span className="mb-1 block font-medium">{ui.repairOrgCategoryLabel}</span>
              <input
                className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
                value={repairOrgCategoryInput}
                onChange={(e) => setRepairOrgCategoryInput(e.target.value)}
                disabled={repairBusy}
              />
              <span className="mt-1 block text-il-meta text-text-3">{ui.repairOrgCategoryHint}</span>
              <span className="mt-1 block text-il-meta text-text-2">
                {ui.repairOrgCategoryYamlName}：{repairRow.subjectCategoryName || '—'}
              </span>
            </label>
            <label className="mb-3 block text-il-label text-text-2">
              <span className="mb-1 block font-medium">{ui.repairReasonLabel}</span>
              <input
                className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
                value={repairReason}
                onChange={(e) => setRepairReason(e.target.value)}
                disabled={repairBusy}
                placeholder={ui.repairReasonPlaceholder}
              />
            </label>
            {repairError ? <div className="mb-3 text-il-meta text-danger">{repairError}</div> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={closeRepairModal}
                disabled={repairBusy}
              >
                {ui.repairCancel}
              </button>
              <button
                type="button"
                disabled={repairBusy}
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90 disabled:opacity-60"
                onClick={() => void confirmRepair()}
              >
                {repairBusy ? ui.repairBusy : ui.repairSubmit}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
