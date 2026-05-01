import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'

type StateCapitalStatus = 'state_owned' | 'non_state_owned' | 'unmaintained'

function inferStateCapitalStatus(stateInvestor: string): StateCapitalStatus {
  const v = stateInvestor.trim()
  if (!v) return 'unmaintained'
  if (v === '非国资') return 'non_state_owned'
  return 'state_owned'
}

const seedRows = [
  {
    code: '91370000123456789A',
    name: '山东XX能源集团有限公司',
    mainBusiness: '能源投资与产业运营',
    mgmtLevel: 1,
    equityLevel: 1,
    stateInvestor: '山东XX能源集团有限公司',
    shareholders: '山东省国资委(100%)',
    snapshotYear: '2026',
  },
  {
    code: '91370200111222333B',
    name: '青岛XX工程建设有限公司',
    mainBusiness: '工程建设与运维',
    mgmtLevel: 2,
    equityLevel: 3,
    stateInvestor: '山东XX能源集团有限公司',
    shareholders: '山东XX建设投资控股有限公司(60%)；员工持股平台(40%)',
    snapshotYear: '2026',
  },
  {
    code: '91370100999888777C',
    name: '济南XX贸易有限公司',
    mainBusiness: '大宗贸易',
    mgmtLevel: 3,
    equityLevel: 2,
    stateInvestor: '非国资',
    shareholders: '社会资本A(55%)；社会资本B(45%)',
    snapshotYear: '2026',
  },
  {
    code: '91371300123410000F',
    name: '临沂XX新材料有限公司',
    mainBusiness: '新材料研发与加工',
    mgmtLevel: 2,
    equityLevel: 2,
    stateInvestor: '',
    shareholders: '待维护',
    snapshotYear: '2026',
  },
  {
    code: '91370000123456789A',
    name: '山东XX能源集团有限公司',
    mainBusiness: '能源投资与产业运营',
    mgmtLevel: 1,
    equityLevel: 1,
    stateInvestor: '山东XX能源集团有限公司',
    shareholders: '山东省国资委(100%)',
    snapshotYear: '2025',
  },
  {
    code: '91370200111222333B',
    name: '青岛XX工程建设有限公司',
    mainBusiness: '工程建设与运维',
    mgmtLevel: 2,
    equityLevel: 2,
    stateInvestor: '山东XX能源集团有限公司',
    shareholders: '山东XX建设投资控股有限公司(80%)；员工持股平台(20%)',
    snapshotYear: '2025',
  },
  {
    code: '91370600101010101D',
    name: '烟台XX物流有限公司',
    mainBusiness: '仓储与物流',
    mgmtLevel: 2,
    equityLevel: 3,
    stateInvestor: '非国资',
    shareholders: '社会资本C(100%)',
    snapshotYear: '2025',
  },
  {
    code: '91370700777766666E',
    name: '潍坊XX设备制造有限公司',
    mainBusiness: '装备制造',
    mgmtLevel: 3,
    equityLevel: 3,
    stateInvestor: '',
    shareholders: '待维护',
    snapshotYear: '2025',
  },
]

