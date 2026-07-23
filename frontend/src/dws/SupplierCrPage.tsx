import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDwsCounterpartyCrMatrix,
  fetchDwsSupplierCr,
  type CounterpartyCrMatrixRow,
} from '../config/localApi'
import { fetchDwsCustomerCr } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { DwsScopeFilterBar } from './DwsScopeFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsUrlDeepLinkFilter } from './useDwsFilters'
import { useDwsAnalysisScope, type DwsScopeMode } from './useDwsAnalysisScope'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

function normTaxId(v: string): string {
  return v.replace(/[\s-]+/g, '').toUpperCase()
}

export function SupplierCrPage({
  onNav,
  embedMode,
}: { onNav?: (key: NavKey) => void } & EmbedModeProps = {}) {
  const ui = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('supplier_cr', embedMode)
  const [roleMode, setRoleMode] = useState<'supplier' | 'customer'>(() => {
    if (urlQuery.role_mode === 'customer') return 'customer'
    const saved = savedUi?.extra?.roleMode
    return saved === 'customer' ? 'customer' : 'supplier'
  })
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

  const f = useDwsAnalysisScope(true, {
    entityPool: 'analysis',
    requireBuyer: !isCustomer,
    requireBothRoles: isCustomer,
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })

  const [scopeModeInit] = useState<DwsScopeMode>(() => {
    const saved = savedUi?.extra?.scopeMode
    if (saved === 'org_mg' || saved === 'org_eq' || saved === 'entity') return saved
    if (urlQuery.scope_mode === 'org_mg' || urlQuery.scope_mode === 'org_eq') {
      return urlQuery.scope_mode
    }
    return 'entity'
  })
  const [scopeEntityInit] = useState(
    () => urlQuery.scope_entity_id ?? String(savedUi?.extra?.scopeEntityId ?? ''),
  )

  useEffect(() => {
    if (scopeModeInit !== 'entity') f.setScopeMode(scopeModeInit)
    if (scopeEntityInit) f.setScopeEntityId(scopeEntityInit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cr, setCr] = useState<{
    cr1: number | null
    cr3: number | null
    cr10: number | null
    supplier_cnt: number
    total_net_jshj: number
  } | null>(null)
  const [matrixRows, setMatrixRows] = useState<CounterpartyCrMatrixRow[]>([])
  const [matrixTotal, setMatrixTotal] = useState(0)

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

  const { shellProps } = useDwsPageAnalysisShell({
    host: 'supplier_cr',
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

  const orgMemberHint = useMemo(() => {
    if (!f.isOrgScope || !f.scopeEntityId.trim() || f.orgMembersLoading) return null
    const name = f.scopeEntityName || f.scopeEntityId
    return ui.scopeOrgMemberHint
      .replace('{name}', name)
      .replace('{count}', String(f.orgMembers.length))
  }, [f.isOrgScope, f.scopeEntityId, f.scopeEntityName, f.orgMembers.length, f.orgMembersLoading, ui])

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear) {
      setCr(null)
      setMatrixRows([])
      return
    }
    setLoading(true)
    setErr(null)
    try {
      if (f.isOrgScope) {
        if (!f.scopeEntityId.trim()) {
          setMatrixRows([])
          setCr(null)
          return
        }
        const res = await fetchDwsCounterpartyCrMatrix(
          {
            statYear: f.effectiveYear,
            tree: f.orgTree as 'mg' | 'eq',
            scopeEntityId: f.scopeEntityId.trim(),
            role: isCustomer ? 'customer' : 'supplier',
            requireBuyer: !isCustomer,
            requireBothRoles: isCustomer,
            minInvoiceCount: f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10,
          },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          setMatrixRows([])
          return
        }
        setMatrixRows(res.rows ?? [])
        setMatrixTotal(res.total ?? 0)
        setCr(null)
        if (res.hint && !(res.rows?.length)) setErr(null)
      } else {
        if (!f.entityId.trim()) {
          setCr(null)
          setMatrixRows([])
          return
        }
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
          supplier_cnt:
            (res as { supplier_cnt?: number }).supplier_cnt ??
            (res as { customer_cnt?: number }).customer_cnt ??
            0,
          total_net_jshj: res.total_net_jshj ?? 0,
        })
        setMatrixRows([])
      }
    } finally {
      setLoading(false)
    }
  }, [
    f.effectiveYear,
    f.entityId,
    f.isOrgScope,
    f.scopeEntityId,
    f.orgTree,
    f.minInvoiceCount,
    f.defaultMinInvoiceCount,
    deepLink.timeFilterParams,
    isCustomer,
    ui.loadFailed,
  ])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const drillToTop = useCallback(
    (entityId: string) => {
      if (!onNav) return
      onNav('supplier_top')
      writeNavQueryParams({
        stat_year: f.effectiveYear,
        entity_id: entityId,
        scope_mode: f.scopeMode,
        scope_entity_id: f.scopeEntityId || undefined,
        role_mode: roleMode,
      })
    },
    [onNav, f.effectiveYear, f.scopeMode, f.scopeEntityId, roleMode],
  )

  return (
    <>
      <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
        {!embedMode ? (
          <PrototypePageHeader
            title={isCustomer ? ui.customerCrTitle : ui.supplierCrTitle}
            note={isCustomer ? ui.customerCrDesc : ui.supplierCrDesc}
            noteTone="plain"
          />
        ) : null}
        {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
        {deepLink.flagContextHint ? (
          <p className="mb-2 text-il-meta text-amber-800">{deepLink.flagContextHint}</p>
        ) : null}
        {supplierContextHint ? <p className="mb-2 text-il-meta text-amber-800">{supplierContextHint}</p> : null}
        {f.poolHint && !f.isOrgScope ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
        {f.orgTreeHint && f.isOrgScope ? (
          <p className="mb-2 text-il-meta text-amber-800">{f.orgTreeHint || ui.scopeOrgNodeEmpty}</p>
        ) : null}
        {orgMemberHint ? <p className="mb-2 text-il-meta text-text-3">{orgMemberHint}</p> : null}
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

        {f.isOrgScope ? (
          <Card title={ui.scopeOrgCrMatrixTitle}>
            <p className="mb-3 text-il-meta text-text-3">{ui.scopeOrgCrMatrixDesc}</p>
            {!f.scopeEntityId.trim() ? (
              <p className="text-il-meta text-text-3">{ui.pickOrgNodeHint}</p>
            ) : loading ? (
              <p className="text-il-meta text-text-3">{ui.loading}</p>
            ) : matrixRows.length === 0 ? (
              <p className="text-il-meta text-text-3">{ui.emptyOrgScopeMembers}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-il-page-desc">
                  <thead>
                    <tr className="border-b border-border-light text-left text-il-label text-text-3">
                      <th className="py-2 pr-3">{ui.colOrgLevel}</th>
                      <th className="py-2 pr-3">{ui.colEntityName}</th>
                      <th className="py-2 pr-3">{ui.colEntityId}</th>
                      <th className="py-2 pr-3 text-right">CR1</th>
                      <th className="py-2 pr-3 text-right">CR3</th>
                      <th className="py-2 pr-3 text-right">CR10</th>
                      <th className="py-2 pr-3 text-right">{ui.colCounterpartyCnt}</th>
                      <th className="py-2 pr-3 text-right">{ui.kpiPurchaseTotal}</th>
                      <th className="py-2">{ui.drillToTop}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map((row) => (
                      <tr key={row.entity_id} className="border-b border-border-light/70">
                        <td className="py-2 pr-3 tabular-nums">{row.org_level}</td>
                        <td className="py-2 pr-3">{row.entity_name}</td>
                        <td className="py-2 pr-3 font-mono text-il-meta">{row.entity_id}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatDwsPct(row.cr1)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatDwsPct(row.cr3)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatDwsPct(row.cr10)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{row.counterparty_cnt}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatDwsAmount(row.total_net_jshj)}
                        </td>
                        <td className="py-2">
                          {onNav ? (
                            <button
                              type="button"
                              className="text-accent hover:underline"
                              onClick={() => drillToTop(row.entity_id)}
                            >
                              {ui.drillToTop}
                            </button>
                          ) : (
                            '—'
                          )}
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
        )}
      </div>
      {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
