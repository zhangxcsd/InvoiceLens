import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchFinanceLedgerBatches,
  fetchFinanceReconcileOverview,
  postFinanceLedgerImport,
  type FinanceLedgerBatch,
  type FinanceReconcileOverview,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'
import { useDimDict } from '../dim/useDimDict'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'
import { readFinanceFilterParams } from './financeNav'
import { useFinanceFilters } from './useFinanceFilters'

type Props = { onNav?: (key: NavKey) => void } & EmbedModeProps

function StepCard(props: { index: number; title: string; desc: string }) {
  return (
    <div className="flex gap-3 rounded-sm border border-border-light bg-[#fafbfd] px-4 py-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#c8dff7] bg-[#f0f7ff] text-il-label font-semibold text-accent">
        {props.index}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-il-card-title font-semibold text-text">{props.title}</div>
        <p className="mt-1 text-il-meta leading-relaxed text-text-3">{props.desc}</p>
      </div>
    </div>
  )
}

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
}

function fmtMoney(n: number) {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function FinanceReconcilePage({ onNav, embedMode }: Props) {
  const ui = t.financeReconcileUi
  const dimDict = useDimDict()
  const filters = useFinanceFilters()
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'finance_reconcile',
    enabled: Boolean(onNav) && !embedMode,
    onNav,
    breadcrumbRootLabel: ui.pageTitle,
  })
  const goAnalysis = useCallback(
    (nav: NavKey, params: Record<string, string | undefined>) => {
      if (!onNav) return
      const compact: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') compact[k] = v
      }
      handleNavAnalysisAction(nav, compact, onNav, embedMode ? null : analysisHandlers, {
        closeShell: shellProps ? closeShell : undefined,
      })
    },
    [onNav, embedMode, analysisHandlers, shellProps, closeShell],
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const [batches, setBatches] = useState<FinanceLedgerBatch[]>([])
  const [overview, setOverview] = useState<FinanceReconcileOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  const loadBatches = useCallback(async () => {
    const res = await fetchFinanceLedgerBatches({ limit: 50 })
    if (!res.ok) {
      setErr(res.error?.message ?? ui.loadError)
      return []
    }
    setBatches(res.batches)
    return res.batches
  }, [ui.loadError])

  const loadOverview = useCallback(
    async (bid?: string) => {
      setLoading(true)
      setErr('')
      const res = await fetchFinanceReconcileOverview({
        batchId: bid || undefined,
        statYear: filters.statYearNum,
        entityId: filters.entityId.trim() || undefined,
      })
      setOverview(res)
      if (!res.ok) setErr(res.error?.message ?? ui.loadError)
      setLoading(false)
    },
    [filters.statYearNum, filters.entityId, ui.loadError],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const list = await loadBatches()
      if (cancelled) return
      const urlBatch = readFinanceFilterParams().batchId
      const first =
        (urlBatch && list.some((b) => b.batch_id === urlBatch) ? urlBatch : '') || list[0]?.batch_id || ''
      if (first) {
        filters.setBatchId(first)
        await loadOverview(first)
      } else {
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (filters.batchId) void loadOverview(filters.batchId)
  }, [filters.batchId, filters.statYearNum, filters.entityId, loadOverview])

  const onBatchChange = (bid: string) => {
    filters.setBatchId(bid)
  }

  const onImportClick = () => fileRef.current?.click()

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    setToast('')
    setErr('')
    const res = await postFinanceLedgerImport({ file })
    setImporting(false)
    if (!res.ok) {
      setErr(res.error?.message ?? res.message ?? ui.importFailed)
      return
    }
    setToast(
      ui.importSuccess
        .replace('{count}', String(res.row_count ?? 0))
        .replace('{reject}', String(res.reject_count ?? 0)),
    )
    const list = await loadBatches()
    const nextId = res.batch_id ?? list[0]?.batch_id ?? ''
    if (nextId) {
      filters.setBatchId(nextId)
      await loadOverview(nextId)
    }
  }

  const kpi = overview?.kpi
  const hasData = Boolean(kpi && kpi.total_rows > 0)

  return (
    <>
    <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? (
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        actions={
          onNav ? (
            <button
              type="button"
              className="rounded-[7px] border border-accent bg-white px-3 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff]"
              onClick={() =>
                goAnalysis('finance_diff', {
                  batch_id: filters.batchId,
                  stat_year: filters.effectiveYear,
                  entity_id: filters.entityId,
                })
              }
            >
              {ui.goDiffBtn}
            </button>
          ) : null
        }
      />
      ) : null}

      <Card title={ui.workflowTitle}>
        <div className="flex flex-col gap-3">
          {ui.workflowSteps.map((step, i) => (
            <StepCard key={step.title} index={i + 1} title={step.title} desc={step.desc} />
          ))}
        </div>
      </Card>

      <Card title={ui.actionsTitle}>
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
                  {b.batch_name}（{b.row_count} 行 · {dimDict.getLabel('finance_import_status', b.import_status)})
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
          <button
            type="button"
            className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            disabled={loading || !filters.batchId}
            onClick={() => void loadOverview(filters.batchId)}
          >
            {ui.refreshBtn}
          </button>
          <button
            type="button"
            disabled={importing}
            className="rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onImportClick}
          >
            {importing ? ui.importingBtn : ui.importLedgerBtn}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={onFileChange}
          />
        </div>
        {toast ? <p className="mb-2 text-il-meta text-accent">{toast}</p> : null}
        {err ? <p className="mb-2 text-il-meta text-danger">{err}</p> : null}
        {overview?.hint && !overview.ledger_ready ? (
          <p className="text-il-meta text-text-3">{overview.hint}</p>
        ) : null}
      </Card>

      <Card title={ui.outputTitle}>
        {loading ? (
          <p className="text-il-meta text-text-3">{t.dimDataTableUi.tableLoading}</p>
        ) : !hasData ? (
          <div className="rounded-sm border border-dashed border-border-light bg-[#fafbfd] px-4 py-8 text-center">
            <p className="text-il-meta text-text-3">{ui.outputEmpty}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
              <div className="text-il-label text-text-3">{ui.kpiTotalRows}</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums text-text">{fmt(kpi!.total_rows)}</div>
            </div>
            <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
              <div className="text-il-label text-text-3">{ui.kpiMatched}</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums text-accent">{fmt(kpi!.matched_count)}</div>
            </div>
            <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
              <div className="text-il-label text-text-3">{ui.kpiUnmatched}</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums text-warn">{fmt(kpi!.unmatched_count)}</div>
            </div>
            <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
              <div className="text-il-label text-text-3">{ui.kpiDiffAmount}</div>
              <div className="mt-1 text-[22px] font-semibold tabular-nums text-danger">
                {fmtMoney(kpi!.total_diff_amount)}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
