import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsSupplierTop, type DwsSupplierTopRow } from '../config/localApi'
import { fetchDwsCustomerTop } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams, navigateToEntityProfile, writeNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { InvoiceDetailDrillPanel } from './InvoiceDetailDrillPanel'
import { formatDwsAmount, formatDwsPct, useDwsFilters, useDwsUrlDeepLinkFilter } from './useDwsFilters'
import type { NavKey } from '../types'

function normTaxId(v: string): string {
  return v.replace(/[\s-]+/g, '').toUpperCase()
}

export function SupplierTopPage({ onNav }: { onNav?: (key: NavKey) => void }) {
  const ui = t.dwsDashboardUi
  const drillUi = t.invoiceDetailDrillUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const [roleMode, setRoleMode] = useState<'supplier' | 'customer'>(() =>
    urlQuery.role_mode === 'customer' ? 'customer' : 'supplier',
  )
  const isCustomer = roleMode === 'customer'
  const deepLink = useDwsUrlDeepLinkFilter()
  const highlightSupplierId = useMemo(() => {
    const raw = urlQuery.seller_tax_no?.trim()
    return raw ? normTaxId(raw) : ''
  }, [urlQuery.seller_tax_no])
  const flagContextHint = useMemo(() => {
    if (highlightSupplierId) {
      return ui.flagContextSupplierHint.replace('{id}', urlQuery.seller_tax_no?.trim() || highlightSupplierId)
    }
    return deepLink.flagContextHint
  }, [highlightSupplierId, urlQuery.seller_tax_no, deepLink.flagContextHint, ui])
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    requireBuyer: !isCustomer,
    requireBothRoles: isCustomer,
    initFromUrl: true,
  })
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const [rows, setRows] = useState<DwsSupplierTopRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillSeller, setDrillSeller] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setRows([])
      setTotal(0)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = isCustomer
        ? await fetchDwsCustomerTop({ statYear: f.effectiveYear, entityId: f.entityId.trim(), limit: 20 }, signal)
        : await fetchDwsSupplierTop(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim(),
              limit: 20,
              statMonth: deepLink.apiStatMonth,
              dateFrom: deepLink.apiDateFrom,
              dateTo: deepLink.apiDateTo,
              quarter: deepLink.apiQuarter,
            },
            signal,
          )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        return
      }
      if (isCustomer) {
        const custRes = res as Awaited<ReturnType<typeof fetchDwsCustomerTop>>
        const mapped: DwsSupplierTopRow[] = (custRes.rows ?? []).map((r) => ({
          supplier_id: r.customer_id,
          supplier_name: r.customer_name,
          net_jshj: r.net_jshj,
          invoice_cnt: r.invoice_cnt,
          amount_rank: r.amount_rank,
          amount_ratio: r.amount_ratio,
          cumulative_ratio: r.cumulative_ratio,
          is_new_supplier: r.is_new_customer,
          first_invoice_date: '',
          last_invoice_date: r.last_invoice_date,
        }))
        setRows(mapped)
      } else {
        const supRes = res as Awaited<ReturnType<typeof fetchDwsSupplierTop>>
        setRows(supRes.rows ?? [])
      }
      setTotal(res.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, deepLink.apiStatMonth, deepLink.apiDateFrom, deepLink.apiDateTo, deepLink.apiQuarter, isCustomer, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  useEffect(() => {
    if (!highlightSupplierId || rows.length === 0) return
    const match = rows.find((r) => normTaxId(r.supplier_id) === highlightSupplierId)
    if (!match) return
    const el = rowRefs.current.get(match.supplier_id)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [rows, highlightSupplierId])

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={isCustomer ? ui.customerTopTitle : ui.supplierTopTitle}
        note={isCustomer ? ui.customerTopDesc : ui.supplierTopDesc}
        noteTone="plain"
      />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {flagContextHint ? <p className="mb-2 text-il-meta text-amber-800">{flagContextHint}</p> : null}
      {f.poolHint ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

      <Card title={ui.filterTitle}>
        <div className="mb-3 flex gap-2">
          {(['supplier', 'customer'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={[
                'rounded border px-2 py-1 text-il-meta',
                roleMode === mode ? 'border-accent bg-accent/5 text-accent' : 'border-border-light text-text-3',
              ].join(' ')}
              onClick={() => {
                setRoleMode(mode)
                writeNavQueryParams({ role_mode: mode })
              }}
            >
              {mode === 'supplier' ? ui.roleSupplier : ui.roleCustomer}
            </button>
          ))}
        </div>
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
        {onNav && f.entityId.trim() ? (
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() =>
              navigateToEntityProfile(onNav, {
                statYear: f.effectiveYear,
                entityId: f.entityId.trim(),
              })
            }
          >
            {t.sidebar.entityProfile} →
          </button>
        ) : null}
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
                  <th className="px-3 py-2 font-medium">{drillUi.drillBtn}</th>
                </tr>
              </thead>
              <tbody className="text-text-2">
                {rows.length > 0 ? (
                  rows.map((r) => (
                    <tr
                      key={r.supplier_id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(r.supplier_id, el)
                        else rowRefs.current.delete(r.supplier_id)
                      }}
                      className={[
                        'border-b border-border-light last:border-b-0',
                        normTaxId(r.supplier_id) === highlightSupplierId ? 'bg-[#fff8ef]' : '',
                        r.is_new_supplier && normTaxId(r.supplier_id) !== highlightSupplierId
                          ? 'bg-[#fff8ef]'
                          : '',
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
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => {
                            setDrillSeller(r.supplier_id)
                            setDrillOpen(true)
                          }}
                        >
                          {drillUi.drillFromSupplier}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-text-3">
                      {loading ? ui.loading : ui.emptySupplier}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <InvoiceDetailDrillPanel
        open={drillOpen}
        onClose={() => setDrillOpen(false)}
        title={drillUi.drillFromSupplier}
        filters={{
          statYear: f.effectiveYear,
          entityId: f.entityId.trim() || undefined,
          sellerTaxNo: drillSeller ?? undefined,
          statMonth: deepLink.apiStatMonth,
          dateFrom: deepLink.apiDateFrom,
          dateTo: deepLink.apiDateTo,
        }}
      />
    </div>
  )
}
