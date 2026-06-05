import { useCallback, useMemo, useState } from 'react'
import { AuditedEnterpriseFilters } from '../components/AuditedEnterpriseFilters'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import { useAuditedEnterpriseFilters } from '../hooks/useAuditedEnterpriseFilters'
import { useAuditedEnterpriseRegistryRows } from '../hooks/useAuditedEnterpriseRegistryRows'
import { registryRowsToRelationRows, type AuditedEnterpriseRelationRow } from './auditedEnterpriseRegistryHelpers'

function relationTypeClass(value: string) {
  if (value === '一致') return 'rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-2 py-0.5 text-il-meta font-medium text-[#1b6b3a]'
  if (value === '不一致') return 'rounded-sm border border-[#e8d4c8] bg-[#fffaf6] px-2 py-0.5 text-il-meta font-medium text-[#8a4a22]'
  return 'text-text-2'
}

type SortKey = 'name' | 'snapshotYear' | 'mgmtPath' | 'equityPath' | 'relationType'

function relationTypeRank(value: string) {
  if (value === '一致') return 0
  if (value === '不一致') return 1
  return 2
}

function compareRows(a: AuditedEnterpriseRelationRow, b: AuditedEnterpriseRelationRow, key: SortKey, dir: 'asc' | 'desc'): number {
  const inv = dir === 'desc' ? -1 : 1
  let c = 0
  switch (key) {
    case 'name':
      c = a.name.localeCompare(b.name, 'zh-CN')
      break
    case 'snapshotYear':
      c = (Number(a.snapshotYear) || 0) - (Number(b.snapshotYear) || 0)
      break
    case 'mgmtPath':
      c = a.mgmtPath.localeCompare(b.mgmtPath, 'zh-CN')
      break
    case 'equityPath':
      c = a.equityPath.localeCompare(b.equityPath, 'zh-CN')
      break
    case 'relationType':
      c = relationTypeRank(a.relationType) - relationTypeRank(b.relationType)
      break
    default:
      break
  }
  if (c !== 0) return c * inv
  return a.name.localeCompare(b.name, 'zh-CN')
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

export function AuditedEnterpriseRelationViewPage() {
  const ui = t.auditedEnterpriseRelationUi
  const { rows: registryRows, loading, loadError } = useAuditedEnterpriseRegistryRows(ui.loadFailed)

  const relationRows = useMemo(() => registryRowsToRelationRows(registryRows), [registryRows])

  const {
    selectedYear,
    setSelectedYear,
    selectedStateInvestor,
    setSelectedStateInvestor,
    enterpriseKeyword,
    setEnterpriseKeyword,
    years,
    stateInvestorEnterprises,
    filteredRows,
    canReset,
    resetFilters,
  } = useAuditedEnterpriseFilters(relationRows, {
    yearAll: ui.filterYearAll,
    stateInvestorAll: ui.filterStateInvestorAll,
  })

  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [exportError, setExportError] = useState('')
  const [exported, setExported] = useState(false)

  const toggleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir(key === 'snapshotYear' ? 'desc' : 'asc')
      return
    }
    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
  }

  const displayRows = useMemo(() => {
    if (!sortKey) return filteredRows
    const arr = [...filteredRows]
    arr.sort((a, b) => compareRows(a, b, sortKey, sortDir))
    return arr
  }, [filteredRows, sortDir, sortKey])

  const exportCurrent = useCallback(async () => {
    if (displayRows.length === 0) return
    try {
      setExportError('')
      const XLSX = await import('xlsx')
      const header = [ui.colName, ui.colSnapshotYear, ui.colMgmtPath, ui.colEquityPath, ui.colRelationType]
      const body = displayRows.map((r) => [r.name, r.snapshotYear, r.mgmtPath, r.equityPath, r.relationType])
      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '对照')
      const name = `${ui.exportFileNamePrefix}_${exportStamp()}.xlsx`
      XLSX.writeFile(wb, name)
      setExported(true)
      window.setTimeout(() => setExported(false), 2000)
    } catch {
      setExportError(ui.exportFailed)
    }
  }, [displayRows, ui])

  const emptyMessage = loading ? '…' : loadError || (relationRows.length === 0 ? ui.loadEmptyHint : ui.filterEmpty)

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageNote}
        note={ui.pageDesc}
        noteTone="plain"
        badgeText={ui.prototypeBadge}
        actions={
          <div className="flex items-center gap-2">
            {exported ? <span className="text-il-meta text-[#1b6b3a]">{ui.exportSuccess}</span> : null}
            <button
              type="button"
              className={[
                'rounded-sm border px-3 py-1.5 text-il-meta transition-colors',
                displayRows.length > 0
                  ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                  : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
              ].join(' ')}
              disabled={displayRows.length === 0}
              onClick={() => void exportCurrent()}
            >
              {ui.exportCurrentResult}
            </button>
          </div>
        }
      />

      {loadError ? <p className="mb-3 text-il-meta text-red-600">{loadError}</p> : null}

      <Card title={ui.tableTitle}>
        <AuditedEnterpriseFilters
          yearLabel={ui.filterYearLabel}
          yearAllLabel={ui.filterYearAll}
          years={years}
          selectedYear={selectedYear}
          onYearChange={setSelectedYear}
          stateInvestorLabel={ui.filterStateInvestorLabel}
          stateInvestorAllLabel={ui.filterStateInvestorAll}
          stateInvestorOptions={stateInvestorEnterprises}
          selectedStateInvestor={selectedStateInvestor}
          onStateInvestorChange={setSelectedStateInvestor}
          enterpriseLabel={ui.filterEnterpriseLabel}
          enterprisePlaceholder={ui.filterEnterprisePlaceholder}
          enterpriseKeyword={enterpriseKeyword}
          onEnterpriseKeywordChange={setEnterpriseKeyword}
          resetLabel={ui.filterReset}
          canReset={canReset}
          onReset={resetFilters}
        />
        <div className="-mt-1 mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-light pb-3 text-il-meta text-text-3">
          <span className="min-w-0 max-w-[720px] leading-relaxed">{ui.tableHint}</span>
          <span className="whitespace-nowrap">
            <span className="text-text-3">{ui.recordCountLabel}</span>
            <span className="ml-1 font-semibold tabular-nums text-text">{filteredRows.length}</span>
          </span>
        </div>
        {exportError ? <div className="mb-2 text-il-meta text-[#c2410c]">{exportError}</div> : null}
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1120px] border-separate border-spacing-0 text-il-page-desc">
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th scope="col" className={`${thCorner} px-3 py-2 pl-3 font-medium`}>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 select-none text-left font-medium text-text-3 hover:text-text-2"
                    onClick={() => toggleSort('name')}
                  >
                    {ui.colName}
                    {sortKey === 'name' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 select-none font-medium text-text-3 hover:text-text-2"
                    onClick={() => toggleSort('snapshotYear')}
                  >
                    {ui.colSnapshotYear}
                    {sortKey === 'snapshotYear' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} px-3 py-2 font-medium`}>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 select-none font-medium text-text-3 hover:text-text-2"
                    onClick={() => toggleSort('mgmtPath')}
                  >
                    {ui.colMgmtPath}
                    {sortKey === 'mgmtPath' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} px-3 py-2 font-medium`}>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 select-none font-medium text-text-3 hover:text-text-2"
                    onClick={() => toggleSort('equityPath')}
                  >
                    {ui.colEquityPath}
                    {sortKey === 'equityPath' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
                <th scope="col" className={`${thStickyTop} whitespace-nowrap px-3 py-2 font-medium`}>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 select-none font-medium text-text-3 hover:text-text-2"
                    onClick={() => toggleSort('relationType')}
                  >
                    {ui.colRelationType}
                    {sortKey === 'relationType' ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {displayRows.map((row) => (
                <tr key={`${row.name}-${row.snapshotYear}`} className="group">
                  <td className={`${tdStickyLeft} px-3 py-2.5 font-medium text-text`}>{row.name}</td>
                  <td className="border-b border-border-light px-3 py-2.5 tabular-nums group-hover:bg-[#f8fafc]">
                    {row.snapshotYear}
                  </td>
                  <td
                    className={`${pathCellCls} border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]`}
                    title={row.mgmtPath}
                  >
                    {row.mgmtPath}
                  </td>
                  <td
                    className={`${pathCellCls} border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]`}
                    title={row.equityPath}
                  >
                    {row.equityPath}
                  </td>
                  <td className="border-b border-border-light px-3 py-2.5 group-hover:bg-[#f8fafc]">
                    <span className={relationTypeClass(row.relationType)}>{row.relationType}</span>
                  </td>
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td className="border-b border-border-light px-3 py-6 text-center text-text-3" colSpan={5}>
                    {emptyMessage}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
