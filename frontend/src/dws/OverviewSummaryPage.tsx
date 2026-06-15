import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsOverviewSummary, postDwsRebuild } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, useDwsFilters, useDwsUrlDeepLinkFilter } from './useDwsFilters'

export function OverviewSummaryPage() {
  const ui = t.dwsDashboardUi
  const deepLink = useDwsUrlDeepLinkFilter()
  const f = useDwsFilters(false, { initFromUrl: true })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [summary, setSummary] = useState<{
    total_net_jshj: number
    invoice_cnt: number
    output_net_jshj: number
    input_net_jshj: number
    supplier_cnt: number
    quality_issue_cnt: number
    avg_quality_score: number
    red_cnt: number
    cancel_cnt: number
    supplier_cnt_source?: string
    quality_metrics_source?: string
  } | null>(null)
  const [rebuildBusy, setRebuildBusy] = useState(false)
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsOverviewSummary(
        {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim() || undefined,
          ...deepLink.timeFilterParams,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setSummary(null)
        return
      }
      setSummary({
        total_net_jshj: res.total_net_jshj ?? 0,
        invoice_cnt: res.invoice_cnt ?? 0,
        output_net_jshj: res.output_net_jshj ?? 0,
        input_net_jshj: res.input_net_jshj ?? 0,
        supplier_cnt: res.supplier_cnt ?? 0,
        quality_issue_cnt: res.quality_issue_cnt ?? 0,
        avg_quality_score: res.avg_quality_score ?? 0,
        red_cnt: res.red_cnt ?? 0,
        cancel_cnt: res.cancel_cnt ?? 0,
        supplier_cnt_source: res.supplier_cnt_source,
        quality_metrics_source: res.quality_metrics_source,
      })
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, deepLink.timeFilterParams, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const hasTimeFilter = Boolean(
    deepLink.timeFilterParams.statMonth ||
      deepLink.timeFilterParams.dateFrom ||
      deepLink.timeFilterParams.dateTo,
  )
  const caliberHint = useMemo(() => {
    if (!hasTimeFilter) return null
    const parts: string[] = [ui.monthGranularityHint]
    if (summary?.quality_metrics_source === 'dwd_inv_header') {
      parts.push(ui.qualityFilteredHint)
    } else if (summary?.quality_metrics_source === 'dws_quality') {
      parts.push(ui.qualityAnnualHint)
    }
    return parts.join(' ')
  }, [hasTimeFilter, summary?.quality_metrics_source, ui])

  const onRebuild = async () => {
    setRebuildBusy(true)
    setRebuildMsg(null)
    try {
      const res = await postDwsRebuild({ statYears: [f.effectiveYear] })
      if (!res.ok) {
        setRebuildMsg(res.error?.message ?? ui.rebuildFailed)
        return
      }
      setRebuildMsg(ui.rebuildSuccess.replace('{year}', f.effectiveYear))
      await f.reloadMeta()
      await load()
    } finally {
      setRebuildBusy(false)
    }
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.overviewSummaryTitle} note={ui.overviewSummaryDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {deepLink.flagContextHint ? (
        <p className="mb-2 text-il-meta text-amber-800">{deepLink.flagContextHint}</p>
      ) : null}
      {caliberHint ? <p className="mb-2 text-il-meta text-amber-800">{caliberHint}</p> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}
      {rebuildMsg ? <p className="mb-2 text-il-meta text-accent">{rebuildMsg}</p> : null}

      <Card title={ui.filterTitle}>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.entityOptions}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-sm border border-border bg-white px-2.5 py-1 text-il-page-desc text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
            disabled={rebuildBusy || !f.effectiveYear}
            onClick={() => void onRebuild()}
          >
            {rebuildBusy ? ui.rebuildBusy : ui.rebuildBtn}
          </button>
        </div>
        <p className="mt-2 text-il-meta text-text-3">{ui.overviewCaliberHint}</p>
      </Card>

      <Card title={ui.kpiCardTitle}>
        {loading || f.loadingMeta ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: ui.kpiTotalNet, value: formatDwsAmount(summary?.total_net_jshj) },
            { label: ui.kpiInvoiceCnt, value: summary ? String(summary.invoice_cnt) : '—' },
            { label: ui.kpiSupplierCnt, value: summary ? String(summary.supplier_cnt) : '—' },
            { label: ui.kpiQualityScore, value: summary ? summary.avg_quality_score.toFixed(1) : '—' },
            { label: ui.kpiOutputNet, value: formatDwsAmount(summary?.output_net_jshj) },
            { label: ui.kpiInputNet, value: formatDwsAmount(summary?.input_net_jshj) },
            { label: ui.kpiRedCnt, value: summary ? String(summary.red_cnt) : '—' },
            { label: ui.kpiQualityIssues, value: summary ? String(summary.quality_issue_cnt) : '—' },
          ].map((item) => (
            <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
              <div className="text-il-label text-text-3">{item.label}</div>
              <div className="mt-1 text-[16px] font-semibold tabular-nums text-text">{item.value}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
