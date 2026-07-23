import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchCompareChartsSeries,
  fetchCompareMeta,
  type CompareChartPoint,
  type CompareChartsMetric,
  type CompareSoeOption,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { formatDwsAmount } from '../dws/useDwsFilters'
import { scorecardRiskLevelBarClass } from '../dim/dimDictHelpers'
import { useDimDictDomain } from '../dim/useDimDict'
import { useLicense } from '../settings/useLicense'
import { handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'

import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

const METRICS: CompareChartsMetric[] = ['amount', 'flags', 'score', 'cr1', 'cancel']

const SCORECARD_DIST_KEY: Record<string, keyof { normal: number; watch: number; critical: number }> = {
  正常: 'normal',
  关注: 'watch',
  重点关注: 'critical',
}

function levelBarClass(level: string): string {
  return scorecardRiskLevelBarClass(level)
}

function fmtMetricValue(metric: CompareChartsMetric, v: number): string {
  if (metric === 'amount') return formatDwsAmount(v)
  if (metric === 'score') return v.toFixed(0)
  if (metric === 'cr1' || metric === 'cancel') return `${(v * 100).toFixed(2)}%`
  return String(Math.round(v))
}

export function CompareChartsPage({ onNav, embedMode }: { onNav?: (key: NavKey) => void } & EmbedModeProps) {
  const ui = t.compareChartsUi
  const license = useLicense()
  const crossGroupAllowed = license.crossGroupAllowed
  const crossGroupHint = license.crossGroupHint
  const scorecardRiskDict = useDimDictDomain('scorecard_risk_level')
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'compare_charts',
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
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [soeOptions, setSoeOptions] = useState<CompareSoeOption[]>([])
  const [soeSelectId, setSoeSelectId] = useState('')
  const [soeKw, setSoeKw] = useState('')
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

  const loadMeta = useCallback(async (year: string, signal?: AbortSignal) => {
    if (!crossGroupAllowed) return
    const res = await fetchCompareMeta({ statYear: year || undefined }, signal)
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
    setSoeOptions(res.soe_options ?? [])
    setMetaHint(res.hint ?? null)
  }, [ui.loadFailed, crossGroupAllowed])

  const loadSeries = useCallback(async (signal?: AbortSignal) => {
    if (!crossGroupAllowed || !effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchCompareChartsSeries(
        {
          statYear: effectiveYear,
          metric,
          limit: topN,
          soeAnchorId: soeSelectId.trim() || undefined,
          soeAnchorKw: soeSelectId.trim() ? undefined : soeKw.trim() || undefined,
        },
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
  }, [effectiveYear, metric, topN, soeSelectId, soeKw, ui.loadFailed, crossGroupAllowed])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(effectiveYear, ac.signal)
    return () => ac.abort()
  }, [loadMeta, effectiveYear])

  useEffect(() => {
    const ac = new AbortController()
    void loadSeries(ac.signal)
    return () => ac.abort()
  }, [loadSeries])

  const maxVal = useMemo(() => Math.max(...series.map((s) => Math.abs(s.value)), 1), [series])
  const distTotal = riskDist.total || 1

  const distItems = useMemo(
    () =>
      scorecardRiskDict.options.map((o) => {
        const distKey = SCORECARD_DIST_KEY[o.code]
        const count = distKey ? riskDist[distKey] : 0
        return {
          code: o.code,
          label: o.label,
          count,
          cls: scorecardRiskLevelBarClass(o.code),
        }
      }),
    [riskDist, scorecardRiskDict.options],
  )

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
    <>
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {!embedMode ? (
        <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      ) : null}
      <LicenseGateBanner hint={crossGroupHint} />
      {metaHint ? <p className="text-sm text-warn">{metaHint}</p> : null}
      {err ? <p className="text-sm text-danger">{err}</p> : null}

      {!crossGroupAllowed ? (
        <Card title={ui.filterTitle}>
          <p className="text-sm text-text-2">{ui.lockedHint}</p>
        </Card>
      ) : (
        <>
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
          <label className="flex flex-col gap-1 text-sm min-w-[220px]">
            <span className="text-text-2">{ui.soeSelectLabel}</span>
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={soeSelectId}
              onChange={(e) => setSoeSelectId(e.target.value)}
              disabled={!effectiveYear}
            >
              <option value="">{ui.soeSelectAll}</option>
              {soeOptions.map((o) => (
                <option key={o.soe_anchor_enterprise_id} value={o.soe_anchor_enterprise_id}>
                  {o.soe_anchor_enterprise_name || o.soe_anchor_enterprise_id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm min-w-[200px]">
            <span className="text-text-2">{ui.soeKwLabel}</span>
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-60"
              placeholder={ui.soeKwPlaceholder}
              value={soeKw}
              onChange={(e) => setSoeKw(e.target.value)}
              disabled={Boolean(soeSelectId.trim())}
            />
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
                  <div key={row.entity_id} className="flex flex-col gap-1 border-b border-border-light/60 pb-2 last:border-0">
                    <div className="grid grid-cols-[minmax(0,8rem)_1fr_minmax(0,4.5rem)] items-center gap-2 text-sm">
                      <button
                        type="button"
                        className="truncate text-left text-text-2 hover:text-accent hover:underline"
                        title={row.entity_name || row.entity_id}
                        onClick={() =>
                          goAnalysis('compare_rank', {
                            stat_year: effectiveYear,
                            entity_id: row.entity_id,
                          })
                        }
                      >
                        {row.entity_name || row.entity_id}
                      </button>
                      <div className="h-5 rounded bg-surface-2">
                        <div
                          className={`h-full rounded ${levelBarClass(row.risk_level)}`}
                          style={{ width: `${pct}%` }}
                          title={fmtMetricValue(metric, row.value)}
                        />
                      </div>
                      <div className="text-right tabular-nums text-text">{fmtMetricValue(metric, row.value)}</div>
                    </div>
                    {onNav ? (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 pl-[calc(8rem+0.5rem)] text-xs">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() =>
                            goAnalysis('overview_summary', {
                              stat_year: effectiveYear,
                              entity_id: row.entity_id,
                            })
                          }
                        >
                          {ui.actionOverviewSummary}
                        </button>
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() =>
                            goAnalysis('tax_risk_exposure', {
                              stat_year: effectiveYear,
                              entity_id: row.entity_id,
                            })
                          }
                        >
                          {ui.actionTaxRiskExposure}
                        </button>
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() =>
                            goAnalysis('supplier_top', {
                              stat_year: effectiveYear,
                              entity_id: row.entity_id,
                            })
                          }
                        >
                          {ui.actionSupplierTop}
                        </button>
                      </div>
                    ) : null}
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
              {distItems.map((d) => (
                <div key={d.code}>
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
        </>
      )}
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
