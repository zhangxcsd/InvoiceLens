import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { fetchAuditedEnterpriseInvoiceLink, type AuditedEnterpriseInvoiceLinkRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

export function AuditedEnterpriseInvoiceLinkPage() {
  const ui = t.auditedEnterpriseInvoiceLinkUi
  const [snapshotYear, setSnapshotYear] = useState('2026')
  const [snapshotYears, setSnapshotYears] = useState<string[]>(['2026'])
  const [rows, setRows] = useState<AuditedEnterpriseInvoiceLinkRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reasonFilter, setReasonFilter] = useState('全部')
  const [statusFilter, setStatusFilter] = useState('全部')
  const [capitalFilter, setCapitalFilter] = useState('全部')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchAuditedEnterpriseInvoiceLink({ snapshotYear })
    if (!res.ok) {
      setLoadError(res.error?.message ?? '加载失败')
      setRows([])
      setLoading(false)
      return
    }
    const years = res.snapshot_years?.length ? res.snapshot_years : ['2026']
    setSnapshotYears(years)
    if (!years.includes(snapshotYear)) {
      setSnapshotYear(res.selected_year ?? years[0])
    }
    setRows(res.rows ?? [])
    setLoading(false)
  }, [snapshotYear])

  useEffect(() => {
    void load()
  }, [load])

  const reasonOptions = useMemo(() => {
    const set = new Set<string>()
    for (const row of rows) {
      const reason = row.pendingReason?.trim()
      if (reason) set.add(reason)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [rows])

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (statusFilter !== '全部' && row.matchStatus !== statusFilter) return false
        if (capitalFilter !== '全部' && row.stateCapitalStatus !== capitalFilter) return false
        if (reasonFilter !== '全部' && row.pendingReason !== reasonFilter) return false
        return true
      }),
    [capitalFilter, reasonFilter, rows, statusFilter],
  )

  const getStatusClass = (status: string) => {
    if (status === '已匹配') return 'border-[#c5ebd8] bg-[#ecfbf2] text-[#157347]'
    if (status === '名称兜底匹配') return 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
    return 'border-[#ffe0b2] bg-[#fff8ef] text-[#a16207]'
  }

  const hasBaseData = rows.length > 0
  const emptyMessage = loading ? '…' : loadError || (hasBaseData ? ui.emptyByFilter : ui.emptyByData)

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">{ui.prototypeBadge}</span>
        </div>
        <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
        <p className="mt-2 text-il-meta text-text-3">{ui.pageNote}</p>
        {loadError ? <p className="mt-2 text-il-meta text-red-600">{loadError}</p> : null}
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
        <div className="mb-3 grid gap-3 md:grid-cols-5">
          <label className="text-il-label text-text-2">
            快照年度
            <select
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={snapshotYear}
              onChange={(e) => setSnapshotYear(e.target.value)}
            >
              {snapshotYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
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
              {reasonOptions.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
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
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.code || '—'}</td>
                    <td className="px-3 py-2.5">{row.stateCapitalStatus}</td>
                    <td className="px-3 py-2.5">{row.matchKey}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.linkedTaxpayerId}</td>
                    <td className="px-3 py-2.5">{row.pendingReason?.trim() ? row.pendingReason : '—'}</td>
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
                    {emptyMessage}
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
