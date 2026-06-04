import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchAuditedEnterpriseRegistry,
  postAuditedEnterpriseRegistryBootstrapDemo,
  postAuditedEnterpriseRegistryRow,
  type AuditedEnterpriseRegistryRow,
} from '../config/localApi'

type StateCapitalStatus = 'state_owned' | 'non_state_owned' | 'unmaintained'

type LedgerGroupMode = 'flat' | 'stateInvestor' | 'mgmtParent'

type LedgerTableSegment =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'row'; row: AuditedEnterpriseRegistryRow; seqNo: number }

const TABLE_COL_COUNT = 21
const thSticky =
  'sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]'

function cellOrDash(value: string): string {
  return value.trim() ? value : '—'
}

function groupKeyStateInvestor(row: AuditedEnterpriseRegistryRow): string {
  return row.stateInvestor.trim() || '__unnamed__'
}

function groupKeyMgmtParent(row: AuditedEnterpriseRegistryRow): string {
  return row.mgmtParent.trim() || '__unnamed__'
}

function buildLedgerTableSegments(
  rows: AuditedEnterpriseRegistryRow[],
  groupMode: LedgerGroupMode,
  ui: (typeof t)['auditedEnterpriseLedgerUi'],
  seqOffset = 0,
): LedgerTableSegment[] {
  if (groupMode === 'flat') {
    return rows.map((row, index) => ({ kind: 'row', row, seqNo: seqOffset + index + 1 }))
  }

  const keyFn = groupMode === 'stateInvestor' ? groupKeyStateInvestor : groupKeyMgmtParent
  const labelFn =
    groupMode === 'stateInvestor'
      ? (row: AuditedEnterpriseRegistryRow) => row.stateInvestor.trim() || ui.groupHeaderUnnamed
      : (row: AuditedEnterpriseRegistryRow) => row.mgmtParent.trim() || ui.groupHeaderUnnamed

  const buckets = new Map<string, { label: string; rows: AuditedEnterpriseRegistryRow[] }>()
  for (const row of rows) {
    const key = keyFn(row)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.rows.push(row)
      continue
    }
    buckets.set(key, { label: labelFn(row), rows: [row] })
  }

  const segments: LedgerTableSegment[] = []
  let seqNo = seqOffset
  for (const [key, bucket] of buckets) {
    const count = bucket.rows.length
    const headerTemplate =
      groupMode === 'stateInvestor' ? ui.groupHeaderStateInvestor : ui.groupHeaderMgmtParent
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

function renderLedgerRow(row: AuditedEnterpriseRegistryRow, seqNo: number, ui: (typeof t)['auditedEnterpriseLedgerUi']) {
  return (
    <tr key={`${row.code}-${row.snapshotYear}-${seqNo}`} className="border-b border-border-light last:border-b-0">
      <td className="px-3 py-2.5 tabular-nums text-text-3">{seqNo}</td>
      <td className="px-3 py-2.5 tabular-nums">{row.snapshotYear}</td>
      <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.code}</td>
      <td className="px-3 py-2.5 font-medium text-text">{row.name}</td>
      <td className="px-3 py-2.5">{row.domesticOverseas}</td>
      <td className="px-3 py-2.5 max-w-[220px]">{row.detailAddress}</td>
      <td className="px-3 py-2.5">{row.currency}</td>
      <td className="px-3 py-2.5 tabular-nums">{row.registeredCapital}</td>
      <td className="px-3 py-2.5 tabular-nums">{row.registrationDate}</td>
      <td className="px-3 py-2.5 max-w-[220px]">{row.nationalEconomyIndustryMajor}</td>
      <td className="px-3 py-2.5 max-w-[240px]">{row.enterpriseCategory}</td>
      <td className="px-3 py-2.5">{row.stateInvestor.trim() || ui.stateStatusUnmaintained}</td>
      <td className="px-3 py-2.5 max-w-[200px]">{cellOrDash(row.sasacAuthority)}</td>
      <td className="px-3 py-2.5 max-w-[180px]">{cellOrDash(row.sasacRelation)}</td>
      <td className="px-3 py-2.5">{row.consolidatedReporting}</td>
      <td className="px-3 py-2.5">{row.listedCompany}</td>
      <td className="px-3 py-2.5">{row.mainBusiness}</td>
      <td className="px-3 py-2.5">{row.mgmtLevel}</td>
      <td className="px-3 py-2.5">{row.mgmtParent.trim() ? row.mgmtParent : '—'}</td>
      <td className="px-3 py-2.5">{row.equityLevel}</td>
      <td className="px-3 py-2.5">{row.shareholders}</td>
    </tr>
  )
}

