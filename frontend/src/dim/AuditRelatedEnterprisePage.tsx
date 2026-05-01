import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'

type RoleTag = 'seller' | 'buyer' | 'both'

type EnterpriseRow = {
  enterpriseId: string
  enterpriseName: string
  taxpayerId: string
  roleTag: RoleTag
  lastSeenBatchId: string
  mgmtLevel: number
  mgmtParentName: string
  propertyLevel: number
  propertyParentName: string
  stateInvestorEnterprise: string
}

const rowsSeed: EnterpriseRow[] = [
  {
    enterpriseId: 'ENT_001',
    enterpriseName: '山东XX能源集团有限公司',
    taxpayerId: '91370000123456789A',
    roleTag: 'both',
    lastSeenBatchId: '20260420_A03',
    mgmtLevel: 1,
    mgmtParentName: '省属企业',
    propertyLevel: 1,
    propertyParentName: '山东省国资委',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
  {
    enterpriseId: 'ENT_002',
    enterpriseName: '青岛XX工程建设有限公司',
    taxpayerId: '91370200111222333B',
    roleTag: 'seller',
    lastSeenBatchId: '20260419_A02',
    mgmtLevel: 2,
    mgmtParentName: '山东XX能源集团有限公司',
    propertyLevel: 3,
    propertyParentName: '山东XX建设投资控股有限公司',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
  {
    enterpriseId: 'ENT_003',
    enterpriseName: '济南XX贸易有限公司',
    taxpayerId: '91370100999888777C',
    roleTag: 'buyer',
    lastSeenBatchId: '20260420_A03',
    mgmtLevel: 3,
    mgmtParentName: '青岛XX工程建设有限公司',
    propertyLevel: 2,
    propertyParentName: '山东XX能源集团有限公司',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
  {
    enterpriseId: 'ENT_004',
    enterpriseName: '烟台XX物流有限公司',
    taxpayerId: '91370600101010101D',
    roleTag: 'both',
    lastSeenBatchId: '20260420_A03',
    mgmtLevel: 2,
    mgmtParentName: '山东XX能源集团有限公司',
    propertyLevel: 2,
    propertyParentName: '山东XX能源集团有限公司',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
  {
    enterpriseId: 'ENT_005',
    enterpriseName: '潍坊XX设备制造有限公司',
    taxpayerId: '91370700777766666E',
    roleTag: 'seller',
    lastSeenBatchId: '20260420_A03',
    mgmtLevel: 2,
    mgmtParentName: '山东XX能源集团有限公司',
    propertyLevel: 4,
    propertyParentName: '烟台XX物流有限公司',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
  {
    enterpriseId: 'ENT_006',
    enterpriseName: '临沂XX新材料有限公司',
    taxpayerId: '91371300123410000F',
    roleTag: 'buyer',
    lastSeenBatchId: '20260419_A02',
    mgmtLevel: 2,
    mgmtParentName: '山东XX能源集团有限公司',
    propertyLevel: 2,
    propertyParentName: '山东XX能源集团有限公司',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
  {
    enterpriseId: 'ENT_007',
    enterpriseName: '淄博XX化工有限公司',
    taxpayerId: '91370300999123000G',
    roleTag: 'seller',
    lastSeenBatchId: '20260420_A03',
    mgmtLevel: 3,
    mgmtParentName: '烟台XX物流有限公司',
    propertyLevel: 3,
    propertyParentName: '山东XX化工投资有限公司',
    stateInvestorEnterprise: '山东XX能源集团有限公司',
  },
]

export function AuditRelatedEnterprisePage() {
  const ui = t.auditRelatedEnterpriseUi
  const [statYear, setStatYear] = useState('2026')
  const [groupName, setGroupName] = useState('山东省属企业-能源口径')
  const [stateInvestor, setStateInvestor] = useState('山东XX能源集团有限公司')
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')
  const [listView, setListView] = useState<'unreported' | 'reported' | 'all'>('unreported')

  const auditRelatedRows = useMemo(() => rowsSeed.filter((r) => r.roleTag === 'both'), [])
  const groupMemberRows = useMemo(() => rowsSeed.filter((r) => r.enterpriseName !== '山东XX能源集团有限公司'), [])
  const keywordFilteredGroupRows = useMemo(() => {
    const keyword = enterpriseKeyword.trim().toLowerCase()
    if (!keyword) return groupMemberRows
    return groupMemberRows.filter(
      (r) =>
        r.enterpriseName.toLowerCase().includes(keyword) ||
        r.taxpayerId.toLowerCase().includes(keyword) ||
        r.enterpriseId.toLowerCase().includes(keyword),
    )
  }, [enterpriseKeyword, groupMemberRows])

  const unreportedRows = useMemo(() => {
    const uploadedTaxSet = new Set(auditRelatedRows.map((r) => r.taxpayerId))
    return keywordFilteredGroupRows.filter((r) => !uploadedTaxSet.has(r.taxpayerId))
  }, [auditRelatedRows, keywordFilteredGroupRows])
  const reportedRows = useMemo(() => {
    const uploadedTaxSet = new Set(auditRelatedRows.map((r) => r.taxpayerId))
    return keywordFilteredGroupRows.filter((r) => uploadedTaxSet.has(r.taxpayerId))
  }, [auditRelatedRows, keywordFilteredGroupRows])

  const coverageRate = useMemo(() => {
    if (!groupMemberRows.length) return '0.00%'
    const reported = groupMemberRows.length - unreportedRows.length
    return `${((reported / groupMemberRows.length) * 100).toFixed(2)}%`
  }, [groupMemberRows, unreportedRows])
  const currentListRows = useMemo(() => {
    if (listView === 'reported') return reportedRows
    if (listView === 'all') return keywordFilteredGroupRows
    return unreportedRows
  }, [keywordFilteredGroupRows, listView, reportedRows, unreportedRows])
  const currentListTitle =
    listView === 'reported'
      ? ui.reportedTitle
      : listView === 'all'
        ? ui.allListTitle
        : ui.unreportedTitle
  const currentListHint =
    listView === 'reported'
      ? ui.reportedHint.replace('{year}', statYear).replace('{count}', String(currentListRows.length))
      : listView === 'all'
        ? ui.allListHint.replace('{year}', statYear).replace('{count}', String(currentListRows.length))
        : ui.unreportedHint.replace('{year}', statYear).replace('{count}', String(currentListRows.length))
  const hasBaseData = rowsSeed.length > 0

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">{ui.prototypeBadge}</span>
        </div>
        <p className="mt-2 max-w-[820px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
        <p className="mt-2 text-il-meta text-text-3">{ui.prototypeNote}</p>
      </div>

      <Card title={ui.compareTitle}>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-3 sm:gap-y-3">
          <div className="w-full shrink-0 sm:w-[7.25rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.compareYearLabel}</label>
            <select className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent" value={statYear} onChange={(e) => setStatYear(e.target.value)}>
              <option value="2026">2026</option>
              <option value="2025">2025</option>
              <option value="2024">2024</option>
            </select>
          </div>
          <div className="w-full shrink-0 sm:w-[15.5rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.compareGroupLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={ui.compareGroupPlaceholder}
            />
          </div>
          <div className="w-full shrink-0 sm:w-[15.5rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.compareStateInvestorLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={stateInvestor}
              onChange={(e) => setStateInvestor(e.target.value)}
              placeholder={ui.compareStateInvestorPlaceholder}
            />
          </div>
          <div className="min-w-0 w-full flex-1 sm:min-w-[12rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.enterpriseFilterLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={enterpriseKeyword}
              onChange={(e) => setEnterpriseKeyword(e.target.value)}
              placeholder={ui.enterpriseFilterPlaceholder}
            />
          </div>
        </div>
        <div className="mb-3 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">
          {ui.compareCaliberHint.replace('{year}', statYear)}
        </div>
        <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
          <div className="mb-2 text-il-label text-text-3">{ui.coreMetricsTitle}</div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: ui.auditKpiAll, value: rowsSeed.length },
              { label: ui.auditKpiRelated, value: auditRelatedRows.length },
              { label: ui.compareUnreported, value: unreportedRows.length },
              { label: ui.compareCoverageLabel, value: coverageRate },
            ].map((item) => (
              <div key={item.label}>
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 text-[16px] font-semibold tabular-nums text-text">{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card title={currentListTitle}>
        <div className="mb-3 flex items-center gap-2">
          {[
            { key: 'unreported' as const, label: ui.listViewUnreported },
            { key: 'reported' as const, label: ui.listViewReported },
            { key: 'all' as const, label: ui.listViewAll },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={[
                'rounded-sm border px-2.5 py-1 text-il-page-desc transition-colors',
                listView === item.key
                  ? 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
                  : 'border-border bg-white text-text-2 hover:border-accent hover:text-accent',
              ].join(' ')}
              onClick={() => setListView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mb-2 text-il-meta text-text-3">{currentListHint}</div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1320px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colEnterpriseName}</th>
                <th className="px-3 py-2 font-medium">{ui.colTaxpayerId}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColStateInvestor}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColMgmtLevel}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColMgmtParent}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColPropertyLevel}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColPropertyParent}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColLastBatch}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {currentListRows.length > 0 ? (
                currentListRows.map((row) => (
                  <tr key={`gap_${row.enterpriseId}`} className="border-b border-border-light last:border-b-0">
                    <td className="px-3 py-2.5 font-medium text-text">{row.enterpriseName}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.taxpayerId}</td>
                    <td className="px-3 py-2.5">{row.stateInvestorEnterprise}</td>
                    <td className="px-3 py-2.5">{row.mgmtLevel}</td>
                    <td className="px-3 py-2.5">{row.mgmtParentName}</td>
                    <td className="px-3 py-2.5">{row.propertyLevel}</td>
                    <td className="px-3 py-2.5">{row.propertyParentName}</td>
                    <td className="px-3 py-2.5">{row.lastSeenBatchId}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-3 py-6 text-center text-text-3" colSpan={8}>
                    {hasBaseData ? ui.emptyByFilter : ui.emptyByData}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
