import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsSupplierChurn, type DwsSupplierChurnRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'

type ChurnKind = 'new' | 'disappeared'

export function SupplierNewPage() {
  const ui = t.dwsDashboardUi
  const f = useDwsFilters(true, { entityPool: 'analysis', requireBuyer: true })
  const [kind, setKind] = useState<ChurnKind>('new')
  const [topOnly, setTopOnly] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<DwsSupplierChurnRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<{
    new_total: number
    new_top10: number
    disappeared_total: number
    prior_year: string
  } | null>(null)
  const [priorYear, setPriorYear] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10

  const caliberHint = ui.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setRows([])
      setTotal(0)
      setSummary(null)
      setHint(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsSupplierChurn(
        {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim(),
          kind,
          topOnly: kind === 'new' ? topOnly : false,
          keyword: keyword.trim() || undefined,
          limit: 100,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        setSummary(null)
        return
      }
      setRows(res.rows ?? [])
      setTotal(res.total ?? 0)
      setSummary(res.summary ?? null)
      setPriorYear(res.prior_year ?? '')
      setHint(res.hint ?? null)
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, kind, topOnly, keyword, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const tableTitle =
    kind === 'new'
      ? ui.supplierNewTableNew.replace('{count}', String(total))
      : ui.supplierNewTableDisappeared.replace('{count}', String(total))

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.supplierNewTitle} note={ui.supplierNewDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {f.poolHint ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

      <Card title={ui.filterTitle}>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.entityOptions}
          requireEntity
          showMinInvoiceCount
          minInvoiceCount={effectiveN}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <p className="mt-2 text-il-meta text-text-3">{caliberHint}</p>
      </Card>

      {f.entityId.trim() ? (
        <Card title={ui.supplierNewSummaryTitle}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: ui.supplierNewKpiNew, value: summary ? String(summary.new_total) : '—' },
              { label: ui.supplierNewKpiNewTop10, value: summary ? String(summary.new_top10) : '—' },
              {
                label: ui.supplierNewKpiDisappeared,
                value: summary ? String(summary.disappeared_total) : '—',
              },
              {
                label: ui.supplierNewKpiCompareYear,
                value: priorYear || summary?.prior_year || '—',
              },
            ].map((item) => (
              <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-text">{item.value}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card title={tableTitle}>
        {!f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div>
                <label className="mb-1 block text-il-label font-medium text-text-2">{ui.supplierNewKindLabel}</label>
                <div className="flex gap-2">
                  {(['new', 'disappeared'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={[
                        'rounded-sm border px-3 py-1.5 text-il-page-desc',
                        kind === k
                          ? 'border-accent bg-accent/10 font-medium text-accent'
                          : 'border-border-light bg-white text-text-2 hover:bg-[#fafbfd]',
                      ].join(' ')}
                      onClick={() => setKind(k)}
                    >
                      {k === 'new' ? ui.supplierNewTabNew : ui.supplierNewTabDisappeared}
                    </button>
                  ))}
                </div>
              </div>
              {kind === 'new' ? (
                <label className="flex items-center gap-2 text-il-page-desc text-text-2">
                  <input
                    type="checkbox"
                    checked={topOnly}
                    onChange={(e) => setTopOnly(e.target.checked)}
                  />
                  {ui.supplierNewTopOnly}
                </label>
              ) : null}
              <div className="min-w-0 flex-1 sm:min-w-[14rem]">
                <label className="mb-1 block text-il-label font-medium text-text-2">{ui.supplierNewKeywordLabel}</label>
                <input
                  className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                  placeholder={ui.supplierNewKeywordPlaceholder}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
            </div>
            {hint ? <p className="mb-2 text-il-meta text-text-3">{hint}</p> : null}
            <div className="overflow-x-auto rounded-sm border border-border-light">
              <table className="w-full min-w-[960px] border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="px-3 py-2 font-medium">{ui.colRank}</th>
                    <th className="px-3 py-2 font-medium">{ui.colSupplierName}</th>
                    <th className="px-3 py-2 font-medium">{ui.colSupplierId}</th>
                    <th className="px-3 py-2 font-medium">{ui.colNetJshj}</th>
                    <th className="px-3 py-2 font-medium">{ui.colAmountRatio}</th>
                    <th className="px-3 py-2 font-medium">{ui.colCumulativeRatio}</th>
                    <th className="px-3 py-2 font-medium">{ui.colInvoiceCnt}</th>
                    <th className="px-3 py-2 font-medium">{ui.colFirstInvoice}</th>
                    <th className="px-3 py-2 font-medium">{ui.colLastInvoice}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {rows.length > 0 ? (
                    rows.map((r) => (
                      <tr
                        key={`${r.supplier_id}-${r.churn_kind}`}
                        className={[
                          'border-b border-border-light last:border-b-0',
                          r.is_top10 ? 'bg-[#fff8ef]' : '',
                        ].join(' ')}
                      >
                        <td className="px-3 py-2 tabular-nums">{r.amount_rank || '—'}</td>
                        <td className="px-3 py-2 font-medium text-text">{r.supplier_name || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{r.supplier_id || '—'}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDwsAmount(r.net_jshj)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDwsPct(r.amount_ratio)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDwsPct(r.cumulative_ratio)}</td>
                        <td className="px-3 py-2 tabular-nums">{r.invoice_cnt}</td>
                        <td className="px-3 py-2">{r.first_invoice_date || '—'}</td>
                        <td className="px-3 py-2">{r.last_invoice_date || '—'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-text-3">
                        {loading ? ui.loading : ui.emptySupplierChurn}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
