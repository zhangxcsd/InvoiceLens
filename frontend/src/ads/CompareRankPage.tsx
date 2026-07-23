import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchCompareMeta,
  fetchCompareRankList,
  postCompareRebuild,
  type CompareSoeOption,
  type ScorecardRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { formatDwsAmount } from '../dws/useDwsFilters'
import { useDimDictDomain } from '../dim/useDimDict'
import { ScorecardRiskLevelBadge, SCORECARD_RISK_COL_CLASS } from '../dm/auditRiskBadge'
import { useLicense } from '../settings/useLicense'
import { handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

type Props = { onNav?: (key: NavKey) => void } & EmbedModeProps

type RiskTab = 'all' | string

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(2)}%`
}

export function CompareRankPage({ onNav, embedMode }: Props) {
  const ui = t.compareRankUi
  const pagUi = t.dimDataTableUi
  const license = useLicense()
  const crossGroupAllowed = license.crossGroupAllowed
  const crossGroupHint = license.crossGroupHint
  const scorecardRiskDict = useDimDictDomain('scorecard_risk_level')
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'compare_rank',
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
  const [riskTab, setRiskTab] = useState<RiskTab>('all')
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<ScorecardRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState({ total: 0, normal: 0, watch: 0, critical: 0 })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [rebuildBusy, setRebuildBusy] = useState(false)
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null)

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

  const loadList = useCallback(async (signal?: AbortSignal) => {
    if (!crossGroupAllowed || !effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchCompareRankList(
        {
          statYear: effectiveYear,
          riskLevel: riskTab === 'all' ? undefined : riskTab,
          keyword: keyword.trim() || undefined,
          soeAnchorId: soeSelectId.trim() || undefined,
          soeAnchorKw: soeSelectId.trim() ? undefined : soeKw.trim() || undefined,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        return
      }
      setRows(res.rows ?? [])
      setTotal(res.total ?? 0)
      setSummary(res.summary ?? { total: 0, normal: 0, watch: 0, critical: 0 })
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, riskTab, keyword, soeSelectId, soeKw, page, pageSize, ui.loadFailed, crossGroupAllowed])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(effectiveYear, ac.signal)
    return () => ac.abort()
  }, [loadMeta, effectiveYear])

  useEffect(() => {
    const ac = new AbortController()
    void loadList(ac.signal)
    return () => ac.abort()
  }, [loadList])

  useEffect(() => {
    setPage(1)
  }, [effectiveYear, riskTab, keyword, soeSelectId, soeKw])

  const onRebuild = async () => {
    if (!crossGroupAllowed) return
    setRebuildBusy(true)
    setRebuildMsg(null)
    try {
      const res = await postCompareRebuild({ statYear: effectiveYear })
      if (!res.ok) {
        setRebuildMsg(res.error?.message ?? ui.rebuildFailed)
        return
      }
      const cnt = res.total_inserted ?? res.year_results?.[0]?.inserted ?? 0
      setRebuildMsg(ui.rebuildSuccess.replace('{year}', effectiveYear).replace('{count}', String(cnt)))
      await loadMeta(effectiveYear)
      await loadList()
    } finally {
      setRebuildBusy(false)
    }
  }

  const riskTabs: { id: RiskTab; label: string }[] = useMemo(
    () => [
      { id: 'all', label: ui.riskAll },
      ...scorecardRiskDict.options.map((o) => ({ id: o.code, label: o.label })),
    ],
    [scorecardRiskDict.options, ui.riskAll],
  )

  const entityCapHint = useMemo(() => {
    if (!crossGroupAllowed || license.maxEntities == null || license.maxEntities <= 0) return null
    return `对比分析按授权最多展示 ${license.maxEntities} 个主体，超出部分已截断。`
  }, [crossGroupAllowed, license.maxEntities])

  return (
    <>
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {!embedMode ? (
        <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      ) : null}
      <LicenseGateBanner hint={crossGroupHint} />
      <LicenseGateBanner hint={entityCapHint} />
      {metaHint ? <p className="text-sm text-warn">{metaHint}</p> : null}

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
          <label className="flex flex-col gap-1 text-sm min-w-[200px]">
            <span className="text-text-2">{ui.keywordLabel}</span>
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder={ui.keywordPlaceholder}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded bg-primary px-4 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={rebuildBusy || !effectiveYear || !crossGroupAllowed}
            onClick={() => void onRebuild()}
          >
            {rebuildBusy ? ui.rebuildBusy : ui.rebuildBtn}
          </button>
        </div>
        {rebuildMsg ? <p className="mt-2 text-sm text-text-2">{rebuildMsg}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {riskTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rounded px-3 py-1 text-sm ${
                riskTab === tab.id ? 'bg-primary text-white' : 'bg-surface-2 text-text-2'
              }`}
              onClick={() => setRiskTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </Card>

      <Card title={ui.summaryTitle}>
        <div className="flex flex-wrap gap-4 text-sm">
          <span>{ui.summaryTotal.replace('{n}', String(summary.total))}</span>
          <span className="text-green">{ui.summaryNormal.replace('{n}', String(summary.normal))}</span>
          <span className="text-warn">{ui.summaryWatch.replace('{n}', String(summary.watch))}</span>
          <span className="text-danger">{ui.summaryCritical.replace('{n}', String(summary.critical))}</span>
        </div>
      </Card>

      <Card title={ui.tableTitle.replace('{count}', String(total))}>
        {err ? <p className="text-sm text-danger">{err}</p> : null}
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-2">{ui.emptyHint}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">{ui.colStateInvestor}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colEntity}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colAmount}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colCount}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colSupplier}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colFlags}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colHigh}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colCr1}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colCancel}</th>
                  <th className="py-2 pr-3 font-medium text-right">{ui.colScore}</th>
                  <th className={`py-2 font-medium ${SCORECARD_RISK_COL_CLASS}`}>{ui.colLevel}</th>
                  {onNav ? <th className="py-2 font-medium">{ui.colAction}</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={r.scorecard_id} className="border-b border-border/60">
                    <td className="py-2 pr-3 text-text-2">{(page - 1) * pageSize + idx + 1}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-text">
                        {r.soe_anchor_enterprise_name?.trim() || ui.colStateInvestorUnassigned}
                      </div>
                      {r.soe_anchor_enterprise_id?.trim() ? (
                        <div className="text-xs text-text-3">{r.soe_anchor_enterprise_id}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-text">{r.entity_name || r.entity_id}</div>
                      <div className="text-xs text-text-3">{r.entity_id}</div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatDwsAmount(r.total_amount)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.total_count.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.supplier_count}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.flag_total}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-danger">{r.flag_high}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(r.cr1)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(r.cancel_ratio)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">{r.risk_score.toFixed(0)}</td>
                    <td className={`py-2 ${SCORECARD_RISK_COL_CLASS}`}>
                      <ScorecardRiskLevelBadge
                        level={r.risk_level}
                        label={scorecardRiskDict.getLabel(r.risk_level)}
                      />
                    </td>
                    {onNav ? (
                      <td className="py-2">
                        <div className="flex flex-col gap-1 text-xs">
                          <button
                            type="button"
                            className="text-left text-accent hover:underline"
                            onClick={() =>
                              goAnalysis('entity_profile', {
                                stat_year: String(r.stat_year),
                                entity_id: r.entity_id,
                              })
                            }
                          >
                            {ui.actionEntityProfile}
                          </button>
                          <button
                            type="button"
                            className="text-left text-accent hover:underline"
                            onClick={() =>
                              goAnalysis('health_score', {
                                stat_year: String(r.stat_year),
                                entity_id: r.entity_id,
                              })
                            }
                          >
                            {ui.actionHealthScore}
                          </button>
                          <button
                            type="button"
                            className="text-left text-accent hover:underline"
                            onClick={() =>
                              goAnalysis('tax_risk_exposure', {
                                stat_year: String(r.stat_year),
                                entity_id: r.entity_id,
                              })
                            }
                          >
                            {ui.actionTaxRiskExposure}
                          </button>
                          <button
                            type="button"
                            className="text-left text-accent hover:underline"
                            onClick={() =>
                              goAnalysis('supplier_top', {
                                stat_year: String(r.stat_year),
                                entity_id: r.entity_id,
                              })
                            }
                          >
                            {ui.actionSupplierTop}
                          </button>
                          <button
                            type="button"
                            className="text-left text-accent hover:underline"
                            onClick={() =>
                              goAnalysis('flags_list', {
                                stat_year: String(r.stat_year),
                                entity_id: r.entity_id,
                              })
                            }
                          >
                            {ui.actionFlagsList}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DimTablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          ui={pagUi}
        />
      </Card>
        </>
      )}
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
