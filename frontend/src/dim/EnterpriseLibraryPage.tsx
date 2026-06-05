import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { navToDwdDimWithTask, SUBJECT_DIM_TASK } from '../dwd/dwdDimNav'
import {
  fetchSubjectLibraryInvoiceHeaders,
  fetchSubjectLibraryOrgCategoryOptions,
  fetchSubjectLibraryRenameTimeline,
  fetchSubjectLibraryRows,
  fetchSubjectLibrarySummary,
  postSubjectLibraryExternalImport,
  postSubjectLibraryRepair,
  type SubjectLibraryInvoiceHeaderDto,
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

const INVOICE_MODAL_PAGE_SIZE = 50

function formatInvoiceJshj(n: number | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

export function EnterpriseLibraryPage(props: { onNav?: (k: NavKey) => void }) {
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
  const [reloadSeq, setReloadSeq] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [subjectType, setSubjectType] = useState<'all' | SubjectType>('enterprise')
  const [sourceType, setSourceType] = useState<'all' | 'platform' | 'external'>('all')
  const [subjectCategory, setSubjectCategory] = useState('all')
  const [orgCategoryOptions, setOrgCategoryOptions] = useState<{ category_code: string; category_name: string }[]>(
    [],
  )
  const [orgCategoryOptionsError, setOrgCategoryOptionsError] = useState('')
  const [orgCategoryMetaLoaded, setOrgCategoryMetaLoaded] = useState(false)
  const [renameSignal, setRenameSignal] = useState<'all' | 'yes' | 'no'>('all')
  const [categoryReview, setCategoryReview] = useState<'all' | 'yes' | 'no'>('all')
  const [batchId, setBatchId] = useState('')
  const [expandedRenameId, setExpandedRenameId] = useState<string | null>(null)
  const [renameTimelineBySubject, setRenameTimelineBySubject] = useState<Record<string, string[]>>({})
  const [renameTimelineLoading, setRenameTimelineLoading] = useState<string | null>(null)
  const [showTechColumns, setShowTechColumns] = useState(false)
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
  const [invoiceModalSubject, setInvoiceModalSubject] = useState<EnterpriseRow | null>(null)
  const [invoiceModalPage, setInvoiceModalPage] = useState(1)
  const [invoiceModalLoading, setInvoiceModalLoading] = useState(false)
  const [invoiceModalError, setInvoiceModalError] = useState('')
  const [invoiceModalWarning, setInvoiceModalWarning] = useState('')
  const [invoiceModalRows, setInvoiceModalRows] = useState<SubjectLibraryInvoiceHeaderDto[]>([])
  const [invoiceModalTotal, setInvoiceModalTotal] = useState(0)
  const [rowTotal, setRowTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const filterListKey = useMemo(
    () =>
      JSON.stringify({
        batchId,
        categoryReview,
        keyword,
        renameSignal,
        sourceType,
        subjectCategory,
        subjectType,
        reloadSeq,
        pageSize,
      }),
    [batchId, categoryReview, keyword, renameSignal, reloadSeq, sourceType, subjectCategory, subjectType, pageSize],
  )
  const prevFilterListKeyRef = useRef<string | null>(null)

  const orgCategoryCodeSet = useMemo(
    () => new Set(orgCategoryOptions.map((o) => o.category_code)),
    [orgCategoryOptions],
  )
  /** 人工修正弹窗：有可用配置项时用下拉，避免手写编码 */
  const repairOrgCategoryUseSelect =
    orgCategoryMetaLoaded && orgCategoryOptions.length > 0 && !orgCategoryOptionsError

  useEffect(() => {
    let cancelled = false
    setOrgCategoryMetaLoaded(false)
    ;(async () => {
      const res = await fetchSubjectLibraryOrgCategoryOptions()
      if (cancelled) return
      setOrgCategoryMetaLoaded(true)
      if (res.ok) {
        setOrgCategoryOptions(res.categories)
        setOrgCategoryOptionsError('')
      } else {
        setOrgCategoryOptions([])
        setOrgCategoryOptionsError(res.error?.message ?? t.enterpriseLibraryUi.subjectCategoryOptionsLoadError)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadSeq])

  useEffect(() => {
    if (subjectCategory === 'all') return
    if (!orgCategoryMetaLoaded || orgCategoryOptionsError) return
    if (orgCategoryOptions.length === 0) return
    if (!orgCategoryOptions.some((o) => o.category_code === subjectCategory)) {
      setSubjectCategory('all')
    }
  }, [orgCategoryOptions, orgCategoryMetaLoaded, orgCategoryOptionsError, subjectCategory])

  const canReset =
    keyword.trim().length > 0 ||
    subjectType !== 'enterprise' ||
    sourceType !== 'all' ||
    subjectCategory !== 'all' ||
    renameSignal !== 'all' ||
    categoryReview !== 'all' ||
    batchId.trim().length > 0

  const resetFilters = () => {
    setKeyword('')
    setSubjectType('enterprise')
    setSourceType('all')
    setSubjectCategory('all')
    setRenameSignal('all')
    setCategoryReview('all')
    setBatchId('')
    setPage(1)
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
    setRepairOrgCategoryInput((row.subjectCategoryCode ?? '').trim())
  }

  const closeRepairModal = () => {
    setRepairRow(null)
    setRepairError('')
    setRepairReason('')
    setRepairBusy(false)
  }

  const openInvoiceModal = (row: EnterpriseRow) => {
    setInvoiceModalSubject(row)
    setInvoiceModalPage(1)
    setInvoiceModalError('')
    setInvoiceModalWarning('')
    setInvoiceModalRows([])
    setInvoiceModalTotal(0)
  }

  const closeInvoiceModal = () => {
    setInvoiceModalSubject(null)
    setInvoiceModalPage(1)
    setInvoiceModalLoading(false)
    setInvoiceModalError('')
    setInvoiceModalWarning('')
    setInvoiceModalRows([])
    setInvoiceModalTotal(0)
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

  type KpiKey = 'total' | 'ent' | 'person' | 'needs_review' | 'rename'

  const isKpiActive = (key: KpiKey): boolean => {
    switch (key) {
      case 'total':
        return subjectType === 'all'
      case 'ent':
        return subjectType === 'enterprise'
      case 'person':
        return subjectType === 'person'
      case 'needs_review':
        return categoryReview === 'yes'
      case 'rename':
        return renameSignal === 'yes'
      default:
        return false
    }
  }

  const activateKpi = (key: KpiKey) => {
    setPage(1)
    setExpandedRenameId(null)
    switch (key) {
      case 'total':
        if (subjectType !== 'all') setSubjectType('all')
        break
      case 'ent':
        setSubjectType(subjectType === 'enterprise' ? 'all' : 'enterprise')
        break
      case 'person':
        setSubjectType(subjectType === 'person' ? 'all' : 'person')
        break
      case 'needs_review':
        setCategoryReview(categoryReview === 'yes' ? 'all' : 'yes')
        break
      case 'rename':
        setRenameSignal(renameSignal === 'yes' ? 'all' : 'yes')
        break
      default:
        break
    }
  }

  const kpiActivateTitle = (key: KpiKey, count: number): string | undefined => {
    const active = isKpiActive(key)
    if (!active && count <= 0) return undefined
    switch (key) {
      case 'total':
        return active ? ui.kpiTotalClickHintActive : ui.kpiTotalClickHint.replace('{count}', String(count))
      case 'ent':
        return active
          ? ui.kpiEnterpriseClickHintActive
          : ui.kpiEnterpriseClickHint.replace('{count}', String(count))
      case 'person':
        return active ? ui.kpiPersonClickHintActive : ui.kpiPersonClickHint.replace('{count}', String(count))
      case 'needs_review':
        return active
          ? ui.kpiCategoryNeedsReviewClickHintActive
          : ui.kpiCategoryNeedsReviewClickHint.replace('{count}', String(count))
      case 'rename':
        return active
          ? ui.kpiRenameSignalClickHintActive
          : ui.kpiRenameSignalClickHint.replace('{count}', String(count))
      default:
        return undefined
    }
  }

  const canActivateKpi = (key: KpiKey, count: number): boolean => isKpiActive(key) || count > 0

  useEffect(() => {
    let cancelled = false
    const prevFk = prevFilterListKeyRef.current
    const filterChanged = prevFk !== null && prevFk !== filterListKey
    prevFilterListKeyRef.current = filterListKey
    const effectivePage = filterChanged ? 1 : page

    ;(async () => {
      setLoading(true)
      setLoadingError('')
      const offset = (effectivePage - 1) * pageSize
      const [rowsRes, sumRes] = await Promise.all([
        fetchSubjectLibraryRows({
          keyword,
          subjectType,
          sourceType,
          subjectCategory,
          renameSignal,
          categoryReview,
          batchId,
          limit: pageSize,
          offset,
        }),
        // KPI 与「主体类型」列表筛选解耦：汇总始终为当前数据来源+关键词下的全量 org/person 结构，避免筛「组织」时自然人恒为 0 的误导
        fetchSubjectLibrarySummary({
          subjectType: 'all',
          sourceType,
          keyword,
        }),
      ])
      if (cancelled) return
      if (!rowsRes.ok) {
        setLoadingError(rowsRes.error?.message ?? '主体库数据加载失败')
        setRows([])
        setRowTotal(0)
      } else {
        setRowTotal(Number(rowsRes.total ?? 0))
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
            renameHint:
              r.rename_hint && String(r.rename_hint).trim() !== '—'
                ? String(r.rename_hint)
                : '',
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

    if (filterChanged && page !== 1) {
      setPage(1)
    }
    return () => {
      cancelled = true
    }
  }, [filterListKey, page, pageSize])

  const totalPages = useMemo(() => {
    if (rowTotal <= 0) return 1
    return Math.max(1, Math.ceil(rowTotal / pageSize))
  }, [rowTotal, pageSize])

  useEffect(() => {
    setExpandedRenameId(null)
  }, [page])

  useEffect(() => {
    if (!repairSuccessFlash) return
    const id = window.setTimeout(() => setRepairSuccessFlash(''), 8000)
    return () => window.clearTimeout(id)
  }, [repairSuccessFlash])

  useEffect(() => {
    if (!invoiceModalSubject) return
    let cancelled = false
    setInvoiceModalLoading(true)
    setInvoiceModalError('')
    ;(async () => {
      const res = await fetchSubjectLibraryInvoiceHeaders({
        subjectId: invoiceModalSubject.enterpriseId,
        limit: INVOICE_MODAL_PAGE_SIZE,
        offset: (invoiceModalPage - 1) * INVOICE_MODAL_PAGE_SIZE,
      })
      if (cancelled) return
      setInvoiceModalLoading(false)
      if (!res.ok) {
        setInvoiceModalError(res.error?.message ?? '加载失败')
        setInvoiceModalRows([])
        setInvoiceModalTotal(0)
        setInvoiceModalWarning('')
        return
      }
      setInvoiceModalRows(res.rows)
      setInvoiceModalTotal(res.total)
      setInvoiceModalWarning(res.warning ?? '')
    })()
    return () => {
      cancelled = true
    }
  }, [invoiceModalSubject, invoiceModalPage])

  const invoiceModalTotalPages = useMemo(() => {
    if (invoiceModalTotal <= 0) return 1
    return Math.max(1, Math.ceil(invoiceModalTotal / INVOICE_MODAL_PAGE_SIZE))
  }, [invoiceModalTotal])

  return (
    <div className="flex h-full min-h-0 w-full flex-col px-5 py-6">
      <div className="shrink-0">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.prototypeNote}
        note={ui.pageIntroMerged}
        noteTone="callout"
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
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc]"
              onClick={() => props.onNav && navToDwdDimWithTask(props.onNav, SUBJECT_DIM_TASK.ingest)}
              title={ui.goToDwdToDimBuildHint}
            >
              {ui.goToDwdToDimBuildBtn}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc]"
              onClick={() => props.onNav && navToDwdDimWithTask(props.onNav, SUBJECT_DIM_TASK.recompute)}
              title={ui.goToDwdToDimRecomputeHint}
            >
              {ui.goToDwdToDimRecomputeBtn}
            </button>
          </div>
        }
      />
      </div>
      <div className="shrink-0">
      {importSuccess ? <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{importSuccess}</div> : null}
      {repairSuccessFlash ? (
        <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{repairSuccessFlash}</div>
      ) : null}
      {loadingError ? <div className="mb-4 rounded-sm border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">{loadingError}</div> : null}
      {loading ? <div className="mb-4 rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2 text-il-meta text-text-3">主体库数据加载中…</div> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {(
          [
            { key: 'total' as const, label: ui.kpiTotal, value: stats.total, cls: 'text-text' },
            { key: 'ent' as const, label: ui.kpiEnterprise, value: stats.enterpriseCount, cls: 'text-accent' },
            { key: 'person' as const, label: ui.kpiPerson, value: stats.personCount, cls: 'text-warn' },
            {
              key: 'needs_review' as const,
              label: ui.kpiCategoryNeedsReview,
              value: stats.needsReviewCount,
              cls: 'text-[#6b5cb3]',
            },
            {
              key: 'rename' as const,
              label: ui.kpiRenameSignalSubjects,
              value: stats.renameSignalSubjects,
              cls: 'text-[#0d6e5c]',
            },
          ] as const
        ).map((item) => {
          const active = isKpiActive(item.key)
          const clickable = canActivateKpi(item.key, item.value)
          const activateTitle = kpiActivateTitle(item.key, item.value)
          const inner = (
            <>
              <div className="text-il-label text-text-3">{item.label}</div>
              <div className={['mt-1 text-[20px] font-bold tabular-nums', item.cls].join(' ')}>{item.value}</div>
            </>
          )
          if (clickable) {
            return (
              <button
                key={item.key}
                type="button"
                title={activateTitle}
                aria-pressed={active}
                onClick={() => activateKpi(item.key)}
                className={[
                  'rounded-[10px] border px-3 py-3 text-left shadow-sm transition-colors',
                  active
                    ? 'border-accent/50 bg-[#f0f7ff] ring-1 ring-accent/25'
                    : 'border-border-light bg-white hover:border-[#c4b8e8] hover:bg-[#faf8ff]',
                ].join(' ')}
              >
                {inner}
              </button>
            )
          }
          return (
            <div key={item.key} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
              {inner}
            </div>
          )
        })}
      </div>
      <p className="mb-4 text-il-meta leading-relaxed text-text-3">{ui.kpiScopeHint}</p>

      <Card title={ui.filterTitle}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-9">
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
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-[#f5f7fa] disabled:text-text-3"
              value={subjectCategory}
              disabled={!orgCategoryMetaLoaded}
              onChange={(e) => setSubjectCategory(e.target.value)}
            >
              <option value="all">{ui.subjectCategoryAll}</option>
              {orgCategoryOptions.map((o) => (
                <option key={o.category_code} value={o.category_code}>
                  {o.category_name}
                </option>
              ))}
            </select>
            {orgCategoryOptionsError ? (
              <span className="mt-1 block text-il-meta text-danger">{orgCategoryOptionsError}</span>
            ) : null}
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
            <span className="mb-1 block font-medium">{ui.categoryReviewLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={categoryReview}
              onChange={(e) => setCategoryReview(e.target.value as 'all' | 'yes' | 'no')}
            >
              <option value="all">{ui.categoryReviewAll}</option>
              <option value="yes">{ui.categoryReviewYes}</option>
              <option value="no">{ui.categoryReviewNo}</option>
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
      </div>

      <Card
        title={ui.tableTitle}
        className="!mb-0 flex min-h-0 flex-1 flex-col overflow-hidden"
        bodyClassName="flex min-h-0 flex-1 flex-col pt-0"
      >
        <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-border-light">
          <table
            className={[
              // border-separate：避免 border-collapse 下部分浏览器 thead sticky 失效
              'w-full border-separate border-spacing-0 text-il-page-desc',
              showTechColumns ? 'min-w-[1680px]' : 'min-w-[1180px]',
            ].join(' ')}
          >
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colSubjectName}
                </th>
                <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colSubjectNo}
                </th>
                <th className="sticky top-0 z-10 whitespace-nowrap border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colSourceType}
                </th>
                <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colSubjectType}
                </th>
                <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colSubjectCategory}
                </th>
                <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colSubjectCategoryName}
                </th>
                <th className="sticky top-0 z-10 whitespace-nowrap border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colRepairAction}
                </th>
                <th
                  className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 text-center font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]"
                  colSpan={2}
                >
                  {ui.colRenameSection}
                </th>
                <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colLastBatch}
                </th>
                <th className="sticky top-0 z-10 whitespace-nowrap border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                  {ui.colInvoiceEvidence}
                </th>
                {showTechColumns ? (
                  <>
                    <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                      {ui.colTechSnapshot}
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                      {ui.colTechBuildRun}
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                      {ui.colTechRuleVer}
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                      {ui.colTechCategoryNote}
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]">
                      {ui.colTechQuality}
                    </th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody className="text-text-2">
              {rows.map((row) => {
                const isExpanded = expandedRenameId === row.enterpriseId
                const span = showTechColumns ? 16 : 11
                const lines = renameTimelineBySubject[row.enterpriseId] ?? []
                return (
                  <Fragment key={row.enterpriseId}>
                    <tr key={row.enterpriseId} className="border-b border-border-light bg-white">
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
                      <td className="max-w-[320px] px-3 py-2.5 text-text-2">
                        {row.renameHint ? row.renameHint : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
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
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">{row.lastSeenBatchId}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <button
                          type="button"
                          className="rounded-sm border border-border bg-white px-2 py-0.5 text-il-meta text-text-2 hover:border-accent hover:text-accent"
                          onClick={() => openInvoiceModal(row)}
                        >
                          {ui.invoiceEvidenceOpen}
                        </button>
                      </td>
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
        <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border-light pt-2">
          <div className="text-il-meta text-text-3">
            {(ui.filterTotalHint ?? '筛选共 {count} 条').replace('{count}', String(rowTotal))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-il-meta text-text-2">
              <span>{ui.tablePageSizeLabel}</span>
              <select
                className="h-8 rounded-sm border border-border-light bg-white px-2 text-il-meta text-text outline-none focus:border-accent"
                value={String(pageSize)}
                disabled={loading}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                }}
              >
                {[25, 50, 100, 200].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={loading || page <= 1}
              className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {ui.tablePagePrev}
            </button>
            <span className="tabular-nums text-il-meta text-text-3">
              {ui.tablePageOf
                .replace('{page}', String(Math.min(page, totalPages)))
                .replace('{pages}', String(totalPages))}
            </span>
            <button
              type="button"
              disabled={loading || page >= totalPages}
              className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {ui.tablePageNext}
            </button>
          </div>
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
              {!orgCategoryMetaLoaded ? (
                <div className="h-9 w-full rounded-sm border border-border-light bg-[#f5f7fa] px-2 text-il-meta leading-9 text-text-3">
                  {ui.repairOrgCategoryOptionsLoading}
                </div>
              ) : repairOrgCategoryUseSelect ? (
                <select
                  className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
                  value={repairOrgCategoryInput.trim()}
                  onChange={(e) => setRepairOrgCategoryInput(e.target.value)}
                  disabled={repairBusy}
                >
                  <option value="">{ui.repairOrgCategoryOptionClear}</option>
                  {(() => {
                    const cur = repairOrgCategoryInput.trim()
                    if (cur && !orgCategoryCodeSet.has(cur)) {
                      return (
                        <option key="__current_unknown__" value={cur}>
                          {ui.repairOrgCategoryOptionUnknownPrefix}
                          {cur}
                        </option>
                      )
                    }
                    return null
                  })()}
                  {orgCategoryOptions.map((o) => (
                    <option key={o.category_code} value={o.category_code}>
                      {o.category_code}
                      {o.category_name ? ` — ${o.category_name}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
                    value={repairOrgCategoryInput}
                    onChange={(e) => setRepairOrgCategoryInput(e.target.value)}
                    disabled={repairBusy}
                  />
                  {orgCategoryOptionsError ? (
                    <span className="mt-1 block text-il-meta text-danger">{orgCategoryOptionsError}</span>
                  ) : (
                    <span className="mt-1 block text-il-meta text-text-3">{ui.repairOrgCategoryFallbackInputHint}</span>
                  )}
                </>
              )}
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
      {invoiceModalSubject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4 py-6"
          onClick={closeInvoiceModal}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-[12px] border border-border-light bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="subject-invoice-modal-title"
          >
            <div className="shrink-0 border-b border-border-light px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 id="subject-invoice-modal-title" className="text-[16px] font-semibold text-text">
                    {ui.invoiceModalTitle}
                  </h3>
                  <div className="mt-1 truncate text-il-meta text-text-2" title={invoiceModalSubject.enterpriseName}>
                    {invoiceModalSubject.enterpriseName}
                  </div>
                  <div className="font-mono text-il-meta text-text-3">{invoiceModalSubject.taxpayerId}</div>
                  <p className="mt-2 text-il-meta leading-relaxed text-text-3">{ui.invoiceModalScopeHint}</p>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-il-page-desc text-text-3 hover:text-text"
                  onClick={closeInvoiceModal}
                >
                  {ui.modalClose}
                </button>
              </div>
            </div>
            {invoiceModalWarning ? (
              <div className="shrink-0 border-b border-[#fff1c7] bg-[#fffaf0] px-4 py-2 text-il-meta text-[#946200]">
                {invoiceModalWarning}
              </div>
            ) : null}
            {invoiceModalError ? (
              <div className="shrink-0 border-b border-danger/30 bg-[#fff5f5] px-4 py-2 text-il-meta text-danger">
                {invoiceModalError}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 pt-2">
              {invoiceModalLoading ? (
                <div className="px-2 py-6 text-center text-il-meta text-text-3">加载中…</div>
              ) : invoiceModalError ? (
                <div className="px-2 py-6 text-center text-il-meta text-text-3">—</div>
              ) : invoiceModalRows.length === 0 ? (
                <div className="px-2 py-6 text-center text-il-meta text-text-3">{ui.invoiceModalEmpty}</div>
              ) : (
                <table className="w-full min-w-[880px] border-separate border-spacing-0 text-il-page-desc">
                  <thead>
                    <tr className="text-left text-il-label text-text-3">
                      <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColFpdm}
                      </th>
                      <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColFphm}
                      </th>
                      <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColSdfphm}
                      </th>
                      <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColXfmc}
                      </th>
                      <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColGfmc}
                      </th>
                      <th className="sticky top-0 z-10 whitespace-nowrap border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColKprq}
                      </th>
                      <th className="sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColStatYear}
                      </th>
                      <th className="sticky top-0 z-10 whitespace-nowrap border-b border-border-light bg-[#fafbfd] px-2 py-2 font-medium">
                        {ui.invoiceColJshj}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-text-2">
                    {invoiceModalRows.map((inv) => (
                      <tr key={inv.header_uuid || `${inv.fpdm}-${inv.fphm}-${inv.sdfphm}-${inv.kprq}`} className="border-b border-border-light">
                        <td className="px-2 py-2 font-mono text-[11px]">{inv.fpdm || '—'}</td>
                        <td className="px-2 py-2 font-mono text-[11px]">{inv.fphm || '—'}</td>
                        <td className="px-2 py-2 font-mono text-[11px]">{inv.sdfphm || '—'}</td>
                        <td className="max-w-[140px] truncate px-2 py-2" title={inv.xfmc}>
                          {inv.xfmc || '—'}
                        </td>
                        <td className="max-w-[140px] truncate px-2 py-2" title={inv.gfmc}>
                          {inv.gfmc || '—'}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2">{inv.kprq || '—'}</td>
                        <td className="px-2 py-2 tabular-nums">{inv.stat_year != null ? String(inv.stat_year) : '—'}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatInvoiceJshj(inv.jshj)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border-light px-4 py-2">
              <div className="text-il-meta text-text-3">
                {ui.invoiceModalPageOf
                  .replace('{page}', String(Math.min(invoiceModalPage, invoiceModalTotalPages)))
                  .replace('{pages}', String(invoiceModalTotalPages))
                  .replace('{total}', String(invoiceModalTotal))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={invoiceModalLoading || invoiceModalPage <= 1}
                  className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
                  onClick={() => setInvoiceModalPage((p) => Math.max(1, p - 1))}
                >
                  {ui.invoiceModalPagePrev}
                </button>
                <button
                  type="button"
                  disabled={invoiceModalLoading || invoiceModalPage >= invoiceModalTotalPages}
                  className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
                  onClick={() => setInvoiceModalPage((p) => Math.min(invoiceModalTotalPages, p + 1))}
                >
                  {ui.invoiceModalPageNext}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
