import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import { fetchHealthScoreSnapshot, type HealthIndicatorRow } from '../config/localApi'
import { DwsFilterBar } from '../dws/DwsFilterBar'
import { useDwsFilters } from '../dws/useDwsFilters'
import { readNavQueryParams } from '../utils/navHelpers'
import { readPanelTargetFromUrl } from '../utils/panelNavQuery'
import type { NavKey } from '../types'
import { AUDIT_RISK_COL_CLASS, AuditRiskLevelBadge, ScorecardRiskLevelBadge } from '../dm/auditRiskBadge'
import { useDimDictDomain } from '../dim/useDimDict'
import { getFlagActionLinks, minimalFlagRowForRule } from '../dm/flagActionHelpers'
import { handleFlagActionOrNavigate, handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { type AnalysisShellTier, type FlagActionTarget } from '../dm/flagActionTarget'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'
import { readHealthScoreUiSnapshot, writeHealthScoreUiSnapshot } from './healthScoreUiState'

type FlagBreakdownRow = {
  rule_id: string
  risk_level: string
  count: number
  amount: number
}

type Level = 'normal' | 'warning' | 'alert'

import type { EmbedModeProps } from '../types/embedMode'

type Props = { onNav?: (key: NavKey) => void } & EmbedModeProps

function snapshotToShellStack(
  items: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>,
): FlagActionTarget[] {
  return items
    .filter((item) => item.nav)
    .map((item) => ({
      nav: item.nav as NavKey,
      params: item.params,
      title: item.title,
      tier: item.tier as AnalysisShellTier,
    }))
}

function levelTag(level: Level) {
  if (level === 'alert') {
    return <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 py-0.5 text-il-label text-danger">异常</span>
  }
  if (level === 'warning') {
    return <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 py-0.5 text-il-label text-warn">预警</span>
  }
  return <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-1.5 py-0.5 text-il-label text-accent">正常</span>
}

export function HealthScorePage({ onNav, embedMode }: Props) {
  const q = t.healthScoreUi
  const scorecardRiskDict = useDimDictDomain('scorecard_risk_level')
  const auditRiskDict = useDimDictDomain('audit_risk_level')
  const initialQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useMemo(() => readHealthScoreUiSnapshot(), [])
  const panelFromUrl = useMemo(() => readPanelTargetFromUrl(), [])
  const scrollRestored = useRef(false)
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    initialStatYear: initialQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: initialQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [dataSource, setDataSource] = useState<string | null>(null)
  const [overview, setOverview] = useState({
    total_score: 0,
    grade: '-',
    risk_level: '',
    change_vs_prev: 0,
    score_formula: '',
    grade_rule: '',
  })
  const [dimensions, setDimensions] = useState<Array<{ dimension_name: string; weight: number; score: number }>>([])
  const [indicators, setIndicators] = useState<HealthIndicatorRow[]>([])
  const [topDeductions, setTopDeductions] = useState<Array<{ indicator_name: string; explain_text: string }>>([])
  const [flagBreakdown, setFlagBreakdown] = useState<FlagBreakdownRow[]>([])
  const [selected, setSelected] = useState<HealthIndicatorRow | null>(null)
  const [onlyAbnormal, setOnlyAbnormal] = useState(() => savedUi?.onlyAbnormal ?? false)
  const [levelFilter, setLevelFilter] = useState<'all' | Level>(() => savedUi?.levelFilter ?? 'all')
  const [dimensionFilter, setDimensionFilter] = useState(() => savedUi?.dimensionFilter ?? 'all')
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const pendingSelectedCode = useRef(savedUi?.selectedIndicatorCode ?? null)

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
    },
    [f],
  )

  const { shellStack, analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'health_score',
    enabled: Boolean(onNav) && !embedMode,
    onNav,
    breadcrumbRootLabel: t.auditFlagUi.analysisShell.breadcrumbHealthScore,
    getInitialStack: () => {
      if (panelFromUrl) return [panelFromUrl]
      if (savedUi?.shellStack?.length) return snapshotToShellStack(savedUi.shellStack)
      return []
    },
    onHostReturn,
  })

  useEffect(() => {
    if (embedMode) return
    writeHealthScoreUiSnapshot({
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      onlyAbnormal,
      levelFilter,
      dimensionFilter,
      selectedIndicatorCode: selected?.indicator_code ?? pendingSelectedCode.current,
      scrollY: window.scrollY,
      shellStack: shellStack.map((item) => ({
        nav: item.nav,
        params: item.params,
        title: item.title,
        tier: item.tier,
      })),
    })
  }, [
    embedMode,
    f.effectiveYear,
    f.entityId,
    f.minInvoiceCount,
    onlyAbnormal,
    levelFilter,
    dimensionFilter,
    selected?.indicator_code,
    shellStack,
  ])

  useEffect(() => {
    if (embedMode || scrollRestored.current || !savedUi?.scrollY) return
    if (loading) return
    scrollRestored.current = true
    requestAnimationFrame(() => window.scrollTo(0, savedUi.scrollY))
  }, [embedMode, loading, savedUi?.scrollY])

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim()) {
        setOverview({
          total_score: 0,
          grade: '-',
          risk_level: '',
          change_vs_prev: 0,
          score_formula: '',
          grade_rule: '',
        })
        setDimensions([])
        setIndicators([])
        setTopDeductions([])
        setFlagBreakdown([])
        setDataSource(null)
        setErr('')
        return
      }
      setLoading(true)
      setErr('')
      const res = await fetchHealthScoreSnapshot({
        statYear: f.effectiveYear,
        entityId: f.entityId.trim(),
        signal,
      })
      setLoading(false)
      if (signal?.aborted) return
      if (!res.ok || !res.overview) {
        setErr(res.error?.message ?? q.loadFailedPrefix)
        return
      }
      setDataSource(res.data_source ?? null)
      setOverview({
        total_score: res.overview.total_score,
        grade: res.overview.grade,
        risk_level: res.overview.risk_level ?? '',
        change_vs_prev: res.overview.change_vs_prev,
        score_formula: res.overview.score_formula,
        grade_rule: res.overview.grade_rule,
      })
      setDimensions(
        (res.dimensions ?? []).map((x) => ({
          dimension_name: x.dimension_name,
          weight: x.weight,
          score: x.score,
        })),
      )
      setIndicators((res.indicators ?? []) as HealthIndicatorRow[])
      setTopDeductions(
        (res.top_deductions ?? []).map((x) => ({
          indicator_name: x.indicator_name,
          explain_text: x.explain_text,
        })),
      )
      setFlagBreakdown(
        (res.flag_breakdown ?? []).map((x) => ({
          rule_id: String(x.rule_id ?? ''),
          risk_level: String(x.risk_level ?? ''),
          count: Number(x.count ?? 0),
          amount: Number(x.amount ?? 0),
        })),
      )
    },
    [f.effectiveYear, f.entityId, q.loadFailedPrefix],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const rows = useMemo(() => {
    return indicators.filter((x) => {
      if (onlyAbnormal && x.level === 'normal') return false
      if (levelFilter !== 'all' && x.level !== levelFilter) return false
      if (dimensionFilter !== 'all' && x.dimension_code !== dimensionFilter) return false
      return true
    })
  }, [onlyAbnormal, levelFilter, dimensionFilter, indicators])

  const dimensionOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const item of indicators) {
      if (!seen.has(item.dimension_code)) {
        seen.set(item.dimension_code, item.dimension_name)
      }
    }
    return Array.from(seen.entries()).map(([code, name]) => ({ code, name }))
  }, [indicators])

  useEffect(() => {
    if (rows.length === 0) {
      setSelected(null)
      return
    }
    setSelected((prev) => {
      if (prev) {
        const exists = rows.some((r) => r.indicator_code === prev.indicator_code)
        if (exists) return prev
      }
      const pending = pendingSelectedCode.current
      if (pending) {
        const match = rows.find((r) => r.indicator_code === pending)
        if (match) {
          pendingSelectedCode.current = null
          return match
        }
      }
      return rows[0] ?? null
    })
  }, [rows])

  useEffect(() => {
    if (!selected) return
    const el = rowRefs.current[selected.indicator_code]
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const flagActionLabels = useMemo(
    () => ({
      viewFinanceDiffBtn: t.auditFlagUi.viewFinanceDiffBtn,
      viewTaxCodeBtn: t.auditFlagUi.viewTaxCodeBtn,
      viewSemanticDetailBtn: t.auditFlagUi.viewSemanticDetailBtn,
      viewQualityTrendBtn: t.auditFlagUi.viewQualityTrendBtn,
      viewQualityBtn: t.auditTrackUi.viewQualityBtn,
      viewInvoiceBtn: t.auditTrackUi.exportInvoiceBtn,
      viewRelatedPairsBtn: t.auditFlagUi.viewRelatedPairsBtn,
      viewRelatedShellBtn: t.auditFlagUi.viewRelatedShellBtn,
      viewRelatedGraphBtn: t.auditFlagUi.viewRelatedGraphBtn,
      viewTradeRelationshipsBtn: t.auditFlagUi.viewTradeRelationshipsBtn,
      viewSupplierTopBtn: t.auditFlagUi.viewSupplierTopBtn,
      viewSupplierCrBtn: t.auditFlagUi.viewSupplierCrBtn,
      viewOverviewTrendBtn: t.auditFlagUi.viewOverviewTrendBtn,
      viewInvoiceTimingBtn: t.auditFlagUi.viewInvoiceTimingBtn,
      viewRedOffsetBtn: t.auditFlagUi.viewRedOffsetBtn,
      viewTaxInOutDevBtn: t.auditFlagUi.viewTaxInOutDevBtn,
      viewTaxRiskExposureBtn: t.auditFlagUi.viewTaxRiskExposureBtn,
      viewTrackBtn: t.auditFlagUi.viewTrackBtn,
      viewFlagsListBtn: t.auditTrackUi.viewFlagsListBtn,
      genReportBtn: t.auditFlagUi.genReportBtn,
    }),
    [],
  )

  return (
    <>
      <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? (
        <div className="mb-5">
          <h1 className="text-il-page-title font-semibold text-text">{q.pageTitle}</h1>
          <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{q.pageDesc}</p>
          {dataSource === 'ads_scorecard' ? (
            <p className="mt-2 text-il-meta text-accent">{q.dataBackedHint}</p>
          ) : null}
        </div>
      ) : null}

      <Card title={q.filterTitle}>
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
          {t.dwsDashboardUi.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))}
        </p>
      </Card>

      {!f.entityId.trim() ? (
        <Card title={q.kpiTotalScore}>
          <p className="text-il-meta text-text-3">{q.pickEntityHint}</p>
        </Card>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
              <div className="text-il-label text-text-3">{q.kpiTotalScore}</div>
              <div className="mt-1 text-[24px] font-bold tabular-nums text-text">{overview.total_score.toFixed(2)}</div>
            </div>
            <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
              <div className="text-il-label text-text-3">{q.kpiGrade}</div>
              <div className="mt-1 text-[24px] font-bold tabular-nums text-accent">
                {overview.grade}
                {overview.risk_level ? (
                  <ScorecardRiskLevelBadge
                    level={overview.risk_level}
                    label={scorecardRiskDict.getLabel(overview.risk_level)}
                    size="large"
                    className="ml-2"
                  />
                ) : null}
              </div>
            </div>
            <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
              <div className="text-il-label text-text-3">{q.kpiChange}</div>
              <div
                className={[
                  'mt-1 text-[24px] font-bold tabular-nums',
                  overview.change_vs_prev >= 0 ? 'text-green-600' : 'text-danger',
                ].join(' ')}
              >
                {overview.change_vs_prev > 0 ? '+' : ''}
                {overview.change_vs_prev.toFixed(2)}
              </div>
            </div>
            <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
              <div className="text-il-label text-text-3">{q.kpiRule}</div>
              <div className="mt-1 text-il-meta leading-relaxed text-text-2">{overview.grade_rule || '-'}</div>
            </div>
          </div>

          {onNav ? (
            <div className="mb-4 flex flex-wrap gap-3">
              <button
                type="button"
                className="text-il-meta text-accent hover:underline"
                onClick={() => {
                  if (!onNav) return
                  handleNavAnalysisAction(
                    'flags_list',
                    { stat_year: f.effectiveYear, entity_id: f.entityId.trim() },
                    onNav,
                    embedMode ? null : analysisHandlers,
                    { closeShell: shellProps ? closeShell : undefined },
                  )
                }}
              >
                {q.viewFlagsLink}
              </button>
            </div>
          ) : null}

          <Card title={q.dimensionTitle}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {dimensions.map((d) => (
                <div key={d.dimension_name} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2">
                  <div className="text-il-label text-text-3">
                    {d.dimension_name} · {(d.weight * 100).toFixed(0)}%
                  </div>
                  <div className="mt-1 text-[20px] font-semibold tabular-nums text-text">{d.score.toFixed(2)}</div>
                </div>
              ))}
            </div>
            {overview.score_formula ? (
              <p className="mt-2 text-il-meta text-text-3">{overview.score_formula}</p>
            ) : null}
          </Card>

          <Card title={q.topDeductionTitle}>
            {topDeductions.length === 0 ? (
              <p className="text-il-meta text-text-3">{q.emptyHint}</p>
            ) : (
              <ul className="list-inside list-disc space-y-1 text-il-page-desc text-text-2">
                {topDeductions.map((x) => (
                  <li key={x.indicator_name}>
                    <span className="font-medium text-text">{x.indicator_name}</span>：{x.explain_text}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={q.flagBreakdownTitle}>
            <p className="mb-3 text-il-meta text-text-3">{q.flagBreakdownLead}</p>
            {flagBreakdown.length === 0 ? (
              <p className="text-il-meta text-text-3">{q.noFlagBreakdown}</p>
            ) : (
              <div className="overflow-auto rounded-sm border border-border-light">
                <table className="w-full min-w-[720px] border-collapse text-il-page-desc">
                  <thead>
                    <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                      <th className="px-2 py-2 font-medium">{q.colRuleId}</th>
                      <th className={`px-2 py-2 font-medium ${AUDIT_RISK_COL_CLASS}`}>{q.colRiskLevel}</th>
                      <th className="px-2 py-2 font-medium">{q.colFlagCount}</th>
                      <th className="px-2 py-2 font-medium">{q.colFlagAmount}</th>
                      {onNav ? <th className="px-2 py-2 font-medium">{q.colAction}</th> : null}
                    </tr>
                  </thead>
                  <tbody className="text-text-2">
                    {flagBreakdown.map((row) => {
                      const mockFlag = minimalFlagRowForRule(row.rule_id, f.entityId.trim())
                      const analysisLinks = getFlagActionLinks(mockFlag, f.effectiveYear, flagActionLabels).filter(
                        (l) => l.id !== 'health_score',
                      )
                      const primaryLink = analysisLinks[0]
                      return (
                        <tr key={`${row.rule_id}::${row.risk_level}`} className="border-b border-border-light last:border-0">
                          <td className="whitespace-nowrap px-2 py-2 font-mono text-[12px]">{row.rule_id}</td>
                          <td className={`px-2 py-2 ${AUDIT_RISK_COL_CLASS}`}>
                            <AuditRiskLevelBadge
                              level={row.risk_level}
                              label={auditRiskDict.getLabel(row.risk_level)}
                            />
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums">{row.count}</td>
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                            {row.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          {onNav ? (
                            <td className="px-2 py-2">
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className="text-il-meta text-accent hover:underline"
                                  onClick={() => {
                                    if (!onNav) return
                                    handleNavAnalysisAction(
                                      'flags_list',
                                      {
                                        stat_year: f.effectiveYear,
                                        entity_id: f.entityId.trim(),
                                        rule_id: row.rule_id,
                                      },
                                      onNav,
                                      embedMode ? null : analysisHandlers,
                                      { closeShell: shellProps ? closeShell : undefined },
                                    )
                                  }}
                                >
                                  {q.viewFlagsForRuleBtn}
                                </button>
                                {primaryLink ? (
                                  <button
                                    type="button"
                                    className="text-il-meta text-accent hover:underline"
                                    onClick={() =>
                                      handleFlagActionOrNavigate(
                                        primaryLink.id,
                                        mockFlag,
                                        f.effectiveYear,
                                        flagActionLabels,
                                        onNav,
                                        analysisHandlers,
                                      )
                                    }
                                  >
                                    {primaryLink.label || q.viewAnalysisBtn}
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={q.indicatorTableTitle}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-il-meta text-text-3">{q.tableLead}</p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="min-w-[140px] rounded-sm border border-border bg-white px-2 py-1 text-il-page-desc text-text outline-none focus:border-accent"
                  value={levelFilter}
                  onChange={(e) => setLevelFilter(e.target.value as 'all' | Level)}
                >
                  <option value="all">{q.levelAll}</option>
                  <option value="normal">{q.levelNormal}</option>
                  <option value="warning">{q.levelWarning}</option>
                  <option value="alert">{q.levelAlert}</option>
                </select>
                <select
                  className="min-w-[170px] rounded-sm border border-border bg-white px-2 py-1 text-il-page-desc text-text outline-none focus:border-accent"
                  value={dimensionFilter}
                  onChange={(e) => setDimensionFilter(e.target.value)}
                >
                  <option value="all">{q.dimensionAll}</option>
                  {dimensionOptions.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-il-page-desc text-text-2">
                  <input type="checkbox" checked={onlyAbnormal} onChange={(e) => setOnlyAbnormal(e.target.checked)} />
                  {q.onlyAbnormal}
                </label>
                <button
                  type="button"
                  className="rounded-sm border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                  onClick={() => {
                    setLevelFilter('all')
                    setDimensionFilter('all')
                    setOnlyAbnormal(false)
                  }}
                >
                  {q.resetFilters}
                </button>
              </div>
            </div>
            <div className="flex items-stretch gap-3">
              <div className="min-w-0 flex-1">
                <div
                  className="h-[560px] overflow-auto rounded-sm border border-border-light outline-none focus:ring-2 focus:ring-accent/20"
                  tabIndex={0}
                >
                  <table className="w-full min-w-[1080px] border-collapse text-il-page-desc">
                    <thead>
                      <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                        <th className="px-2 py-2 font-medium">{q.colIndicator}</th>
                        <th className="px-2 py-2 font-medium">{q.colValue}</th>
                        <th className="px-2 py-2 font-medium">{q.colScore}</th>
                        <th className="px-2 py-2 font-medium">{q.colThreshold}</th>
                        <th className="px-2 py-2 font-medium">{q.colJudgement}</th>
                      </tr>
                    </thead>
                    <tbody className="text-text-2">
                      {rows.map((r) => (
                        <tr
                          key={r.indicator_code}
                          ref={(el) => {
                            rowRefs.current[r.indicator_code] = el
                          }}
                          className={[
                            'border-b border-border-light align-top last:border-0 cursor-pointer',
                            selected?.indicator_code === r.indicator_code ? 'bg-[#f0f7ff]' : 'hover:bg-[#f8fbff]',
                          ].join(' ')}
                          onClick={() => setSelected(r)}
                        >
                          <td className="px-2 py-2">
                            <div className="font-medium text-text">{r.indicator_name}</div>
                            <div className="mt-1 text-il-meta text-text-3">{r.dimension_name}</div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.indicator_value.toFixed(4)}</td>
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.score.toFixed(2)}</td>
                          <td className="px-2 py-2">{r.threshold_text}</td>
                          <td className="whitespace-nowrap px-2 py-2">{levelTag(r.level)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="hidden h-[560px] w-[420px] shrink-0 rounded-[10px] border border-border-light bg-[#fcfdff] xl:block">
                {selected ? (
                  <div className="h-full overflow-auto">
                    <div className="sticky top-0 z-10 border-b border-border-light bg-white/95 px-4 py-3 backdrop-blur">
                      <h2 className="text-il-card-title font-semibold text-text">{q.drawerTitle}</h2>
                      <p className="mt-1 text-il-meta text-text-3">{selected.indicator_name}</p>
                    </div>
                    <div className="space-y-3 px-4 py-3">
                      <div className="rounded-[10px] border border-border-light bg-white p-3 text-il-page-desc text-text-2">
                        <p>
                          <span className="font-medium text-text">{q.formulaLabel}</span>：{selected.formula_text}
                        </p>
                        <p className="mt-1">
                          <span className="font-medium text-text">{q.thresholdLabel}</span>：{selected.threshold_text}
                        </p>
                        <p className="mt-1">
                          <span className="font-medium text-text">{q.sourceLabel}</span>：{selected.data_source_text}
                        </p>
                        <p className="mt-1">
                          <span className="font-medium text-text">{q.explainLabel}</span>：{selected.explain_text}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-il-meta text-text-3">
                    {q.selectHint}
                  </div>
                )}
              </div>
            </div>
            {loading ? <p className="mt-3 text-il-meta text-text-3">{q.loadingText}</p> : null}
            {err ? <p className="mt-3 text-il-meta text-danger">{err}</p> : null}
          </Card>
        </>
      )}
      </div>
      {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
