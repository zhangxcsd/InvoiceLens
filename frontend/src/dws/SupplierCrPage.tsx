import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsSupplierCr } from '../config/localApi'
import { fetchDwsCustomerCr } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters, useDwsUrlDeepLinkFilter } from './useDwsFilters'

function normTaxId(v: string): string {
  return v.replace(/[\s-]+/g, '').toUpperCase()
}

export function SupplierCrPage() {
  const ui = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const [roleMode, setRoleMode] = useState<'supplier' | 'customer'>(() =>
    urlQuery.role_mode === 'customer' ? 'customer' : 'supplier',
  )
  const isCustomer = roleMode === 'customer'
  const deepLink = useDwsUrlDeepLinkFilter()
  const highlightSupplierId = useMemo(() => {
    const raw = deepLink.urlQuery.seller_tax_no?.trim()
    return raw ? normTaxId(raw) : ''
  }, [deepLink.urlQuery.seller_tax_no])
  const supplierContextHint = useMemo(() => {
    if (!highlightSupplierId) return null
    return ui.flagContextSupplierHint.replace(
      '{id}',
      deepLink.urlQuery.seller_tax_no?.trim() || highlightSupplierId,
    )
  }, [highlightSupplierId, deepLink.urlQuery.seller_tax_no, ui])
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    requireBuyer: !isCustomer,
    requireBothRoles: isCustomer,
    initFromUrl: true,
  })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cr, setCr] = useState<{
    cr1: number | null
    cr3: number | null
    cr10: number | null
    supplier_cnt: number
    total_net_jshj: number
  } | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setCr(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const fetcher = isCustomer ? fetchDwsCustomerCr : fetchDwsSupplierCr
      const res = await fetcher(
        {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim(),
          ...(!isCustomer ? deepLink.timeFilterParams : {}),
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setCr(null)
        return
      }
      setCr({
        cr1: res.cr1 ?? null,
        cr3: res.cr3 ?? null,
        cr10: res.cr10 ?? null,
        supplier_cnt: (res as { supplier_cnt?: number }).supplier_cnt ?? (res as { customer_cnt?: number }).customer_cnt ?? 0,
        total_net_jshj: res.total_net_jshj ?? 0,
      })
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, deepLink.timeFilterParams, isCustomer, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={isCustomer ? ui.customerCrTitle : ui.supplierCrTitle}
        note={isCustomer ? ui.customerCrDesc : ui.supplierCrDesc}
        noteTone="plain"
      />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {deepLink.flagContextHint ? (
        <p className="mb-2 text-il-meta text-amber-800">{deepLink.flagContextHint}</p>
      ) : null}
      {supplierContextHint ? <p className="mb-2 text-il-meta text-amber-800">{supplierContextHint}</p> : null}
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
      </Card>

      <Card title={ui.supplierCrCardTitle}>
        {!f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : loading ? (
          <p className="text-il-meta text-text-3">{ui.loading}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { label: 'CR1', value: formatDwsPct(cr?.cr1) },
              { label: 'CR3', value: formatDwsPct(cr?.cr3) },
              { label: 'CR10', value: formatDwsPct(cr?.cr10) },
              { label: ui.kpiSupplierCnt, value: cr ? String(cr.supplier_cnt) : '—' },
              { label: ui.kpiPurchaseTotal, value: formatDwsAmount(cr?.total_net_jshj) },
            ].map((item) => (
              <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-text">{item.value}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