export function AuditedEnterpriseLedgerPage() {
  const ui = t.auditedEnterpriseLedgerUi
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [stateCapitalStatus, setStateCapitalStatus] = useState<StateCapitalStatus>('state_owned')
  const [mgmtParent, setMgmtParent] = useState('')
  const [stateInvestorName, setStateInvestorName] = useState('山东XX能源集团有限公司')
  const [equityParents, setEquityParents] = useState([{ id: 1, name: '', ratio: '' }])
  const snapshotYears = useMemo(
    () => [...new Set(seedRows.map((r) => r.snapshotYear))].sort((a, b) => b.localeCompare(a, 'zh-CN')),
    [],
  )
  const [selectedYear, setSelectedYear] = useState(snapshotYears[0] ?? '2026')
  const [stateFilter, setStateFilter] = useState<'all' | StateCapitalStatus>('all')
  const [stateInvestorFilter, setStateInvestorFilter] = useState('')
  const [enterpriseFilter, setEnterpriseFilter] = useState('')
  const filteredRows = useMemo(
    () =>
      seedRows.filter((r) => {
        if (r.snapshotYear !== selectedYear) return false
        if (stateFilter !== 'all' && inferStateCapitalStatus(r.stateInvestor) !== stateFilter) return false
        const stateInvestorKeyword = stateInvestorFilter.trim().toLowerCase()
        if (stateInvestorKeyword && !r.stateInvestor.toLowerCase().includes(stateInvestorKeyword)) return false
        const enterpriseKeyword = enterpriseFilter.trim().toLowerCase()
        if (enterpriseKeyword && !r.name.toLowerCase().includes(enterpriseKeyword)) return false
        return true
      }),
    [enterpriseFilter, selectedYear, stateFilter, stateInvestorFilter],
  )

  const summary = useMemo(
    () => ({
      total: filteredRows.length,
      stateOwned: filteredRows.filter((r) => inferStateCapitalStatus(r.stateInvestor) === 'state_owned').length,
      nonStateOwned: filteredRows.filter((r) => inferStateCapitalStatus(r.stateInvestor) === 'non_state_owned').length,
      unmaintained: filteredRows.filter((r) => inferStateCapitalStatus(r.stateInvestor) === 'unmaintained').length,
      multiShareholder: filteredRows.filter((r) => r.shareholders.includes('；')).length,
    }),
    [filteredRows],
  )

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">{ui.prototypeBadge}</span>
        </div>
        <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
        <p className="mt-2 text-il-meta text-text-3">{ui.pageNote}</p>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-5">
        {[
          { label: ui.kpiTotal, value: summary.total },
          { label: ui.kpiStateOwned, value: summary.stateOwned },
          { label: ui.kpiNonStateOwned, value: summary.nonStateOwned },
          { label: ui.kpiUnmaintained, value: summary.unmaintained },
          { label: ui.kpiMultiShareholder, value: summary.multiShareholder },
        ].map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className="mt-1 text-[20px] font-bold tabular-nums text-text">{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.tableTitle}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="text-il-meta text-text-3">{ui.tableHint.replace('{year}', selectedYear)}</div>
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
              {ui.stateStatusFilterLabel}
              <select
                className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value as 'all' | StateCapitalStatus)}
              >
                <option value="all">{ui.stateStatusAll}</option>
                <option value="state_owned">{ui.stateStatusStateOwned}</option>
                <option value="non_state_owned">{ui.stateStatusNonStateOwned}</option>
                <option value="unmaintained">{ui.stateStatusUnmaintained}</option>
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
          <div className="flex items-center gap-2">
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
              onClick={() => setShowCreateModal(true)}
            >
              {ui.createBtn}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1240px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colCode}</th>
                <th className="px-3 py-2 font-medium">{ui.colName}</th>
                <th className="px-3 py-2 font-medium">{ui.colMainBusiness}</th>
                <th className="px-3 py-2 font-medium">{ui.colStateInvestor}</th>
                <th className="px-3 py-2 font-medium">{ui.colMgmtLevel}</th>
                <th className="px-3 py-2 font-medium">{ui.colEquityLevel}</th>
                <th className="px-3 py-2 font-medium">{ui.colShareholders}</th>
                <th className="px-3 py-2 font-medium">{ui.colSnapshotYear}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {filteredRows.map((row) => (
                <tr key={row.code} className="border-b border-border-light last:border-b-0">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.code}</td>
                  <td className="px-3 py-2.5 font-medium text-text">{row.name}</td>
                  <td className="px-3 py-2.5">{row.mainBusiness}</td>
                  <td className="px-3 py-2.5">{row.stateInvestor.trim() || ui.stateStatusUnmaintained}</td>
                  <td className="px-3 py-2.5">{row.mgmtLevel}</td>
                  <td className="px-3 py-2.5">{row.equityLevel}</td>
                  <td className="px-3 py-2.5">{row.shareholders}</td>
                  <td className="px-3 py-2.5">{row.snapshotYear}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-il-label text-text-2">
                {ui.colCode}
                <input className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent" placeholder="9137..." />
              </label>
              <label className="text-il-label text-text-2">
                {ui.colName}
                <input className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent" placeholder="输入企业名称" />
              </label>
              <label className="text-il-label text-text-2 md:col-span-2">
                {ui.colMgmtParent}
                <input
                  className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                  value={mgmtParent}
                  onChange={(e) => setMgmtParent(e.target.value)}
                  placeholder="输入上级管理单位"
                />
              </label>
              <label className="text-il-label text-text-2 md:col-span-2">
                {ui.colMainBusiness}
                <input className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent" placeholder="输入主业情况" />
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
                    className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent disabled:bg-[#f6f8fb] disabled:text-text-3"
                    value={stateInvestorName}
                    onChange={(e) => setStateInvestorName(e.target.value)}
                    placeholder={ui.stateInvestorInputPlaceholder}
                    disabled={stateCapitalStatus !== 'state_owned'}
                  />
                </div>
              </label>
              <label className="text-il-label text-text-2">
                {ui.colSnapshotYear}
                <input className="mt-1 w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent" defaultValue="2026" />
              </label>
              <div className="text-il-label text-text-2 md:col-span-2">
                {ui.colShareholders}
                <div className="mt-1 space-y-2">
                  {equityParents.map((row, idx) => (
                    <div key={row.id} className="grid gap-2 md:grid-cols-[1fr_140px_72px]">
                      <input
                        className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                        value={row.name}
                        onChange={(e) =>
                          setEquityParents((prev) =>
                            prev.map((p) => (p.id === row.id ? { ...p, name: e.target.value } : p)),
                          )
                        }
                        placeholder={`上级产权单位 ${idx + 1}`}
                      />
                      <input
                        className="w-full rounded-sm border border-border px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                        value={row.ratio}
                        onChange={(e) =>
                          setEquityParents((prev) =>
                            prev.map((p) => (p.id === row.id ? { ...p, ratio: e.target.value } : p)),
                          )
                        }
                        placeholder="持股比例%"
                      />
                      <button
                        type="button"
                        className="rounded-[7px] border border-border bg-white px-2 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={equityParents.length === 1}
                        onClick={() =>
                          setEquityParents((prev) =>
                            prev.length === 1 ? prev : prev.filter((p) => p.id !== row.id),
                          )
                        }
                      >
                        {ui.removeRowBtn}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                    onClick={() =>
                      setEquityParents((prev) => [...prev, { id: Date.now(), name: '', ratio: '' }])
                    }
                  >
                    {ui.addEquityParentBtn}
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">{ui.createModalHint}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent" onClick={() => setShowCreateModal(false)}>
                {ui.modalCancel}
              </button>
              <button type="button" className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90" onClick={() => setShowCreateModal(false)}>
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
            </div>
            <div className="mt-3 rounded-sm border border-[#fff1c7] bg-[#fffaf0] px-3 py-2 text-il-meta text-[#946200]">{ui.importModalTip}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent" onClick={() => setShowImportModal(false)}>
                {ui.modalCancel}
              </button>
              <button type="button" className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90" onClick={() => setShowImportModal(false)}>
                {ui.importConfirmBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

