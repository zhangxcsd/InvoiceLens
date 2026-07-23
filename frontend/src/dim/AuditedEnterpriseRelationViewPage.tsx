import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AuditedEnterpriseFilters } from '../components/AuditedEnterpriseFilters'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchAuditedEnterpriseRelationRows,
  type AuditedEnterpriseRelationKpis,
  type AuditedEnterpriseRelationListRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { navigateToOrgHierTree, readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { buildStatYearOptions, defaultPracticeStatYear } from '../utils/statYearOptions'
import { DimTablePagination } from './DimTablePagination'
import { relationListRowKey, relationRowOrgTreeParams } from './auditedEnterpriseTreeHelpers'
import type { OrgTreeSharedFilters } from './orgTreeSharedFilters'
import { navToSubjectLibrary } from './subjectLibraryNav'

function relationTypeClass(value: string) {
  if (value === '一致') return 'rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-2 py-0.5 text-il-meta font-medium text-[#1b6b3a]'
  if (value === '不一致') return 'rounded-sm border border-[#e8d4c8] bg-[#fffaf6] px-2 py-0.5 text-il-meta font-medium text-[#8a4a22]'
  return 'text-text-2'
}

type SortKey = 'name' | 'snapshot_year' | 'mgmt_path' | 'equity_path' | 'relation_type' | 'invoice_count'

function sortToApi(key: SortKey | null, dir: 'asc' | 'desc'): string | undefined {
  if (!key) return undefined
  return `${key}_${dir}`
}

function exportStamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const pathCellBaseCls =
  'max-w-[220px] align-top break-words text-left leading-snug sm:max-w-[260px] md:max-w-[300px] lg:max-w-[340px]'
const pathCellCls = `${pathCellBaseCls} line-clamp-3`
const pathCellExpandedCls = pathCellBaseCls

const thStickyTop = 'sticky top-0 z-20 border-b border-border-light bg-[#fafbfd] shadow-[0_1px_0_0_rgba(15,23,42,0.06)]'
const thCorner = `${thStickyTop} sticky left-0 z-30 border-r border-border-light pr-2`
const tdStickyLeft = 'sticky left-0 z-10 border-b border-border-light border-r border-border-light bg-white group-hover:bg-[#f8fafc]'

const emptyKpis: AuditedEnterpriseRelationKpis = {
  total: 0,
  relation_mismatch: 0,
  mapped: 0,
  unmapped: 0,
  in_analysis_pool: 0,
}

const FILTER_DEBOUNCE_MS = 320

export function AuditedEnterpriseRelationViewPage(props: {
  onNav?: (k: NavKey) => void
  embedded?: boolean
  sharedFilters?: OrgTreeSharedFilters
  onOpenOrgTree?: (params: {
    statYear?: string
    keyword?: string
    stateInvestor?: string
    treeMode?: 'management' | 'equity'
  }) => void
}) {
  const ui = t.auditedEnterpriseRelationUi
  const dash = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])

  const [rows, setRows] = useState<AuditedEnterpriseRelationListRow[]>([])
  const [total, setTotal] = useState(0)
  const [kpis, setKpis] = useState<AuditedEnterpriseRelationKpis>(emptyKpis)
  const [snapshotYears, setSnapshotYears] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [emptyHint, setEmptyHint] = useState('')

  const [localSelectedYear, setLocalSelectedYear] = useState<string>(
    urlQuery.stat_year?.trim() || ui.filterYearAll,
  )
  const [localSelectedStateInvestor, setLocalSelectedStateInvestor] = useState<string>(
    urlQuery.state_investor?.trim() || ui.filterStateInvestorAll,
  )
  const [localEnterpriseKeyword, setLocalEnterpriseKeyword] = useState(
    urlQuery.keyword ?? urlQuery.seller_tax_no ?? urlQuery.buyer_tax_no ?? '',
  )
  const [localDebouncedEnterpriseKeyword, setLocalDebouncedEnterpriseKeyword] = useState(localEnterpriseKeyword)
  const [localSelectedRelationType, setLocalSelectedRelationType] = useState<string>(() => {
    const raw = urlQuery.relation_type?.trim()
    if (raw === ui.filterRelationTypeMatch || raw === ui.filterRelationTypeMismatch) return raw
    return ui.filterRelationTypeAll
  })
  const [localSelectedMatchStatus, setLocalSelectedMatchStatus] = useState<string>(() => {
    const raw = urlQuery.match_status?.trim()
    if (raw === ui.filterMatchStatusMapped || raw === ui.filterMatchStatusUnmapped) return raw
    return ui.filterMatchStatusAll
  })
  const [localInAnalysisPoolOnly, setLocalInAnalysisPoolOnly] = useState(
    () => urlQuery.in_analysis_pool?.trim() === '1',
  )

  const selectedYear = props.sharedFilters?.selectedYear ?? localSelectedYear
  const selectedStateInvestor = props.sharedFilters?.selectedStateInvestor ?? localSelectedStateInvestor
  const enterpriseKeyword = props.sharedFilters?.enterpriseKeyword ?? localEnterpriseKeyword
  const debouncedEnterpriseKeyword =
    props.sharedFilters?.debouncedEnterpriseKeyword ?? localDebouncedEnterpriseKeyword
  const selectedRelationType = props.sharedFilters?.selectedRelationType ?? localSelectedRelationType
  const selectedMatchStatus = props.sharedFilters?.selectedMatchStatus ?? localSelectedMatchStatus
  const inAnalysisPoolOnly = props.sharedFilters?.inAnalysisPoolOnly ?? localInAnalysisPoolOnly
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [exportError, setExportError] = useState('')
  const [exported, setExported] = useState(false)
  const [selectedRowKey, setSelectedRowKey] = useState('')
  const [expandedPathRowKeys, setExpandedPathRowKeys] = useState<Set<string>>(() => new Set())
  const tableScrollRef = useRef<HTMLDivElement | null>(null)

  const filterRows = useMemo(
    () =>
      rows.map((r) => ({
        name: r.name,
        snapshotYear: r.snapshot_year,
        stateInvestorEnterprise: r.state_investor_enterprise,
      })),
    [rows],
  )

  const years = useMemo(
    () => buildStatYearOptions(snapshotYears.length ? snapshotYears : filterRows.map((r) => r.snapshotYear)),
    [filterRows, snapshotYears],
  )

  const stateInvestorEnterprises = useMemo(
    () => Array.from(new Set(filterRows.map((r) => r.stateInvestorEnterprise))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [filterRows],
  )

  const relationTypeOptions = useMemo(
    () => [ui.filterRelationTypeMatch, ui.filterRelationTypeMismatch],
    [ui.filterRelationTypeMatch, ui.filterRelationTypeMismatch],
  )
  const matchStatusOptions = useMemo(
    () => [ui.filterMatchStatusMapped, ui.filterMatchStatusUnmapped],
    [ui.filterMatchStatusMapped, ui.filterMatchStatusUnmapped],
  )

  const effectiveRelationType =
    selectedRelationType === ui.filterRelationTypeAll ? undefined : selectedRelationType
  const effectiveMatchStatus =
    selectedMatchStatus === ui.filterMatchStatusAll ? undefined : selectedMatchStatus

  const canReset =
    props.sharedFilters?.canReset ??
    (selectedYear !== ui.filterYearAll ||
      selectedStateInvestor !== ui.filterStateInvestorAll ||
      enterpriseKeyword.trim().length > 0 ||
      selectedRelationType !== ui.filterRelationTypeAll ||
      selectedMatchStatus !== ui.filterMatchStatusAll ||
      inAnalysisPoolOnly)

  const resetFilters = () => {
    if (!canReset) return
    if (props.sharedFilters) {
      props.sharedFilters.onReset()
    } else {
      setLocalSelectedYear(ui.filterYearAll)
      setLocalSelectedStateInvestor(ui.filterStateInvestorAll)
      setLocalEnterpriseKeyword('')
      setLocalDebouncedEnterpriseKeyword('')
      setLocalSelectedRelationType(ui.filterRelationTypeAll)
      setLocalSelectedMatchStatus(ui.filterMatchStatusAll)
      setLocalInAnalysisPoolOnly(false)
    }
    setPage(1)
    setSelectedRowKey('')
    setExpandedPathRowKeys(new Set())
  }

  useEffect(() => {
    if (props.sharedFilters) return
    const timer = window.setTimeout(() => setLocalDebouncedEnterpriseKeyword(localEnterpriseKeyword), FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [localEnterpriseKeyword, props.sharedFilters])

  useEffect(() => {
    if (props.embedded || props.sharedFilters) return
    writeNavQueryParams({
      stat_year: selectedYear === ui.filterYearAll ? undefined : selectedYear,
      state_investor: selectedStateInvestor === ui.filterStateInvestorAll ? undefined : selectedStateInvestor,
      keyword: debouncedEnterpriseKeyword.trim() || undefined,
      relation_type: effectiveRelationType,
      match_status: effectiveMatchStatus,
      in_analysis_pool: inAnalysisPoolOnly ? '1' : undefined,
    })
  }, [
    debouncedEnterpriseKeyword,
    effectiveMatchStatus,
    effectiveRelationType,
    inAnalysisPoolOnly,
    props.embedded,
    props.sharedFilters,
    selectedStateInvestor,
    selectedYear,
    ui.filterStateInvestorAll,
    ui.filterYearAll,
  ])

  const onYearChange = (year: string) => {
    if (props.sharedFilters) props.sharedFilters.onYearChange(year)
    else setLocalSelectedYear(year)
    setPage(1)
  }

  const onStateInvestorChange = (value: string) => {
    if (props.sharedFilters) props.sharedFilters.onStateInvestorChange(value)
    else setLocalSelectedStateInvestor(value)
    setPage(1)
  }

  const onEnterpriseKeywordChange = (keyword: string) => {
    if (props.sharedFilters) props.sharedFilters.onEnterpriseKeywordChange(keyword)
    else setLocalEnterpriseKeyword(keyword)
    setPage(1)
  }

  const onRelationTypeChange = (value: string) => {
    if (props.sharedFilters) props.sharedFilters.onRelationTypeChange(value)
    else setLocalSelectedRelationType(value)
    if (value !== ui.filterRelationTypeAll) {
      if (props.sharedFilters) {
        props.sharedFilters.onMatchStatusChange(ui.filterMatchStatusAll)
        props.sharedFilters.onInAnalysisPoolOnlyChange(false)
      } else {
        setLocalSelectedMatchStatus(ui.filterMatchStatusAll)
        setLocalInAnalysisPoolOnly(false)
      }
    }
    setPage(1)
    setSelectedRowKey('')
    setExpandedPathRowKeys(new Set())
  }

  const onMatchStatusChange = (value: string) => {
    if (props.sharedFilters) props.sharedFilters.onMatchStatusChange(value)
    else setLocalSelectedMatchStatus(value)
    if (value !== ui.filterMatchStatusAll) {
      if (props.sharedFilters) {
        props.sharedFilters.onRelationTypeChange(ui.filterRelationTypeAll)
        props.sharedFilters.onInAnalysisPoolOnlyChange(false)
      } else {
        setLocalSelectedRelationType(ui.filterRelationTypeAll)
        setLocalInAnalysisPoolOnly(false)
      }
    }
    setPage(1)
    setSelectedRowKey('')
    setExpandedPathRowKeys(new Set())
  }

  const onInAnalysisPoolOnlyChange = (value: boolean) => {
    if (props.sharedFilters) props.sharedFilters.onInAnalysisPoolOnlyChange(value)
    else setLocalInAnalysisPoolOnly(value)
    if (value) {
      if (props.sharedFilters) {
        props.sharedFilters.onRelationTypeChange(ui.filterRelationTypeAll)
        props.sharedFilters.onMatchStatusChange(ui.filterMatchStatusAll)
      } else {
        setLocalSelectedRelationType(ui.filterRelationTypeAll)
        setLocalSelectedMatchStatus(ui.filterMatchStatusAll)
      }
    }
    setPage(1)
    setSelectedRowKey('')
    setExpandedPathRowKeys(new Set())
  }

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchAuditedEnterpriseRelationRows({
      snapshotYear: selectedYear === ui.filterYearAll ? undefined : selectedYear,
      stateInvestor:
        selectedStateInvestor === ui.filterStateInvestorAll ? undefined : selectedStateInvestor,
      keyword: debouncedEnterpriseKeyword.trim() || undefined,
      relationType: effectiveRelationType,
      matchStatus: effectiveMatchStatus,
      inAnalysisPool: inAnalysisPoolOnly,
      page,
      pageSize,
      sort: sortToApi(sortKey, sortDir),
    })
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.loadFailed)
      setRows([])
      setTotal(0)
      setKpis(emptyKpis)
      setLoading(false)
      return
    }
    setSnapshotYears(res.snapshot_years ?? [])
    if (res.selected_year && !props.sharedFilters) {
      const mergedYears = buildStatYearOptions(res.snapshot_years ?? [])
      setLocalSelectedYear((prev) =>
        prev === ui.filterYearAll || !mergedYears.includes(prev)
          ? defaultPracticeStatYear(mergedYears, res.selected_year)
          : prev,
      )
    }
    setRows(res.rows ?? [])
    setTotal(res.total ?? 0)
    setKpis(res.kpis ?? emptyKpis)
    setEmptyHint(res.empty_hint ?? '')
    setSelectedRowKey('')
    setExpandedPathRowKeys(new Set())
    setLoading(false)
  }, [
    debouncedEnterpriseKeyword,
    effectiveMatchStatus,
    effectiveRelationType,
    inAnalysisPoolOnly,
    page,
    pageSize,
    selectedStateInvestor,
    selectedYear,
    sortDir,
    sortKey,
    ui.filterStateInvestorAll,
    ui.filterYearAll,
    ui.loadFailed,
    props.sharedFilters,
  ])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedRowKey) return
    const el = tableScrollRef.current?.querySelector(`[data-relation-row="${CSS.escape(selectedRowKey)}"]`)
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [rows, selectedRowKey])

  const toggleKpiFilter = useCallback(
    (key: 'total' | 'mismatch' | 'mapped' | 'unmapped' | 'in_pool') => {
      if (key === 'total') {
        onRelationTypeChange(ui.filterRelationTypeAll)
        onMatchStatusChange(ui.filterMatchStatusAll)
        onInAnalysisPoolOnlyChange(false)
        return
      }
      if (key === 'mismatch') {
        const active = selectedRelationType === ui.filterRelationTypeMismatch
        onRelationTypeChange(active ? ui.filterRelationTypeAll : ui.filterRelationTypeMismatch)
        return
      }
      if (key === 'mapped') {
        const active = selectedMatchStatus === ui.filterMatchStatusMapped
        onMatchStatusChange(active ? ui.filterMatchStatusAll : ui.filterMatchStatusMapped)
        return
      }
      if (key === 'unmapped') {
        const active = selectedMatchStatus === ui.filterMatchStatusUnmapped
        onMatchStatusChange(active ? ui.filterMatchStatusAll : ui.filterMatchStatusUnmapped)
        return
      }
      onInAnalysisPoolOnlyChange(!inAnalysisPoolOnly)
    },
    [
      inAnalysisPoolOnly,
      onInAnalysisPoolOnlyChange,
      onMatchStatusChange,
      onRelationTypeChange,
      selectedMatchStatus,
      selectedRelationType,
      ui.filterMatchStatusAll,
      ui.filterMatchStatusMapped,
      ui.filterMatchStatusUnmapped,
      ui.filterRelationTypeAll,
      ui.filterRelationTypeMismatch,
    ],
  )

  const isKpiActive = useCallback(
    (key: 'total' | 'mismatch' | 'mapped' | 'unmapped' | 'in_pool') => {
      if (key === 'total') {
        return (
          selectedRelationType === ui.filterRelationTypeAll &&
          selectedMatchStatus === ui.filterMatchStatusAll &&
          !inAnalysisPoolOnly
        )
      }
      if (key === 'mismatch') return selectedRelationType === ui.filterRelationTypeMismatch
      if (key === 'mapped') return selectedMatchStatus === ui.filterMatchStatusMapped
      if (key === 'unmapped') return selectedMatchStatus === ui.filterMatchStatusUnmapped
      return inAnalysisPoolOnly
    },
    [
      inAnalysisPoolOnly,
      selectedMatchStatus,
      selectedRelationType,
      ui.filterMatchStatusAll,
      ui.filterMatchStatusMapped,
      ui.filterMatchStatusUnmapped,
      ui.filterRelationTypeAll,
      ui.filterRelationTypeMismatch,
    ],
  )

  const toggleSort = (key: SortKey) => {
    setPage(1)
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir(key === 'snapshot_year' || key === 'invoice_count' ? 'desc' : 'asc')
      return
    }
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
  }

  const exportCurrent = useCallback(async () => {
    if (rows.length === 0) return
    try {
      setExportError('')
      const XLSX = await import('xlsx')
      const header = [
        ui.colName,
        ui.colSnapshotYear,
        ui.colMgmtPath,
        ui.colEquityPath,
        ui.colRelationType,
        ui.colEntityId,
        ui.colRoleLabel,
        ui.colInvoiceCount,
        ui.colMatchStatus,
        ui.colInRoster,
      ]
      const body = rows.map((r) => [
        r.name,
        r.snapshot_year,
        r.mgmt_path,
        r.equity_path,
        r.relation_type,
        r.entity_id || r.code || '',
        r.role_label || '—',
        r.invoice_count ?? 0,
        r.match_status || '—',
        r.in_roster ? ui.rosterYes : ui.rosterNo,
      ])
      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '对照')
      XLSX.writeFile(wb, `${ui.exportFileNamePrefix}_${exportStamp()}.xlsx`)
      setExported(true)
      window.setTimeout(() => setExported(false), 2000)
    } catch {
      setExportError(ui.exportFailed)
    }
  }, [rows, ui])

  const emptyMessage = loading ? '…' : loadError || emptyHint || (total === 0 ? ui.loadEmptyHint : ui.filterEmpty)

  const kpiCards = [
    { key: 'total' as const, label: ui.kpiTotal, value: kpis.total, clickable: true },
    { key: 'mismatch' as const, label: ui.kpiMismatch, value: kpis.relation_mismatch, clickable: true },
    { key: 'mapped' as const, label: ui.kpiMapped, value: kpis.mapped, clickable: true },
    { key: 'unmapped' as const, label: ui.kpiUnmapped, value: kpis.unmapped, clickable: true },
    { key: 'in_pool' as const, label: ui.kpiInPool, value: kpis.in_analysis_pool, clickable: true },
  ]

  const flagContextHint = useMemo(() => {
    const buyer = urlQuery.buyer_tax_no?.trim()
    const seller = urlQuery.seller_tax_no?.trim()
    if (!buyer && !seller) return null
    return dash.flagContextInternalHint
      .replace('{buyer}', buyer || '—')
      .replace('{seller}', seller || '—')
  }, [dash, urlQuery.buyer_tax_no, urlQuery.seller_tax_no])

  const openOrgTree = (params: {
    statYear?: string
    keyword?: string
    stateInvestor?: string
    treeMode?: 'management' | 'equity'
  }) => {
    if (props.onOpenOrgTree) {
      props.onOpenOrgTree(params)
      return
    }
    if (props.onNav) navigateToOrgHierTree(props.onNav, params)
  }

  const openOrgTreeFromRow = useCallback(
    (row: AuditedEnterpriseRelationListRow) => {
      openOrgTree(relationRowOrgTreeParams(row, selectedStateInvestor, ui.filterStateInvestorAll))
    },
    [openOrgTree, selectedStateInvestor, ui.filterStateInvestorAll],
  )

  const rowKeys = useMemo(() => rows.map((row) => relationListRowKey(row)), [rows])

  const handleTableKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return
      const { key } = event
      if (key === 'Enter') {
        if (!selectedRowKey) return
        const row = rows.find((item) => relationListRowKey(item) === selectedRowKey)
        if (!row || !(props.onNav || props.onOpenOrgTree)) return
        event.preventDefault()
        openOrgTreeFromRow(row)
        return
      }
      if (key === ' ') {
        if (!selectedRowKey) return
        event.preventDefault()
        setExpandedPathRowKeys((prev) => {
          const next = new Set(prev)
          if (next.has(selectedRowKey)) next.delete(selectedRowKey)
          else next.add(selectedRowKey)
          return next
        })
        return
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return
      event.preventDefault()
      const currentIdx = selectedRowKey ? rowKeys.indexOf(selectedRowKey) : -1
      if (key === 'Home') {
        setSelectedRowKey(rowKeys[0] ?? '')
        return
      }
      if (key === 'End') {
        setSelectedRowKey(rowKeys[rowKeys.length - 1] ?? '')
        return
      }
      if (key === 'ArrowDown') {
        const next = rowKeys[Math.min(currentIdx + 1, rowKeys.length - 1)] ?? rowKeys[0]
        if (next) setSelectedRowKey(next)
        return
      }
      const prev =
        currentIdx <= 0 ? rowKeys[0] : rowKeys[Math.max(currentIdx - 1, 0)]
      if (prev) setSelectedRowKey(prev)
    },
    [openOrgTreeFromRow, props.onNav, props.onOpenOrgTree, rowKeys, rows, selectedRowKey],
  )

  const body = (
    <>
      {flagContextHint ? <p className="mb-3 text-il-meta text-amber-800">{flagContextHint}</p> : null}
      {loadError ? <p className="mb-3 text-il-meta text-red-600">{loadError}</p> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {kpiCards.map((item) => {
          const active = isKpiActive(item.key)
          return (
            <button
              key={item.key}
              type="button"
              className={[
                'rounded-[10px] border px-3 py-3 text-left shadow-sm transition-colors',
                active ? 'border-accent/40 bg-[#f0f7ff]' : 'border-border-light bg-white',
                item.clickable ? 'cursor-pointer hover:border-accent/30 hover:bg-[#f8fbff]' : 'cursor-default',
              ].join(' ')}
              onClick={() => toggleKpiFilter(item.key)}
            >
              <div className="text-il-label text-text-3">{item.label}</div>
              <div className="mt-1 text-[20px] font-bold tabular-nums text-text">{item.value}</div>
            </button>
          )
        })}
      </div>

      <Card title={ui.tableTitle}>
        {props.embedded ? (
          <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
            {exported ? <span className="text-il-meta text-[#1b6b3a]">{ui.exportSuccess}</span> : null}
            <button
              type="button"
              className={[
                'rounded-sm border px-3 py-1.5 text-il-meta transition-colors',
                rows.length > 0
                  ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                  : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
              ].join(' ')}
              disabled={rows.length === 0}
              onClick={() => void exportCurrent()}
            >
              {ui.exportCurrentResult}
            </button>
          </div>
        ) : null}
        <AuditedEnterpriseFilters
          yearLabel={ui.filterYearLabel}
          yearAllLabel={ui.filterYearAll}
          years={years}
          selectedYear={selectedYear}
          onYearChange={onYearChange}
          stateInvestorLabel={ui.filterStateInvestorLabel}
          stateInvestorAllLabel={ui.filterStateInvestorAll}
          stateInvestorOptions={stateInvestorEnterprises}
          selectedStateInvestor={selectedStateInvestor}
          onStateInvestorChange={onStateInvestorChange}
          enterpriseLabel={ui.filterEnterpriseLabel}
          enterprisePlaceholder={ui.filterEnterprisePlaceholder}
          enterpriseKeyword={enterpriseKeyword}
          onEnterpriseKeywordChange={onEnterpriseKeywordChange}
          relationTypeLabel={ui.filterRelationTypeLabel}
          relationTypeAllLabel={ui.filterRelationTypeAll}
          relationTypeOptions={relationTypeOptions}
          selectedRelationType={selectedRelationType}
          onRelationTypeChange={onRelationTypeChange}
          matchStatusLabel={ui.filterMatchStatusLabel}
          matchStatusAllLabel={ui.filterMatchStatusAll}
          matchStatusOptions={matchStatusOptions}
          selectedMatchStatus={selectedMatchStatus}
          onMatchStatusChange={onMatchStatusChange}
          inAnalysisPoolLabel={ui.filterInAnalysisPoolLabel}
          inAnalysisPoolOnly={inAnalysisPoolOnly}
          onInAnalysisPoolOnlyChange={onInAnalysisPoolOnlyChange}
          resetLabel={ui.filterReset}
          canReset={canReset}
          onReset={resetFilters}
        />
        <div className="-mt-1 mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-light pb-3 text-il-meta text-text-3">
          <span className="min-w-0 max-w-[720px] leading-relaxed">{ui.tableHint}</span>
          <span className="whitespace-nowrap">
            <span className="text-text-3">{ui.recordCountLabel}</span>
            <span className="ml-1 font-semibold tabular-nums text-text">{total}</span>
          </span>
        </div>
        {exportError ? <div className="mb-2 text-il-meta text-[#c2410c]">{exportError}</div> : null}
        <div
          ref={tableScrollRef}
          tabIndex={0}
          role="grid"
          data-testid="org-relation-table-grid"
          aria-label={ui.tableTitle}
          onKeyDown={handleTableKeyDown}
          className="overflow-x-auto rounded-sm border border-border-light outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        >
          <table className="w-full min-w-[1400px] border-separate border-spacing-0 text-il-page-desc">
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th scope="col" className={`${thCorner} px-3 py-2 pl-3 font-medium`}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-medium text-text-3 hover:text-text-2" onClick={() => toggleSort('name')}>
                    {ui.colName}
                    {sortKey === 'name' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-medium text-text-3 hover:text-text-2" onClick={() => toggleSort('snapshot_year')}>
                    {ui.colSnapshotYear}
                    {sortKey === 'snapshot_year' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} px-3 py-2 font-medium`}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-medium text-text-3 hover:text-text-2" onClick={() => toggleSort('mgmt_path')}>
                    {ui.colMgmtPath}
                    {sortKey === 'mgmt_path' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} px-3 py-2 font-medium`}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-medium text-text-3 hover:text-text-2" onClick={() => toggleSort('equity_path')}>
                    {ui.colEquityPath}
                    {sortKey === 'equity_path' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-medium text-text-3 hover:text-text-2" onClick={() => toggleSort('relation_type')}>
                    {ui.colRelationType}
                    {sortKey === 'relation_type' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>{ui.colEntityId}</th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>{ui.colRoleLabel}</th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-medium text-text-3 hover:text-text-2" onClick={() => toggleSort('invoice_count')}>
                    {ui.colInvoiceCount}
                    {sortKey === 'invoice_count' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>{ui.colMatchStatus}</th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>{ui.colInRoster}</th>
                {props.onNav || props.onOpenOrgTree ? <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>{ui.colActions}</th> : null}
              </tr>
            </thead>
            <tbody className="text-text-2">
              {rows.map((row) => {
                const subjectKw = row.subject_no || row.code || row.name
                const rowKey = relationListRowKey(row)
                const activeRow = selectedRowKey === rowKey
                const pathsExpanded = expandedPathRowKeys.has(rowKey)
                const pathCls = pathsExpanded ? pathCellExpandedCls : pathCellCls
                return (
                  <tr
                    key={rowKey}
                    data-relation-row={rowKey}
                    data-relation-path-expanded={pathsExpanded ? 'true' : 'false'}
                    className={[
                      'group cursor-pointer',
                      activeRow ? 'bg-[#f0f7ff]' : 'hover:bg-[#f8fafc]',
                    ].join(' ')}
                    onClick={() => setSelectedRowKey(rowKey)}
                    onDoubleClick={() => {
                      if (props.onNav || props.onOpenOrgTree) openOrgTreeFromRow(row)
                    }}
                  >
                    <td className={`${tdStickyLeft} px-3 py-2.5 font-medium text-text ${activeRow ? 'bg-[#f0f7ff]' : ''}`}>{row.name}</td>
                    <td className={`border-b border-border-light px-3 py-2.5 tabular-nums ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>{row.snapshot_year}</td>
                    <td className={`${pathCls} border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`} title={row.mgmt_path}>{row.mgmt_path}</td>
                    <td className={`${pathCls} border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`} title={row.equity_path}>{row.equity_path}</td>
                    <td className={`border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>
                      <span className={relationTypeClass(row.relation_type)}>{row.relation_type}</span>
                    </td>
                    <td className={`border-b border-border-light px-3 py-2.5 font-mono text-[12px] ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>{row.entity_id || row.code || '—'}</td>
                    <td className={`border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>{row.role_label || '—'}</td>
                    <td className={`border-b border-border-light px-3 py-2.5 tabular-nums ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>{row.invoice_count ?? '—'}</td>
                    <td className={`border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>{row.match_status || '—'}</td>
                    <td className={`border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>{row.in_roster ? ui.rosterYes : ui.rosterNo}</td>
                    {props.onNav || props.onOpenOrgTree ? (
                      <td className={`border-b border-border-light px-3 py-2.5 ${activeRow ? 'bg-[#f0f7ff]' : 'group-hover:bg-[#f8fafc]'}`}>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className="text-il-label text-accent hover:underline"
                            onClick={(event) => {
                              event.stopPropagation()
                              openOrgTreeFromRow(row)
                            }}
                          >
                            {ui.actionOrgTree}
                          </button>
                          {props.onNav ? (
                            <>
                              <button type="button" className="text-il-label text-accent hover:underline" onClick={(event) => { event.stopPropagation(); props.onNav?.('dim_audit_related_library') }}>{ui.actionCoverage}</button>
                              <button type="button" className="text-il-label text-accent hover:underline" onClick={(event) => { event.stopPropagation(); navToSubjectLibrary(props.onNav!, subjectKw) }}>{ui.actionSubjectLibrary}</button>
                              <button type="button" className="text-il-label text-accent hover:underline" onClick={(event) => { event.stopPropagation(); props.onNav?.('dim_enterprise_year_roster') }}>{ui.actionYearRoster}</button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td className="border-b border-border-light px-3 py-6 text-center text-text-3" colSpan={props.onNav || props.onOpenOrgTree ? 11 : 10}>
                    {emptyMessage}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <DimTablePagination
          total={total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          ui={ui}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
        />
      </Card>
    </>
  )

  if (props.embedded) return body

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageNote}
        note={ui.pageDesc}
        noteTone="plain"
        badgeText={undefined}
        actions={
          <div className="flex items-center gap-2">
            {exported ? <span className="text-il-meta text-[#1b6b3a]">{ui.exportSuccess}</span> : null}
            <button
              type="button"
              className={[
                'rounded-sm border px-3 py-1.5 text-il-meta transition-colors',
                rows.length > 0
                  ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                  : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
              ].join(' ')}
              disabled={rows.length === 0}
              onClick={() => void exportCurrent()}
            >
              {ui.exportCurrentResult}
            </button>
          </div>
        }
      />
      {body}
    </div>
  )
}
