import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchReportArchive,
  fetchReportMeta,
  getReportDownloadUrl,
  postReportGenerate,
  type ReportArchiveFile,
  type ReportChapter,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

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

export function ReportConfigPage() {
  const ui = t.reportConfigUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [title, setTitle] = useState('')
  const [chapters, setChapters] = useState<ReportChapter[]>([])
  const [chapterSel, setChapterSel] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [generateBusy, setGenerateBusy] = useState(false)
  const [generateMsg, setGenerateMsg] = useState<string | null>(null)
  const [archive, setArchive] = useState<ReportArchiveFile[]>([])

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
        setTitle(res.default_title ?? `${def}年度发票数据审计分析报告`)
      }
      const ch = res.chapters ?? []
      setChapters(ch)
      const sel: Record<string, boolean> = {}
      for (const c of ch) sel[c.id] = c.default !== false
      setChapterSel(sel)
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  const loadArchive = useCallback(async (signal?: AbortSignal) => {
    const res = await fetchReportArchive(signal)
    if (signal?.aborted || res.aborted) return
    if (res.ok) setArchive(res.files ?? [])
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    void loadArchive(ac.signal)
    return () => ac.abort()
  }, [loadMeta, loadArchive])

  useEffect(() => {
    setTitle(`${effectiveYear}年度发票数据审计分析报告`)
  }, [effectiveYear])

  const onGenerate = async () => {
    setGenerateBusy(true)
    setGenerateMsg(null)
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
      setGenerateMsg(ui.generateSuccess.replace('{file}', res.file_name ?? ''))
      await loadArchive()
    } finally {
      setGenerateBusy(false)
    }
  }

  const toggleChapter = (id: string) => {
    setChapterSel((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {loading ? <p className="text-sm text-text-2">{ui.loading}</p> : null}
      {err ? <p className="text-sm text-danger">{err}</p> : null}

      <Card title={ui.configTitle}>
        <div className="flex flex-col gap-4 max-w-xl">
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
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chapterSel[c.id] !== false}
                    onChange={() => toggleChapter(c.id)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            className="w-fit rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={generateBusy || !effectiveYear}
            onClick={() => void onGenerate()}
          >
            {generateBusy ? ui.generateBusy : ui.generateBtn}
          </button>
          {generateMsg ? <p className="text-sm text-text-2">{generateMsg}</p> : null}
        </div>
      </Card>

      <Card title={ui.archiveTitle}>
        {archive.length === 0 ? (
          <p className="text-sm text-text-2">{ui.archiveEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-3 font-medium">{ui.colFile}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colSize}</th>
                  <th className="py-2 font-medium">{ui.colDownload}</th>
                </tr>
              </thead>
              <tbody>
                {archive.map((f) => (
                  <tr key={f.file_name} className="border-b border-border/60">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{f.file_name}</div>
                      <div className="text-xs text-text-3">{fmtTime(f.modified_at)}</div>
                    </td>
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
