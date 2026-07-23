import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Card } from '../components/Card'
import { fetchDqDomainOverview, postSemanticQualitySyncFlags, type DqDomainOverview } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'
import { QualityBatchSelect } from './QualityBatchSelect'
import { type QualityDomainKey } from './qualityNav'
import { useQualityBatchFilter } from './useQualityBatchFilter'
import { useDimDictDomain } from '../dim/useDimDict'

const q = t.dataQualityPrototype

type DomainTone = 'accent' | 'amber' | 'rose' | 'violet' | 'slate'

const EMPTY_OVERVIEW: DqDomainOverview = {
  ok: false,
  kpi: { scanned_headers: 0, anomaly_headers: 0, block_count: 0, warn_count: 0, info_count: 0 },
  domains: {
    uniqueness: { dup_groups: 0, dup_tickets: 0 },
    tax_id: { empty_count: 0, bad_len_count: 0 },
    cross_table: { linecount_mismatch_tickets: 0, uuid_mismatch_rows: 0 },
    header_detail: { unbalanced_count: 0, max_balance_delta: null },
    semantic: { missing_spc_tickets: 0, summary_line_count: 0 },
    red_link: {
      unmatched_blue_count: 0,
      orphan_red_count: 0,
      matched_blue_count: 0,
      red_invoice_count: 0,
    },
    lineage_reject: {
      row_reject_count: 0,
      file_blocking_count: 0,
      reject_sample_count: 0,
      import_file_count: 0,
    },
    dwd_lineage: {
      missing_header_count: 0,
      missing_detail_count: 0,
      distinct_source_files: 0,
      coverage_rate: 100,
    },
  },
  dup_counts: { header_groups: 0, detail_groups: 0, spc_groups: null },
}

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
}

function DomainCard(props: {
  tone: DomainTone
  title: string
  body: string
  m1Label: string
  m1Value: string
  m2Label: string
  m2Value: string
  block?: string
  warn?: string
  info?: string
  onOpenDetail?: () => void
  footerExtra?: ReactNode
}) {
  const border: Record<DomainTone, string> = {
    accent: 'border-l-accent',
    amber: 'border-l-[#d9a227]',
    rose: 'border-l-danger',
    violet: 'border-l-[#6b5cb3]',
    slate: 'border-l-text-3',
  }
  return (
    <div
      className={[
        'rounded-[10px] border border-border-light bg-white p-4 shadow-sm',
        'border-l-[3px]',
        border[props.tone],
      ].join(' ')}
    >
      <div className="text-il-card-title font-semibold text-text">{props.title}</div>
      <p className="mt-1.5 text-il-meta leading-relaxed text-text-2">{props.body}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-sm border border-border-light bg-[#fafbfd] px-2.5 py-2">
          <div className="text-il-label uppercase tracking-wide text-text-3">{props.m1Label}</div>
          <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">{props.m1Value}</div>
        </div>
        <div className="rounded-sm border border-border-light bg-[#fafbfd] px-2.5 py-2">
          <div className="text-il-label uppercase tracking-wide text-text-3">{props.m2Label}</div>
          <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">{props.m2Value}</div>
        </div>
      </div>
      {(props.block || props.warn || props.info) && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-il-label">
          {props.block ? (
            <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 py-0.5 text-danger">{props.block}</span>
          ) : null}
          {props.warn ? (
            <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 py-0.5 text-warn">{props.warn}</span>
          ) : null}
          {props.info ? (
            <span className="rounded border border-border-light bg-[#f5f7ff] px-1.5 py-0.5 text-text-2">{props.info}</span>
          ) : null}
        </div>
      )}
      {props.onOpenDetail ? (
        <button
          type="button"
          className="mt-3 text-il-btn font-medium text-accent hover:underline"
          onClick={props.onOpenDetail}
        >
          {q.goDetail} →
        </button>
      ) : null}
      {props.footerExtra ? <div className="mt-3">{props.footerExtra}</div> : null}
    </div>
  )
}

