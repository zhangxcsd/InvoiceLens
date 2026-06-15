import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchAllFinanceReconcileDetails,
  fetchFinanceDiffSummary,
  fetchFinanceLedgerBatches,
  fetchFinanceReconcileDetails,
  postFinanceReconcileSyncFlags,
  type FinanceDiffSummary,
  type FinanceLedgerBatch,
  type FinanceReconcileDetailRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import {
  navigateToFlagsList,
  navigateToFlagsTrack,
  navigateToInvoiceExport,
  navigateToRelatedGraph,
  navigateToReportConfig,
  navigateToTaxRiskExposure,
} from '../utils/navHelpers'
import { downloadFinanceReconcileDetailsCsv } from './financeExport'
import { navigateToFinancePage, readFinanceFilterParams } from './financeNav'
import { useFinanceFilters } from './useFinanceFilters'
import { useLicense } from '../settings/useLicense'

type Props = { onNav?: (key: NavKey) => void }

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
}

function fmtMoney(n: number | null) {
  if (n == null) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function periodLabel(year: number, month: number | null) {
  if (month == null || month <= 0) return `${year} 年度`
  return `${year}-${String(month).padStart(2, '0')}`
}

function ruleIdForDiffType(diffType: string): string {
  switch (diffType) {
    case 'A':
      return 'RULE-FIN-INVOICE-ONLY'
    case 'B':
      return 'RULE-FIN-LEDGER-ONLY'
    case 'C':
      return 'RULE-FIN-DIFF'
    case 'D':
      return 'RULE-FIN-OTHER'
    default:
      return 'RULE-FIN-DIFF'
  }
}

function monthDateRange(year: number, month: number | null): { dateFrom: string; dateTo: string } {
  if (month == null || month <= 0) {
    return { dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` }
  }
  const lastDay = new Date(year, month, 0).getDate()
  const mm = String(month).padStart(2, '0')
  return {
    dateFrom: `${year}-${mm}-01`,
    dateTo: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  }
}

export function FinanceDiffPage({ onNav }: Props) {
  const ui = t.financeDiffUi
  const license = useLicense()
  const filters = useFinanceFilters()
  const [batches, setBatches] = useState<FinanceLedgerBatch[]>([])
  const [summary, setSummary] = useState<FinanceDiffSummary | null>(null)
  const [rows, setRows] = useState<FinanceReconcileDetailRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [err, setErr] = useState('')

  const loadData = useCallback(
    async (bid: string, dt: string) => {
      if (!bid) {
        setSummary(null)
        setRows([])
        setTotal(0)
        setLoading(false)
        return
      }
      setLoading(true)
      setErr('')
      const apiParams = {
        batchId: bid,
        statYear: filters.statYearNum,
        entityId: filters.entityId.trim() || undefined,
      }
      const [sumRes, detRes] = await Promise.all([
        fetchFinanceDiffSummary(apiParams),
        fetchFinanceReconcileDetails({
          ...apiParams,
          diffType: dt || undefined,
          limit: 100,
        }),
      ])
      setSummary(sumRes)
      setRows(detRes.rows)
      setTotal(detRes.total)
      if (!sumRes.ok) setErr(sumRes.error?.message ?? ui.loadError)
      else if (!detRes.ok) setErr(detRes.error?.message ?? ui.loadError)
      setLoading(false)
    },
    [filters.statYearNum, filters.entityId, ui.loadError],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await fetchFinanceLedgerBatches({ limit: 50 })
      if (cancelled) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadError)
        setLoading(false)
        return
      }
      setBatches(res.batches)
      const urlBatch = readFinanceFilterParams().batchId
      const first =
        (urlBatch && res.batches.some((b) => b.batch_id === urlBatch) ? urlBatch : '') ||
        res.batches[0]?.batch_id ||
        ''
      filters.setBatchId(first)
      if (first) await loadData(first, filters.diffType)
      else setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 仅挂载时拉批次

  useEffect(() => {
    if (filters.batchId) void loadData(filters.batchId, filters.diffType)
  }, [filters.batchId, filters.diffType, filters.statYearNum, filters.entityId, loadData])

  const onBatchChange = (bid: string) => {
    filters.setBatchId(bid)
    setSyncMsg('')
  }

  const onDiffTypeChange = (dt: string) => {
    filters.setDiffType(dt)
    setSyncMsg('')
  }

  const exportCsv = async () => {
    if (!license.exportAllowed) {
      setErr(license.trialHint ?? ui.exportLicenseDenied)
      return
    }
    if (!filters.batchId) return
    setExporting(true)
    setErr('')
    try {
      let exportRows = rows
      const apiParams = {
        batchId: filters.batchId,
        statYear: filters.statYearNum,
        entityId: filters.entityId.trim() || undefined,
        diffType: filters.diffType || undefined,
      }
      if (total > rows.length) {
        const res = await fetchAllFinanceReconcileDetails(apiParams)
        if (!res.ok) {
          setErr(res.error?.message ?? ui.exportFailed)
          return
        }
        exportRows = res.rows
      }
      if (exportRows.length === 0) {
        setErr(ui.exportEmpty)
        return
      }
      downloadFinanceReconcileDetailsCsv(exportRows, {
        batchId: filters.batchId,
        diffTypeLabels: ui.diffTypes,
        headers: ui.exportColumns,
        fileStem: '差异明细',
      })
    } finally {
      setExporting(false)
    }
  }

  const syncFlags = async () => {
    if (!filters.batchId) return
    setSyncing(true)
    setErr('')
    setSyncMsg('')
    try {
      const res = await postFinanceReconcileSyncFlags({
        batchId: filters.batchId,
        statYear: filters.statYearNum,
        entityId: filters.entityId.trim() || undefined,
      })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.syncFlagsFailed)
        return
      }
      setSyncMsg(
        ui.syncFlagsOk
          .replace('{inserted}', String(res.inserted ?? 0))
          .replace('{skipped}', String(res.skipped_confirmed ?? 0)),
      )
    } finally {
      setSyncing(false)
    }
  }

  const kpi = summary?.kpi
  const byType = summary?.by_type ?? {}

  const kpiValues = [
    kpi ? fmt(kpi.diff_count) : '—',
    kpi ? fmtMoney(kpi.diff_amount_total) : '—',
    kpi ? fmt(kpi.explained_count) : '—',
    kpi ? fmt(kpi.pending_count) : '—',
  ]

  const showActions = Boolean(onNav)

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        actions={
          onNav ? (
            <button
              type="button"
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => navigateToFinancePage(onNav, 'finance_reconcile')}
            >
              {ui.backReconcileBtn}
            </button>
          ) : null
        }
      />

      <LicenseGateBanner hint={license.trialHint} />

      <Card title={ui.kpiTitle}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.batchLabel}</span>
            <select
              className="min-w-[220px] rounded-[7px] border border-border bg-white px-2.5 py-1.5 text-il-btn"
              value={filters.batchId}
              onChange={(e) => onBatchChange(e.target.value)}
            >
              <option value="">{ui.batchPlaceholder}</option>
              {batches.map((b) => (
                <option key={b.batch_id} value={b.batch_id}>
                  {b.batch_name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.statYearLabel}</span>
            <select
              className="min-w-[120px] rounded-[7px] border border-border bg-white px-2.5 py-1.5 text-il-btn"
              value={filters.effectiveYear}
              onChange={(e) => filters.setStatYear(e.target.value)}
            >
              {filters.yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.entityLabel}</span>
            <select
              className="min-w-[200px] rounded-[7px] border border-border bg-white px-2.5 py-1.5 text-il-btn"
              value={filters.entityId}
              onChange={(e) => filters.setEntityId(e.target.value)}
            >
              <option value="">{ui.entityAll}</option>
              {filters.entityOptions.map((o) => (
                <option key={o.entity_id} value={o.entity_id}>
                  {o.entity_name || o.entity_id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.filterAll}</span>
            <select
              className="min-w-[160px] rounded-[7px] border border-border bg-white px-2.5 py-1.5 text-il-btn"
              value={filters.diffType}
              onChange={(e) => onDiffTypeChange(e.target.value)}
            >
              <option value="">{ui.filterAll}</option>
              {ui.diffTypes.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.code} · {row.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={loading || syncing || !filters.batchId}
            className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-btn text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void syncFlags()}
          >
            {syncing ? ui.syncFlagsBusy : ui.syncFlagsBtn}
          </button>
        </div>
        <p className="mb-3 text-il-meta text-text-3">{ui.kpiHint}</p>
        <p className="mb-3 text-il-meta text-text-3">{ui.syncFlagsHint}</p>
        {syncMsg ? <p className="mb-3 text-il-meta text-accent">{syncMsg}</p> : null}
        {err ? <p className="mb-3 text-il-meta text-danger">{err}</p> : null}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {ui.kpiItems.map((item, i) => (
            <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
              <div className="text-il-label text-text-3">{item.label}</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums text-text">
                {loading ? '…' : kpiValues[i]}
              </div>
              {!loading && !kpi && <div className="mt-0.5 text-il-soon text-text-3">{ui.noData}</div>}
            </div>
          ))}
        </div>
      </Card>

      <Card title={ui.typeTitle}>
        <div className="flex flex-col gap-2">
          {ui.diffTypes.map((row) => {
            const stat = byType[row.code]
            return (
              <div
                key={row.code}
                className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-sm border border-border-light px-3 py-2.5"
              >
                <span className="shrink-0 rounded border border-[#c8dff7] bg-[#f0f7ff] px-1.5 py-0.5 text-il-soon font-semibold text-accent">
                  {row.code}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-il-btn font-medium text-text">{row.name}</span>
                    {stat ? (
                      <span className="text-il-meta tabular-nums text-text-3">
                        {fmt(stat.count)} 笔 · {fmtMoney(stat.diff_amount)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-il-meta leading-relaxed text-text-3">{row.desc}</p>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <Card title={ui.detailTitle}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-il-meta text-text-3">
            {ui.detailHint}
            {total > 0 ? `（共 ${fmt(total)} 条）` : ''}
          </p>
          <button
            type="button"
            disabled={loading || exporting || !filters.batchId || total === 0 || !license.exportAllowed}
            className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void exportCsv()}
          >
            {exporting ? ui.exportBusy : ui.exportCsv}
          </button>
        </div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[720px] border-collapse text-left text-il-meta">
            <thead>
              <tr className="border-b border-border-light bg-[#f5f7fa]">
                {ui.detailColumns.map((col) => (
                  <th key={col} className="px-3 py-2 font-semibold text-text-2">
                    {col}
                  </th>
                ))}
                {showActions ? (
                  <th className="px-3 py-2 font-semibold text-text-2">{ui.colActions}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={ui.detailColumns.length + (showActions ? 1 : 0)}
                    className="px-3 py-10 text-center text-text-3"
                  >
                    {t.dimDataTableUi.tableLoading}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={ui.detailColumns.length + (showActions ? 1 : 0)}
                    className="px-3 py-10 text-center text-text-3"
                  >
                    {ui.detailEmpty}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const { dateFrom, dateTo } = monthDateRange(r.stat_year, r.stat_month)
                  const ruleId = ruleIdForDiffType(r.diff_type)
                  return (
                    <tr key={r.diff_id} className="border-b border-border-light/60 hover:bg-[#fafbfd]">
                      <td className="px-3 py-2 font-mono text-il-soon text-text-2">{r.diff_id}</td>
                      <td className="px-3 py-2 text-text">{r.entity_name || r.tax_id}</td>
                      <td className="px-3 py-2 text-text-2">{r.subject_name || r.subject_code || '—'}</td>
                      <td className="px-3 py-2 tabular-nums text-text-2">
                        {periodLabel(r.stat_year, r.stat_month)}
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-1.5 py-0.5 text-il-soon font-semibold text-accent">
                          {r.diff_type}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-text">{fmtMoney(r.ledger_amount)}</td>
                      <td className="px-3 py-2 tabular-nums text-text">{fmtMoney(r.invoice_net)}</td>
                      <td className="px-3 py-2 tabular-nums text-text">{fmtMoney(r.diff_amount)}</td>
                      <td className="px-3 py-2 text-text-2">{r.status}</td>
                      {showActions ? (
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="text-il-soon text-accent hover:underline"
                              onClick={() =>
                                navigateToTaxRiskExposure(onNav!, {
                                  statYear: String(r.stat_year),
                                  entityId: r.tax_id,
                                })
                              }
                            >
                              {ui.viewTaxRiskBtn}
                            </button>
                            <button
                              type="button"
                              className="text-il-soon text-accent hover:underline"
                              onClick={() =>
                                navigateToRelatedGraph(onNav!, {
                                  statYear: String(r.stat_year),
                                  entityId: r.tax_id,
                                })
                              }
                            >
                              {ui.viewRelatedGraphBtn}
                            </button>
                            <button
                              type="button"
                              className="text-il-soon text-accent hover:underline"
                              onClick={() =>
                                navigateToFlagsList(onNav!, {
                                  statYear: String(r.stat_year),
                                  entityId: r.tax_id,
                                  ruleId,
                                  batchId: filters.batchId,
                                })
                              }
                            >
                              {ui.viewFlagsListBtn}
                            </button>
                            <button
                              type="button"
                              className="text-il-soon text-accent hover:underline"
                              onClick={() =>
                                navigateToFlagsTrack(onNav!, {
                                  statYear: String(r.stat_year),
                                  entityId: r.tax_id,
                                  ruleId,
                                  trackTab: 'pending',
                                })
                              }
                            >
                              {ui.viewFlagsBtn}
                            </button>
                            <button
                              type="button"
                              className="text-il-soon text-accent hover:underline"
                              onClick={() =>
                                navigateToInvoiceExport(onNav!, {
                                  statYear: String(r.stat_year),
                                  entityId: r.tax_id,
                                  dateFrom,
                                  dateTo,
                                })
                              }
                            >
                              {ui.exportInvoiceBtn}
                            </button>
                            <button
                              type="button"
                              className="text-il-soon text-accent hover:underline"
                              onClick={() =>
                                navigateToReportConfig(onNav!, {
                                  statYear: String(r.stat_year),
                                  entityId: r.tax_id,
                                  chapters: ['finance_reconcile', 'flags_track', 'audit_flags'],
                                  title: `${r.stat_year}年度财务账票核对差异报告`,
                                })
                              }
                            >
                              {ui.genReportBtn}
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
