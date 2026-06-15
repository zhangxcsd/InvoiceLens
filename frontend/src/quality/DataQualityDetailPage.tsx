import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchDqDomainDetails,
  parseRedInvoiceBzDebug,
  postSemanticQualitySyncFlags,
  type DqDomainDetailRow,
  type QualityDomainKey,
} from '../config/localApi'
import { zhCN } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { QualityBatchSelect } from './QualityBatchSelect'
import { downloadDqDomainDetailsCsv } from './qualityExport'
import {
  navigateToQualityPage,
  readQualityDomainParam,
  writeQualityDomainParam,
  type QualityDomainKey as NavDomainKey,
} from './qualityNav'
import { useQualityBatchFilter } from './useQualityBatchFilter'
import { useDimDictDomain } from '../dim/useDimDict'
import { useLicense } from '../settings/useLicense'

const q = zhCN.dataQualityPrototype

const DOMAIN_OPTIONS: { value: QualityDomainKey; label: string }[] = [
  { value: 'red_link', label: q.domainRedLink },
  { value: 'lineage_reject', label: q.domainE_title },
  { value: 'dwd_lineage', label: q.domainF_title },
  { value: 'uniqueness', label: q.domainA_title },
  { value: 'tax_id', label: q.domainTaxId_title },
  { value: 'header_detail', label: q.domainC_title },
  { value: 'cross_table', label: q.domainB_title },
  { value: 'semantic', label: q.domainD_title },
]

function domainLabel(key: QualityDomainKey): string {
  return DOMAIN_OPTIONS.find((o) => o.value === key)?.label ?? key
}

