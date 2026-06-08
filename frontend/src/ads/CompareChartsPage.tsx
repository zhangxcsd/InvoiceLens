import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchCompareChartsSeries,
  fetchCompareMeta,
  type CompareChartPoint,
  type CompareChartsMetric,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { formatDwsAmount } from '../dws/useDwsFilters'

const METRICS: CompareChartsMetric[] = ['amount', 'flags', 'score', 'cr1', 'cancel']

function levelBarClass(level: string): string {
  if (level === '重点关注') return 'bg-danger'
  if (level === '关注') return 'bg-warn'
  return 'bg-green'
}

function fmtMetricValue(metric: CompareChartsMetric, v: number): string {
  if (metric === 'amount') return formatDwsAmount(v)
  if (metric === 'score') return v.toFixed(0)
  if (metric === 'cr1' || metric === 'cancel') return `${(v * 100).toFixed(2)}%`
  return String(Math.round(v))
}

export function CompareChartsPage() {
  const ui = t.compareChartsUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [metric, setMetric] = useState<CompareChartsMetric>('amount')
  const [topN, setTopN] = useState(12)
  const [series, setSeries] = useState<CompareChartPoint[]>([])
  const [riskDist, setRiskDist] = useState({ normal: 0, watch: 0, critical: 0, total: 0 })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const effectiveYear = useMemo(() => {
    const y = statYear.trim()
    if (y && statYears.includes(y)) return y
    return statYears[0] ?? y
  }, [statYear, statYears])

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    const res = await fetchCompareMeta(signal)
    if (signal?.aborted || res.aborted) return
    if (!res.ok) {
      setMetaHint(res.error?.message ?? ui.loadFailed)
      return
    }
    const years = res.stat_years ?? []
    setStatYears(years)
    if (years.length) {
      const cy = String(new Date().getFullYear())
      setStatYear((prev) => (years.includes(prev) ? prev : years.includes(cy) ? cy : years[0]))
    }
    setMetaHint(res.hint ?? null)
  }, [ui.loadFailed])

  const loadSeries = useCallback(async (signal?: AbortSignal) => {
    if (!effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchCompareChartsSeries(
        { statYear: effectiveYear, metric, limit: topN },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setSeries([])
        return
      }
      setSeries(res.series ?? [])
      setRiskDist(res.risk_distribution ?? { normal: 0, watch: 0, critical: 0, total: 0 })
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, metric, topN, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    return () => ac.abort()
  }, [loadMeta])

  useEffect(() => {
    const ac = new AbortController()
    void loadSeries(ac.signal)
    return () => ac.abort()
  }, [loadSeries])

  const maxVal = useMemo(() => Math.max(...series.map((s) => Math.abs(s.value)), 1), [series])
  const distTotal = riskDist.total || 1

  const metricLabel = (m: CompareChartsMetric) => {
    const map: Record<CompareChartsMetric, string> = {
      amount: ui.metricAmount,
      flags: ui.metricFlags,
      score: ui.metricScore,
      cr1: ui.metricCr1,
      cancel: ui.metricCancel,
    }
    return map[m]
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {metaHint ? <p className="text-sm text-warn">{metaHint}</p> : null}
      {err ? <p className="text-sm text-danger">{err}</p> : null}

      <Card title={ui.filterTitle}>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.statYearLabel}</span>
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={effectiveYear}
              onChange={(e) => setStatYear(e.target.value)}
            >
              {statYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.topNLabel}</span>
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
            >
              {[8, 12, 15, 20].map((n) => (
                <option key={n} value={n}>
                  Top {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {METRICS.map((m) => (
            <button
              key={m}
              type="button"
              className={`rounded px-3 py-1 text-sm ${
                metric === m ? 'bg-primary text-white' : 'bg-surface-2 text-text-2'
              }`}
              onClick={() => setMetric(m)}
            >
              {metricLabel(m)}
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={ui.barChartTitle.replace('{metric}', metricLabel(metric))} className="lg:col-span-2">
          {loading ? (
            <p className="text-sm text-text-2">{ui.loading}</p>
          ) : series.length === 0 ? (
            <p className="text-sm text-text-2">{ui.emptyHint}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {series.map((row) => {
                const pct = Math.max(2, Math.round((Math.abs(row.value) / maxVal) * 100))
                return (
                  <div key={row.entity_id} className="grid grid-cols-[minmax(0,8rem)_1fr_minmax(0,4.5rem)] items-center gap-2 text-sm">
                    <div className="truncate text-text-2" title={row.entity_name || row.entity_id}>
                      {row.entity_name || row.entity_id}
                    </div>
                    <div className="h-5 rounded bg-surface-2">
                      <div
                        className={`h-full rounded ${levelBarClass(row.risk_level)}`}
                        style={{ width: `${pct}%` }}
                        title={fmtMetricValue(metric, row.value)}
                      />
                    </div>
                    <div className="text-right tabular-nums text-text">{fmtMetricValue(metric, row.value)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card title={ui.distChartTitle}>
          {loading ? (
            <p className="text-sm text-text-2">{ui.loading}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {[
                { key: 'normal', label: ui.distNormal, count: riskDist.normal, cls: 'bg-green' },
                { key: 'watch', label: ui.distWatch, count: riskDist.watch, cls: 'bg-warn' },
                { key: 'critical', label: ui.distCritical, count: riskDist.critical, cls: 'bg-danger' },
              ].map((d) => (
                <div key={d.key}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{d.label}</span>
                    <span className="tabular-nums text-text-2">
                      {d.count} ({((d.count / distTotal) * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-3 rounded bg-surface-2">
                    <div
                      className={`h-full rounded ${d.cls}`}
                      style={{ width: `${Math.max(2, (d.count / distTotal) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-xs text-text-3">{ui.distHint.replace('{n}', String(riskDist.total))}</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
