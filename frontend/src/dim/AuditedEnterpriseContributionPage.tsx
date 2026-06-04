import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchAuditedEnterpriseContribution,
  postAuditedEnterpriseContributionBootstrapDemo,
  postAuditedEnterpriseContributionRow,
  type AuditedEnterpriseContributionRow,
} from '../config/localApi'

function cellOrDash(value: string): string {
  return value.trim() ? value : '—'
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`
}

type ContributionGroupMode = 'flat' | 'investee' | 'stateInvestor'

type ContributionTableSegment =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'row'; row: AuditedEnterpriseContributionRow; seqNo: number }

const TABLE_COL_COUNT = 14
const thSticky =
  'sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]'

function groupKeyInvestee(row: AuditedEnterpriseContributionRow): string {
  const code = row.unifiedCreditCode.trim()
  const name = row.investeeName.trim()
  return code || name || '__unnamed__'
}

function groupKeyStateInvestor(row: AuditedEnterpriseContributionRow): string {
  return row.stateInvestorEnterprise.trim() || '__unnamed__'
}

function buildContributionTableSegments(
  rows: AuditedEnterpriseContributionRow[],
  groupMode: ContributionGroupMode,
  ui: (typeof t)['auditedEnterpriseContributionUi'],
  seqOffset = 0,
): ContributionTableSegment[] {
  if (groupMode === 'flat') {
    return rows.map((row, index) => ({ kind: 'row', row, seqNo: seqOffset + index + 1 }))
  }

  const keyFn = groupMode === 'investee' ? groupKeyInvestee : groupKeyStateInvestor
  const labelFn =
    groupMode === 'investee'
      ? (row: AuditedEnterpriseContributionRow) => {
          const name = row.investeeName.trim() || ui.groupHeaderUnnamed
          const code = row.unifiedCreditCode.trim()
          return code ? `${name}（${code}）` : name
        }
      : (row: AuditedEnterpriseContributionRow) => row.stateInvestorEnterprise.trim() || ui.groupHeaderUnnamed

  const buckets = new Map<string, { label: string; rows: AuditedEnterpriseContributionRow[] }>()
  for (const row of rows) {
    const key = keyFn(row)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.rows.push(row)
      continue
    }
    buckets.set(key, { label: labelFn(row), rows: [row] })
  }

  const segments: ContributionTableSegment[] = []
  let seqNo = seqOffset
  for (const [key, bucket] of buckets) {
    const count = bucket.rows.length
    const headerTemplate = groupMode === 'investee' ? ui.groupHeaderInvestee : ui.groupHeaderStateInvestor
    segments.push({
      kind: 'group',
      key,
      label: headerTemplate.replace('{name}', bucket.label).replace('{count}', String(count)),
    })
    for (const row of bucket.rows) {
      seqNo += 1
      segments.push({ kind: 'row', row, seqNo })
    }
  }
  return segments
}

export function AuditedEnterpriseContributionPage() {
  const ui = t.auditedEnterpriseContributionUi
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [snapshotYears, setSnapshotYears] = useState<string[]>(['2026'])
  const [selectedYear, setSelectedYear] = useState('2026')
  const [investeeFilter, setInvesteeFilter] = useState('')
  const [groupMode, setGroupMode] = useState<ContributionGroupMode>('investee')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [rows, setRows] = useState<AuditedEnterpriseContributionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [importBanner, setImportBanner] = useState('')
  const [importBusy, setImportBusy] = useState(false)

  const [createSnapshotYear, setCreateSnapshotYear] = useState('2026')
  const [createUnifiedCreditCode, setCreateUnifiedCreditCode] = useState('')
  const [createInvesteeName, setCreateInvesteeName] = useState('')
  const [createStateInvestorEnterprise, setCreateStateInvestorEnterprise] = useState('')
  const [createStateInvestorUnifiedCreditCode, setCreateStateInvestorUnifiedCreditCode] = useState('')
  const [createContributorName, setCreateContributorName] = useState('')
  const [createContributorOrgCode, setCreateContributorOrgCode] = useState('')
  const [createContributorCategory, setCreateContributorCategory] = useState('')
  const [createContributionInfo, setCreateContributionInfo] = useState('')
  const [createRelationToTarget, setCreateRelationToTarget] = useState('')
  const [createCurrency, setCreateCurrency] = useState('人民币')
  const [createSubscribedAmountWan, setCreateSubscribedAmountWan] = useState('')
  const [createShareRatio, setCreateShareRatio] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchAuditedEnterpriseContribution({
      snapshotYear: selectedYear,
      keyword: investeeFilter,
    })
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.loadFailed)
      setRows([])
      setLoading(false)
      return
    }
    const years = res.snapshot_years?.length ? res.snapshot_years : ['2026']
    setSnapshotYears(years)
    if (!years.includes(selectedYear)) {
      setSelectedYear(res.selected_year ?? years[0])
    }
    setRows(res.rows ?? [])
    setLoading(false)
  }, [investeeFilter, selectedYear, ui.loadFailed])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [groupMode, investeeFilter, selectedYear])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(rows.length / pageSize)), [pageSize, rows.length])
  const effectivePage = Math.min(page, totalPages)

  useEffect(() => {
    if (page !== effectivePage) setPage(effectivePage)
  }, [effectivePage, page])

  const pagedRows = useMemo(() => {
    const offset = (effectivePage - 1) * pageSize
    return rows.slice(offset, offset + pageSize)
  }, [effectivePage, pageSize, rows])

  const summary = useMemo(() => {
    const investees = new Set(rows.map((r) => r.investeeName.trim()).filter(Boolean))
    const contributors = new Set(rows.map((r) => r.contributorName.trim()).filter(Boolean))
    return {
      relationRows: rows.length,
      investees: investees.size,
      contributors: contributors.size,
    }
  }, [rows])

  const tableSegments = useMemo(
    () => buildContributionTableSegments(pagedRows, groupMode, ui, (effectivePage - 1) * pageSize),
    [effectivePage, groupMode, pageSize, pagedRows, ui],
  )

  const openCreate = () => {
    setCreateSnapshotYear(selectedYear)
    setCreateUnifiedCreditCode('')
    setCreateInvesteeName('')
    setCreateStateInvestorEnterprise('')
    setCreateStateInvestorUnifiedCreditCode('')
    setCreateContributorName('')
    setCreateContributorOrgCode('')
    setCreateContributorCategory('')
    setCreateContributionInfo('')
    setCreateRelationToTarget('')
    setCreateCurrency('人民币')
    setCreateSubscribedAmountWan('')
    setCreateShareRatio('')
    setSaveError('')
    setShowCreateModal(true)
  }

  const submitCreate = async () => {
    setSaveError('')
    const body: Record<string, unknown> = {
      snapshotYear: createSnapshotYear.trim(),
      unifiedCreditCode: createUnifiedCreditCode.trim(),
      investeeName: createInvesteeName.trim(),
      stateInvestorEnterprise: createStateInvestorEnterprise.trim(),
      stateInvestorUnifiedCreditCode: createStateInvestorUnifiedCreditCode.trim(),
      contributorName: createContributorName.trim(),
      contributorOrgCode: createContributorOrgCode.trim(),
      contributorCategory: createContributorCategory.trim(),
      contributionInfo: createContributionInfo.trim(),
      relationToTarget: createRelationToTarget.trim(),
      currency: createCurrency.trim() || '人民币',
      subscribedAmountWan: Number.parseFloat(createSubscribedAmountWan.trim()) || 0,
      shareRatio: Number.parseFloat(createShareRatio.trim()) || 0,
    }
    const res = await postAuditedEnterpriseContributionRow(body)
    if (!res.ok) {
      setSaveError(res.error?.message ?? ui.saveFailed)
      return
    }
    setShowCreateModal(false)
    await load()
  }

  const runBootstrapDemo = async () => {
    setImportBusy(true)
    setImportBanner('')
    const res = await postAuditedEnterpriseContributionBootstrapDemo()
    setImportBusy(false)
    if (!res.ok) {
      setImportBanner(ui.bootstrapDemoFail + (res.error?.message ? `：${res.error.message}` : ''))
      return
    }
    setImportBanner(ui.bootstrapDemoOk)
    await load()
  }

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => setShowImportModal(true)}
            >
              {ui.importBtn}
            </button>
            <button
              type="button"
              className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90"
              onClick={openCreate}
            >
              {ui.createBtn}
            </button>
          </div>
        </div>
        <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
        <p className="mt-2 text-il-meta text-text-3">{ui.pageNote}</p>
        {loadError ? <p className="mt-2 text-il-meta text-red-600">{loadError}</p> : null}
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: ui.kpiRelationRows, value: summary.relationRows },
          { label: ui.kpiInvestees, value: summary.investees },
          { label: ui.kpiContributors, value: summary.contributors },
        ].map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className="mt-1 text-[20px] font-bold tabular-nums text-text">{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.tableTitle}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="text-il-meta text-text-3">
            {loading
              ? '…'
              : ui.tableHint.replace('{year}', selectedYear).replace('{count}', String(rows.length))}
          </div>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.groupModeLabel}
            <select
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={groupMode}
              onChange={(e) => setGroupMode(e.target.value as ContributionGroupMode)}
            >
              <option value="flat">{ui.groupModeFlat}</option>
              <option value="investee">{ui.groupModeInvestee}</option>
              <option value="stateInvestor">{ui.groupModeStateInvestor}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.snapshotFilterLabel}
            <select
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
            >
              {snapshotYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.investeeFilterLabel}
            <input
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={investeeFilter}
              onChange={(e) => setInvesteeFilter(e.target.value)}
              placeholder={ui.investeeFilterPlaceholder}
            />
          </label>
        </div>
        <div className="max-h-[min(calc(100vh-22rem),640px)] min-h-[240px] overflow-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1960px] border-separate border-spacing-0 text-il-page-desc">
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th className={`${thSticky} w-[52px]`}>{ui.colSeqNo}</th>
                <th className={thSticky}>{ui.colSnapshotYear}</th>
                <th className={thSticky}>{ui.colUnifiedCreditCode}</th>
                <th className={thSticky}>{ui.colInvesteeName}</th>
                <th className={thSticky}>{ui.colStateInvestorEnterprise}</th>
                <th className={thSticky}>{ui.colStateInvestorUnifiedCreditCode}</th>
                <th className={thSticky}>{ui.colContributorName}</th>
                <th className={thSticky}>{ui.colContributorOrgCode}</th>
                <th className={thSticky}>{ui.colContributorCategory}</th>
                <th className={thSticky}>{ui.colContributionInfo}</th>
                <th className={thSticky}>{ui.colRelationToTarget}</th>
                <th className={thSticky}>{ui.colCurrency}</th>
                <th className={thSticky}>{ui.colSubscribedAmount}</th>
                <th className={thSticky}>{ui.colShareRatio}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={TABLE_COL_COUNT} className="px-3 py-8 text-center text-il-page-desc text-text-3">
                    {ui.tableEmpty}
                  </td>
                </tr>
              ) : (
                tableSegments.map((segment) => {
                  if (segment.kind === 'group') {
                    return (
                      <tr key={`group-${segment.key}`} className="border-b border-border-light bg-[#f0f4fa]">
                        <td colSpan={TABLE_COL_COUNT} className="px-3 py-2 text-il-label font-medium text-text">
                          {segment.label}
                        </td>
                      </tr>
                    )
                  }
                  const row = segment.row
                  return (
                    <tr
                      key={row.rowId || `${row.unifiedCreditCode}-${row.contributorName}-${segment.seqNo}`}
                      className="border-b border-border-light last:border-b-0"
                    >
                      <td className="px-3 py-2.5 tabular-nums text-text-3">{segment.seqNo}</td>
                      <td className="px-3 py-2.5 tabular-nums">{row.snapshotYear}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-text">{cellOrDash(row.unifiedCreditCode)}</td>
                      <td className="px-3 py-2.5 font-medium text-text">{row.investeeName}</td>
                      <td className="px-3 py-2.5">{cellOrDash(row.stateInvestorEnterprise)}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px]">{cellOrDash(row.stateInvestorUnifiedCreditCode)}</td>
                      <td className="px-3 py-2.5">{row.contributorName}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px]">{cellOrDash(row.contributorOrgCode)}</td>
                      <td className="px-3 py-2.5">{cellOrDash(row.contributorCategory)}</td>
                      <td className="px-3 py-2.5 max-w-[200px]">{cellOrDash(row.contributionInfo)}</td>
                      <td className="px-3 py-2.5">{cellOrDash(row.relationToTarget)}</td>
                      <td className="px-3 py-2.5">{row.currency || '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums">{formatAmount(row.subscribedAmountWan)}</td>
                      <td className="px-3 py-2.5 tabular-nums">{formatRatio(row.shareRatio)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-2">
            <div className="text-il-meta text-text-3">
              {ui.tablePagedTotalHint.replace('{total}', String(rows.length))}
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
                    setPage(1)
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
                disabled={loading || effectivePage <= 1}
                className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {ui.tablePagePrev}
              </button>
              <span className="tabular-nums text-il-meta text-text-3">
                {ui.tablePageOf
                  .replace('{page}', String(effectivePage))
                  .replace('{pages}', String(totalPages))}
              </span>
              <button
                type="button"
                disabled={loading || effectivePage >= totalPages}
                className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {ui.tablePageNext}
              </button>
            </div>
          </div>
        ) : null}
      </Card>

      {showCreateModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="w-full max-w-[760px] rounded-[12px] border border-border-light bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-text">{ui.createModalTitle}</h3>
              <button type="button" className="text-il-page-desc text-text-3 hover:text-text" onClick={() => setShowCreateModal(false)}>
                {ui.modalClose}
              </button>
            </div>
            {saveError ? <p className="mb-2 text-il-meta text-red-600">{saveError}</p> : null}
            <div className="max-h-[min(72vh,640px)] overflow-y-auto pr-1">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-il-label text-text-2">
                  {ui.colSnapshotYear}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createSnapshotYear}
                    onChange={(e) => setCreateSnapshotYear(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colUnifiedCreditCode}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createUnifiedCreditCode}
                    onChange={(e) => setCreateUnifiedCreditCode(e.target.value)}
                    placeholder={ui.unifiedCreditCodePlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colInvesteeName}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createInvesteeName}
                    onChange={(e) => setCreateInvesteeName(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colStateInvestorEnterprise}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createStateInvestorEnterprise}
                    onChange={(e) => setCreateStateInvestorEnterprise(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colStateInvestorUnifiedCreditCode}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createStateInvestorUnifiedCreditCode}
                    onChange={(e) => setCreateStateInvestorUnifiedCreditCode(e.target.value)}
                    placeholder={ui.unifiedCreditCodePlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colContributorName}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createContributorName}
                    onChange={(e) => setCreateContributorName(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colContributorOrgCode}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createContributorOrgCode}
                    onChange={(e) => setCreateContributorOrgCode(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colContributorCategory}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createContributorCategory}
                    onChange={(e) => setCreateContributorCategory(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colContributionInfo}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createContributionInfo}
                    onChange={(e) => setCreateContributionInfo(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colRelationToTarget}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createRelationToTarget}
                    onChange={(e) => setCreateRelationToTarget(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colCurrency}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createCurrency}
                    onChange={(e) => setCreateCurrency(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colSubscribedAmount}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createSubscribedAmountWan}
                    onChange={(e) => setCreateSubscribedAmountWan(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colShareRatio}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createShareRatio}
                    onChange={(e) => setCreateShareRatio(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
              </div>
            </div>
            <div className="mt-3 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">{ui.createModalHint}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={() => setShowCreateModal(false)}
              >
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90"
                onClick={() => void submitCreate()}
              >
                {ui.modalSubmit}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showImportModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="w-full max-w-[640px] rounded-[12px] border border-border-light bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-text">{ui.importModalTitle}</h3>
              <button type="button" className="text-il-page-desc text-text-3 hover:text-text" onClick={() => setShowImportModal(false)}>
                {ui.modalClose}
              </button>
            </div>
            <div className="rounded-sm border border-dashed border-[#9fc5f5] bg-[#f8fbff] px-4 py-6 text-center">
              <div className="text-il-page-desc font-medium text-text">{ui.importDropTitle}</div>
              <div className="mt-1 text-il-meta text-text-3">{ui.importDropHint}</div>
              <button type="button" className="mt-3 rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent">
                {ui.importPickFile}
              </button>
              <div className="mt-4">
                <button
                  type="button"
                  disabled={importBusy}
                  className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  onClick={() => void runBootstrapDemo()}
                >
                  {importBusy ? '…' : ui.bootstrapDemoBtn}
                </button>
              </div>
              {importBanner ? <p className="mt-3 text-il-meta text-text-2">{importBanner}</p> : null}
            </div>
            <div className="mt-3 rounded-sm border border-[#fff1c7] bg-[#fffaf0] px-3 py-2 text-il-meta text-[#946200]">{ui.importModalTip}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={() => setShowImportModal(false)}
              >
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90"
                onClick={() => setShowImportModal(false)}
              >
                {ui.importConfirmBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
