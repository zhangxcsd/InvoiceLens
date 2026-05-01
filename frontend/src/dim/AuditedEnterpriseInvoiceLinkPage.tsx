import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'

type StateCapitalStatus = '国资' | '非国资' | '未维护'

const rows = [
  {
    name: '山东XX能源集团有限公司',
    code: '91370000123456789A',
    matchKey: '统一社会信用代码',
    linkedTaxpayerId: '91370000123456789A',
    matchStatus: '已匹配',
    stateCapitalStatus: '国资' as StateCapitalStatus,
  },
  {
    name: '青岛XX工程建设有限公司',
    code: '91370200111222333B',
    matchKey: '统一社会信用代码',
    linkedTaxpayerId: '91370200111222333B',
    matchStatus: '已匹配',
    stateCapitalStatus: '国资' as StateCapitalStatus,
  },
  {
    name: '济南XX贸易有限公司',
    code: '91370100999888777C',
    matchKey: '企业名称兜底',
    linkedTaxpayerId: '91370100999888777X',
    matchStatus: '名称兜底匹配',
    pendingReason: '税号疑似变更',
    stateCapitalStatus: '非国资' as StateCapitalStatus,
  },
  {
    name: '烟台XX物流有限公司',
    code: '91370600101010101D',
    matchKey: '未命中',
    linkedTaxpayerId: '-',
    matchStatus: '待匹配',
    pendingReason: '企业名称不一致',
    stateCapitalStatus: '未维护' as StateCapitalStatus,
  },
  {
    name: '潍坊XX设备制造有限公司',
    code: '91370700777766666E',
    matchKey: '未命中',
    linkedTaxpayerId: '-',
    matchStatus: '待匹配',
    pendingReason: '缺少统一社会信用代码',
    stateCapitalStatus: '未维护' as StateCapitalStatus,
  },
]

export function AuditedEnterpriseInvoiceLinkPage() {
  const ui = t.auditedEnterpriseInvoiceLinkUi
  const [reasonFilter, setReasonFilter] = useState('全部')
  const [statusFilter, setStatusFilter] = useState('全部')
  const [capitalFilter, setCapitalFilter] = useState('全部')

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (statusFilter !== '全部' && row.matchStatus !== statusFilter) return false
        if (capitalFilter !== '全部' && row.stateCapitalStatus !== capitalFilter) return false
        if (reasonFilter !== '全部' && row.pendingReason !== reasonFilter) return false
        return true
      }),
    [reasonFilter, statusFilter, capitalFilter],
  )

  const getStatusClass = (status: string) => {
    if (status === '已匹配') return 'border-[#c5ebd8] bg-[#ecfbf2] text-[#157347]'
    if (status === '名称兜底匹配') return 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
    return 'border-[#ffe0b2] bg-[#fff8ef] text-[#a16207]'
  }
  const hasBaseData = rows.length > 0

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

      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-4">
        {[
          { label: ui.kpiMatched, value: filteredRows.filter((r) => r.matchStatus === '已匹配').length },
          { label: ui.kpiFallback, value: filteredRows.filter((r) => r.matchStatus === '名称兜底匹配').length },
          { label: ui.kpiPending, value: filteredRows.filter((r) => r.matchStatus === '待匹配').length },
          { label: ui.kpiUnmaintained, value: filteredRows.filter((r) => r.stateCapitalStatus === '未维护').length },
        ].map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className="mt-1 text-[20px] font-bold tabular-nums text-text">{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.tableTitle}>
        <div className="mb-3 grid gap-3 md:grid-cols-4">
          <label className="text-il-label text-text-2">
            {ui.statusFilterLabel}
            <select
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="全部">全部</option>
              <option value="已匹配">已匹配</option>
              <option value="名称兜底匹配">名称兜底匹配</option>
              <option value="待匹配">待匹配</option>
            </select>
          </label>
          <label className="text-il-label text-text-2">
            {ui.reasonFilterLabel}
            <select
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value)}
            >
              <option value="全部">全部</option>
              <option value="税号疑似变更">税号疑似变更</option>
              <option value="企业名称不一致">企业名称不一致</option>
              <option value="缺少统一社会信用代码">缺少统一社会信用代码</option>
            </select>
          </label>
          <label className="text-il-label text-text-2">
            {ui.stateCapitalFilterLabel}
            <select
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={capitalFilter}
              onChange={(e) => setCapitalFilter(e.target.value)}
            >
              <option value="全部">全部</option>
              <option value="国资">国资</option>
              <option value="非国资">非国资</option>
              <option value="未维护">未维护</option>
            </select>
          </label>
          <div className="flex items-end text-il-meta text-text-3">{ui.tableHint.replace('{count}', String(filteredRows.length))}</div>
        </div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1240px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colName}</th>
                <th className="px-3 py-2 font-medium">{ui.colCode}</th>
                <th className="px-3 py-2 font-medium">{ui.colStateCapitalStatus}</th>
                <th className="px-3 py-2 font-medium">{ui.colMatchKey}</th>
                <th className="px-3 py-2 font-medium">{ui.colLinkedTaxpayerId}</th>
                <th className="px-3 py-2 font-medium">{ui.colPendingReason}</th>
                <th className="px-3 py-2 font-medium">{ui.colMatchStatus}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {filteredRows.length > 0 ? (
                filteredRows.map((row) => (
                  <tr key={`${row.name}_${row.code}`} className="border-b border-border-light last:border-b-0">
                    <td className="px-3 py-2.5 font-medium text-text">{row.name}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.code}</td>
                    <td className="px-3 py-2.5">{row.stateCapitalStatus}</td>
                    <td className="px-3 py-2.5">{row.matchKey}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.linkedTaxpayerId}</td>
                    <td className="px-3 py-2.5">{row.pendingReason ?? '-'}</td>
                    <td className="px-3 py-2.5">
                      <span className={['inline-flex rounded-full border px-2 py-0.5 text-il-meta font-medium', getStatusClass(row.matchStatus)].join(' ')}>
                        {row.matchStatus}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-3 py-6 text-center text-text-3" colSpan={7}>
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

