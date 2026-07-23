import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchInvoiceToAuditedEnterprise, type InvoiceToAuditedEnterpriseRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { navToSubjectLibrary } from './subjectLibraryNav'

export function InvoiceToAuditedEnterprisePage(props: { onNav?: (k: NavKey) => void }) {
  const ui = t.invoiceToAuditedEnterpriseUi
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [statYears, setStatYears] = useState<string[]>([String(new Date().getFullYear())])
  const [minInvoiceCount, setMinInvoiceCount] = useState(10)
  const [rows, setRows] = useState<InvoiceToAuditedEnterpriseRow[]>([])
  const [summary, setSummary] = useState<{ total: number; in_registry: number; not_in_registry: number } | null>(
    null,
  )
  const [caliberHint, setCaliberHint] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [registryFilter, setRegistryFilter] = useState('全部')
  const [keyword, setKeyword] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchInvoiceToAuditedEnterprise({ statYear, minInvoiceCount })
    if (!res.ok) {
      setLoadError(res.error?.message ?? '加载失败')
      setRows([])
      setSummary(null)
      setLoading(false)
      return
    }
    const years = res.stat_years?.length ? res.stat_years : [String(new Date().getFullYear())]
    setStatYears(years)
    if (res.selected_stat_year && !statYear) {
      setStatYear(res.selected_stat_year)
    } else if (res.selected_stat_year && years.includes(statYear)) {
      // keep user selection
    } else if (res.selected_stat_year) {
      setStatYear(res.selected_stat_year)
    }
    if (typeof res.min_invoice_count === 'number') {
      setMinInvoiceCount(res.min_invoice_count)
    }
    setCaliberHint(res.caliber_hint ?? '')
    setRows(res.rows ?? [])
    setSummary(res.summary ?? null)
    setLoading(false)
  }, [statYear, minInvoiceCount])

  useEffect(() => {
    void load()
  }, [load])

  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return rows.filter((row) => {
      if (registryFilter === '已在台账' && !row.inAuditedRegistry) return false
      if (registryFilter === '未在台账' && row.inAuditedRegistry) return false
      if (!kw) return true
      const hay = `${row.enterpriseName} ${row.taxpayerId} ${row.registryName}`.toLowerCase()
      return hay.includes(kw)
    })
  }, [keyword, registryFilter, rows])

  const getRegistryClass = (inRegistry: boolean) =>
    inRegistry
      ? 'border-[#c5ebd8] bg-[#ecfbf2] text-[#157347]'
      : 'border-[#ffe0b2] bg-[#fff8ef] text-[#a16207]'

  const hasBaseData = rows.length > 0
  const emptyMessage = loading ? '…' : loadError || (hasBaseData ? ui.emptyByFilter : ui.emptyByData)

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.pageNote}
        noteTone="compact"
        badgeText={ui.prototypeBadge || undefined}
      />
      {loadError ? <p className="-mt-3 mb-5 text-il-meta text-red-600">{loadError}</p> : null}
      {caliberHint ? <p className="-mt-2 mb-5 text-il-meta text-text-3">{caliberHint}</p> : null}

      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-4">
        {[
          { label: ui.kpiTotal, value: summary?.total ?? filteredRows.length },
          { label: ui.kpiInRegistry, value: summary?.in_registry ?? filteredRows.filter((r) => r.inAuditedRegistry).length },
          {
            label: ui.kpiNotInRegistry,
            value: summary?.not_in_registry ?? filteredRows.filter((r) => !r.inAuditedRegistry).length,
          },
          { label: ui.kpiMinCount, value: minInvoiceCount },
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
            {ui.statYearLabel}
            <select
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={statYear}
              onChange={(e) => setStatYear(e.target.value)}
            >
              {statYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="text-il-label text-text-2">
            {ui.registryFilterLabel}
            <select
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={registryFilter}
              onChange={(e) => setRegistryFilter(e.target.value)}
            >
              <option value="全部">全部</option>
              <option value="已在台账">已在台账</option>
              <option value="未在台账">未在台账</option>
            </select>
          </label>
          <label className="text-il-label text-text-2 md:col-span-2">
            {ui.keywordLabel}
            <input
              className="mt-1 w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
            />
          </label>
          <div className="flex items-end text-il-meta text-text-3">
            {ui.tableHint.replace('{count}', String(filteredRows.length))}
          </div>
        </div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1200px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colName}</th>
                <th className="px-3 py-2 font-medium">{ui.colCode}</th>
                <th className="px-3 py-2 font-medium">{ui.colInvoiceCount}</th>
                <th className="px-3 py-2 font-medium">{ui.colSellerRole}</th>
                <th className="px-3 py-2 font-medium">{ui.colBuyerRole}</th>
                <th className="px-3 py-2 font-medium">{ui.colRegistryStatus}</th>
                <th className="px-3 py-2 font-medium">{ui.colRegistryName}</th>
                <th className="px-3 py-2 font-medium">{ui.colStateCapitalStatus}</th>
                {props.onNav ? <th className="px-3 py-2 font-medium">{ui.colActions}</th> : null}
              </tr>
            </thead>
            <tbody className="text-text-2">
              {filteredRows.length > 0 ? (
                filteredRows.map((row) => (
                  <tr key={row.taxpayerId} className="border-b border-border-light last:border-b-0">
                    <td className="px-3 py-2.5 font-medium text-text">{row.enterpriseName || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.taxpayerId || '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums">{row.invoiceCount}</td>
                    <td className="px-3 py-2.5">{row.hasSellerRole ? ui.roleYes : ui.roleNo}</td>
                    <td className="px-3 py-2.5">{row.hasBuyerRole ? ui.roleYes : ui.roleNo}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={[
                          'inline-flex rounded-full border px-2 py-0.5 text-il-meta font-medium',
                          getRegistryClass(row.inAuditedRegistry),
                        ].join(' ')}
                      >
                        {row.inAuditedRegistry ? ui.registryYes : ui.registryNo}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{row.registryName?.trim() ? row.registryName : '—'}</td>
                    <td className="px-3 py-2.5">{row.inAuditedRegistry ? row.stateCapitalStatus : '—'}</td>
                    {props.onNav ? (
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className="text-il-label text-accent hover:underline"
                            onClick={() => navToSubjectLibrary(props.onNav!, row.taxpayerId || row.enterpriseName)}
                          >
                            {ui.actionSubjectLibrary}
                          </button>
                          {row.inAuditedRegistry ? (
                            <button
                              type="button"
                              className="text-il-label text-accent hover:underline"
                              onClick={() => props.onNav?.('dim_audited_registry')}
                            >
                              {ui.actionRegistry}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-il-label text-accent hover:underline"
                              onClick={() => props.onNav?.('dim_audited_registry')}
                            >
                              {ui.actionAddRegistry}
                            </button>
                          )}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-3 py-6 text-center text-text-3" colSpan={props.onNav ? 9 : 8}>
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