export function AuditedEnterpriseLedgerPage() {
  const ui = t.auditedEnterpriseLedgerUi
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [stateCapitalStatus, setStateCapitalStatus] = useState<StateCapitalStatus>('state_owned')
  const [mgmtParent, setMgmtParent] = useState('')
  const [stateInvestorName, setStateInvestorName] = useState('山东XX能源集团有限公司')
  const [equityParentName, setEquityParentName] = useState('')
  const [equityParentRatio, setEquityParentRatio] = useState('')
  const [createSnapshotYear, setCreateSnapshotYear] = useState('2026')
  const [createCode, setCreateCode] = useState('')
  const [createName, setCreateName] = useState('')
  const [createDomesticOverseas, setCreateDomesticOverseas] = useState('境内')
  const [createDetailAddress, setCreateDetailAddress] = useState('')
  const [createCurrency, setCreateCurrency] = useState('')
  const [createRegisteredCapital, setCreateRegisteredCapital] = useState('')
  const [createRegistrationDate, setCreateRegistrationDate] = useState('')
  const [createNationalEconomyIndustryMajor, setCreateNationalEconomyIndustryMajor] = useState('')
  const [createEnterpriseCategory, setCreateEnterpriseCategory] = useState('')
  const [createSasacAuthority, setCreateSasacAuthority] = useState('')
  const [createSasacRelation, setCreateSasacRelation] = useState('')
  const [createConsolidatedReporting, setCreateConsolidatedReporting] = useState('')
  const [createListedCompany, setCreateListedCompany] = useState('')
  const [createMainBusiness, setCreateMainBusiness] = useState('')
  const [createMgmtLevel, setCreateMgmtLevel] = useState('1')
  const [createEquityLevel, setCreateEquityLevel] = useState('1')

  const [snapshotYears, setSnapshotYears] = useState<string[]>(['2026'])
  const [selectedYear, setSelectedYear] = useState('2026')
  const [stateInvestorFilter, setStateInvestorFilter] = useState('')
  const [enterpriseFilter, setEnterpriseFilter] = useState('')
  const [groupMode, setGroupMode] = useState<LedgerGroupMode>('stateInvestor')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [rows, setRows] = useState<AuditedEnterpriseRegistryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [importBanner, setImportBanner] = useState('')
  const [importBusy, setImportBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchAuditedEnterpriseRegistry({
      snapshotYear: selectedYear,
      stateInvestor: stateInvestorFilter,
      enterprise: enterpriseFilter,
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
  }, [enterpriseFilter, selectedYear, stateInvestorFilter, ui.loadFailed])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [enterpriseFilter, groupMode, selectedYear, stateInvestorFilter])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(rows.length / pageSize)), [pageSize, rows.length])
  const effectivePage = Math.min(page, totalPages)

  useEffect(() => {
    if (page !== effectivePage) setPage(effectivePage)
  }, [effectivePage, page])

  const pagedRows = useMemo(() => {
    const offset = (effectivePage - 1) * pageSize
    return rows.slice(offset, offset + pageSize)
  }, [effectivePage, pageSize, rows])

  const summary = useMemo(
    () => ({
      total: rows.length,
      listedCompany: rows.filter((r) => r.listedCompany.trim() === '是').length,
      overseas: rows.filter((r) => r.domesticOverseas.includes('境外')).length,
      mgmtParentMaintained: rows.filter((r) => r.mgmtParent.trim() !== '').length,
      equityParentMaintained: rows.filter((r) => {
        const s = r.shareholders.trim()
        return Boolean(s) && s !== '待维护'
      }).length,
      mainBusinessMaintained: rows.filter((r) => r.mainBusiness.trim() !== '').length,
    }),
    [rows],
  )

  const tableSegments = useMemo(
    () => buildLedgerTableSegments(pagedRows, groupMode, ui, (effectivePage - 1) * pageSize),
    [effectivePage, groupMode, pageSize, pagedRows, ui],
  )

  const openCreate = () => {
    setCreateSnapshotYear(selectedYear)
    setCreateCode('')
    setCreateName('')
    setCreateDomesticOverseas('境内')
    setCreateDetailAddress('')
    setCreateCurrency('')
    setCreateRegisteredCapital('')
    setCreateRegistrationDate('')
    setCreateNationalEconomyIndustryMajor('')
    setCreateEnterpriseCategory('')
    setCreateSasacAuthority('')
    setCreateSasacRelation('')
    setCreateConsolidatedReporting('')
    setCreateListedCompany('')
    setCreateMainBusiness('')
    setCreateMgmtLevel('1')
    setMgmtParent('')
    setCreateEquityLevel('1')
    setStateCapitalStatus('state_owned')
    setStateInvestorName('山东XX能源集团有限公司')
    setEquityParentName('')
    setEquityParentRatio('')
    setSaveError('')
    setShowCreateModal(true)
  }

  const submitCreate = async () => {
    setSaveError('')
    const body: Record<string, unknown> = {
      snapshotYear: createSnapshotYear.trim(),
      code: createCode.trim(),
      name: createName.trim(),
      domesticOverseas: createDomesticOverseas.trim(),
      detailAddress: createDetailAddress.trim(),
      currency: createCurrency.trim(),
      registeredCapital: createRegisteredCapital.trim(),
      registrationDate: createRegistrationDate.trim(),
      nationalEconomyIndustryMajor: createNationalEconomyIndustryMajor.trim(),
      enterpriseCategory: createEnterpriseCategory.trim(),
      stateCapitalStatus,
      stateInvestor: stateInvestorName.trim(),
      sasacAuthority: createSasacAuthority.trim(),
      sasacRelation: createSasacRelation.trim(),
      consolidatedReporting: createConsolidatedReporting.trim(),
      listedCompany: createListedCompany.trim(),
      mainBusiness: createMainBusiness.trim(),
      mgmtLevel: Number.parseInt(createMgmtLevel.trim(), 10) || 1,
      mgmtParent: mgmtParent.trim(),
      equityLevel: Number.parseInt(createEquityLevel.trim(), 10) || 1,
      equityParentName: equityParentName.trim(),
      equityParentRatio: equityParentRatio.trim(),
    }
    const res = await postAuditedEnterpriseRegistryRow(body)
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
    const res = await postAuditedEnterpriseRegistryBootstrapDemo()
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

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: ui.kpiTotal, value: summary.total },
          { label: ui.kpiListedCompany, value: summary.listedCompany },
          { label: ui.kpiOverseasEnterprises, value: summary.overseas },
          { label: ui.kpiMgmtParentMaintained, value: summary.mgmtParentMaintained },
          { label: ui.kpiEquityParentMaintained, value: summary.equityParentMaintained },
          { label: ui.kpiMainBusinessMaintained, value: summary.mainBusinessMaintained },
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
              onChange={(e) => setGroupMode(e.target.value as LedgerGroupMode)}
            >
              <option value="flat">{ui.groupModeFlat}</option>
              <option value="stateInvestor">{ui.groupModeStateInvestor}</option>
              <option value="mgmtParent">{ui.groupModeMgmtParent}</option>
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
            {ui.stateInvestorFilterLabel}
            <input
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={stateInvestorFilter}
              onChange={(e) => setStateInvestorFilter(e.target.value)}
              placeholder={ui.stateInvestorFilterPlaceholder}
            />
          </label>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.enterpriseFilterLabel}
            <input
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={enterpriseFilter}
              onChange={(e) => setEnterpriseFilter(e.target.value)}
              placeholder={ui.enterpriseFilterPlaceholder}
            />
          </label>
        </div>
        <div className="max-h-[min(calc(100vh-22rem),640px)] min-h-[240px] overflow-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[2940px] border-separate border-spacing-0 text-il-page-desc">
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th className={`${thSticky} w-[52px]`}>{ui.colSeqNo}</th>
                <th className={thSticky}>{ui.colSnapshotYear}</th>
                <th className={thSticky}>{ui.colCode}</th>
                <th className={thSticky}>{ui.colName}</th>
                <th className={thSticky}>{ui.colDomesticOverseas}</th>
                <th className={thSticky}>{ui.colDetailAddress}</th>
                <th className={thSticky}>{ui.colCurrency}</th>
                <th className={thSticky}>{ui.colRegisteredCapital}</th>
                <th className={thSticky}>{ui.colRegistrationDate}</th>
                <th className={thSticky}>{ui.colNationalEconomyIndustryMajor}</th>
                <th className={thSticky}>{ui.colEnterpriseCategory}</th>
                <th className={thSticky}>{ui.colStateInvestor}</th>
                <th className={thSticky}>{ui.colSasacAuthority}</th>
                <th className={thSticky}>{ui.colSasacRelation}</th>
                <th className={thSticky}>{ui.colConsolidatedReporting}</th>
                <th className={thSticky}>{ui.colListedCompany}</th>
                <th className={thSticky}>{ui.colMainBusiness}</th>
                <th className={thSticky}>{ui.colMgmtLevel}</th>
                <th className={thSticky}>{ui.colMgmtParent}</th>
                <th className={thSticky}>{ui.colEquityLevel}</th>
                <th className={thSticky}>{ui.colShareholders}</th>
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
                  return renderLedgerRow(segment.row, segment.seqNo, ui)
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
                  {ui.colCode}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createCode}
                    onChange={(e) => setCreateCode(e.target.value)}
                    placeholder={ui.codeInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colName}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder={ui.nameInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colDomesticOverseas}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createDomesticOverseas}
                    onChange={(e) => setCreateDomesticOverseas(e.target.value)}
                    placeholder={ui.domesticOverseasInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colCurrency}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createCurrency}
                    onChange={(e) => setCreateCurrency(e.target.value)}
                    placeholder={ui.currencyInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colDetailAddress}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createDetailAddress}
                    onChange={(e) => setCreateDetailAddress(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colRegisteredCapital}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createRegisteredCapital}
                    onChange={(e) => setCreateRegisteredCapital(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colRegistrationDate}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createRegistrationDate}
                    onChange={(e) => setCreateRegistrationDate(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colNationalEconomyIndustryMajor}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createNationalEconomyIndustryMajor}
                    onChange={(e) => setCreateNationalEconomyIndustryMajor(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colEnterpriseCategory}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createEnterpriseCategory}
                    onChange={(e) => setCreateEnterpriseCategory(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colStateInvestor}
                  <div className="mt-1 grid gap-2 md:grid-cols-[140px_1fr]">
                    <select
                      className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                      value={stateCapitalStatus}
                      onChange={(e) => {
                        const next = e.target.value as StateCapitalStatus
                        setStateCapitalStatus(next)
                        if (next !== 'state_owned') setStateInvestorName('')
                      }}
                    >
                      <option value="state_owned">{ui.stateStatusStateOwned}</option>
                      <option value="non_state_owned">{ui.stateStatusNonStateOwned}</option>
                      <option value="unmaintained">{ui.stateStatusUnmaintained}</option>
                    </select>
                    <input
                      className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none disabled:bg-[#f6f8fb] disabled:text-text-3 focus:border-accent"
                      value={stateInvestorName}
                      onChange={(e) => setStateInvestorName(e.target.value)}
                      placeholder={ui.stateInvestorInputPlaceholder}
                      disabled={stateCapitalStatus !== 'state_owned'}
                    />
                  </div>
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colSasacAuthority}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createSasacAuthority}
                    onChange={(e) => setCreateSasacAuthority(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colSasacRelation}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createSasacRelation}
                    onChange={(e) => setCreateSasacRelation(e.target.value)}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colConsolidatedReporting}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createConsolidatedReporting}
                    onChange={(e) => setCreateConsolidatedReporting(e.target.value)}
                    placeholder={ui.yesNoInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colListedCompany}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createListedCompany}
                    onChange={(e) => setCreateListedCompany(e.target.value)}
                    placeholder={ui.yesNoInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colMainBusiness}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createMainBusiness}
                    onChange={(e) => setCreateMainBusiness(e.target.value)}
                    placeholder={ui.mainBusinessInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colMgmtLevel}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createMgmtLevel}
                    onChange={(e) => setCreateMgmtLevel(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colMgmtParent}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={mgmtParent}
                    onChange={(e) => setMgmtParent(e.target.value)}
                    placeholder={ui.mgmtParentInputPlaceholder}
                  />
                </label>
                <label className="text-il-label text-text-2">
                  {ui.colEquityLevel}
                  <input
                    className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={createEquityLevel}
                    onChange={(e) => setCreateEquityLevel(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
                <label className="text-il-label text-text-2 md:col-span-2">
                  {ui.colShareholders}
                  <div className="mt-1 grid gap-2 md:grid-cols-[1fr_140px]">
                    <input
                      className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                      value={equityParentName}
                      onChange={(e) => setEquityParentName(e.target.value)}
                      placeholder={ui.equityParentNamePlaceholder}
                    />
                    <input
                      className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                      value={equityParentRatio}
                      onChange={(e) => setEquityParentRatio(e.target.value)}
                      placeholder={ui.equityParentRatioPlaceholder}
                    />
                  </div>
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
