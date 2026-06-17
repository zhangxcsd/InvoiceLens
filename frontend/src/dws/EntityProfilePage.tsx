import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsEntityProfile, type DwsEntityProfile } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'
import type { NavKey } from '../types'
import {
  navigateToFlagsList,
  navigateToGoodsCategory,
  navigateToCounterpartyRisk,
  navigateToInvoiceTiming,
  navigateToRedOffsetAnalysis,
  navigateToRelatedGraph,
  navigateToSupplierTop,
  navigateToTaxRiskExposure,
  navigateToYearOverYearCompare,
  readNavQueryParams,
} from '../utils/navHelpers'
import { fetchDwsEnterpriseBehaviorProfile } from '../config/dwsDplusApi'
import type { DwsEnterpriseBehaviorMonth } from '../config/localApi'

function fluctuationLevelLabel(level: string | null | undefined, ui: typeof t.entityProfileUi) {
  if (level === 'high') return ui.fluctuationHigh
  if (level === 'medium') return ui.fluctuationMedium
  if (level === 'low') return ui.fluctuationLow
  return ui.fluctuationUnknown
}

type Props = {
  onNav?: (key: NavKey) => void
}

export function EntityProfilePage({ onNav }: Props) {
  const ui = t.entityProfileUi
  const dash = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const f = useDwsFilters(true, { entityPool: 'analysis', requireBuyer: true, initFromUrl: true })
  const [profile, setProfile] = useState<DwsEntityProfile | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'behavior'>('overview')
  const [behaviorMonths, setBehaviorMonths] = useState<DwsEnterpriseBehaviorMonth[]>([])
  const [behaviorLoading, setBehaviorLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim()) {
        setProfile(null)
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsEntityProfile(
          {
            statYear: f.effectiveYear,
            entityId: f.entityId.trim() || urlQuery.entity_id?.trim() || '',
            minInvoiceCount: effectiveN,
          },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          setProfile(null)
          return
        }
        setProfile(res.data ?? null)
      } finally {
        setLoading(false)
      }
    },
    [effectiveN, f.effectiveYear, f.entityId, ui.loadFailed, urlQuery.entity_id],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const loadBehavior = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim() || activeTab !== 'behavior') {
        setBehaviorMonths([])
        return
      }
      setBehaviorLoading(true)
      try {
        const res = await fetchDwsEnterpriseBehaviorProfile(
          { statYear: f.effectiveYear, entityId: f.entityId.trim() },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        setBehaviorMonths(res.ok ? res.months ?? [] : [])
      } finally {
        setBehaviorLoading(false)
      }
    },
    [activeTab, f.effectiveYear, f.entityId],
  )

  useEffect(() => {
    const ac = new AbortController()
    void loadBehavior(ac.signal)
    return () => ac.abort()
  }, [loadBehavior])

  const taxCode = profile?.tax_code

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
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
        <p className="mt-2 text-il-meta text-text-3">
          {dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))}
        </p>
      </Card>

      {!f.entityId.trim() ? (
        <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
      ) : loading ? (
        <p className="text-il-meta text-text-3">{ui.loading}</p>
      ) : profile ? (
        <>
          <Card title={ui.headerCardTitle}>
            <div className="text-[18px] font-semibold text-text">{profile.entity_name}</div>
            <div className="mt-1 font-mono text-il-meta text-text-3">{profile.entity_id}</div>
            <div className="mt-1 text-il-meta text-text-3">{ui.statYearTag.replace('{year}', profile.stat_year)}</div>
            <div className="mt-3 flex gap-2">
              {(['overview', 'behavior'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={[
                    'rounded border px-3 py-1 text-il-meta',
                    activeTab === tab ? 'border-accent bg-accent/5 text-accent' : 'border-border-light text-text-3',
                  ].join(' ')}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'overview' ? ui.tabOverview : ui.tabBehavior}
                </button>
              ))}
            </div>
          </Card>

          {activeTab === 'behavior' ? (
            <Card title={ui.behaviorTitle}>
              {behaviorLoading ? (
                <p className="text-il-meta text-text-3">{ui.loading}</p>
              ) : behaviorMonths.length === 0 ? (
                <p className="text-il-meta text-text-3">{ui.noBehaviorData}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-il-page-desc">
                    <thead>
                      <tr className="border-b border-border-light text-il-label text-text-3">
                        <th className="py-2 pr-2">{ui.colMonth}</th>
                        <th className="py-2 pr-2 text-right">{ui.colInvCnt}</th>
                        <th className="py-2 pr-2 text-right">{ui.colInvAmt}</th>
                        <th className="py-2 pr-2 text-right">{ui.colRedRatio}</th>
                        <th className="py-2 pr-2 text-right">{ui.colMomAmt}</th>
                        <th className="py-2">{ui.colRisk}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {behaviorMonths.map((m) => (
                        <tr key={m.stat_month} className="border-b border-border-light/60">
                          <td className="py-2 pr-2">{m.stat_month}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{m.inv_cnt_total}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{formatDwsAmount(m.inv_amt_total)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{formatDwsPct(m.red_inv_ratio)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{formatDwsPct(m.amt_mom_change)}</td>
                          <td className="py-2">
                            {m.abnormal_red_flag || m.abnormal_spike_flag || m.abnormal_counterparty_concentration_flag
                              ? ui.abnormalTag
                              : m.risk_level || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ) : (
          <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={ui.concentrationTitle}>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'CR1', value: formatDwsPct(profile.concentration.cr1) },
                  { label: 'CR3', value: formatDwsPct(profile.concentration.cr3) },
                  { label: 'CR10', value: formatDwsPct(profile.concentration.cr10) },
                ].map((item) => (
                  <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-2 py-2">
                    <div className="text-il-label text-text-3">{item.label}</div>
                    <div className="mt-1 font-semibold tabular-nums text-text">{item.value}</div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-il-meta text-text-3">
                {ui.purchaseTotalHint.replace('{amount}', formatDwsAmount(profile.concentration.total_net_jshj))}
              </p>
              {profile.concentration.top_suppliers.length > 0 ? (
                <ul className="mt-2 space-y-1 text-il-page-desc text-text-2">
                  {profile.concentration.top_suppliers.map((s) => (
                    <li key={s.supplier_id} className="flex justify-between gap-2">
                      <span className="truncate">{s.supplier_name || s.supplier_id}</span>
                      <span className="shrink-0 tabular-nums">{formatDwsPct(s.amount_ratio)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-il-meta text-text-3">{ui.noSuppliers}</p>
              )}
              {onNav ? (
                <button
                  type="button"
                  className="mt-3 text-il-meta text-accent hover:underline"
                  onClick={() =>
                    navigateToSupplierTop(onNav, {
                      statYear: profile.stat_year,
                      entityId: profile.entity_id,
                    })
                  }
                >
                  {ui.linkSupplierTop}
                </button>
              ) : null}
            </Card>

            <Card title={ui.churnTitle}>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-sm border border-border-light bg-[#fafbfd] px-2 py-2">
                  <div className="text-il-label text-text-3">{ui.newSuppliers}</div>
                  <div className="mt-1 font-semibold text-text">{profile.churn.new_total}</div>
                  <div className="text-il-meta text-text-3">{ui.newTop10.replace('{n}', String(profile.churn.new_top10))}</div>
                </div>
                <div className="rounded-sm border border-border-light bg-[#fafbfd] px-2 py-2">
                  <div className="text-il-label text-text-3">{ui.disappearedSuppliers}</div>
                  <div className="mt-1 font-semibold text-text">{profile.churn.disappeared_total}</div>
                  <div className="text-il-meta text-text-3">
                    {ui.vsPriorYear.replace('{year}', profile.churn.prior_year)}
                  </div>
                </div>
              </div>
            </Card>

            <Card title={ui.taxStructureTitle}>
              {profile.tax_structure.buckets.length === 0 ? (
                <p className="text-il-meta text-text-3">{ui.noTaxBuckets}</p>
              ) : (
                <ul className="space-y-1 text-il-page-desc text-text-2">
                  {profile.tax_structure.buckets.slice(0, 6).map((b) => (
                    <li key={b.tax_bucket} className="flex justify-between gap-2">
                      <span>{b.tax_bucket}</span>
                      <span className="shrink-0 tabular-nums">{formatDwsPct(b.amount_ratio)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={ui.taxCodeTitle}>
              <div className="grid grid-cols-2 gap-2 text-il-page-desc text-text-2">
                <div>
                  <span className="text-text-3">{ui.matchRateLabel}：</span>
                  {formatDwsPct(taxCode?.match_rate)}
                </div>
                <div>
                  <span className="text-text-3">{ui.highRiskShareLabel}：</span>
                  {formatDwsPct(taxCode?.high_risk_amount_share)}
                </div>
                <div className="col-span-2">
                  <span className="text-text-3">{ui.topCategoryLabel}：</span>
                  {taxCode?.top_category_name
                    ? `${taxCode.top_category_name}（${formatDwsPct(taxCode.top_category_share)}）`
                    : '—'}
                </div>
                <div className="col-span-2">
                  <span className="text-text-3">{ui.fluctuationLabel}：</span>
                  {taxCode?.fluctuation_index != null
                    ? `${taxCode.fluctuation_index.toFixed(2)} · ${fluctuationLevelLabel(taxCode.fluctuation_level, ui)}`
                    : ui.fluctuationPending}
                  {taxCode?.baseline_month != null && taxCode?.compare_month != null ? (
                    <span className="text-text-3">
                      {' '}
                      （{taxCode.baseline_month}→{taxCode.compare_month} {ui.monthUnit}）
                    </span>
                  ) : null}
                </div>
              </div>
            </Card>

            <Card title={ui.relatedTitle}>
              <p className="text-il-page-desc text-text-2">
                {ui.graphStats
                  .replace('{nodes}', String(profile.related.graph_node_count))
                  .replace('{edges}', String(profile.related.graph_edge_count))}
              </p>
              {onNav ? (
                <button
                  type="button"
                  className="mt-2 text-il-meta text-accent hover:underline"
                  onClick={() =>
                    navigateToRelatedGraph(onNav, {
                      statYear: profile.stat_year,
                      entityId: profile.entity_id,
                    })
                  }
                >
                  {ui.linkRelatedGraph}
                </button>
              ) : null}
            </Card>

            <Card title={ui.flagsTitle}>
              <p className="text-il-page-desc text-text-2">
                {ui.flagsSummary
                  .replace('{total}', String(profile.audit_flags.total))
                  .replace('{pending}', String(profile.audit_flags.pending))}
              </p>
              {profile.audit_flags.by_rule.length > 0 ? (
                <ul className="mt-2 space-y-1 text-il-page-desc text-text-2">
                  {profile.audit_flags.by_rule.slice(0, 8).map((r) => (
                    <li key={r.rule_id} className="flex justify-between gap-2">
                      <span className="font-mono text-[12px]">{r.rule_id}</span>
                      <span className="shrink-0 tabular-nums">
                        {r.flag_count}
                        {r.pending_count > 0 ? ` (${ui.pendingTag}${r.pending_count})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-il-meta text-text-3">{ui.noFlags}</p>
              )}
              {onNav ? (
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToFlagsList(onNav, {
                        statYear: profile.stat_year,
                        entityId: profile.entity_id,
                      })
                    }
                  >
                    {ui.linkFlagsList}
                  </button>
                  <button
                    type="button"
                    className="text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToTaxRiskExposure(onNav, {
                        statYear: profile.stat_year,
                        entityId: profile.entity_id,
                      })
                    }
                  >
                    {ui.linkTaxRisk}
                  </button>
                </div>
              ) : null}
            </Card>
          </div>

          {profile.customer_concentration ? (
            <Card title={ui.customerConcentrationTitle} className="mt-4">
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'CR1', value: formatDwsPct(profile.customer_concentration.cr1) },
                  { label: 'CR3', value: formatDwsPct(profile.customer_concentration.cr3) },
                  { label: 'CR10', value: formatDwsPct(profile.customer_concentration.cr10) },
                ].map((item) => (
                  <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-2 py-2">
                    <div className="text-il-label text-text-3">{item.label}</div>
                    <div className="mt-1 font-semibold tabular-nums text-text">{item.value}</div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {profile.goods_category?.top_categories && profile.goods_category.top_categories.length > 0 ? (
            <Card title={ui.goodsCategoryTitle} className="mt-4">
              <ul className="space-y-1 text-il-page-desc text-text-2">
                {profile.goods_category.top_categories.map((c) => (
                  <li key={`${c.stat_quarter}-${c.tax_code_short}`} className="flex justify-between gap-2">
                    <span>
                      Q{c.stat_quarter} · {c.tax_code_level2 || c.tax_code_short}
                    </span>
                    <span className="tabular-nums">{formatDwsAmount(c.net_jshj)}</span>
                  </li>
                ))}
              </ul>
              {onNav ? (
                <button
                  type="button"
                  className="mt-2 text-il-meta text-accent hover:underline"
                  onClick={() =>
                    navigateToGoodsCategory(onNav, { statYear: profile.stat_year, entityId: profile.entity_id })
                  }
                >
                  {ui.linkGoodsCategory}
                </button>
              ) : null}
            </Card>
          ) : null}

          {profile.counterparty_risk?.rows && profile.counterparty_risk.rows.length > 0 ? (
            <Card title={ui.counterpartyRiskTitle} className="mt-4">
              <ul className="space-y-1 text-il-page-desc text-text-2">
                {profile.counterparty_risk.rows.map((r) => (
                  <li key={r.counterparty_id} className="flex justify-between gap-2">
                    <span className="truncate">{r.counterparty_name}</span>
                    <span className="shrink-0 tabular-nums">
                      {ui.riskScoreLabel.replace('{score}', r.risk_score.toFixed(1))}
                    </span>
                  </li>
                ))}
              </ul>
              {onNav ? (
                <button
                  type="button"
                  className="mt-2 text-il-meta text-accent hover:underline"
                  onClick={() =>
                    navigateToCounterpartyRisk(onNav, { statYear: profile.stat_year, entityId: profile.entity_id })
                  }
                >
                  {ui.linkCounterpartyRisk}
                </button>
              ) : null}
            </Card>
          ) : null}

          {profile.year_over_year ? (
            <Card title={ui.yoyTitle} className="mt-4">
              <p className="text-il-page-desc text-text-2">
                {ui.yoyChurnHint
                  .replace('{prior}', profile.year_over_year.prior_year)
                  .replace('{new}', String(profile.year_over_year.churn_summary?.new_total ?? 0))
                  .replace('{dis}', String(profile.year_over_year.churn_summary?.disappeared_total ?? 0))}
              </p>
              {onNav ? (
                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToYearOverYearCompare(onNav, { statYear: profile.stat_year, entityId: profile.entity_id })
                    }
                  >
                    {ui.linkYearOverYear}
                  </button>
                  <button
                    type="button"
                    className="text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToRedOffsetAnalysis(onNav, { statYear: profile.stat_year, entityId: profile.entity_id })
                    }
                  >
                    {ui.linkRedOffset}
                  </button>
                  <button
                    type="button"
                    className="text-il-meta text-accent hover:underline"
                    onClick={() =>
                      navigateToInvoiceTiming(onNav, { statYear: profile.stat_year, entityId: profile.entity_id })
                    }
                  >
                    {ui.linkInvoiceTiming}
                  </button>
                </div>
              ) : null}
            </Card>
          ) : null}
          </>
          )}
        </>
      ) : null}
    </div>
  )
}
