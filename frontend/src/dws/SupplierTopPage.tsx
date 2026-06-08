import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsSupplierTop, type DwsSupplierTopRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'

export function SupplierTopPage() {
  const ui = t.dwsDashboardUi
  const f = useDwsFilters(true, { entityPool: 'analysis', requireBuyer: true })
  const [rows, setRows] = useState<DwsSupplierTopRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setRows([])
      setTotal(0)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsSupplierTop(
        { statYear: f.effectiveYear, entityId: f.entityId.trim(), limit: 20 },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        return
      }
      setRows(res.rows ?? [])
      setTotal(res.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.supplierTopTitle} note={ui.supplierTopDesc} noteTone="plain" />
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
          minInvoiceCount={f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <p className="mt-2 text-il-meta text-text-3">
          {ui.analysisSubjectCaliberHint.replace(
            '{n}',
            String(f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10),
          )}
        </p>
      </Card>

      <Card title={ui.supplierTopTableTitle.replace('{count}', String(total))}>
        {!f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : (
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
                  <th className="px-3 py-2 font-medium">{ui.colNewSupplier}</th>
                </tr>
              </thead>
              <tbody className="text-text-2">
                {rows.length > 0 ? (
                  rows.map((r) => (
                    <tr
                      key={r.supplier_id}
                      className={[
                        'border-b border-border-light last:border-b-0',
                        r.is_new_supplier ? 'bg-[#fff8ef]' : '',
                      ].join(' ')}
                    >
                      <td className="px-3 py-2 tabular-nums">{r.amount_rank}</td>
                      <td className="px-3 py-2 font-medium text-text">{r.supplier_name || '—'}</td>
                      <td className="px-3 py-2 font-mono text-[12px]">{r.supplier_id || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDwsAmount(r.net_jshj)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDwsPct(r.amount_ratio)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDwsPct(r.cumulative_ratio)}</td>
                      <td className="px-3 py-2 tabular-nums">{r.invoice_cnt}</td>
                      <td className="px-3 py-2">{r.is_new_supplier ? ui.newSupplierYes : '—'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-text-3">
                      {loading ? ui.loading : ui.emptySupplier}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
