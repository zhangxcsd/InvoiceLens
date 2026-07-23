import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDwsTradeRelationships,
  type DwsTradeRelationshipRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, useDwsFilters } from './useDwsFilters'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

type RoleFilter = 'all' | '供应商' | '客户' | '往来单位'

const ROLE_BADGE: Record<string, string> = {
  供应商: 'bg-[#e8f4fd] text-[#2b6cb0]',
  客户: 'bg-[#edf7ed] text-[#2f855a]',
  往来单位: 'bg-[#fff8ef] text-[#c05621]',
}

export function TradeRelationshipsPage({
  onNav,
  embedMode,
}: { onNav?: (key: NavKey) => void } & EmbedModeProps = {}) {
  const ui = t.tradeRelationshipsUi
  const dash = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('trade_relationships', embedMode)
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(() => {
    const saved = savedUi?.extra?.roleFilter
    if (saved === '供应商' || saved === '客户' || saved === '往来单位') return saved
    return 'all'
  })
  const [keyword, setKeyword] = useState(
    () =>
      urlQuery.keyword ??
      urlQuery.seller_tax_no ??
      urlQuery.buyer_tax_no ??
      String(savedUi?.extra?.keyword ?? ''),
  )
  const [rows, setRows] = useState<DwsTradeRelationshipRow[]>([])
  const [total, setTotal] = useState(0)
  const [roleSummary, setRoleSummary] = useState<Record<string, number>>({})
  const [hint, setHint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
    },
    [f],
  )

  const { shellProps } = useDwsPageAnalysisShell({
    host: 'trade_relationships',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      loading,
      extra: { roleFilter, keyword },
    },
  })

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN)).replace(
    '本页另要求有购方（进项）角色。',
    '本页使用 L1 基础分析主体池（购方或销方任一侧即可）。',
  )
  const flagContextHint = useMemo(() => {
    const buyer = urlQuery.buyer_tax_no?.trim()
    const seller = urlQuery.seller_tax_no?.trim()
    if (!buyer && !seller) return null
    return dash.flagContextInternalHint
      .replace('{buyer}', buyer || '—')
      .replace('{seller}', seller || '—')
  }, [dash, urlQuery.buyer_tax_no, urlQuery.seller_tax_no])

  const counterpartyFilter = useMemo(() => {
    const raw =
      urlQuery.seller_tax_no?.trim() ||
      urlQuery.counterparty_id?.trim() ||
      urlQuery.counterparty_tax_no?.trim() ||
      ''
    return raw ? raw.replace(/[\s-]+/g, '').toUpperCase() : ''
  }, [urlQuery.counterparty_id, urlQuery.counterparty_tax_no, urlQuery.seller_tax_no])

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setRows([])
      setTotal(0)
      setRoleSummary({})
      setHint(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsTradeRelationships(
        {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim(),
          roleFilter,
          keyword: keyword.trim() || undefined,
          counterpartyId: counterpartyFilter || undefined,
          partyATax: urlQuery.buyer_tax_no?.trim() || f.entityId.trim() || undefined,
          partyBTax: urlQuery.seller_tax_no?.trim() || undefined,
          limit: 200,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        setRoleSummary({})
        return
      }
      setRows(res.rows ?? [])
      setTotal(res.total ?? 0)
      setRoleSummary(res.role_summary ?? {})
      setHint(res.hint ?? null)
    } finally {
      setLoading(false)
    }
  }, [counterpartyFilter, f.effectiveYear, f.entityId, keyword, roleFilter, ui.loadFailed, urlQuery.buyer_tax_no, urlQuery.seller_tax_no])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const roleButtons: { key: RoleFilter; label: string }[] = [
    { key: 'all', label: ui.roleAll },
    { key: '供应商', label: ui.roleSupplier },
    { key: '客户', label: ui.roleCustomer },
    { key: '往来单位', label: ui.roleBoth },
  ]

  return (
    <>
    <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" /> : null}
      {flagContextHint ? <p className="mb-2 text-il-meta text-amber-800">{flagContextHint}</p> : null}
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
        <Card title={ui.summaryTitle}>
          <div className="flex flex-wrap gap-3">
            {[
              { label: ui.roleSupplier, count: roleSummary['供应商'] ?? 0 },
              { label: ui.roleCustomer, count: roleSummary['客户'] ?? 0 },
              { label: ui.roleBoth, count: roleSummary['往来单位'] ?? 0 },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5"
              >
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-text">{item.count}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card title={ui.tableTitle.replace('{count}', String(total))}>
        {!f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div>
                <label className="mb-1 block text-il-label font-medium text-text-2">{ui.roleFilterLabel}</label>
                <div className="flex flex-wrap gap-2">
                  {roleButtons.map((rb) => (
                    <button
                      key={rb.key}
                      type="button"
                      className={[
                        'rounded-sm border px-3 py-1.5 text-il-page-desc',
                        roleFilter === rb.key
                          ? 'border-accent bg-accent/10 font-medium text-accent'
                          : 'border-border-light bg-white text-text-2 hover:bg-[#fafbfd]',
                      ].join(' ')}
                      onClick={() => setRoleFilter(rb.key)}
                    >
                      {rb.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-0 flex-1 sm:min-w-[14rem]">
                <label className="mb-1 block text-il-label font-medium text-text-2">{ui.keywordLabel}</label>
                <input
                  className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
                  placeholder={ui.keywordPlaceholder}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
              </div>
            </div>
            {hint ? <p className="mb-2 text-il-meta text-text-3">{hint}</p> : null}
            <div className="overflow-x-auto rounded-sm border border-border-light">
              <table className="w-full min-w-[1000px] border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="px-3 py-2 font-medium">{ui.colCounterpartyName}</th>
                    <th className="px-3 py-2 font-medium">{ui.colCounterpartyId}</th>
                    <th className="px-3 py-2 font-medium">{ui.colRole}</th>
                    <th className="px-3 py-2 font-medium">{ui.colPurchaseAmount}</th>
                    <th className="px-3 py-2 font-medium">{ui.colSalesAmount}</th>
                    <th className="px-3 py-2 font-medium">{ui.colPurchaseCnt}</th>
                    <th className="px-3 py-2 font-medium">{ui.colSalesCnt}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {rows.length > 0 ? (
                    rows.map((r) => {
                      const highlighted =
                        counterpartyFilter !== '' &&
                        r.counterparty_id.replace(/[\s-]+/g, '').toUpperCase() === counterpartyFilter
                      return (
                      <tr
                        key={r.counterparty_id}
                        className={[
                          'border-b border-border-light last:border-b-0',
                          highlighted ? 'bg-amber-50/80' : '',
                        ].join(' ')}
                      >
                        <td className="px-3 py-2 font-medium text-text">{r.counterparty_name || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{r.counterparty_id || '—'}</td>
                        <td className="px-3 py-2">
                          <span
                            className={[
                              'inline-block rounded-sm px-2 py-0.5 text-il-label font-medium',
                              ROLE_BADGE[r.counterparty_role] ?? 'bg-text-3/10 text-text-2',
                            ].join(' ')}
                          >
                            {r.counterparty_role || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{formatDwsAmount(r.purchase_amount)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDwsAmount(r.sales_amount)}</td>
                        <td className="px-3 py-2 tabular-nums">{r.purchase_cnt}</td>
                        <td className="px-3 py-2 tabular-nums">{r.sales_cnt}</td>
                      </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-text-3">
                        {loading ? ui.loading : ui.emptyHint}
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
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
