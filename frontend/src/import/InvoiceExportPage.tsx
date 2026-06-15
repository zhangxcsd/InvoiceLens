import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchExportInvoicesCount,
  fetchExportInvoicesMeta,
  getExportInvoicesUrl,
  postExportInvoices,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from '../dws/DwsFilterBar'
import { useDwsFilters } from '../dws/useDwsFilters'
import { useLicense } from '../settings/useLicense'

export function InvoiceExportPage() {
  const ui = t.invoiceExportUi
  const dash = t.dwsDashboardUi
  const license = useLicense()
  const initialQuery = useMemo(() => readNavQueryParams(), [])
  const f = useDwsFilters(false, { entityPool: 'analysis' })
  const initializedFromUrl = useRef(false)
  const [dateFrom, setDateFrom] = useState(initialQuery.date_from ?? '')
  const [dateTo, setDateTo] = useState(initialQuery.date_to ?? '')
  const [fpzt, setFpzt] = useState(initialQuery.fpzt ?? '全部')
  const sellerTaxNo = initialQuery.seller_tax_no?.trim() || ''
  const flagContextHint = useMemo(() => {
    if (!sellerTaxNo) return null
    return ui.flagContextSellerHint.replace('{id}', sellerTaxNo)
  }, [sellerTaxNo, ui])
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv')
  const [statusOptions, setStatusOptions] = useState<string[]>(['全部'])
  const [totalHeaders, setTotalHeaders] = useState(0)
  const [maxExportRows, setMaxExportRows] = useState(50000)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewMsg, setPreviewMsg] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [exportBusy, setExportBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const exportAllowed = license.exportAllowed
  const licenseHint = license.trialHint

  useEffect(() => {
    if (initializedFromUrl.current) return
    if (initialQuery.stat_year) f.setStatYear(initialQuery.stat_year)
    if (initialQuery.entity_id) f.setEntityId(initialQuery.entity_id)
    initializedFromUrl.current = true
  }, [initialQuery, f])

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchExportInvoicesMeta(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      setStatusOptions(res.invoice_status_options ?? ['全部'])
      setTotalHeaders(res.total_headers ?? 0)
      setMaxExportRows(res.max_export_rows ?? 50000)
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    return () => ac.abort()
  }, [loadMeta])

  const loadPreview = useCallback(async (signal?: AbortSignal) => {
    setPreviewLoading(true)
    try {
      const res = await fetchExportInvoicesCount(
        {
          statYear: f.effectiveYear || undefined,
          entityId: f.entityId.trim() || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          fpzt: fpzt === '全部' ? undefined : fpzt,
          sellerTaxNo: sellerTaxNo || undefined,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setPreviewCount(null)
        setPreviewMsg(null)
        return
      }
      setPreviewCount(res.rowCount ?? 0)
      setPreviewMsg(res.message ?? null)
    } finally {
      setPreviewLoading(false)
    }
  }, [f.effectiveYear, f.entityId, dateFrom, dateTo, fpzt, sellerTaxNo])

  useEffect(() => {
    const ac = new AbortController()
    const tmr = window.setTimeout(() => void loadPreview(ac.signal), 300)
    return () => {
      ac.abort()
      window.clearTimeout(tmr)
    }
  }, [loadPreview])

  const onExport = async () => {
    setExportBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await postExportInvoices({
        statYear: f.effectiveYear || undefined,
        entityId: f.entityId.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        fpzt: fpzt === '全部' ? undefined : fpzt,
        sellerTaxNo: sellerTaxNo || undefined,
        format,
      })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.exportFailed)
        return
      }
      if (res.blob) {
        const url = URL.createObjectURL(res.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = res.fileName ?? `invoice_export.${format}`
        a.click()
        URL.revokeObjectURL(url)
        setMsg(ui.exportSuccess)
      }
    } finally {
      setExportBusy(false)
    }
  }

  const previewUrl = getExportInvoicesUrl({
    statYear: f.effectiveYear || undefined,
    entityId: f.entityId.trim() || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    fpzt: fpzt === '全部' ? undefined : fpzt,
    sellerTaxNo: sellerTaxNo || undefined,
    format: 'csv',
  })

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {flagContextHint ? (
        <div className="rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-text-2">{flagContextHint}</div>
      ) : null}
      <LicenseGateBanner hint={licenseHint} />
      {loading ? <p className="text-sm text-text-2">{ui.loading}</p> : null}
      {err ? <p className="text-sm text-danger">{err}</p> : null}
      {msg ? <p className="text-sm text-success">{msg}</p> : null}

      <Card title={ui.filterTitle}>
        <p className="mb-3 text-sm text-text-2">{ui.totalHint.replace('{count}', String(totalHeaders))}</p>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.entityOptions}
          showMinInvoiceCount
          minInvoiceCount={effectiveN}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <p className="mt-2 text-sm text-text-3">{caliberHint}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.statusLabel}</span>
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={fpzt}
              onChange={(e) => setFpzt(e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.dateFromLabel}</span>
            <input
              type="date"
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.dateToLabel}</span>
            <input
              type="date"
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.formatLabel}</span>
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={format}
              onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx')}
            >
              <option value="csv">CSV</option>
              <option value="xlsx">XLSX</option>
            </select>
          </label>
        </div>
        <div className="mt-3 text-sm text-text-2">
          {previewLoading ? (
            <span>{ui.previewLoading}</span>
          ) : previewCount != null ? (
            <span>
              {ui.previewCount.replace('{count}', previewCount.toLocaleString('zh-CN'))}
              {previewMsg ? <span className="ml-2 text-warn">{previewMsg}</span> : null}
              {!previewMsg && previewCount > maxExportRows ? (
                <span className="ml-2 text-warn">
                  {ui.previewCap.replace('{max}', maxExportRows.toLocaleString('zh-CN'))}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={exportBusy || !exportAllowed}
            className="rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void onExport()}
          >
            {exportBusy ? ui.exportBusy : ui.exportBtn}
          </button>
          {exportAllowed ? (
            <a className="rounded border border-border px-4 py-2 text-sm text-primary hover:underline" href={previewUrl}>
              {ui.quickCsvLink}
            </a>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
