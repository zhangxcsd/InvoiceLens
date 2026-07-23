import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import {
  fetchDwdLineageQualityTrend,
  fetchDomainQualityTrend,
  fetchLineageRejectQualityTrend,
  fetchRedInvoiceQualityTrend,
  fetchSemanticQualityTrend,
  type DwdLineageQualityTrendRow,
  type LineageRejectQualityTrendRow,
  type RedInvoiceQualityTrendRow,
  type SemanticQualityTrendRow,
  type StructuredDqTrendRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'
import { QualityBatchSelect } from './QualityBatchSelect'
import { useQualityBatchFilter } from './useQualityBatchFilter'

const q = t.dataQualityPrototype

type TrendDomain =
  | 'red_link'
  | 'lineage_reject'
  | 'dwd_lineage'
  | 'semantic'
  | 'uniqueness'
  | 'tax_id'
  | 'cross_table'
  | 'header_detail'

type BarChartRow = {
  key: string
  anomaly: number
  block: number
  coverage?: number
}

export function DataQualityTrendPage(props: { onNav?: (k: NavKey) => void } & EmbedModeProps) {
  const { onNav, embedMode } = props
  const { batchId, sessionId, setBatchId, batchOptions, batchesLoading } = useQualityBatchFilter()
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'import_quality_trend',
    enabled: Boolean(onNav) && !embedMode,
    onNav,
    breadcrumbRootLabel: q.trendTitle,
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
  const qualityParams = useCallback(() => {
    const out: Record<string, string> = {}
    if (batchId) out.batch_id = batchId
    if (sessionId) out.session_id = sessionId
    return out
  }, [batchId, sessionId])
  const [trendDomain, setTrendDomain] = useState<TrendDomain>('red_link')
  const [granularity, setGranularity] = useState<'week' | 'month'>('week')
  const [redRows, setRedRows] = useState<RedInvoiceQualityTrendRow[]>([])
  const [lineageRows, setLineageRows] = useState<LineageRejectQualityTrendRow[]>([])
  const [dwdLineageRows, setDwdLineageRows] = useState<DwdLineageQualityTrendRow[]>([])
  const [semanticRows, setSemanticRows] = useState<SemanticQualityTrendRow[]>([])
  const [structuredRows, setStructuredRows] = useState<StructuredDqTrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    setLoading(true)
    const structuredDomains = ['uniqueness', 'tax_id', 'cross_table', 'header_detail'] as const
    const fetcher =
      structuredDomains.includes(trendDomain as typeof structuredDomains[number])
        ? fetchDomainQualityTrend({
            domain: trendDomain as 'uniqueness' | 'tax_id' | 'cross_table' | 'header_detail',
            batchId: batchId || undefined,
            sessionId: sessionId || undefined,
            granularity,
            limit: 12,
            signal: ac.signal,
          })
        : trendDomain === 'lineage_reject'
        ? fetchLineageRejectQualityTrend({
            batchId: batchId || undefined,
            sessionId: sessionId || undefined,
            granularity,
            limit: 12,
            signal: ac.signal,
          })
        : trendDomain === 'dwd_lineage'
          ? fetchDwdLineageQualityTrend({
              batchId: batchId || undefined,
              sessionId: sessionId || undefined,
              granularity,
              limit: 12,
              signal: ac.signal,
            })
          : trendDomain === 'semantic'
            ? fetchSemanticQualityTrend({
                batchId: batchId || undefined,
                sessionId: sessionId || undefined,
                granularity,
                limit: 12,
                signal: ac.signal,
              })
            : fetchRedInvoiceQualityTrend({
                batchId: batchId || undefined,
                sessionId: sessionId || undefined,
                granularity,
                limit: 12,
                signal: ac.signal,
              })
    void fetcher.then((res) => {
      if (!alive) return
      setLoading(false)
      if (res.ok) {
        if (structuredDomains.includes(trendDomain as typeof structuredDomains[number])) {
          setStructuredRows(res.rows as StructuredDqTrendRow[])
          setRedRows([])
          setLineageRows([])
          setDwdLineageRows([])
          setSemanticRows([])
        } else if (trendDomain === 'lineage_reject') {
          setLineageRows(res.rows as LineageRejectQualityTrendRow[])
          setRedRows([])
          setDwdLineageRows([])
          setSemanticRows([])
        } else if (trendDomain === 'dwd_lineage') {
          setDwdLineageRows(res.rows as DwdLineageQualityTrendRow[])
          setRedRows([])
          setLineageRows([])
          setSemanticRows([])
        } else if (trendDomain === 'semantic') {
          setSemanticRows(res.rows as SemanticQualityTrendRow[])
          setRedRows([])
          setLineageRows([])
          setDwdLineageRows([])
        } else {
          setRedRows(res.rows as RedInvoiceQualityTrendRow[])
          setLineageRows([])
          setDwdLineageRows([])
          setSemanticRows([])
        }
        setErr('')
      } else {
        setRedRows([])
        setLineageRows([])
        setDwdLineageRows([])
        setSemanticRows([])
        setStructuredRows([])
        setErr(res.error?.message ?? '加载失败')
      }
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [granularity, batchId, sessionId, trendDomain])

  const chartRows: BarChartRow[] = useMemo(() => {
    if (['uniqueness', 'tax_id', 'cross_table', 'header_detail'].includes(trendDomain)) {
      return structuredRows.map((w) => ({
        key: w.period_label,
        anomaly: w.anomaly_count,
        block: w.block_count ?? 0,
      }))
    }
    if (trendDomain === 'lineage_reject') {
      return lineageRows.map((w) => ({
        key: w.period_label,
        anomaly: w.row_reject_count,
        block: w.file_blocking_count,
      }))
    }
    if (trendDomain === 'dwd_lineage') {
      return dwdLineageRows.map((w) => ({
        key: w.period_label,
        anomaly: w.missing_header_count,
        block: w.missing_detail_count,
        coverage: w.coverage_rate,
      }))
    }
    if (trendDomain === 'semantic') {
      return semanticRows.map((w) => ({
        key: w.period_label,
        anomaly: w.missing_spc_tickets,
        block: w.summary_line_count,
      }))
    }
    return redRows.map((w) => ({
      key: w.period_label,
      anomaly: w.unmatched_count,
      block: w.orphan_count,
    }))
  }, [trendDomain, redRows, lineageRows, dwdLineageRows, semanticRows, structuredRows])

  const maxVal = useMemo(() => {
    if (['uniqueness', 'tax_id', 'cross_table', 'header_detail'].includes(trendDomain)) {
      const vals = structuredRows.flatMap((w) => [w.anomaly_count, (w.block_count ?? 0) * 8])
      return Math.max(1, ...vals)
    }
    if (trendDomain === 'dwd_lineage') {
      const vals = dwdLineageRows.flatMap((w) => [w.missing_header_count, w.missing_detail_count * 8])
      return Math.max(1, ...vals)
    }
    if (trendDomain === 'lineage_reject') {
      const vals = lineageRows.flatMap((w) => [w.row_reject_count, w.file_blocking_count * 8])
      return Math.max(1, ...vals)
    }
    if (trendDomain === 'semantic') {
      const vals = semanticRows.flatMap((w) => [w.missing_spc_tickets, w.summary_line_count * 8])
      return Math.max(1, ...vals)
    }
    const vals = redRows.flatMap((w) => [w.unmatched_count, w.orphan_count * 8])
    return Math.max(1, ...vals)
  }, [trendDomain, redRows, lineageRows, dwdLineageRows, semanticRows, structuredRows])

  const periodAxisLabel = granularity === 'month' ? q.trendMonth : q.trendWeek
  const structuredDomainCopy = useMemo(() => {
    const map = {
      uniqueness: {
        lead: q.trendLeadUniqueness,
        note: q.trendNoteUniqueness,
        empty: q.trendEmptyUniqueness,
        anomaly: q.trendAnomalyUniqueness,
        block: q.trendBlockUniqueness,
        anomalyHint: q.trendAnomalyHintUniqueness,
        blockHint: q.trendBlockHintUniqueness,
      },
      tax_id: {
        lead: q.trendLeadTaxId,
        note: q.trendNoteTaxId,
        empty: q.trendEmptyTaxId,
        anomaly: q.trendAnomalyTaxId,
        block: q.trendBlockTaxId,
        anomalyHint: q.trendAnomalyHintTaxId,
        blockHint: q.trendBlockHintTaxId,
      },
      cross_table: {
        lead: q.trendLeadCrossTable,
        note: q.trendNoteCrossTable,
        empty: q.trendEmptyCrossTable,
        anomaly: q.trendAnomalyCrossTable,
        block: q.trendBlockCrossTable,
        anomalyHint: q.trendAnomalyHintCrossTable,
        blockHint: q.trendBlockHintCrossTable,
      },
      header_detail: {
        lead: q.trendLeadHeaderDetail,
        note: q.trendNoteHeaderDetail,
        empty: q.trendEmptyHeaderDetail,
        anomaly: q.trendAnomalyHeaderDetail,
        block: q.trendBlockHeaderDetail,
        anomalyHint: q.trendAnomalyHintHeaderDetail,
        blockHint: q.trendBlockHintHeaderDetail,
      },
    } as const
    return map[trendDomain as keyof typeof map]
  }, [trendDomain, q])
  const trendLead =
    structuredDomainCopy?.lead ??
    (trendDomain === 'lineage_reject'
      ? q.trendLeadLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendLeadDwdLineage
        : trendDomain === 'semantic'
          ? q.trendLeadSemantic
          : q.trendLeadConnected)
  const trendNote =
    structuredDomainCopy?.note ??
    (trendDomain === 'lineage_reject'
      ? q.trendNoteLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendNoteDwdLineage
        : trendDomain === 'semantic'
          ? q.trendNoteSemantic
          : q.trendNoteConnected)
  const anomalyLabel =
    structuredDomainCopy?.anomaly ??
    (trendDomain === 'lineage_reject'
      ? q.trendAnomalyLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendMissingHeader
        : trendDomain === 'semantic'
          ? q.trendAnomalySemantic
          : q.trendAnomaly)
  const blockLabel =
    structuredDomainCopy?.block ??
    (trendDomain === 'lineage_reject'
      ? q.trendBlockLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendMissingDetail
        : trendDomain === 'semantic'
          ? q.trendInfoSemantic
          : q.trendBlock)
  const anomalyHint =
    structuredDomainCopy?.anomalyHint ??
    (trendDomain === 'lineage_reject'
      ? q.trendAnomalyHintLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendMissingHeaderHint
        : trendDomain === 'semantic'
          ? q.trendAnomalyHintSemantic
          : q.trendAnomalyHint)
  const blockHint =
    structuredDomainCopy?.blockHint ??
    (trendDomain === 'lineage_reject'
      ? q.trendBlockHintLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendMissingDetailHint
        : trendDomain === 'semantic'
          ? q.trendInfoHintSemantic
          : q.trendBlockHint)
  const emptyText =
    structuredDomainCopy?.empty ??
    (trendDomain === 'lineage_reject'
      ? q.trendEmptyLineageReject
      : trendDomain === 'dwd_lineage'
        ? q.trendEmptyDwdLineage
        : trendDomain === 'semantic'
          ? q.trendEmptySemantic
          : q.trendEmpty)

  const chartTitle =
    trendDomain === 'dwd_lineage'
      ? `${periodAxisLabel} · ${q.trendMissingHeader} / ${q.trendMissingDetail} / ${q.trendCoverageRate}`
      : `${periodAxisLabel} · ${anomalyLabel} / ${blockLabel}`

  const parseTrendDomain = (v: string): TrendDomain => {
    if (v === 'lineage_reject') return 'lineage_reject'
    if (v === 'dwd_lineage') return 'dwd_lineage'
    if (v === 'semantic') return 'semantic'
    if (v === 'uniqueness') return 'uniqueness'
    if (v === 'tax_id') return 'tax_id'
    if (v === 'cross_table') return 'cross_table'
    if (v === 'header_detail') return 'header_detail'
    return 'red_link'
  }

  return (
    <>
    <div className="mx-auto max-w-[900px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{q.trendTitle}</h1>
          </div>
          <p className="mt-2 text-il-page-desc leading-relaxed text-text-2">{trendLead}</p>
          <p className="mt-1 text-il-meta text-text-3">{trendNote}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <QualityBatchSelect
            batchId={batchId}
            onBatchIdChange={setBatchId}
            batchOptions={batchOptions}
            loading={batchesLoading}
          />
          <button
            type="button"
            className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            onClick={() => goAnalysis('import_quality_overview', qualityParams())}
          >
            ← {q.linkBackOverview}
          </button>
        </div>
      </div>

      <Card title={q.filterCardTitle}>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.trendDomain}</label>
            <select
              className="min-w-[180px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              value={trendDomain}
              onChange={(e) => setTrendDomain(parseTrendDomain(e.target.value))}
            >
              <option value="red_link">{q.trendDomainRedLink}</option>
              <option value="lineage_reject">{q.trendDomainLineageReject}</option>
              <option value="dwd_lineage">{q.trendDomainDwdLineage}</option>
              <option value="semantic">{q.trendDomainSemantic}</option>
              <option value="uniqueness">{q.trendDomainUniqueness}</option>
              <option value="tax_id">{q.trendDomainTaxId}</option>
              <option value="cross_table">{q.trendDomainCrossTable}</option>
              <option value="header_detail">{q.trendDomainHeaderDetail}</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.trendGranularity}</label>
            <select
              className="min-w-[140px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value === 'month' ? 'month' : 'week')}
            >
              <option value="week">{q.trendGranularityWeek}</option>
              <option value="month">{q.trendGranularityMonth}</option>
            </select>
          </div>
        </div>
      </Card>

      <Card title={chartTitle}>
        {loading ? (
          <p className="py-8 text-center text-il-meta text-text-3">{q.trendLoading}</p>
        ) : err ? (
          <p className="py-8 text-center text-il-meta text-danger">{q.trendLoadFailed}：{err}</p>
        ) : chartRows.length === 0 ? (
          <p className="py-8 text-center text-il-meta text-text-3">{emptyText}</p>
        ) : (
          <>
            <div className="relative flex h-[240px] items-end justify-between gap-3 border-b border-border-light pb-1 pl-1 pr-2 pt-8">
              {trendDomain === 'dwd_lineage' ? (
                <div
                  className="pointer-events-none absolute inset-x-0 top-4 flex h-[168px] items-end justify-between gap-3 px-1"
                  aria-hidden
                >
                  {chartRows.map((w, idx) => {
                    const cov = w.coverage ?? 0
                    const y = Math.round((cov / 100) * 160)
                    const prev = idx > 0 ? chartRows[idx - 1].coverage ?? 0 : null
                    const shortLabel = w.key.replace(/^\d{4}-/, '')
                    return (
                      <div key={`line-${w.key}`} className="relative flex flex-1 flex-col items-center">
                        {prev != null ? (
                          <div
                            className="absolute bottom-0 h-px bg-emerald-600/70"
                            style={{
                              width: '100%',
                              left: '-50%',
                              bottom: `${Math.round((prev / 100) * 160)}px`,
                              transform: `rotate(${Math.atan2(
                                Math.round((cov / 100) * 160) - Math.round((prev / 100) * 160),
                                48,
                              )}rad)`,
                              transformOrigin: 'right center',
                            }}
                          />
                        ) : null}
                        <div
                          className="absolute z-10 h-2 w-2 rounded-full border-2 border-white bg-emerald-600 shadow-sm"
                          style={{ bottom: `${Math.max(y, 4)}px` }}
                          title={`${q.trendCoverageRate}: ${cov.toFixed(1)}%`}
                        />
                        <span className="absolute -top-5 text-[10px] tabular-nums text-emerald-700">
                          {cov.toFixed(0)}%
                        </span>
                        <span className="sr-only">{shortLabel}</span>
                      </div>
                    )
                  })}
                </div>
              ) : null}
              {chartRows.map((w) => {
                const h1 = Math.round((w.anomaly / maxVal) * 160)
                const h2 = Math.round(((w.block * 8) / maxVal) * 160)
                const shortLabel = w.key.replace(/^\d{4}-/, '')
                return (
                  <div key={w.key} className="relative z-[1] flex flex-1 flex-col items-center gap-1">
                    <div className="flex h-[168px] w-full max-w-[56px] items-end justify-center gap-1">
                      <div
                        className="w-[40%] min-h-[6px] rounded-t-sm bg-accent/85"
                        style={{ height: `${Math.max(h1, 6)}px` }}
                        title={`${anomalyLabel}: ${w.anomaly}`}
                      />
                      <div
                        className={`w-[40%] min-h-[4px] rounded-t-sm ${trendDomain === 'semantic' ? 'bg-[#8b7fd4]/80' : 'bg-danger/80'}`}
                        style={{ height: `${Math.max(h2, 4)}px` }}
                        title={`${blockLabel}: ${w.block}`}
                      />
                    </div>
                    <div
                      className="max-w-[64px] truncate text-center text-il-label tabular-nums text-text-3"
                      title={w.key}
                    >
                      {shortLabel}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-il-meta text-text-2">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-accent/85" />
                {anomalyLabel}（{anomalyHint}）
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2 w-2 rounded-sm ${trendDomain === 'semantic' ? 'bg-[#8b7fd4]/80' : 'bg-danger/80'}`}
                />
                {blockLabel}（{blockHint}）
              </span>
              {trendDomain === 'dwd_lineage' ? (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-600" />
                  {q.trendCoverageRate}（{q.trendCoverageHint}）
                </span>
              ) : null}
            </div>
          </>
        )}
      </Card>
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
