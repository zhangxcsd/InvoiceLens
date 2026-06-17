import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from './DimTablePagination'
import {
  fetchTaxCodeEnterpriseSummary,
  postTaxCodeSyncFlags,
  type TaxCodeEnterpriseRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { formatDwsPct, useDwsFilters } from '../dws/useDwsFilters'
import { readNavQueryParams } from '../utils/navHelpers'

export function TaxCodeEnterpriseAnalysisPage() {
  const ui = t.taxCodeEnterpriseUi
  const pagUi = t.dimDataTableUi
  const dash = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const f = useDwsFilters(false, { entityPool: 'analysis', initFromUrl: true })
  const [enterpriseKeyword, setEnterpriseKeyword] = useState(urlQuery.keyword ?? urlQuery.goods_name ?? '')
  const [industry, setIndustry] = useState('all')
  const [rows, setRows] = useState<TaxCodeEnterpriseRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [categoryOptions, setCategoryOptions] = useState<string[]>([])
  const [kpis, setKpis] = useState({
    enterprise_coverage: 0,
    high_risk_enterprise_count: 0,
    top_category_concentration: 0,
    monthly_mutation_rate: null as number | null,
  })
  const [hint, setHint] = useState<string | null>(null)
  const [fluctuationHint, setFluctuationHint] = useState<string | null>(null)
  const [fluctuation, setFluctuation] = useState<{
    fluctuation_index: number | null
    fluctuation_level: string | null
    baseline_month: number | null
    compare_month: number | null
    top_movers: Array<{ category_prefix: string; delta_share: number }>
  } | null>(null)
  const [caliberHint, setCaliberHint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const poolCaliberHint = dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))

  const yearOptions = useMemo(() => {
    const merged = new Set<string>(f.yearOptions)
    return [...merged].sort((a, b) => Number(b) - Number(a))
  }, [f.yearOptions])

  const deepGoodsName = urlQuery.goods_name?.trim() || undefined
  const deepSlvNum = urlQuery.slv_num?.trim() || undefined

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear) return
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchTaxCodeEnterpriseSummary(
          {
            statYear: f.effectiveYear,
            entityId: f.entityId.trim() || urlQuery.entity_id?.trim() || undefined,
            keyword: enterpriseKeyword.trim() || undefined,
            topCategory: industry === 'all' ? undefined : industry,
            goodsName: deepGoodsName,
            slvNum: deepSlvNum,
            page,
            pageSize,
            minInvoiceCount: effectiveN,
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
        const data = res.data
        setRows(data?.rows ?? [])
        setTotal(data?.total ?? 0)
        setCategoryOptions(data?.category_options ?? [])
        setKpis({
          enterprise_coverage: data?.kpis?.enterprise_coverage ?? 0,
          high_risk_enterprise_count: data?.kpis?.high_risk_enterprise_count ?? 0,
          top_category_concentration: data?.kpis?.top_category_concentration ?? 0,
          monthly_mutation_rate: data?.kpis?.monthly_mutation_rate ?? null,
        })
        setHint(data?.hint ?? null)
        setFluctuationHint(data?.fluctuation_hint ?? null)
        setFluctuation({
          fluctuation_index: data?.fluctuation_index ?? null,
          fluctuation_level: data?.fluctuation_level ?? null,
          baseline_month: data?.baseline_month ?? null,
          compare_month: data?.compare_month ?? null,
          top_movers: data?.top_movers ?? [],
        })
        setCaliberHint(data?.caliber_hint ?? null)
        if (data?.stat_years?.length && !data.stat_years.includes(f.effectiveYear)) {
          f.setStatYear(data.stat_years[0] ?? f.effectiveYear)
        }
      } finally {
        setLoading(false)
      }
    },
    [deepGoodsName, deepSlvNum, effectiveN, enterpriseKeyword, f.effectiveYear, f.entityId, f.setStatYear, industry, page, pageSize, ui.loadFailed, urlQuery.entity_id],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [f.effectiveYear, enterpriseKeyword, industry, pageSize, effectiveN])

  const flagContextHint = useMemo(() => {
    const goods = urlQuery.goods_name?.trim()
    const slv = urlQuery.slv_num?.trim()
    if (!goods) return null
    const rate = slv ? `${(parseFloat(slv) * 100).toFixed(1)}%` : '—'
    return dash.flagContextGoodsHint.replace('{goods}', goods).replace('{rate}', rate)
  }, [dash, urlQuery.goods_name, urlQuery.slv_num])

  const kpiItems = useMemo(
    () => [
      {
        label: ui.kpiEnterpriseCoverage,
        value: formatDwsPct(kpis.enterprise_coverage),
        cls: 'text-accent' as const,
      },
      {
        label: ui.kpiHighRiskEnterpriseCount,
        value: String(kpis.high_risk_enterprise_count),
        cls: 'text-danger' as const,
      },
      {
        label: ui.kpiTopCategoryConcentration,
        value: formatDwsPct(kpis.top_category_concentration),
        cls: 'text-warn' as const,
      },
      {
        label: ui.kpiMonthlyMutationRate,
        value:
          kpis.monthly_mutation_rate != null
            ? formatDwsPct(kpis.monthly_mutation_rate)
            : ui.kpiMonthlyMutationPending,
        cls: 'text-text' as const,
      },
    ],
    [kpis, ui],
  )

  const syncFlags = async () => {
    if (!f.effectiveYear) return
    setSyncing(true)
    setSyncMsg(null)
    const res = await postTaxCodeSyncFlags({
      statYear: f.effectiveYear,
      minLineCount: effectiveN,
    })
    setSyncing(false)
    if (!res.ok) {
      setErr(res.error?.message ?? ui.syncFlagsFailed)
      return
    }
    setSyncMsg(
      ui.syncFlagsOk
        .replace('{inserted}', String(res.inserted ?? 0))
        .replace('{updated}', String(res.updated ?? 0))
        .replace('{skipped}', String(res.skipped_confirmed ?? 0)),
    )
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {f.poolHint ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
      {flagContextHint ? <p className="mb-2 text-il-meta text-amber-800">{flagContextHint}</p> : null}
      {hint ? <p className="mb-2 text-il-meta text-amber-800">{hint}</p> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpiItems.map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div
              className={[
                'mt-1 text-[20px] font-bold tabular-nums',
                item.cls,
                loading ? 'opacity-50' : '',
              ].join(' ')}
            >
              {loading ? pagUi.tableLoading : item.value}
            </div>
          </div>
        ))}
      </div>

      <Card title={ui.scopeCardTitle}>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.statYearLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={f.effectiveYear}
              onChange={(e) => f.setStatYear(e.target.value)}
              disabled={f.loadingMeta}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.enterpriseKeywordLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={enterpriseKeyword}
              onChange={(e) => setEnterpriseKeyword(e.target.value)}
              placeholder={ui.enterpriseKeywordPlaceholder}
            />
          </div>
          <div>
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.industryLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            >
              <option value="all">{ui.industryAll}</option>
              {categoryOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2 text-il-meta text-text-3">{ui.scopeHint}</p>
        <p className="mt-1 text-il-meta text-text-3">{poolCaliberHint}</p>
        {caliberHint ? (
          <p className="mt-1 text-il-meta text-text-3">
            {ui.caliberHintLabel}：{caliberHint}
          </p>
        ) : null}
        {fluctuationHint ? <p className="mt-1 text-il-meta text-text-3">{fluctuationHint}</p> : null}
      </Card>

      {fluctuation?.fluctuation_index != null ? (
        <Card title={ui.fluctuationCardTitle}>
          <p className="text-il-page-desc text-text-2">
            {ui.fluctuationCompareHint
              .replace('{baseline}', String(fluctuation.baseline_month ?? '—'))
              .replace('{compare}', String(fluctuation.compare_month ?? '—'))}
          </p>
          {fluctuation.top_movers.length > 0 ? (
            <div className="mt-3 overflow-x-auto rounded-sm border border-border-light">
              <table className="w-full border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="px-3 py-2 font-medium">{ui.colMoverCategory}</th>
                    <th className="px-3 py-2 font-medium">{ui.colMoverDelta}</th>
                  </tr>
                </thead>
                <tbody>
                  {fluctuation.top_movers.map((m) => (
                    <tr key={m.category_prefix} className="border-b border-border-light last:border-b-0">
                      <td className="px-3 py-2 font-mono">{m.category_prefix}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDwsPct(m.delta_share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title={ui.syncFlagsBtn}>
        <p className="mb-3 text-il-meta text-text-3">{ui.syncFlagsHint}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={syncing || !f.effectiveYear}
            className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-btn text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void syncFlags()}
          >
            {syncing ? ui.syncFlagsBusy : ui.syncFlagsBtn}
          </button>
          {syncMsg ? <span className="text-il-meta text-text-2">{syncMsg}</span> : null}
        </div>
      </Card>

      <Card title={ui.enterpriseTableTitle}>
        <div className="mb-1 text-il-meta text-text-3">{ui.enterpriseTableHint.replace('{count}', String(total))}</div>
        <div className="mb-2 text-il-meta text-text-3">{ui.topCategoryRuleHint}</div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[920px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colEnterpriseName}</th>
                <th className="px-3 py-2 font-medium">{ui.colTaxpayerId}</th>
                <th className="px-3 py-2 font-medium">{ui.colTopCategory}</th>
                <th className="px-3 py-2 font-medium">{ui.colTopCategoryRatio}</th>
                <th className="px-3 py-2 font-medium">{ui.colHighRiskRatio}</th>
                <th className="px-3 py-2 font-medium">{ui.colFluctuationIndex}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-il-meta text-text-3">
                    {pagUi.tableLoading}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-il-meta text-text-3">
                    {ui.emptyEnterprises}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.taxpayer_id} className="border-b border-border-light last:border-b-0">
                    <td className="px-3 py-2.5 text-text">{row.entity_name}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.taxpayer_id}</td>
                    <td className="px-3 py-2.5">{row.top_category}</td>
                    <td className="px-3 py-2.5">{formatDwsPct(row.top_category_ratio)}</td>
                    <td className="px-3 py-2.5 text-danger">{formatDwsPct(row.high_risk_ratio)}</td>
                    <td className="px-3 py-2.5">
                      {row.fluctuation_index != null ? row.fluctuation_index.toFixed(2) : ui.fluctuationPending}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <DimTablePagination
          total={total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          ui={pagUi}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  )
}