export function DataQualityDetailPage(props: { onNav: (k: NavKey) => void }) {
  const { batchId, sessionId, setBatchId, batchOptions, batchesLoading } = useQualityBatchFilter()
  const license = useLicense()
  const sevDict = useDimDictDomain('quality_severity')
  const sevBlock = sevDict.getLabel('block') || q.severityBlock
  const sevWarn = sevDict.getLabel('warn') || q.severityWarn
  const sevInfo = sevDict.getLabel('info') || q.severityInfo
  const [domain, setDomain] = useState<QualityDomainKey>(() => readQualityDomainParam())
  const [onlyUnmatched, setOnlyUnmatched] = useState(true)
  const [sev, setSev] = useState('')
  const [rows, setRows] = useState<DqDomainDetailRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [ticketKeyFilter, setTicketKeyFilter] = useState('')
  const [sourceFileFilter, setSourceFileFilter] = useState('')
  const [sourceSheetFilter, setSourceSheetFilter] = useState('')
  const [rowKind, setRowKind] = useState<'all' | 'header' | 'detail'>('all')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [ruleIdFilter, setRuleIdFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [syncMsg, setSyncMsg] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [bzInput, setBzInput] = useState('')
  const [bzDebugLoading, setBzDebugLoading] = useState(false)
  const [bzDebugResult, setBzDebugResult] = useState<{
    ok: boolean
    matched: boolean
    rule_name?: string | null
    mode?: string | null
    matched_text?: string | null
    target_blue_header_uuid?: string | null
    groups?: string[]
    error?: { message?: string; detail?: string }
  } | null>(null)
  const bzDebugSectionRef = useRef<HTMLDivElement | null>(null)

  const onDomainChange = (next: QualityDomainKey) => {
    setDomain(next)
    writeQualityDomainParam(next as NavDomainKey)
    setPage(1)
  }

  const isDwdLineage = domain === 'dwd_lineage'
  const isSemantic = domain === 'semantic'
  const pagedDomain = isDwdLineage || isSemantic
  const listOffset = (page - 1) * pageSize

  useEffect(() => {
    if (!pagedDomain) return
    setPage(1)
  }, [
    pagedDomain,
    ticketKeyFilter,
    sourceFileFilter,
    sourceSheetFilter,
    rowKind,
    onlyMissing,
    ruleIdFilter,
    batchId,
    sessionId,
  ])

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    setLoading(true)
    void fetchDqDomainDetails({
      domain,
      batchId: batchId || undefined,
      sessionId: sessionId || undefined,
      onlyUnmatched: domain === 'red_link' ? onlyUnmatched : undefined,
      limit: pagedDomain ? pageSize : 300,
      offset: pagedDomain ? listOffset : undefined,
      ticketKey: pagedDomain ? ticketKeyFilter : undefined,
      sourceExcelFile: isDwdLineage ? sourceFileFilter : undefined,
      sourceSheet: isDwdLineage ? sourceSheetFilter : undefined,
      rowKind: isDwdLineage ? rowKind : undefined,
      onlyMissing: isDwdLineage ? onlyMissing : undefined,
      ruleId: isSemantic ? ruleIdFilter : undefined,
      signal: ac.signal,
    }).then((res) => {
      if (!alive) return
      setLoading(false)
      if (res.ok) {
        setRows(res.rows)
        setTotalCount(pagedDomain ? Number(res.total_count ?? res.rows.length) : res.rows.length)
        setErr('')
      } else {
        setRows([])
        setTotalCount(0)
        setErr(res.error?.message ?? '加载失败')
      }
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [
    domain,
    onlyUnmatched,
    batchId,
    sessionId,
    isDwdLineage,
    isSemantic,
    pagedDomain,
    page,
    pageSize,
    listOffset,
    ticketKeyFilter,
    sourceFileFilter,
    sourceSheetFilter,
    rowKind,
    onlyMissing,
    ruleIdFilter,
  ])

  const runBzDebug = async (text: string) => {
    const v = text.trim()
    if (!v) return
    setBzDebugLoading(true)
    const r = await parseRedInvoiceBzDebug({ bz: v })
    setBzDebugResult(r)
    setBzDebugLoading(false)
  }

  const viewRows = useMemo(() => {
    return rows.filter((r) => {
      if (sev && r.severity !== sev) return false
      return true
    })
  }, [rows, sev])

  const pagUi = zhCN.dimDataTableUi

  const exportCsv = async () => {
    if (!license.exportAllowed) {
      setErr(license.trialHint ?? q.exportLicenseDenied)
      return
    }
    let exportRows = viewRows
    if (pagedDomain && totalCount > viewRows.length) {
      const res = await fetchDqDomainDetails({
        domain,
        batchId: batchId || undefined,
        sessionId: sessionId || undefined,
        limit: Math.min(5000, totalCount),
        offset: 0,
        ticketKey: ticketKeyFilter,
        sourceExcelFile: sourceFileFilter,
        sourceSheet: sourceSheetFilter,
        rowKind,
        onlyMissing,
        ruleId: isSemantic ? ruleIdFilter : undefined,
      })
      if (res.ok) exportRows = res.rows.filter((r) => !sev || r.severity === sev)
    }
    downloadDqDomainDetailsCsv(exportRows, {
      batchId: batchId || undefined,
      domainLabel: domainLabel(domain),
      fileStem: `${domainLabel(domain)}明细`,
      lineageReject: domain === 'lineage_reject',
      dwdLineage: isDwdLineage,
      severityLabelFn: (code) => sevDict.getLabel(code) || code,
    })
  }

  const sevBadge = (severity: DqDomainDetailRow['severity']) => {
    const label = sevDict.getLabel(String(severity ?? '')) || String(severity ?? '—')
    if (severity === 'block')
      return (
        <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 py-0.5 text-il-label text-danger">
          {label}
        </span>
      )
    if (severity === 'info')
      return (
        <span className="rounded border border-border-light bg-[#f5f7ff] px-1.5 py-0.5 text-il-label text-text-2">
          {label}
        </span>
      )
    return (
      <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 py-0.5 text-il-label text-warn">
        {label}
      </span>
    )
  }

  const detailLead =
    domain === 'red_link'
      ? q.detailLeadConnected
      : domain === 'lineage_reject'
        ? q.detailLeadLineageReject
        : domain === 'dwd_lineage'
          ? q.detailLeadDwdLineage
          : domain === 'semantic'
            ? q.detailLeadSemantic
            : q.detailLeadMultiDomain.replace('{domain}', domainLabel(domain))

  const syncSemanticFlags = async () => {
    setSyncing(true)
    setSyncMsg('')
    const res = await postSemanticQualitySyncFlags({ batchId: batchId || undefined })
    setSyncing(false)
    if (!res.ok) {
      setErr(res.error?.message ?? q.syncSemanticFlagsFailed)
      return
    }
    setSyncMsg(
      q.syncSemanticFlagsOk
        .replace('{inserted}', String(res.inserted ?? 0))
        .replace('{updated}', String(res.updated ?? 0))
        .replace('{skipped}', String(res.skipped_confirmed ?? 0)),
    )
  }

  const tableTitle =
    domain === 'red_link' ? q.detailTableTitle : `${domainLabel(domain)} · ${q.detailTableTitleGeneric}`

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{q.detailTitle}</h1>
          </div>
          <p className="mt-2 max-w-[720px] text-il-page-desc leading-relaxed text-text-2">{detailLead}</p>
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
            onClick={() => navigateToQualityPage(props.onNav, 'import_quality_overview', { batchId, domain })}
          >
            ← {q.linkBackOverview}
          </button>
        </div>
      </div>

      <LicenseGateBanner hint={license.trialHint} className="mb-4" />

      <Card title={q.filterCardTitle}>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.filterDomain}</label>
            <select
              className="min-w-[220px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              value={domain}
              onChange={(e) => onDomainChange(e.target.value as QualityDomainKey)}
            >
              {DOMAIN_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.filterSeverity}</label>
            <select
              className="min-w-[140px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              value={sev}
              onChange={(e) => setSev(e.target.value)}
            >
              <option value="">{q.filterAll}</option>
              {(sevDict.options.length > 0
                ? sevDict.options
                : [
                    { code: 'block', label: sevBlock },
                    { code: 'warn', label: sevWarn },
                    { code: 'info', label: sevInfo },
                  ]
              ).map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {domain === 'red_link' ? (
            <div>
              <label className="mb-1 block text-il-label text-text-3">{q.filterScope}</label>
              <select
                className="min-w-[180px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                value={onlyUnmatched ? 'unmatched' : 'all'}
                onChange={(e) => setOnlyUnmatched(e.target.value === 'unmatched')}
              >
                <option value="unmatched">{q.filterOnlyUnmatched}</option>
                <option value="all">{q.filterAllRed}</option>
              </select>
            </div>
          ) : null}
          {isDwdLineage ? (
            <>
              <div>
                <label className="mb-1 block text-il-label text-text-3">{q.filterTicketKey}</label>
                <input
                  type="text"
                  className="min-w-[180px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                  placeholder={q.searchPlaceholderTicket}
                  value={ticketKeyFilter}
                  onChange={(e) => setTicketKeyFilter(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-il-label text-text-3">{q.filterSourceFile}</label>
                <input
                  type="text"
                  className="min-w-[160px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                  placeholder={q.searchPlaceholderFile}
                  value={sourceFileFilter}
                  onChange={(e) => setSourceFileFilter(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-il-label text-text-3">{q.filterSourceSheet}</label>
                <input
                  type="text"
                  className="min-w-[120px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                  placeholder={q.searchPlaceholderSheet}
                  value={sourceSheetFilter}
                  onChange={(e) => setSourceSheetFilter(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-il-label text-text-3">{q.filterRowKind}</label>
                <select
                  className="min-w-[140px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                  value={rowKind}
                  onChange={(e) => setRowKind(e.target.value as 'all' | 'header' | 'detail')}
                >
                  <option value="all">{q.filterRowKindAll}</option>
                  <option value="header">{q.filterRowKindHeader}</option>
                  <option value="detail">{q.filterRowKindDetail}</option>
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-il-page-desc text-text-2">
                  <input
                    type="checkbox"
                    checked={onlyMissing}
                    onChange={(e) => setOnlyMissing(e.target.checked)}
                  />
                  {q.filterOnlyMissing}
                </label>
              </div>
            </>
          ) : null}
          {isSemantic ? (
            <>
              <div>
                <label className="mb-1 block text-il-label text-text-3">{q.filterTicketKey}</label>
                <input
                  type="text"
                  className="min-w-[180px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                  placeholder={q.searchPlaceholderTicket}
                  value={ticketKeyFilter}
                  onChange={(e) => setTicketKeyFilter(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-il-label text-text-3">{q.filterRuleId}</label>
                <select
                  className="min-w-[220px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
                  value={ruleIdFilter}
                  onChange={(e) => setRuleIdFilter(e.target.value)}
                >
                  <option value="">{q.filterRuleIdAll}</option>
                  <option value="summary_reference_line">{q.ruleSummaryReference}</option>
                  <option value="missing_spc_positive_lines">{q.ruleMissingSpc}</option>
                </select>
              </div>
            </>
          ) : null}
        </div>
      </Card>

      {isSemantic ? (
        <Card title={q.syncSemanticFlagsBtn}>
          <p className="mb-3 text-il-meta text-text-3">{q.syncSemanticFlagsHint}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={syncing}
              className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-btn text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void syncSemanticFlags()}
            >
              {syncing ? q.syncSemanticFlagsBusy : q.syncSemanticFlagsBtn}
            </button>
            {syncMsg ? <span className="text-il-meta text-text-2">{syncMsg}</span> : null}
          </div>
        </Card>
      ) : null}

      {domain === 'red_link' ? (
        <div ref={bzDebugSectionRef}>
          <Card title={q.bzDebugTitle}>
            <p className="mb-2 text-il-meta text-text-3">{q.bzDebugLead}</p>
            <textarea
              className="min-h-[92px] w-full rounded-sm border border-border bg-white px-2 py-2 text-il-page-desc outline-none focus:border-accent"
              placeholder={q.bzDebugPlaceholder}
              value={bzInput}
              onChange={(e) => setBzInput(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-btn text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={bzDebugLoading || bzInput.trim().length === 0}
                onClick={async () => runBzDebug(bzInput)}
              >
                {bzDebugLoading ? q.bzDebugRunning : q.bzDebugRun}
              </button>
            </div>
            {bzDebugResult ? (
              <div className="mt-3 rounded-sm border border-border-light bg-[#fafbfd] p-3 text-il-page-desc text-text-2">
                {bzDebugResult.ok ? (
                  <>
                    <div>
                      {q.bzDebugMatched}：{bzDebugResult.matched ? q.bzDebugYes : q.bzDebugNo}
                    </div>
                    <div>
                      {q.bzDebugRule}：{bzDebugResult.rule_name || '—'}
                    </div>
                    <div>
                      {q.bzDebugMode}：{bzDebugResult.mode || '—'}
                    </div>
                    <div className="break-all">
                      {q.bzDebugText}：{bzDebugResult.matched_text || '—'}
                    </div>
                    <div className="break-all">
                      {q.bzDebugTargetUuid}：{bzDebugResult.target_blue_header_uuid || '—'}
                    </div>
                    <div className="break-all">
                      {q.bzDebugGroups}：{(bzDebugResult.groups || []).join(' | ') || '—'}
                    </div>
                  </>
                ) : (
                  <div className="text-danger">
                    {q.bzDebugFailed}：{bzDebugResult.error?.message || '未知错误'}
                  </div>
                )}
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      <Card title={tableTitle}>
        <div className="mb-2 flex justify-end gap-2">
          <button
            type="button"
            disabled={loading || viewRows.length === 0 || !license.exportAllowed}
            className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void exportCsv()}
          >
            {q.exportCsv}
          </button>
        </div>
        {loading ? (
          <p className="py-6 text-center text-il-meta text-text-3">{q.detailLoading}</p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border-light">
            <table className="w-full min-w-[900px] border-collapse text-il-page-desc">
              <thead>
                <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                  <th className="px-2 py-2 font-medium">
                    {domain === 'lineage_reject' ? q.colSeqNo : q.sampleColTicket}
                  </th>
                  {domain === 'lineage_reject' || domain === 'dwd_lineage' ? (
                    <>
                      <th className="px-2 py-2 font-medium">{q.colSourceFile}</th>
                      <th className="px-2 py-2 font-medium">{q.colSourceSheet}</th>
                    </>
                  ) : null}
                  {domain === 'dwd_lineage' ? (
                    <>
                      <th className="px-2 py-2 font-medium">{q.colRowKind}</th>
                      <th className="px-2 py-2 font-medium">{q.colLogicLineNo}</th>
                    </>
                  ) : null}
                  <th className="px-2 py-2 font-medium">{q.sampleColDomain}</th>
                  <th className="px-2 py-2 font-medium">{q.sampleColRule}</th>
                  <th className="px-2 py-2 font-medium">{q.sampleColSev}</th>
                  <th className="px-2 py-2 font-medium">{q.sampleColDelta}</th>
                  <th className="px-2 py-2 font-medium">{q.colBatchId}</th>
                  {domain === 'red_link' ? (
                    <th className="px-2 py-2 font-medium">{q.colActions}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="text-text-2">
                {viewRows.map((r) => (
                  <tr key={`${r.header_uuid}-${r.rule_id}-${r.summary.slice(0, 24)}`} className="border-b border-border-light last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-text">{r.ticket_key}</td>
                    {domain === 'lineage_reject' || domain === 'dwd_lineage' ? (
                      <>
                        <td
                          className="max-w-[200px] truncate px-2 py-2 text-[11px]"
                          title={String(r.extra?.source_excel_file ?? r.extra?.file_name ?? '')}
                        >
                          {String(r.extra?.file_name ?? r.extra?.source_excel_file ?? '—')}
                        </td>
                        <td className="px-2 py-2 text-[11px]">
                          {String(r.extra?.sheet ?? r.extra?.source_sheet ?? '—')}
                        </td>
                      </>
                    ) : null}
                    {domain === 'dwd_lineage' ? (
                      <>
                        <td className="px-2 py-2 text-[11px]">
                          {r.extra?.row_kind === 'header' ? q.rowKindHeader : q.rowKindDetail}
                        </td>
                        <td className="px-2 py-2 tabular-nums text-[11px]">
                          {r.extra?.logic_line_no != null ? String(r.extra.logic_line_no) : '—'}
                        </td>
                      </>
                    ) : null}
                    <td className="px-2 py-2">{domainLabel(r.domain)}</td>
                    <td className="px-2 py-2 font-mono text-[10px] text-text-2">{r.rule_id}</td>
                    <td className="px-2 py-2">{sevBadge(r.severity)}</td>
                    <td className="max-w-[280px] px-2 py-2 leading-snug">{r.summary}</td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-text-3">{r.import_batch_id || '—'}</td>
                    {domain === 'red_link' ? (
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="text-il-btn font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-3 disabled:no-underline"
                          disabled={!String(r.extra?.bz || '').trim()}
                          onClick={async () => {
                            const text = String(r.extra?.bz || '').trim()
                            if (!text) return
                            setBzInput(text)
                            bzDebugSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            await runBzDebug(text)
                          }}
                        >
                          {q.actionDrill}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pagedDomain ? (
          <DimTablePagination
            total={totalCount}
            page={page}
            pageSize={pageSize}
            loading={loading}
            ui={pagUi}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        ) : null}
        {err ? (
          <p className="mt-3 text-il-meta text-danger">
            {q.detailLoadFailed}：{err}
          </p>
        ) : null}
        {!loading && !err && viewRows.length === 0 ? (
          <p className="mt-3 text-il-meta text-text-3">{q.detailEmptyGeneric}</p>
        ) : null}
      </Card>
    </div>
  )
}
