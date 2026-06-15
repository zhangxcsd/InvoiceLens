import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDeliveryPackageDownload,
  fetchDeliveryPackageEstimate,
  fetchDeliveryPackageStatus,
  fetchDeliveryPackages,
  fetchReportMeta,
  postReportDeliveryPackage,
  postReportGenerate,
  type DeliveryPackageEstimate,
  type DeliveryPackageEstimateSection,
  type DeliveryPackageRecord,
  type ReportChapter,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { navigateWithQuery, readNavQueryParams } from '../utils/navHelpers'
import { useLicense } from '../settings/useLicense'
import { reportChapterNavKey } from './reportChapterNav'
import type { NavKey } from '../types'

type Props = { onNav?: (key: NavKey) => void }

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function deliveryParamsFromRecord(raw: Record<string, unknown> | undefined) {
  if (!raw) return undefined
  const statYear = String(raw.statYear ?? raw.stat_year ?? '').trim()
  if (!statYear) return undefined
  const flagFiltersRaw = (raw.flagFilters ?? raw.flag_filters) as Record<string, unknown> | undefined
  return {
    statYear,
    title: raw.title != null ? String(raw.title) : undefined,
    chapters: (raw.chapters as Record<string, boolean> | undefined) ?? undefined,
    entityId: raw.entityId != null ? String(raw.entityId) : raw.entity_id != null ? String(raw.entity_id) : undefined,
    flagFilters: flagFiltersRaw
      ? {
          riskLevel: flagFiltersRaw.riskLevel != null ? String(flagFiltersRaw.riskLevel) : undefined,
          ruleId: flagFiltersRaw.ruleId != null ? String(flagFiltersRaw.ruleId) : undefined,
          trackStatus:
            flagFiltersRaw.trackStatus != null ? String(flagFiltersRaw.trackStatus) : undefined,
        }
      : undefined,
    includeInvoices: raw.includeInvoices as boolean | undefined,
    includeFinance: raw.includeFinance as boolean | undefined,
  }
}

