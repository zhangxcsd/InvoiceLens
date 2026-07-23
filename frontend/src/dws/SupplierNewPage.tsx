import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDwsCounterpartyChurnMatrix,
  fetchDwsSupplierChurn,
  type CounterpartyChurnMatrixRow,
  type DwsSupplierChurnRow,
} from '../config/localApi'
import { fetchDwsCustomerChurn } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { DwsOrgSubtreeFilterBar } from './DwsOrgSubtreeFilterBar'
import { formatDwsAmount, formatDwsPct } from './useDwsFilters'
import { useDwsAnalysisScope } from './useDwsAnalysisScope'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

type ChurnKind = 'new' | 'disappeared'

function parseExcludedFromSaved(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => String(x).trim()).filter(Boolean)
}

export function SupplierNewPage({ onNav, embedMode }: { onNav?: (key: NavKey) => void } & EmbedModeProps = {}) {
  const ui = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('supplier_new', embedMode)
  const [roleMode, setRoleMode] = useState<'supplier' | 'customer'>(() => {
    if (urlQuery.role_mode === 'customer') return 'customer'
    const saved = savedUi?.extra?.roleMode
    return saved === 'customer' ? 'customer' : 'supplier'
  })
  const isCustomer = roleMode === 'customer'
  const savedExcluded = parseExcludedFromSaved(savedUi?.extra?.excludedEntityIds)
  const initialScopeMode =
    urlQuery.scope_mode === 'org_mg' || urlQuery.scope_mode === 'org_eq'
      ? urlQuery.scope_mode
      : savedUi?.extra?.scopeMode === 'org_mg' || savedUi?.extra?.scopeMode === 'org_eq'
        ? savedUi.extra.scopeMode
        : undefined
  const f = useDwsAnalysisScope(true, {
    entityPool: 'analysis',
    entityOptionsSource: 'org_union',
    memberSource: 'org_subtree',
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialScopeMode,
    initialScopeEntityId: urlQuery.scope_entity_id ?? String(savedUi?.extra?.scopeEntityId ?? ''),
    initialExcludedEntityIds: urlQuery.excluded_entity_ids
      ? urlQuery.excluded_entity_ids.split(',').map((s) => s.trim()).filter(Boolean)
      : savedExcluded,
  })

  const [kind, setKind] = useState<ChurnKind>(() =>
    savedUi?.extra?.kind === 'disappeared' ? 'disappeared' : 'new',
  )
  const [topOnly, setTopOnly] = useState(() => Boolean(savedUi?.extra?.topOnly))
  const [keyword, setKeyword] = useState(() => String(savedUi?.extra?.keyword ?? ''))
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
  const [matrixRows, setMatrixRows] = useState<CounterpartyChurnMatrixRow[]>([])
  const [matrixTotal, setMatrixTotal] = useState(0)
  const [matrixPriorYear, setMatrixPriorYear] = useState('')

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
      if (params.scope_mode === 'org_mg' || params.scope_mode === 'org_eq' || params.scope_mode === 'entity') {
        f.setScopeMode(params.scope_mode)
      }
      if (params.scope_entity_id) f.setScopeEntityId(params.scope_entity_id)
      if (params.excluded_entity_ids) {
        f.setExcludedEntityIds(
          params.excluded_entity_ids.split(',').map((s) => s.trim()).filter(Boolean),
        )
      }
    },
    [f],
  )

  const { shellProps } = useDwsPageAnalysisShell({
    host: 'supplier_new',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      loading,
      extra: {
        roleMode,
        kind,
        topOnly,
        keyword,
        scopeMode: f.scopeMode,
        scopeEntityId: f.scopeEntityId,
        excludedEntityIds: f.excludedEntityIds,
      },
    },
  })

  const showOrgMatrix = f.isOrgScope && !f.entityId.trim()

  const orgMemberHint = useMemo(() => {
    if (!f.isOrgScope || !f.scopeEntityId.trim() || f.orgMembersLoading) return null
    const name = f.scopeEntityName || f.scopeEntityId
    const activeCount = f.activeOrgMembers.length
    return ui.scopeOrgMemberHint.replace('{name}', name).replace('{count}', String(activeCount))
  }, [
    f.isOrgScope,
    f.scopeEntityId,
    f.scopeEntityName,
    f.activeOrgMembers.length,
    f.orgMembersLoading,
    ui,
  ])

  const loadMatrix = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.scopeEntityId.trim()) {
        setMatrixRows([])
        setMatrixTotal(0)
        setMatrixPriorYear('')
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsCounterpartyChurnMatrix(
          {
            statYear: f.effectiveYear,
            tree: f.orgTree,
            scopeEntityId: f.scopeEntityId.trim(),
            role: isCustomer ? 'customer' : 'supplier',
            memberSource: 'org_subtree',
            excludedEntityIds: f.excludedEntityIds,
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
        setMatrixPriorYear(res.prior_year ?? '')
      } finally {
        setLoading(false)
      }
    },
    [
      f.effectiveYear,
      f.scopeEntityId,
      f.orgTree,
      f.excludedEntityIds,
      isCustomer,
      ui.loadFailed,
    ],
  )

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
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
        const params = {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim(),
          kind,
          topOnly: kind === 'new' ? topOnly : false,
          keyword: keyword.trim() || undefined,
          limit: 100,
        }
        const res = isCustomer
          ? await fetchDwsCustomerChurn(params, signal)
          : await fetchDwsSupplierChurn(params, signal)
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
    },
    [f.effectiveYear, f.entityId, kind, topOnly, keyword, isCustomer, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    if (showOrgMatrix) void loadMatrix(ac.signal)
    else void loadDetail(ac.signal)
    return () => ac.abort()
  }, [showOrgMatrix, loadMatrix, loadDetail])

  const tableTitle = isCustomer
    ? kind === 'new'
      ? ui.customerNewTableNew.replace('{count}', String(total))
      : ui.customerNewTableDisappeared.replace('{count}', String(total))
    : kind === 'new'
      ? ui.supplierNewTableNew.replace('{count}', String(total))
      : ui.supplierNewTableDisappeared.replace('{count}', String(total))

  const drillToEntity = useCallback(
    (entityId: string) => {
      f.setEntityId(entityId)
      writeNavQueryParams({ entity_id: entityId })
    },
    [f],
  )

  return (
    <>
    <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? (
      <PrototypePageHeader
        title={isCustomer ? ui.customerNewTitle : ui.supplierNewTitle}
        note={isCustomer ? ui.customerNewDesc : ui.supplierNewDesc}
        noteTone="plain"
      />
      ) : null}
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {f.poolHint && !f.isOrgScope ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
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
        <DwsOrgSubtreeFilterBar
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
          orgMembers={f.orgMembers}
          orgMembersLoading={f.orgMembersLoading}
          excludedEntityIds={f.excludedEntityIds}
          onExcludedEntityIdsChange={f.setExcludedEntityIds}
        />
        <p className="mt-2 text-il-meta text-text-3">{ui.supplierNewScopeCaliberHint}</p>
      </Card>

      {showOrgMatrix ? (
        <Card title={ui.scopeOrgChurnMatrixTitle}>
          <p className="mb-3 text-il-meta text-text-3">{ui.scopeOrgChurnMatrixDesc}</p>
          {!f.scopeEntityId.trim() ? (
            <p className="text-il-meta text-text-3">{ui.pickOrgNodeHint}</p>
          ) : loading ? (
            <p className="text-il-meta text-text-3">{ui.loading}</p>
          ) : matrixRows.length === 0 ? (
            <p className="text-il-meta text-text-3">{ui.emptyOrgScopeMembers}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light text-left text-il-label text-text-3">
                    <th className="py-2 pr-3">{ui.colOrgLevel}</th>
                    <th className="py-2 pr-3">{ui.colEntityName}</th>
                    <th className="py-2 pr-3">{ui.colEntityId}</th>
                    <th className="py-2 pr-3 text-right">{ui.colInvoiceCnt}</th>
                    <th className="py-2 pr-3 text-right">
                      {isCustomer ? ui.customerNewKpiNew : ui.supplierNewKpiNew}
                    </th>
                    <th className="py-2 pr-3 text-right">
                      {isCustomer ? ui.customerNewKpiNewTop10 : ui.supplierNewKpiNewTop10}
                    </th>
                    <th className="py-2 pr-3 text-right">
                      {isCustomer ? ui.customerNewKpiDisappeared : ui.supplierNewKpiDisappeared}
                    </th>
                    <th className="py-2 pr-3 text-right">{ui.supplierNewKpiCompareYear}</th>
                    <th className="py-2">{ui.scopeOrgChurnDrillDetail}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {matrixRows.map((row) => (
                    <tr key={row.entity_id} className="border-b border-border-light last:border-b-0">
                      <td className="py-2 pr-3 tabular-nums">{row.org_level}</td>
                      <td className="py-2 pr-3">{row.entity_name}</td>
                      <td className="py-2 pr-3 font-mono text-il-meta">{row.entity_id}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.invoice_count}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.new_total}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.new_top10}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.disappeared_total}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.prior_year || matrixPriorYear || '—'}
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => drillToEntity(row.entity_id)}
                        >
                          {ui.scopeOrgChurnDrillDetail}
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
        <>
          {f.entityId.trim() ? (
            <Card title={ui.supplierNewSummaryTitle}>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  {
                    label: isCustomer ? ui.customerNewKpiNew : ui.supplierNewKpiNew,
                    value: summary ? String(summary.new_total) : '—',
                  },
                  {
                    label: isCustomer ? ui.customerNewKpiNewTop10 : ui.supplierNewKpiNewTop10,
                    value: summary ? String(summary.new_top10) : '—',
                  },
                  {
                    label: isCustomer ? ui.customerNewKpiDisappeared : ui.supplierNewKpiDisappeared,
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
              <p className="text-il-meta text-text-3">
                {f.isOrgScope ? ui.scopeOrgPickEntityHint : ui.pickEntityHint}
              </p>
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
                          {k === 'new'
                            ? isCustomer
                              ? ui.customerNewTabNew
                              : ui.supplierNewTabNew
                            : isCustomer
                              ? ui.customerNewTabDisappeared
                              : ui.supplierNewTabDisappeared}
                        </button>
                      ))}
                    </div>
                  </div>
                  {kind === 'new' ? (
                    <label className="flex items-center gap-2 text-il-page-desc text-text-2">
                      <input type="checkbox" checked={topOnly} onChange={(e) => setTopOnly(e.target.checked)} />
                      {ui.supplierNewTopOnly}
                    </label>
                  ) : null}
                  <div className="min-w-0 flex-1 sm:min-w-[14rem]">
                    <label className="mb-1 block text-il-label font-medium text-text-2">{ui.supplierNewKeywordLabel}</label>
                    <input
                      className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                      placeholder={isCustomer ? ui.customerNewKeywordPlaceholder : ui.supplierNewKeywordPlaceholder}
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
                            {loading ? ui.loading : isCustomer ? ui.emptyCustomerChurn : ui.emptySupplierChurn}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
