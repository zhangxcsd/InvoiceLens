import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDwsCounterpartyTopMatrix,
  fetchDwsSupplierTop,
  type CounterpartyTopMatrixRow,
  type DwsSupplierTopRow,
} from '../config/localApi'
import { fetchDwsCustomerTop } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { DwsScopeFilterBar } from './DwsScopeFilterBar'
import { InvoiceDetailDrillPanel } from './InvoiceDetailDrillPanel'
import { formatDwsAmount, formatDwsPct, useDwsUrlDeepLinkFilter } from './useDwsFilters'
import { useDwsAnalysisScope } from './useDwsAnalysisScope'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

function normTaxId(v: string): string {
  return v.replace(/[\s-]+/g, '').toUpperCase()
}

export function SupplierTopPage({ onNav, embedMode }: { onNav?: (key: NavKey) => void } & EmbedModeProps) {
  const ui = t.dwsDashboardUi
  const drillUi = t.invoiceDetailDrillUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('supplier_top', embedMode)
  const [roleMode, setRoleMode] = useState<'supplier' | 'customer'>(() => {
    if (urlQuery.role_mode === 'customer') return 'customer'
    const saved = savedUi?.extra?.roleMode
    return saved === 'customer' ? 'customer' : 'supplier'
  })
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
  const f = useDwsAnalysisScope(true, {
    entityPool: 'analysis',
    requireBuyer: !isCustomer,
    requireBothRoles: isCustomer,
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })

  useEffect(() => {
    const savedScope = savedUi?.extra?.scopeMode
    if (savedScope === 'org_mg' || savedScope === 'org_eq') f.setScopeMode(savedScope)
    else if (urlQuery.scope_mode === 'org_mg' || urlQuery.scope_mode === 'org_eq') {
      f.setScopeMode(urlQuery.scope_mode)
    }
    const scopeId = urlQuery.scope_entity_id ?? String(savedUi?.extra?.scopeEntityId ?? '')
    if (scopeId) f.setScopeEntityId(scopeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const [rows, setRows] = useState<DwsSupplierTopRow[]>([])
  const [total, setTotal] = useState(0)
  const [matrixRows, setMatrixRows] = useState<CounterpartyTopMatrixRow[]>([])
  const [matrixTotal, setMatrixTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillSeller, setDrillSeller] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const showOrgMatrix = f.isOrgScope && !f.entityId.trim()

  const orgMemberHint = useMemo(() => {
    if (!f.isOrgScope || !f.scopeEntityId.trim() || f.orgMembersLoading) return null
    const name = f.scopeEntityName || f.scopeEntityId
    return ui.scopeOrgMemberHint
      .replace('{name}', name)
      .replace('{count}', String(f.orgMembers.length))
  }, [f.isOrgScope, f.scopeEntityId, f.scopeEntityName, f.orgMembers.length, f.orgMembersLoading, ui])

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
      if (params.scope_mode === 'org_mg' || params.scope_mode === 'org_eq' || params.scope_mode === 'entity') {
        f.setScopeMode(params.scope_mode)
      }
      if (params.scope_entity_id) f.setScopeEntityId(params.scope_entity_id)
    },
    [f],
  )

  const { goAnalysis, shellProps } = useDwsPageAnalysisShell({
    host: 'supplier_top',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      loading,
      extra: { roleMode, scopeMode: f.scopeMode, scopeEntityId: f.scopeEntityId },
    },
  })

  const loadMatrix = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.scopeEntityId.trim()) {
        setMatrixRows([])
        setMatrixTotal(0)
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsCounterpartyTopMatrix(
          {
            statYear: f.effectiveYear,
            tree: f.orgTree,
            scopeEntityId: f.scopeEntityId.trim(),
            role: isCustomer ? 'customer' : 'supplier',
            requireBuyer: !isCustomer,
            requireBothRoles: isCustomer,
            minInvoiceCount: effectiveN,
          },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          setMatrixRows([])
          setMatrixTotal(0)
          return
        }
        setMatrixRows(res.rows ?? [])
        setMatrixTotal(res.total ?? 0)
      } finally {
        setLoading(false)
      }
    },
    [f.effectiveYear, f.scopeEntityId, f.orgTree, isCustomer, effectiveN, ui.loadFailed],
  )

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
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
    },
    [
      f.effectiveYear,
      f.entityId,
      deepLink.apiStatMonth,
      deepLink.apiDateFrom,
      deepLink.apiDateTo,
      deepLink.apiQuarter,
      isCustomer,
      ui.loadFailed,
    ],
  )

  useEffect(() => {
    const ac = new AbortController()
    if (showOrgMatrix) void loadMatrix(ac.signal)
    else void loadDetail(ac.signal)
    return () => ac.abort()
  }, [showOrgMatrix, loadMatrix, loadDetail])

  useEffect(() => {
    if (!highlightSupplierId || rows.length === 0) return
    const match = rows.find((r) => normTaxId(r.supplier_id) === highlightSupplierId)
    if (!match) return
    const el = rowRefs.current.get(match.supplier_id)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [rows, highlightSupplierId])

  const drillToEntity = useCallback(
    (entityId: string) => {
      f.setEntityId(entityId)
      writeNavQueryParams({ entity_id: entityId })
    },
    [f],
  )

  const tableTitle = isCustomer
    ? ui.customerTopTableTitle.replace('{count}', String(total))
    : ui.supplierTopTableTitle.replace('{count}', String(total))

  return (
    <>
    <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? (
      <PrototypePageHeader
        title={isCustomer ? ui.customerTopTitle : ui.supplierTopTitle}
        note={isCustomer ? ui.customerTopDesc : ui.supplierTopDesc}
        noteTone="plain"
      />
      ) : null}
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {flagContextHint ? <p className="mb-2 text-il-meta text-amber-800">{flagContextHint}</p> : null}
      {f.poolHint && !f.isOrgScope ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
      {orgMemberHint ? <p className="mb-2 text-il-meta text-amber-800">{orgMemberHint}</p> : null}
      {f.orgMembersHint ? <p className="mb-2 text-il-meta text-amber-800">{f.orgMembersHint}</p> : null}
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
        <DwsScopeFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          scopeMode={f.scopeMode}
          onScopeModeChange={f.setScopeMode}
          scopeEntityId={f.scopeEntityId}
          onScopeEntityIdChange={f.setScopeEntityId}
          orgFlatNodes={f.orgFlatNodes}
          orgTreeLoading={f.orgTreeLoading}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.isOrgScope ? f.scopedEntityOptions : f.entityOptions}
          requireEntity={!f.isOrgScope}
          showMinInvoiceCount
          minInvoiceCount={effectiveN}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <p className="mt-2 text-il-meta text-text-3">
          {(isCustomer ? ui.analysisSubjectBothRolesCaliberHint : ui.analysisSubjectCaliberHint).replace(
            '{n}',
            String(effectiveN),
          )}
        </p>
        {onNav && f.entityId.trim() ? (
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() =>
              goAnalysis('entity_profile', {
                stat_year: f.effectiveYear,
                entity_id: f.entityId.trim(),
              })
            }
          >
            {t.sidebar.entityProfile} →
          </button>
        ) : null}
      </Card>

      {showOrgMatrix ? (
        <Card title={ui.scopeOrgTopMatrixTitle}>
          <p className="mb-3 text-il-meta text-text-3">{ui.scopeOrgTopMatrixDesc}</p>
          {!f.scopeEntityId.trim() ? (
            <p className="text-il-meta text-text-3">{ui.pickOrgNodeHint}</p>
          ) : loading ? (
            <p className="text-il-meta text-text-3">{ui.loading}</p>
          ) : matrixRows.length === 0 ? (
            <p className="text-il-meta text-text-3">{ui.emptyOrgScopeMembers}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light text-left text-il-label text-text-3">
                    <th className="py-2 pr-3">{ui.colOrgLevel}</th>
                    <th className="py-2 pr-3">{ui.colEntityName}</th>
                    <th className="py-2 pr-3">{ui.colEntityId}</th>
                    <th className="py-2 pr-3">{ui.colTop1Counterparty}</th>
                    <th className="py-2 pr-3 text-right">{ui.colNetJshj}</th>
                    <th className="py-2 pr-3 text-right">{ui.colTop1Ratio}</th>
                    <th className="py-2 pr-3 text-right">{ui.colTop3Cumulative}</th>
                    <th className="py-2 pr-3 text-right">{ui.colCounterpartyCnt}</th>
                    <th className="py-2 pr-3 text-right">{ui.kpiPurchaseTotal}</th>
                    <th className="py-2 pr-3 text-right">
                      {isCustomer ? ui.customerNewKpiNewTop10 : ui.supplierNewKpiNewTop10}
                    </th>
                    <th className="py-2">{ui.scopeOrgTopDrillDetail}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {matrixRows.map((row) => (
                    <tr key={row.entity_id} className="border-b border-border-light last:border-b-0">
                      <td className="py-2 pr-3 tabular-nums">{row.org_level}</td>
                      <td className="py-2 pr-3">{row.entity_name}</td>
                      <td className="py-2 pr-3 font-mono text-il-meta">{row.entity_id}</td>
                      <td className="py-2 pr-3">
                        <div className="font-medium text-text">{row.top1_name || '—'}</div>
                        {row.top1_id ? (
                          <div className="font-mono text-il-meta text-[12px]">{row.top1_id}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatDwsAmount(row.top1_net_jshj)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatDwsPct(row.top1_amount_ratio)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatDwsPct(row.top3_cumulative_ratio)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.counterparty_cnt}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatDwsAmount(row.total_net_jshj)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.new_top10}</td>
                      <td className="py-2">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => drillToEntity(row.entity_id)}
                        >
                          {ui.scopeOrgTopDrillDetail}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {matrixTotal > matrixRows.length ? (
                <p className="mt-2 text-il-meta text-text-3">
                  共 {matrixTotal} 家，当前展示 {matrixRows.length} 家
                </p>
              ) : null}
            </div>
          )}
        </Card>
      ) : (
        <Card title={tableTitle}>
          {f.isOrgScope && !f.scopeEntityId.trim() ? (
            <p className="text-il-meta text-text-3">{ui.pickOrgNodeHint}</p>
          ) : !f.entityId.trim() ? (
            <p className="text-il-meta text-text-3">
              {f.isOrgScope ? ui.scopeOrgPickEntityHint : ui.pickEntityHint}
            </p>
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
      )}

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
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
