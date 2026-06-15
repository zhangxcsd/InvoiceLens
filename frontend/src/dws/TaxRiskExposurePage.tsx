import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsTaxRiskExposure, type DwsTaxRiskBreakdownRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { navigateToFlagsList, navigateToRelatedGraph, navigateToReportConfig } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'

type Props = { onNav?: (key: import('../types').NavKey) => void }

export function TaxRiskExposurePage({ onNav }: Props) {
  const ui = t.taxRiskExposureUi
  const dash = t.dwsDashboardUi
  const f = useDwsFilters(true, { entityPool: 'analysis', requireBothRoles: true })
  const [totalExposure, setTotalExposure] = useState(0)
  const [highRiskRatio, setHighRiskRatio] = useState(0)
  const [deviationExposure, setDeviationExposure] = useState(0)
  const [rule05Amount, setRule05Amount] = useState(0)
  const [rule08Amount, setRule08Amount] = useState(0)
  const [deviationThresholdPct, setDeviationThresholdPct] = useState(10)
  const [breakdown, setBreakdown] = useState<DwsTaxRiskBreakdownRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectBothRolesCaliberHint.replace('{n}', String(effectiveN))

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setTotalExposure(0)
      setHighRiskRatio(0)
      setDeviationExposure(0)
      setRule05Amount(0)
      setRule08Amount(0)
      setBreakdown([])
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsTaxRiskExposure(
        { statYear: f.effectiveYear, entityId: f.entityId.trim() },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setBreakdown([])
        return
      }
      setTotalExposure(res.total_exposure ?? 0)
      setHighRiskRatio(res.high_risk_ratio ?? 0)
      setDeviationExposure(res.deviation_exposure ?? 0)
      setRule05Amount(res.rule_05_amount ?? 0)
      setRule08Amount(res.rule_08_amount ?? 0)
      setDeviationThresholdPct(res.deviation_threshold_pct ?? 10)
      setBreakdown(res.breakdown ?? [])
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const maxBreakdown = useMemo(
    () => Math.max(...breakdown.map((r) => r.deviation_amount), 1),
    [breakdown],
  )

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
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
        {onNav ? (
          <div className="mt-3 flex flex-wrap gap-3 text-il-meta">
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() =>
                navigateToRelatedGraph(onNav, {
                  statYear: f.effectiveYear,
                  entityId: f.entityId.trim(),
                  source: 'tax_risk',
                })
              }
            >
              {ui.viewGraphLink}
            </button>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() =>
                navigateToReportConfig(onNav, {
                  statYear: f.effectiveYear,
                  entityId: f.entityId.trim(),
                  chapters: ['tax_in_out_deviation', 'audit_flags', 'related'],
                  title: ui.reportTitleHint,
                })
              }
            >
              {ui.reportLink}
            </button>
          </div>
        ) : null}
      </Card>

      {!f.entityId.trim() ? (
        <Card title={ui.kpiTitle}>
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        </Card>
      ) : (
        <>
          <Card title={ui.kpiTitle}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.kpiTotalExposure}</div>
                <div className="mt-1 text-[22px] font-semibold tabular-nums text-danger">
                  {formatDwsAmount(totalExposure)}
                </div>
              </div>
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.kpiHighRiskRatio}</div>
                <div className="mt-1 text-[22px] font-semibold tabular-nums text-warn">
                  {formatDwsPct(highRiskRatio)}
                </div>
              </div>
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.kpiDeviationExposure}</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-text">
                  {formatDwsAmount(deviationExposure)}
                </div>
                <p className="mt-1 text-il-meta text-text-3">
                  {ui.thresholdHint.replace('{pct}', String(deviationThresholdPct))}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-sm border border-border-light px-3 py-2">
                <div className="text-il-label text-text-3">{ui.kpiRule05}</div>
                <div className="mt-1 font-semibold tabular-nums text-text">{formatDwsAmount(rule05Amount)}</div>
                {onNav && rule05Amount > 0 ? (
                  <button
                    type="button"
                    className="mt-1 text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToFlagsList(onNav, {
                        statYear: f.effectiveYear,
                        entityId: f.entityId.trim(),
                        ruleId: 'RULE-05',
                      })
                    }
                  >
                    {ui.viewRuleFlags.replace('{rule}', 'RULE-05')}
                  </button>
                ) : null}
              </div>
              <div className="rounded-sm border border-border-light px-3 py-2">
                <div className="text-il-label text-text-3">{ui.kpiRule08}</div>
                <div className="mt-1 font-semibold tabular-nums text-text">{formatDwsAmount(rule08Amount)}</div>
                {onNav && rule08Amount > 0 ? (
                  <button
                    type="button"
                    className="mt-1 text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToFlagsList(onNav, {
                        statYear: f.effectiveYear,
                        entityId: f.entityId.trim(),
                        ruleId: 'RULE-08',
                      })
                    }
                  >
                    {ui.viewRuleFlags.replace('{rule}', 'RULE-08')}
                  </button>
                ) : null}
              </div>
            </div>
          </Card>

          <Card title={ui.breakdownTitle}>
            {loading ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
            {!loading && breakdown.length === 0 ? (
              <p className="text-il-meta text-text-3">{ui.emptyHint}</p>
            ) : (
              <div className="space-y-3">
                {breakdown.map((r) => (
                  <div key={`${r.tax_bucket}-${r.source}-${r.rule_id ?? ''}`} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-il-label text-text-2">{r.tax_bucket}</span>
                    <div className="h-3 flex-1 rounded-sm bg-bg-2">
                      <div
                        className="h-full rounded-sm bg-danger/70"
                        style={{ width: `${Math.round((r.deviation_amount / maxBreakdown) * 100)}%` }}
                      />
                    </div>
                    <span className="w-28 shrink-0 text-right tabular-nums text-il-meta text-text-2">
                      {formatDwsAmount(r.deviation_amount)}
                    </span>
                    {onNav && r.rule_id ? (
                      <button
                        type="button"
                        className="shrink-0 text-il-meta text-accent hover:underline"
                        onClick={() =>
                          navigateToFlagsList(onNav, {
                            statYear: f.effectiveYear,
                            entityId: f.entityId.trim(),
                            ruleId: r.rule_id ?? undefined,
                          })
                        }
                      >
                        {ui.viewRuleFlags.replace('{rule}', r.rule_id)}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {onNav ? (
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="text-il-meta text-accent hover:underline"
                  onClick={() =>
                    navigateToFlagsList(onNav, {
                      statYear: f.effectiveYear,
                      entityId: f.entityId.trim(),
                    })
                  }
                >
                  {ui.viewFlagsLink}
                </button>
                <button
                  type="button"
                  className="text-il-meta text-accent hover:underline"
                  onClick={() =>
                    navigateToRelatedGraph(onNav, {
                      statYear: f.effectiveYear,
                      entityId: f.entityId.trim(),
                      source: 'tax_risk',
                    })
                  }
                >
                  {ui.viewGraphLink}
                </button>
              </div>
            ) : null}
          </Card>
        </>
      )}
    </div>
  )
}
