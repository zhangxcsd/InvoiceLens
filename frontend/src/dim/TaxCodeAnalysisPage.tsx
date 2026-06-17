import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from './DimTablePagination'
import {
  fetchTaxCodeAnalysisOverview,
  fetchTaxCodeAnalysisUnmatched,
  postTaxCodeSyncFlags,
  type TaxCodeAnalysisOverview,
  type TaxCodeUnmatchedRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { InvoiceDetailDrillPanel } from '../dws/InvoiceDetailDrillPanel'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from '../dws/useDwsFilters'
import { readNavQueryParams } from '../utils/navHelpers'

export function TaxCodeAnalysisPage() {
  const ui = t.taxCodeAnalysisUi
  const pagUi = t.dimDataTableUi
  const dash = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const f = useDwsFilters(false, { initFromUrl: true })
  const [batchKeyword, setBatchKeyword] = useState('')
  const [overview, setOverview] = useState<TaxCodeAnalysisOverview | null>(null)
  const [rows, setRows] = useState<TaxCodeUnmatchedRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [loadingTable, setLoadingTable] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const drillUi = t.invoiceDetailDrillUi

  const deepGoodsName = urlQuery.goods_name?.trim() || undefined
  const deepSlvNum = urlQuery.slv_num?.trim() || undefined
  const flagContextHint = useMemo(() => {
    if (!deepGoodsName) return null
    const rate = deepSlvNum ? `${(parseFloat(deepSlvNum) * 100).toFixed(1)}%` : '—'
    return dash.flagContextGoodsHint.replace('{goods}', deepGoodsName).replace('{rate}', rate)
  }, [dash, deepGoodsName, deepSlvNum])

  const yearOptions = useMemo(() => {
    const fromApi = overview?.stat_years ?? []
    const merged = new Set<string>([...f.yearOptions, ...fromApi])
    return [...merged].sort((a, b) => Number(b) - Number(a))
  }, [f.yearOptions, overview?.stat_years])

  const loadOverview = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear) return
      setLoadingOverview(true)
      try {
        const res = await fetchTaxCodeAnalysisOverview(
          {
            statYear: f.effectiveYear,
            entityId: f.entityId.trim() || undefined,
            goodsName: deepGoodsName,
            slvNum: deepSlvNum,
          },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          setOverview(null)
          return
        }
        setOverview(res.data ?? null)
        if (res.data?.stat_years?.length) {
          const ys = res.data.stat_years
          if (!ys.includes(f.effectiveYear)) {
            f.setStatYear(ys[0] ?? f.effectiveYear)
          }
        }
      } finally {
        setLoadingOverview(false)
      }
    },
    [deepGoodsName, deepSlvNum, f.effectiveYear, f.entityId, f.setStatYear, ui.loadFailed],
  )

  const loadUnmatched = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear) return
      setLoadingTable(true)
      try {
        const res = await fetchTaxCodeAnalysisUnmatched(
          {
            statYear: f.effectiveYear,
            entityId: f.entityId.trim() || undefined,
            keyword: batchKeyword.trim() || undefined,
            goodsName: deepGoodsName,
            slvNum: deepSlvNum,
            page,
            pageSize,
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
        setErr(null)
        setRows(res.rows ?? [])
        setTotal(res.total ?? 0)
      } finally {
        setLoadingTable(false)
      }
    },
    [batchKeyword, deepGoodsName, deepSlvNum, f.effectiveYear, f.entityId, page, pageSize, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void loadOverview(ac.signal)
    return () => ac.abort()
  }, [loadOverview])

  useEffect(() => {
    const ac = new AbortController()
    void loadUnmatched(ac.signal)
    return () => ac.abort()
  }, [loadUnmatched])

  useEffect(() => {
    setPage(1)
  }, [f.effectiveYear, batchKeyword, pageSize])

  const hint = overview?.hint ?? null
  const caliberHint = overview?.caliber_hint ?? null

  const syncFlags = async () => {
    if (!f.effectiveYear) return
    setSyncing(true)
    setSyncMsg(null)
    const res = await postTaxCodeSyncFlags({ statYear: f.effectiveYear })
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

  const kpiItems = useMemo(
    () => [
      {
        label: ui.kpiMatchRate,
        value: formatDwsPct(overview?.match_rate),
        cls: 'text-accent' as const,
      },
      {
        label: ui.kpiUnmatchedLines,
        value: String(overview?.unmatched_line_count ?? '—'),
        cls: 'text-warn' as const,
      },
      {
        label: ui.kpiHighRiskAmountShare,
        value: formatDwsPct(overview?.high_risk_amount_share),
        cls: 'text-danger' as const,
      },
      {
        label: ui.kpiTopCategoryShare,
        value: overview?.top_category_name
          ? `${formatDwsPct(overview.top_category_share)} · ${overview.top_category_name}`
          : formatDwsPct(overview?.top_category_share),
        cls: 'text-text' as const,
      },
    ],
    [overview, ui],
  )

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
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
                loadingOverview ? 'opacity-50' : '',
              ].join(' ')}
            >
              {loadingOverview ? pagUi.tableLoading : item.value}
            </div>
          </div>
        ))}
      </div>

      <Card title={ui.scopeCardTitle}>
        <div className="grid gap-3 md:grid-cols-2">
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
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.batchKeywordLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={batchKeyword}
              onChange={(e) => setBatchKeyword(e.target.value)}
              placeholder={ui.batchKeywordPlaceholder}
            />
          </div>
        </div>
        <p className="mt-2 text-il-meta text-text-3">{ui.scopeHint}</p>
        {caliberHint ? (
          <p className="mt-1 text-il-meta text-text-3">
            {ui.caliberHintLabel}：{caliberHint}
          </p>
        ) : null}
        {overview?.fluctuation_hint ? (
          <p className="mt-1 text-il-meta text-text-3">{overview.fluctuation_hint}</p>
        ) : null}
        {f.entityId.trim() ? (
          <button
            type="button"
            className="mt-2 rounded-sm border border-border bg-white px-2.5 py-1 text-il-page-desc text-accent hover:border-accent"
            onClick={() => setDrillOpen(true)}
          >
            {drillUi.drillFromSummary}
          </button>
        ) : null}
      </Card>

      {overview?.fluctuation_index != null ? (
        <Card title={ui.fluctuationCardTitle}>
          <p className="text-il-page-desc text-text-2">
            {ui.fluctuationCompareHint
              .replace('{baseline}', String(overview.baseline_month ?? '—'))
              .replace('{compare}', String(overview.compare_month ?? '—'))}
            {' · '}
            {overview.fluctuation_index.toFixed(2)}
          </p>
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

      <Card title={ui.unmatchedTableTitle}>
        <div className="mb-2 text-il-meta text-text-3">{ui.unmatchedTableHint}</div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[720px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colSsflbm}</th>
                <th className="px-3 py-2 font-medium">{ui.colLineCount}</th>
                <th className="px-3 py-2 font-medium">{ui.colAmountSum}</th>
                <th className="px-3 py-2 font-medium">{ui.colSampleInvoices}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {loadingTable ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-il-meta text-text-3">
                    {pagUi.tableLoading}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-il-meta text-text-3">
                    {ui.emptyUnmatched}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.ssflbm} className="border-b border-border-light last:border-b-0">
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.ssflbm}</td>
                    <td className="px-3 py-2.5">{row.line_count}</td>
                    <td className="px-3 py-2.5">{formatDwsAmount(row.amount_sum)}</td>
                    <td className="px-3 py-2.5">
                      {row.sample_invoice_count} {ui.sampleInvoicesUnit}
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
          loading={loadingTable}
          ui={pagUi}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </Card>

      <InvoiceDetailDrillPanel
        open={drillOpen}
        onClose={() => setDrillOpen(false)}
        title={drillUi.drillFromSummary}
        filters={{
          statYear: f.effectiveYear,
          entityId: f.entityId.trim() || undefined,
          goodsName: deepGoodsName,
          slvNum: deepSlvNum,
        }}
      />
    </div>
  )
}
