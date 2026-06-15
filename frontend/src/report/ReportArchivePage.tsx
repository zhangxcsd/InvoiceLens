import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchReportArchive,
  fetchReportMeta,
  getReportDownloadUrl,
  postReportArchiveBatchDownload,
  type ReportArchiveFile,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { navigateWithQuery, readNavQueryParams } from '../utils/navHelpers'
import type { NavKey } from '../types'

type Props = { onNav?: (key: NavKey) => void }

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN')
  } catch {
    return String(ts)
  }
}

export function ReportArchivePage({ onNav }: Props) {
  const ui = t.reportArchiveUi
  const initialQuery = useMemo(() => readNavQueryParams(), [])
  const [statYears, setStatYears] = useState<string[]>([])
  const [yearFilter, setYearFilter] = useState(initialQuery.stat_year ?? '')
  const [templateFilter, setTemplateFilter] = useState('')
  const [archive, setArchive] = useState<ReportArchiveFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    const res = await fetchReportMeta(signal)
    if (signal?.aborted || res.aborted) return
    if (res.ok) setStatYears(res.stat_years ?? [])
  }, [])

  const loadArchive = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchReportArchive(
        {
          statYear: yearFilter || undefined,
          template: templateFilter.trim() || undefined,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setArchive([])
        return
      }
      setArchive(res.files ?? [])
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [yearFilter, templateFilter, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    return () => ac.abort()
  }, [loadMeta])

  useEffect(() => {
    const ac = new AbortController()
    void loadArchive(ac.signal)
    return () => ac.abort()
  }, [loadArchive])

  const allSelected = useMemo(
    () => archive.length > 0 && selected.size === archive.length,
    [archive.length, selected.size],
  )

  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(archive.map((f) => f.file_name)))
  }

  const onBatchDownload = async () => {
    const names = [...selected]
    if (!names.length) return
    setBatchBusy(true)
    setMsg(null)
    try {
      const res = await postReportArchiveBatchDownload(names)
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.batchFailed)
        return
      }
      if (res.blob) {
        const url = URL.createObjectURL(res.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = res.fileName ?? 'reports.zip'
        a.click()
        URL.revokeObjectURL(url)
        setMsg(ui.batchSuccess.replace('{count}', String(names.length)))
      }
    } finally {
      setBatchBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {onNav ? (
        <div className="flex flex-wrap gap-3 text-sm">
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => navigateWithQuery(onNav, 'report_config', { stat_year: yearFilter || undefined })}
          >
            {ui.goReportConfig}
          </button>
        </div>
      ) : null}
      {err ? <p className="text-sm text-danger">{err}</p> : null}
      {msg ? <p className="text-sm text-text-2">{msg}</p> : null}

      <Card title={ui.filterTitle}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.yearFilterLabel}</span>
            <select
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
            >
              <option value="">{ui.yearFilterAll}</option>
              {statYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-2">{ui.templateFilterLabel}</span>
            <input
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder={ui.templateFilterPlaceholder}
              value={templateFilter}
              onChange={(e) => setTemplateFilter(e.target.value)}
            />
          </label>
        </div>
      </Card>

      <Card title={ui.listTitle.replace('{count}', String(archive.length))}>
        {selected.size > 0 ? (
          <div className="mb-3">
            <button
              type="button"
              disabled={batchBusy}
              className="rounded bg-primary px-4 py-1.5 text-sm text-white disabled:opacity-50"
              onClick={() => void onBatchDownload()}
            >
              {batchBusy ? ui.batchBusy : ui.batchDownload.replace('{count}', String(selected.size))}
            </button>
          </div>
        ) : null}
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : archive.length === 0 ? (
          <p className="text-sm text-text-2">{ui.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="w-8 py-2">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={ui.selectAll} />
                  </th>
                  <th className="py-2 pr-3 font-medium">{ui.colFile}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colYear}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colSize}</th>
                  <th className="py-2 font-medium">{ui.colDownload}</th>
                </tr>
              </thead>
              <tbody>
                {archive.map((f) => (
                  <tr key={f.file_name} className="border-b border-border/60">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(f.file_name)}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(f.file_name)) next.delete(f.file_name)
                            else next.add(f.file_name)
                            return next
                          })
                        }}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{f.file_name}</div>
                      <div className="text-xs text-text-3">{fmtTime(f.modified_at)}</div>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{f.stat_year ?? '—'}</td>
                    <td className="py-2 pr-3 tabular-nums">{fmtBytes(f.size_bytes)}</td>
                    <td className="py-2">
                      <a
                        className="text-primary hover:underline"
                        href={getReportDownloadUrl(f.file_name)}
                        download={f.file_name}
                      >
                        {ui.downloadBtn}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