export function ReportConfigPage({ onNav }: Props) {
  const ui = t.reportConfigUi
  const license = useLicense()
  const initialQuery = useMemo(() => readNavQueryParams(), [])
  const initializedFromUrl = useRef(false)
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => initialQuery.stat_year ?? String(new Date().getFullYear()))
  const [title, setTitle] = useState(initialQuery.title ?? '')
  const [chapters, setChapters] = useState<ReportChapter[]>([])
  const [chapterSel, setChapterSel] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [generateBusy, setGenerateBusy] = useState(false)
  const [generateMsg, setGenerateMsg] = useState<string | null>(null)
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  const [deliveryMsg, setDeliveryMsg] = useState<string | null>(null)
  const [deliveryFailed, setDeliveryFailed] = useState(false)
  const [deliveryRunId, setDeliveryRunId] = useState<string | null>(null)
  const [deliveryReady, setDeliveryReady] = useState<{ runId: string; fileName: string; sizeBytes?: number } | null>(
    null,
  )
  const [recentPackages, setRecentPackages] = useState<DeliveryPackageRecord[]>([])
  const [packagesBusy, setPackagesBusy] = useState(false)
  const [estimate, setEstimate] = useState<DeliveryPackageEstimate | null>(null)
  const [estimateSections, setEstimateSections] = useState<DeliveryPackageEstimateSection[]>([])
  const [estimateNotes, setEstimateNotes] = useState<string[]>([])
  const [estimateBusy, setEstimateBusy] = useState(false)
  const [lastFileName, setLastFileName] = useState<string | null>(null)
  const exportAllowed = license.exportAllowed
  const licenseHint = license.trialHint

  const effectiveYear = useMemo(() => {
    const y = statYear.trim()
    if (y && statYears.includes(y)) return y
    return statYears[0] ?? y
  }, [statYear, statYears])

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchReportMeta(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      const years = res.stat_years ?? []
      setStatYears(years)
      if (years.length) {
        const cy = String(new Date().getFullYear())
        const def = res.default_stat_year ?? (years.includes(cy) ? cy : years[0])
        setStatYear((prev) => (years.includes(prev) ? prev : def))
        if (!title.trim()) setTitle(res.default_title ?? `${def}年度发票数据审计分析报告`)
      }
      const ch = res.chapters ?? []
      setChapters(ch)
      const sel: Record<string, boolean> = {}
      for (const c of ch) sel[c.id] = c.default !== false
      setChapterSel(sel)
      if (!initializedFromUrl.current && initialQuery.chapters) {
        const picked = new Set(initialQuery.chapters.split(',').map((s) => s.trim()).filter(Boolean))
        if (picked.size) {
          for (const c of ch) sel[c.id] = picked.has(c.id)
          setChapterSel({ ...sel })
        }
      }
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed, initialQuery.chapters, title])

  const loadRecentPackages = useCallback(async () => {
    setPackagesBusy(true)
    try {
      const res = await fetchDeliveryPackages({ limit: 8 })
      if (res.ok) setRecentPackages(res.packages ?? [])
    } finally {
      setPackagesBusy(false)
    }
  }, [])

  const loadEstimate = useCallback(
    async (signal?: AbortSignal) => {
      if (!effectiveYear) return
      setEstimateBusy(true)
      try {
        const res = await fetchDeliveryPackageEstimate(
          { statYear: effectiveYear, entityId: initialQuery.entity_id, chapters: chapterSel },
          signal,
        )
        if (signal?.aborted) return
        if (!res.ok) {
          setEstimate(null)
          setEstimateSections([])
          setEstimateNotes([])
          return
        }
        setEstimate(res.estimates ?? null)
        setEstimateSections(res.sections ?? [])
        setEstimateNotes(res.notes ?? [])
      } finally {
        setEstimateBusy(false)
      }
    },
    [effectiveYear, initialQuery.entity_id, chapterSel],
  )

  useEffect(() => {
    void loadRecentPackages()
  }, [loadRecentPackages])

  useEffect(() => {
    const ac = new AbortController()
    void loadEstimate(ac.signal)
    return () => ac.abort()
  }, [loadEstimate])

  const pollDeliveryPackage = async (runId: string) => {
    let pollMs = 1000
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      const st = await fetchDeliveryPackageStatus(runId)
      if (!st.ok) return { ok: false as const, message: st.error?.message ?? ui.deliveryFailed }
      const status = (st.status ?? '').toLowerCase()
      setDeliveryMsg(ui.deliveryProgress.replace('{message}', (st.message ?? status) || '…'))
      if (status === 'success') {
        return {
          ok: true as const,
          fileName: st.file_name,
          runId,
          sizeBytes: st.size_bytes,
        }
      }
      if (status === 'failed') {
        const detail = st.error?.message ?? st.message ?? ui.deliveryFailed
        const code = st.error_code ? `（${st.error_code}）` : ''
        return { ok: false as const, message: `${detail}${code}` }
      }
      await new Promise((r) => setTimeout(r, pollMs))
      pollMs = Math.min(3000, pollMs + 250)
    }
    return { ok: false as const, message: '等待交付包超时' }
  }

  const downloadDeliveryBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    return () => ac.abort()
  }, [loadMeta])

  useEffect(() => {
    initializedFromUrl.current = true
  }, [])

  useEffect(() => {
    if (!initialQuery.title) {
      setTitle(`${effectiveYear}年度发票数据审计分析报告`)
    }
  }, [effectiveYear, initialQuery.title])

  const onGenerate = async () => {
    setGenerateBusy(true)
    setGenerateMsg(null)
    setLastFileName(null)
    try {
      const res = await postReportGenerate({
        statYear: effectiveYear,
        title: title.trim() || `${effectiveYear}年度发票数据审计分析报告`,
        chapters: chapterSel,
      })
      if (!res.ok) {
        setGenerateMsg(res.error?.message ?? ui.generateFailed)
        return
      }
      setLastFileName(res.file_name ?? null)
      setGenerateMsg(ui.generateSuccess.replace('{file}', res.file_name ?? ''))
    } finally {
      setGenerateBusy(false)
    }
  }

  const runDeliveryPackage = async (retryParams?: Record<string, unknown>) => {
    setDeliveryBusy(true)
    setDeliveryMsg(null)
    setDeliveryFailed(false)
    setDeliveryReady(null)
    setDeliveryRunId(null)
    try {
      const normalized = deliveryParamsFromRecord(retryParams)
      const res = await postReportDeliveryPackage({
        statYear: normalized?.statYear ?? effectiveYear,
        title: (normalized?.title ?? title.trim()) || `${effectiveYear}年度发票数据审计分析报告`,
        chapters: normalized?.chapters ?? chapterSel,
        entityId: normalized?.entityId ?? initialQuery.entity_id,
        flagFilters: normalized?.flagFilters ?? {
          ruleId: initialQuery.rule_id,
          trackStatus: initialQuery.track_status,
        },
        includeInvoices: normalized?.includeInvoices,
        includeFinance: normalized?.includeFinance,
        async: true,
      })
      if (!res.ok) {
        setDeliveryMsg(res.error?.message ?? ui.deliveryFailed)
        setDeliveryFailed(true)
        return
      }
      if (!res.runId) {
        setDeliveryMsg(ui.deliveryFailed)
        setDeliveryFailed(true)
        return
      }
      setDeliveryRunId(res.runId)
      setDeliveryMsg(ui.deliveryProgress.replace('{message}', res.message ?? ui.deliveryBusy))
      const polled = await pollDeliveryPackage(res.runId)
      if (!polled.ok) {
        setDeliveryMsg(polled.message)
        setDeliveryFailed(true)
        return
      }
      const fname = polled.fileName ?? 'delivery_package.zip'
      setDeliveryReady({ runId: polled.runId, fileName: fname, sizeBytes: polled.sizeBytes })
      setDeliveryMsg(ui.deliverySuccess.replace('{file}', fname))
      setLastFileName(fname)
      await loadRecentPackages()
    } finally {
      setDeliveryBusy(false)
    }
  }

  const onDownloadReady = async () => {
    if (!deliveryReady) return
    const dl = await fetchDeliveryPackageDownload(deliveryReady.runId)
    if (!dl.ok || !dl.blob) {
      setDeliveryMsg(dl.error?.message ?? ui.deliveryFailed)
      setDeliveryFailed(true)
      return
    }
    downloadDeliveryBlob(dl.blob, dl.fileName ?? deliveryReady.fileName)
  }

  const onDownloadPackage = async (pkg: DeliveryPackageRecord) => {
    const pid = pkg.package_id ?? pkg.run_id
    if (!pid) return
    const dl = await fetchDeliveryPackageDownload(pid)
    if (!dl.ok || !dl.blob) {
      setDeliveryMsg(dl.error?.message ?? ui.deliveryFailed)
      return
    }
    downloadDeliveryBlob(dl.blob, dl.fileName ?? pkg.file_name ?? 'delivery_package.zip')
  }

  const toggleChapter = (id: string) => {
    setChapterSel((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const estimateLines = useMemo(() => {
    if (estimateSections.length) {
      return estimateSections
        .filter((s) => s.included)
        .map((s) => {
          const rows = s.row_count != null ? `${s.row_count.toLocaleString()} 行` : '—'
          const size = s.size_bytes != null && s.size_bytes > 0 ? formatBytes(s.size_bytes) : ''
          return ui.deliveryEstimateSectionRow
            .replace('{label}', s.label)
            .replace('{rows}', rows)
            .replace('{size}', size ? ` · ${size}` : '')
        })
    }
    if (!estimate) return []
    const lines: string[] = []
    if (estimate.audit_flags != null) {
      lines.push(ui.deliveryEstimateFlags.replace('{n}', String(estimate.audit_flags)))
    }
    if (estimate.finance_reconcile != null) {
      lines.push(ui.deliveryEstimateFinance.replace('{n}', String(estimate.finance_reconcile)))
    }
    if (estimate.invoice_detail != null) {
      const total = estimate.invoice_detail_total ?? estimate.invoice_detail
      lines.push(
        ui.deliveryEstimateInvoices
          .replace('{n}', String(estimate.invoice_detail))
          .replace('{total}', String(total)),
      )
    }
    if (estimate.data_quality_scanned != null) {
      lines.push(
        ui.deliveryEstimateQuality
          .replace('{scanned}', String(estimate.data_quality_scanned))
          .replace('{anomaly}', String(estimate.data_quality_metrics ?? 0)),
      )
    }
    if (estimate.tax_code_analysis != null) {
      lines.push(ui.deliveryEstimateTax.replace('{n}', String(estimate.tax_code_analysis)))
    }
    if (estimate.tax_risk_exposure != null) {
      lines.push(ui.deliveryEstimateTaxRisk.replace('{n}', String(estimate.tax_risk_exposure)))
    }
    return lines
  }, [estimate, estimateSections, ui])

  const estimateTotalHint = useMemo(() => {
    const zipEst = estimate?.total_zip_bytes_est
    if (zipEst == null || zipEst <= 0) return null
    return ui.deliveryEstimateTotal.replace('{size}', formatBytes(zipEst))
  }, [estimate, ui])

  const manifestPreviewRows = useMemo(() => {
    if (estimateSections.length) {
      return estimateSections.map((s) => ({
        id: s.id,
        label: s.label,
        file: s.path,
        included: Boolean(s.included),
        kind: s.kind === 'attachment' ? ('attachment' as const) : ('chapter' as const),
        rowCount: s.row_count,
        sizeBytes: s.size_bytes,
      }))
    }
    const year = effectiveYear
    const docx = ui.manifestDocxRow
    const chapterRows = chapters.map((c) => {
      const included = chapterSel[c.id] !== false
      let file: string = docx
      if (c.id === 'audit_flags') file = ui.manifestFlagsCsvRow.replace('{year}', year)
      else if (c.id === 'finance_reconcile') file = ui.manifestFinanceCsvRow.replace('{year}', year)
      else if (c.id === 'data_quality_summary') file = ui.manifestQualityCsvRow.replace('{year}', year)
      else if (c.id === 'tax_code_analysis') file = ui.manifestTaxCsvRow.replace('{year}', year)
      else if (c.id === 'tax_risk_exposure') file = ui.manifestTaxRiskCsvRow.replace('{year}', year)
      return { id: c.id, label: c.label, file, included, kind: 'chapter' as const }
    })
    const attachments = [
      { id: 'invoice_csv', label: ui.manifestAttachmentInvoice, file: ui.manifestInvoiceCsvRow.replace('{year}', year), included: true, kind: 'attachment' as const },
    ]
    return [...chapterRows, ...attachments]
  }, [chapters, chapterSel, effectiveYear, estimateSections, ui])

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      <LicenseGateBanner hint={licenseHint} />
      {loading ? <p className="text-sm text-text-2">{ui.loading}</p> : null}
      {err ? <p className="text-sm text-danger">{err}</p> : null}

      <Card title={ui.configTitle}>
        <div className="flex max-w-xl flex-col gap-4">
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
            <span className="text-text-2">{ui.titleLabel}</span>
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder={ui.titlePlaceholder}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm text-text-2">{ui.chaptersTitle}</legend>
            <div className="flex flex-col gap-2">
              {chapters.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={chapterSel[c.id] !== false}
                      onChange={() => toggleChapter(c.id)}
                    />
                    {c.label}
                  </label>
                  {onNav && reportChapterNavKey(c.id) ? (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() =>
                        navigateWithQuery(onNav, reportChapterNavKey(c.id)!, {
                          stat_year: effectiveYear,
                        })
                      }
                    >
                      {ui.chapterOpenAnalysis}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </fieldset>
          <div className="rounded border border-border bg-[#f8fafc] px-3 py-2 text-xs text-text-2">
            <div className="mb-2 font-medium text-text">{ui.manifestPreviewTitle}</div>
            <p className="mb-2 text-text-3">{ui.manifestPreviewDesc}</p>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border text-text-3">
                  <th className="py-1 pr-2 font-medium">{ui.manifestChapterCol}</th>
                  <th className="py-1 pr-2 font-medium">{ui.manifestFileCol}</th>
                  <th className="py-1 pr-2 font-medium">{ui.manifestRowsCol}</th>
                  <th className="py-1 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {manifestPreviewRows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-1 pr-2 text-text">{row.label}</td>
                    <td className="py-1 pr-2 font-mono text-[11px] text-text-3">{row.file}</td>
                    <td className="py-1 pr-2 tabular-nums text-text-3">
                      {'rowCount' in row && row.rowCount != null
                        ? row.rowCount.toLocaleString()
                        : '—'}
                      {'sizeBytes' in row && row.sizeBytes
                        ? ` · ${formatBytes(row.sizeBytes as number)}`
                        : ''}
                    </td>
                    <td className="py-1 text-text-2">
                      {row.kind === 'attachment'
                        ? ui.manifestOptional
                        : row.included
                          ? ui.manifestIncluded
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="w-fit rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={generateBusy || deliveryBusy || !effectiveYear || !exportAllowed}
            onClick={() => void onGenerate()}
          >
            {generateBusy ? ui.generateBusy : ui.generateBtn}
          </button>
          {generateMsg ? <p className="text-sm text-text-2">{generateMsg}</p> : null}
          <div className="mt-2 border-t border-border pt-4">
            <p className="mb-2 text-sm text-text-2">{ui.deliveryDesc}</p>
            <div className="mb-3 rounded border border-border bg-[#f8fafc] px-3 py-2 text-xs text-text-2">
              <div className="mb-1 font-medium text-text">{ui.deliveryEstimateTitle}</div>
              {estimateBusy ? (
                <p>{ui.deliveryEstimateLoading}</p>
              ) : estimateLines.length ? (
                <ul className="list-inside list-disc space-y-0.5">
                  {estimateLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                  {estimateTotalHint ? <li className="font-medium text-text">{estimateTotalHint}</li> : null}
                  {estimateNotes.map((note) => (
                    <li key={note} className="text-warn">
                      {note}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-text-3">{ui.deliveryEstimateEmpty}</p>
              )}
            </div>
            <button
              type="button"
              className="w-fit rounded border border-primary bg-surface px-4 py-2 text-sm text-primary disabled:opacity-50"
              disabled={deliveryBusy || generateBusy || !effectiveYear || !exportAllowed}
              onClick={() => void runDeliveryPackage()}
            >
              {deliveryBusy ? ui.deliveryBusy : ui.deliveryBtn}
            </button>
            {deliveryMsg ? (
              <p className={`mt-2 text-sm ${deliveryFailed ? 'text-danger' : 'text-text-2'}`}>{deliveryMsg}</p>
            ) : null}
            {deliveryRunId && deliveryBusy ? (
              <p className="mt-1 font-mono text-xs text-text-3">run_id: {deliveryRunId}</p>
            ) : null}
            {deliveryReady && !deliveryBusy ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-sm text-text-2">{ui.deliveryReadyHint}</p>
                <button
                  type="button"
                  className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
                  onClick={() => void onDownloadReady()}
                >
                  {ui.deliveryDownloadReadyBtn}
                </button>
                {deliveryReady.sizeBytes ? (
                  <span className="text-xs text-text-3">
                    {ui.deliverySizeHint.replace('{size}', formatBytes(deliveryReady.sizeBytes))}
                  </span>
                ) : null}
              </div>
            ) : null}
            {deliveryFailed && !deliveryBusy ? (
              <button
                type="button"
                className="mt-2 w-fit rounded border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-[#fff5f5]"
                onClick={() => void runDeliveryPackage()}
              >
                {ui.deliveryRetryBtn}
              </button>
            ) : null}
            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text-2">{ui.deliveryRecentTitle}</span>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                  disabled={packagesBusy}
                  onClick={() => void loadRecentPackages()}
                >
                  {packagesBusy ? ui.loading : '刷新'}
                </button>
              </div>
              {recentPackages.length === 0 ? (
                <p className="text-xs text-text-3">{ui.archiveEmpty}</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {recentPackages.map((pkg) => {
                    const pid = pkg.package_id ?? pkg.run_id ?? ''
                    const st = (pkg.status ?? '').toLowerCase()
                    const statusLabel =
                      st === 'running'
                        ? ui.deliveryStatusRunning
                        : st === 'success'
                          ? ui.deliveryStatusSuccess
                          : st === 'failed'
                            ? ui.deliveryStatusFailed
                            : st || '—'
                    return (
                      <li key={pid} className="flex flex-wrap items-center gap-2 text-text-2">
                        <span className="font-mono text-text-3">{pkg.started_at ?? '—'}</span>
                        <span>{pkg.stat_year ?? '—'}</span>
                        <span className="rounded border border-border px-1 py-0.5">{statusLabel}</span>
                        {pkg.file_name ? <span className="truncate text-text-3">{pkg.file_name}</span> : null}
                        {pkg.size_bytes ? (
                          <span className="text-text-3">{formatBytes(pkg.size_bytes)}</span>
                        ) : null}
                        {st === 'success' && pid ? (
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => void onDownloadPackage(pkg)}
                          >
                            {ui.deliveryDownloadBtn}
                          </button>
                        ) : null}
                        {st === 'failed' && pkg.params ? (
                          <button
                            type="button"
                            className="text-danger hover:underline"
                            onClick={() => void runDeliveryPackage(pkg.params as Record<string, unknown>)}
                          >
                            {ui.deliveryRetryBtn}
                          </button>
                        ) : null}
                        {st === 'failed' && pkg.message ? (
                          <span className="text-danger" title={pkg.error_code ?? undefined}>
                            {pkg.message}
                          </span>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
          {lastFileName && onNav ? (
            <button
              type="button"
              className="w-fit text-sm text-primary hover:underline"
              onClick={() => navigateWithQuery(onNav, 'report_archive', { stat_year: effectiveYear })}
            >
              {ui.goArchive}
            </button>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
