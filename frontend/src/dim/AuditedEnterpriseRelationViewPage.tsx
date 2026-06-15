import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuditedEnterpriseFilters } from '../components/AuditedEnterpriseFilters'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDimOrgHierRows,
  type AuditedEnterpriseRelationKpis,
  type AuditedEnterpriseRelationListRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { readNavQueryParams } from '../utils/navHelpers'
import { DimTablePagination } from './DimTablePagination'
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

const pathCellCls =
  'max-w-[220px] align-top break-words text-left leading-snug sm:max-w-[260px] md:max-w-[300px] lg:max-w-[340px] line-clamp-3'

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

export function AuditedEnterpriseRelationViewPage(props: { onNav?: (k: NavKey) => void }) {
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

  const [selectedYear, setSelectedYear] = useState<string>(
    urlQuery.stat_year?.trim() || ui.filterYearAll,
  )
  const [selectedStateInvestor, setSelectedStateInvestor] = useState<string>(ui.filterStateInvestorAll)
  const [enterpriseKeyword, setEnterpriseKeyword] = useState(
    urlQuery.keyword ?? urlQuery.seller_tax_no ?? urlQuery.buyer_tax_no ?? '',
  )
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [exportError, setExportError] = useState('')
  const [exported, setExported] = useState(false)

  const filterRows = useMemo(
    () =>
      rows.map((r) => ({
        name: r.name,
        snapshotYear: r.snapshot_year,
        stateInvestorEnterprise: r.state_investor_enterprise,
      })),
    [rows],
  )

  const years = useMemo(() => {
    const fromApi = snapshotYears.length ? snapshotYears : Array.from(new Set(filterRows.map((r) => r.snapshotYear)))
    return fromApi.sort((a, b) => Number(b) - Number(a))
  }, [filterRows, snapshotYears])

  const stateInvestorEnterprises = useMemo(
    () => Array.from(new Set(filterRows.map((r) => r.stateInvestorEnterprise))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [filterRows],
  )

  const canReset =
    selectedYear !== ui.filterYearAll ||
    selectedStateInvestor !== ui.filterStateInvestorAll ||
    enterpriseKeyword.trim().length > 0

  const resetFilters = () => {
    if (!canReset) return
    setSelectedYear(ui.filterYearAll)
    setSelectedStateInvestor(ui.filterStateInvestorAll)
    setEnterpriseKeyword('')
    setPage(1)
  }

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchDimOrgHierRows({
      statYear: selectedYear === ui.filterYearAll ? undefined : selectedYear,
      keyword: enterpriseKeyword.trim() || undefined,
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
    setSnapshotYears(res.stat_years ?? [])
    setRows(res.rows ?? [])
    setTotal(res.total ?? 0)
    setKpis(res.kpis ?? emptyKpis)
    setEmptyHint('')
    setLoading(false)
  }, [
    enterpriseKeyword,
    page,
    pageSize,
    selectedStateInvestor,
    selectedYear,
    sortDir,
    sortKey,
    ui.filterStateInvestorAll,
    ui.filterYearAll,
    ui.loadFailed,
  ])

  useEffect(() => {
    void load()
  }, [load])

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
    { label: ui.kpiTotal, value: kpis.total },
    { label: ui.kpiMismatch, value: kpis.relation_mismatch },
    { label: ui.kpiHierDiff ?? '管产分离', value: (kpis as { hier_diff?: number }).hier_diff ?? kpis.relation_mismatch },
    { label: ui.kpiMgChange ?? '管理变更', value: (kpis as { mg_change_count?: number }).mg_change_count ?? 0 },
    { label: ui.kpiEqChange ?? '产权变更', value: (kpis as { eq_change_count?: number }).eq_change_count ?? 0 },
  ]

  const flagContextHint = useMemo(() => {
    const buyer = urlQuery.buyer_tax_no?.trim()
    const seller = urlQuery.seller_tax_no?.trim()
    if (!buyer && !seller) return null
    return dash.flagContextInternalHint
      .replace('{buyer}', buyer || '—')
      .replace('{seller}', seller || '—')
  }, [dash, urlQuery.buyer_tax_no, urlQuery.seller_tax_no])

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

      {flagContextHint ? <p className="mb-3 text-il-meta text-amber-800">{flagContextHint}</p> : null}
      {loadError ? <p className="mb-3 text-il-meta text-red-600">{loadError}</p> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {kpiCards.map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className="mt-1 text-[20px] font-bold tabular-nums text-text">{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.tableTitle}>
        <AuditedEnterpriseFilters
          yearLabel={ui.filterYearLabel}
          yearAllLabel={ui.filterYearAll}
          years={years}
          selectedYear={selectedYear}
          onYearChange={(y) => {
            setSelectedYear(y)
            setPage(1)
          }}
          stateInvestorLabel={ui.filterStateInvestorLabel}
          stateInvestorAllLabel={ui.filterStateInvestorAll}
          stateInvestorOptions={stateInvestorEnterprises}
          selectedStateInvestor={selectedStateInvestor}
          onStateInvestorChange={(v) => {
            setSelectedStateInvestor(v)
            setPage(1)
          }}
          enterpriseLabel={ui.filterEnterpriseLabel}
          enterprisePlaceholder={ui.filterEnterprisePlaceholder}
          enterpriseKeyword={enterpriseKeyword}
          onEnterpriseKeywordChange={(kw) => {
            setEnterpriseKeyword(kw)
            setPage(1)
          }}
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
        <div className="overflow-x-auto rounded-sm border border-border-light">
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
                {props.onNav ? <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>{ui.colActions}</th> : null}
              </tr>
            </thead>
            <tbody className="text-text-2">
              {rows.map((row) => {
                const subjectKw = row.subject_no || row.code || row.name
                return (
                  <tr key={`${row.name}-${row.snapshot_year}-${row.code}`} className="group">
                    <td className={`${tdStickyLeft} px-3 py-2.5 font-medium text-text`}>{row.name}</td>
                    <td className="border-b border-border-light px-3 py-2.5 tabular-nums group-hover:bg-[#f8fafc]">{row.snapshot_year}</td>
                    <td className={`${pathCellCls} border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]`} title={row.mgmt_path}>{row.mgmt_path}</td>
                    <td className={`${pathCellCls} border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]`} title={row.equity_path}>{row.equity_path}</td>
                    <td className="border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]">
                      <span className={relationTypeClass(row.relation_type)}>{row.relation_type}</span>
                    </td>
                    <td className="border-b border-border-light px-3 py-2.5 font-mono text-[12px] group-hover:bg-[#f8fafc]">{row.entity_id || row.code || '—'}</td>
                    <td className="border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]">{row.role_label || '—'}</td>
                    <td className="border-b border-border-light px-3 py-2.5 tabular-nums group-hover:bg-[#f8fafc]">{row.invoice_count ?? '—'}</td>
                    <td className="border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]">{row.match_status || '—'}</td>
                    <td className="border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]">{row.in_roster ? ui.rosterYes : ui.rosterNo}</td>
                    {props.onNav ? (
                      <td className="border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]">
                        <div className="flex flex-wrap gap-1.5">
                          <button type="button" className="text-il-label text-accent hover:underline" onClick={() => props.onNav?.('dim_audit_related_library')}>{ui.actionCoverage}</button>
                          <button type="button" className="text-il-label text-accent hover:underline" onClick={() => navToSubjectLibrary(props.onNav!, subjectKw)}>{ui.actionSubjectLibrary}</button>
                          <button type="button" className="text-il-label text-accent hover:underline" onClick={() => props.onNav?.('dim_enterprise_year_roster')}>{ui.actionYearRoster}</button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td className="border-b border-border-light px-3 py-6 text-center text-text-3" colSpan={props.onNav ? 11 : 10}>
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
    </div>
  )
}