export function DataQualityOverviewPage(props: { onNav?: (k: NavKey) => void } & EmbedModeProps) {
  const { onNav, embedMode } = props
  const { batchId, sessionId, setBatchId, batchOptions, batchesLoading } = useQualityBatchFilter()
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'import_quality_overview',
    enabled: Boolean(onNav) && !embedMode,
    onNav,
    breadcrumbRootLabel: q.overviewTitle,
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
  const qualityParams = useCallback(
    (extra?: { domain?: QualityDomainKey }) => {
      const out: Record<string, string> = {}
      if (batchId) out.batch_id = batchId
      if (sessionId) out.session_id = sessionId
      if (extra?.domain) out.domain = extra.domain
      return out
    },
    [batchId, sessionId],
  )
  const sevDict = useDimDictDomain('quality_severity')
  const sevBlock = sevDict.getLabel('block') || q.severityBlock
  const sevWarn = sevDict.getLabel('warn') || q.severityWarn
  const sevInfo = sevDict.getLabel('info') || q.severityInfo
  const [rOpen, setROpen] = useState(false)
  const [ov, setOv] = useState<DqDomainOverview>(EMPTY_OVERVIEW)
  const [ovErr, setOvErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [syncMsg, setSyncMsg] = useState('')
  const [syncing, setSyncing] = useState(false)

  const syncSemanticFlags = async () => {
    setSyncing(true)
    setSyncMsg('')
    const res = await postSemanticQualitySyncFlags({ batchId: batchId || undefined })
    setSyncing(false)
    if (!res.ok) {
      setSyncMsg(res.error?.message ?? q.syncSemanticFlagsFailed)
      return
    }
    setSyncMsg(
      q.syncSemanticFlagsOk
        .replace('{inserted}', String(res.inserted ?? 0))
        .replace('{updated}', String(res.updated ?? 0))
        .replace('{skipped}', String(res.skipped_confirmed ?? 0)),
    )
  }

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    setLoading(true)
    void fetchDqDomainOverview({
      batchId: batchId || undefined,
      sessionId: sessionId || undefined,
      signal: ac.signal,
    }).then((res) => {
      if (!alive) return
      setLoading(false)
      if (res.ok) {
        setOv(res)
        setOvErr('')
      } else {
        setOv(EMPTY_OVERVIEW)
        setOvErr(res.error?.message ?? '加载失败')
      }
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [batchId, sessionId])

  const d = ov.domains
  const k = ov.kpi
  const dup = ov.dup_counts

  const openDetail = (domain?: QualityDomainKey) =>
    goAnalysis('import_quality_detail', qualityParams({ domain }))

  return (
    <>
    <div className="mx-auto max-w-[1180px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{q.overviewTitle}</h1>
          </div>
          <p className="mt-2 max-w-[820px] text-il-page-desc leading-relaxed text-text-2">{q.overviewLead}</p>
          {ov.import_field_mapping_template ? (
            <p className="mt-2 text-il-meta text-text-2">
              {q.importTemplateLine
                .replace('{name}', ov.import_field_mapping_template.template_name)
                .replace('{id}', ov.import_field_mapping_template.template_id)}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2 text-il-meta">
            <button type="button" className="text-accent hover:underline" onClick={() => openDetail()}>
              {q.goDetail} →
            </button>
            <button type="button" className="text-accent hover:underline" onClick={() => goAnalysis('health_score', {})}>
              {q.linkHealthScore}
            </button>
            <button type="button" className="text-accent hover:underline" onClick={() => goAnalysis('flags_list', {})}>
              {q.linkFlagsList}
            </button>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col gap-2 sm:items-end">
          <QualityBatchSelect
            batchId={batchId}
            onBatchIdChange={setBatchId}
            batchOptions={batchOptions}
            loading={batchesLoading}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => goAnalysis('import_quality_trend', qualityParams())}
            >
              {q.goTrend}
            </button>
          </div>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { k: q.kpiScanned, v: fmt(k.scanned_headers), c: 'text-text' },
          { k: q.kpiAnomaly, v: fmt(k.anomaly_headers), c: 'text-warn' },
          { k: `${sevBlock}级`, v: fmt(k.block_count), c: 'text-danger' },
          { k: `${sevWarn}级`, v: fmt(k.warn_count), c: 'text-warn' },
          { k: `${sevInfo}级`, v: fmt(k.info_count), c: 'text-text-2' },
        ].map((row) => (
          <div
            key={row.k}
            className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm"
          >
            <div className="text-il-label text-text-3">{row.k}</div>
            <div className={['mt-1 text-[20px] font-bold tabular-nums', row.c, loading ? 'opacity-50' : ''].join(' ')}>
              {loading ? '…' : row.v}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-1 text-il-label font-semibold uppercase tracking-wide text-text-3">{q.domainSection}</div>
      <div className="mb-5 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <DomainCard
          tone="slate"
          title={q.domainA_title}
          body={q.domainA_body}
          m1Label={q.domainA_metric1}
          m1Value={fmt(d.uniqueness.dup_groups)}
          m2Label={q.domainA_metric2}
          m2Value={fmt(d.uniqueness.dup_tickets)}
          warn={d.uniqueness.dup_groups > 0 ? `${fmt(d.uniqueness.dup_groups)} ${sevWarn}` : undefined}
          onOpenDetail={() => openDetail('uniqueness')}
        />
        <DomainCard
          tone="rose"
          title={q.domainTaxId_title}
          body={q.domainTaxId_body}
          m1Label={q.domainTaxId_metric1}
          m1Value={fmt(d.tax_id.empty_count)}
          m2Label={q.domainTaxId_metric2}
          m2Value={fmt(d.tax_id.bad_len_count)}
          warn={d.tax_id.empty_count > 0 ? `${fmt(d.tax_id.empty_count)} ${sevWarn}` : undefined}
          info={
            d.tax_id.bad_len_count > 0
              ? `${fmt(d.tax_id.bad_len_count)} ${sevInfo}`
              : undefined
          }
          onOpenDetail={() => openDetail('tax_id')}
        />
        <DomainCard
          tone="accent"
          title={q.domainB_title}
          body={q.domainB_body}
          m1Label={q.domainB_metric1}
          m1Value={fmt(d.cross_table.linecount_mismatch_tickets)}
          m2Label={q.domainB_metric2}
          m2Value={fmt(d.cross_table.uuid_mismatch_rows)}
          warn={
            d.cross_table.linecount_mismatch_tickets > 0
              ? `${fmt(d.cross_table.linecount_mismatch_tickets)} ${sevWarn}`
              : undefined
          }
          info={
            d.cross_table.uuid_mismatch_rows > 0
              ? `${fmt(d.cross_table.uuid_mismatch_rows)} ${sevInfo}`
              : undefined
          }
          onOpenDetail={() => openDetail('cross_table')}
        />
        <DomainCard
          tone="amber"
          title={q.domainC_title}
          body={q.domainC_body}
          m1Label={q.domainC_metric1}
          m1Value={fmt(d.header_detail.unbalanced_count)}
          m2Label={q.domainC_metric2}
          m2Value={
            d.header_detail.max_balance_delta != null
              ? d.header_detail.max_balance_delta.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
              : '—'
          }
          block={
            d.header_detail.unbalanced_count > 0
              ? `${fmt(d.header_detail.unbalanced_count)} ${sevBlock}`
              : undefined
          }
          onOpenDetail={() => openDetail('header_detail')}
        />
        <DomainCard
          tone="violet"
          title={q.domainD_title}
          body={q.domainD_body}
          m1Label={q.domainD_metric1}
          m1Value={fmt(d.semantic.missing_spc_tickets)}
          m2Label={q.domainD_metric2}
          m2Value={fmt(d.semantic.summary_line_count)}
          warn={
            d.semantic.missing_spc_tickets > 0
              ? `${fmt(d.semantic.missing_spc_tickets)} ${sevWarn}`
              : undefined
          }
          info={
            d.semantic.summary_line_count > 0
              ? `${fmt(d.semantic.summary_line_count)} ${sevInfo}`
              : undefined
          }
          onOpenDetail={() => openDetail('semantic')}
          footerExtra={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-sm border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                disabled={syncing}
                onClick={() => void syncSemanticFlags()}
              >
                {syncing ? q.syncSemanticFlagsBusy : q.syncSemanticFlagsBtn}
              </button>
              {syncMsg ? <span className="text-il-meta text-text-2">{syncMsg}</span> : null}
            </div>
          }
        />
        <DomainCard
          tone="slate"
          title="红票蓝票关联质量"
          body="跟踪红票关联蓝票成功率，单独识别“孤立红票（备注可解析但蓝票未入库）”。"
          m1Label="未匹配蓝票"
          m1Value={fmt(d.red_link.unmatched_blue_count)}
          m2Label="孤立红票"
          m2Value={fmt(d.red_link.orphan_red_count)}
          warn={
            d.red_link.unmatched_blue_count > 0
              ? `${fmt(d.red_link.unmatched_blue_count)} ${sevWarn}`
              : undefined
          }
          info={`已匹配 ${fmt(d.red_link.matched_blue_count)}`}
          onOpenDetail={() => openDetail('red_link')}
        />
        <DomainCard
          tone="accent"
          title={q.domainE_title}
          body={q.domainE_body}
          m1Label={q.domainE_metric1}
          m1Value={fmt(d.lineage_reject.row_reject_count)}
          m2Label={q.domainE_metric2}
          m2Value={fmt(d.lineage_reject.file_blocking_count)}
          warn={
            d.lineage_reject.row_reject_count > 0
              ? `${fmt(d.lineage_reject.row_reject_count)} ${sevWarn}`
              : undefined
          }
          block={
            d.lineage_reject.file_blocking_count > 0
              ? `${fmt(d.lineage_reject.file_blocking_count)} ${sevBlock}`
              : undefined
          }
          info={
            d.lineage_reject.reject_sample_count > 0
              ? `样本 ${fmt(d.lineage_reject.reject_sample_count)}`
              : undefined
          }
          onOpenDetail={() => openDetail('lineage_reject')}
        />
        <DomainCard
          tone="violet"
          title={q.domainF_title}
          body={q.domainF_body}
          m1Label={q.domainF_metric1}
          m1Value={fmt(d.dwd_lineage.missing_header_count)}
          m2Label={q.domainF_metric2}
          m2Value={`${d.dwd_lineage.coverage_rate.toFixed(1)}%`}
          warn={
            d.dwd_lineage.missing_header_count > 0
              ? `${fmt(d.dwd_lineage.missing_header_count)} ${sevWarn}`
              : undefined
          }
          info={
            d.dwd_lineage.distinct_source_files > 0
              ? `源文件 ${fmt(d.dwd_lineage.distinct_source_files)}`
              : undefined
          }
          onOpenDetail={() => openDetail('dwd_lineage')}
        />
      </div>
      {ovErr ? <p className="mb-4 text-il-meta text-danger">{q.overviewLoadFailed}：{ovErr}</p> : null}

      <Card title={q.dupSectionTitle}>
        <p className="mb-3 text-il-page-desc leading-relaxed text-text-2">{q.dupSectionLead}</p>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[640px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{q.dupColObject}</th>
                <th className="px-3 py-2 font-medium">{q.dupColRule}</th>
                <th className="w-[120px] px-3 py-2 font-medium text-right">{q.dupColCount}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              <tr className="border-b border-border-light">
                <td className="px-3 py-2.5 font-medium text-text">{q.dupHdr}</td>
                <td className="px-3 py-2.5 leading-relaxed">{q.dupHdrRule}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text">{fmt(dup.header_groups)}</td>
              </tr>
              <tr className="border-b border-border-light">
                <td className="px-3 py-2.5 font-medium text-text">{q.dupDtl}</td>
                <td className="px-3 py-2.5 leading-relaxed">{q.dupDtlRule}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text">{fmt(dup.detail_groups)}</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5 font-medium text-text">{q.dupSpc}</td>
                <td className="px-3 py-2.5 leading-relaxed">{q.dupSpcRule}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text">
                  {dup.spc_groups == null ? '—' : fmt(dup.spc_groups)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={q.rulesSectionTitle}>
        <button
          type="button"
          className="mb-2 text-il-btn font-medium text-accent hover:underline"
          onClick={() => setROpen((v) => !v)}
        >
          {rOpen ? q.rulesCollapse : q.rulesExpand}
        </button>
        {rOpen ? (
          <ul className="list-inside list-decimal space-y-1.5 text-il-page-desc text-text-2">
            <li>{q.ruleR1}</li>
            <li>{q.ruleR2}</li>
            <li>{q.ruleR3}</li>
            <li>{q.ruleR4}</li>
            <li>{q.ruleR5}</li>
            <li>{q.ruleR6}</li>
          </ul>
        ) : (
          <p className="text-il-meta text-text-3">
            已接入 DWD 实时聚合（唯一性、税号、跨表对齐、头明对账、语义覆盖、红票关联、专项业务重复键）与 ODS 导入日志（血缘拒收样本）。
          </p>
        )}
      </Card>
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
