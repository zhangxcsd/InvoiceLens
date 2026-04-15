import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import type { PickedExcel } from '../components/UploadZone'
import { zhCN as t } from '../copy/zh-CN'
import { aggregateSheetCoverage, type AggregatedSheetCoverage } from './sheetCoverageScan'

export function SheetCoveragePanel(props: {
  queue: PickedExcel[]
  knownSheetKeys: string[]
  disabled?: boolean
}) {
  const { queue, knownSheetKeys, disabled } = props
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<AggregatedSheetCoverage | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  const queueSig = queue.map((r) => `${r.file.name}:${r.file.size}:${r.file.lastModified}`).join('\u0001')
  const keysSig = useMemo(() => knownSheetKeys.map((k) => String(k).trim()).join('\u0001'), [knownSheetKeys])

  useEffect(() => {
    setResult(null)
    setScanError(null)
  }, [queueSig, keysSig])

  const runScan = async () => {
    if (queue.length === 0 || disabled || scanning) return
    const total = queue.length
    setScanning(true)
    setScanError(null)
    setScanProgress({ done: 0, total })
    try {
      const agg = await aggregateSheetCoverage(queue, knownSheetKeys, (done, tot) => {
        setScanProgress({ done, total: tot })
      })
      setResult(agg)
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e))
      setResult(null)
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }

  const keysWithHits = useMemo(() => {
    if (!result) return [] as string[]
    const keys = knownSheetKeys.map((k) => String(k).trim()).filter(Boolean)
    return keys.filter((k) => (result.globalHitsByKey[k] ?? []).length > 0)
  }, [result, keysSig, knownSheetKeys])

  return (
    <Card title={t.importUpload.sheetCoverageCardTitle} className="mb-4 shrink-0">
      <p className="mb-3 text-il-meta leading-relaxed text-text-3">{t.importUpload.sheetCoverageCardDesc}</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={queue.length === 0 || disabled || scanning}
          className={[
            'rounded-[7px] border border-accent bg-white px-3 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff] disabled:cursor-not-allowed disabled:opacity-60',
            scanning ? 'tabular-nums' : '',
          ].join(' ')}
          onClick={() => void runScan()}
        >
          {scanning && scanProgress
            ? t.importUpload.sheetCoverageScanningWithProgress
                .replace(/\{done\}/g, String(scanProgress.done))
                .replace(/\{total\}/g, String(scanProgress.total))
            : t.importUpload.sheetCoverageScanButton}
        </button>
        {queue.length === 0 ? (
          <span className="text-il-meta text-text-3">{t.importUpload.sheetCoverageNeedQueue}</span>
        ) : null}
      </div>

      {scanError ? (
        <div className="mb-3 rounded-md border border-danger/30 bg-[#fff8f8] px-3 py-2 text-il-meta text-danger">
          {scanError}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-il-btn font-semibold text-text">{t.importUpload.sheetCoverageByType}</div>
            <div className="max-h-[min(52vh,420px)] overflow-auto rounded-[8px] border border-border-light">
              <table className="w-full min-w-[520px] border-collapse text-left text-[12px]">
                <thead className="sticky top-0 z-[1] bg-[#f5f8fc] text-text-2">
                  <tr>
                    <th className="border-b border-border-light px-2.5 py-2 font-medium">
                      {t.importUpload.sheetCoverageColType}
                    </th>
                    <th className="border-b border-border-light px-2.5 py-2 font-medium">
                      {t.importUpload.sheetCoverageColActual}
                    </th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {keysWithHits.length === 0 ? (
                    <tr>
                      <td className="px-2.5 py-3 text-text-3" colSpan={2}>
                        {t.importUpload.sheetCoverageByTypeEmpty}
                      </td>
                    </tr>
                  ) : (
                    keysWithHits.map((k) => {
                      const names = result.globalHitsByKey[k] ?? []
                      return (
                        <tr key={k} className="border-b border-border-light/80 last:border-b-0">
                          <td className="align-top px-2.5 py-2 font-medium text-text">{k}</td>
                          <td className="px-2.5 py-2">
                            <ul className="list-disc space-y-1 pl-4 [overflow-wrap:anywhere]">
                              {names.map((n) => (
                                <li key={`${k}-${n}`}>{n}</li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-il-meta text-text-3">{t.importUpload.sheetCoverageMultiMatchHint}</p>
          </div>

          <div>
            <div className="mb-2 text-il-btn font-semibold text-text">{t.importUpload.sheetCoverageUnmapped}</div>
            {result.globalUnmatched.length === 0 ? (
              <div className="rounded-md border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">
                {t.importUpload.sheetCoverageAllMapped}
              </div>
            ) : (
              <div className="max-h-[min(36vh,280px)] overflow-auto rounded-[8px] border border-[#d4b84a]/45 bg-[#fffdf6] p-3">
                <p className="mb-2 text-il-meta text-[#7a5f00]">{t.importUpload.sheetCoverageUnmappedHint}</p>
                <ul className="space-y-1.5 text-il-meta [overflow-wrap:anywhere] text-text-2">
                  {result.globalUnmatched.map((row, i) => (
                    <li key={`${row.file}-${row.sheet}-${i}`}>
                      <span className="font-medium text-text">{row.file}</span>
                      <span className="text-text-3"> · </span>
                      <span>{row.sheet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <details className="rounded-md border border-border-light bg-[#fafbfc] px-3 py-2">
            <summary className="cursor-pointer select-none text-il-btn font-medium text-text-2">
              {t.importUpload.sheetCoveragePerFileDetail}
            </summary>
            <p className="mt-2 text-il-meta leading-relaxed text-text-3">
              {t.importUpload.sheetCoveragePerFileDetailIntro}
            </p>
            <div className="mt-3 max-h-[min(42vh,320px)] overflow-y-auto pr-1">
              <ul className="space-y-3 text-il-meta text-text-2">
                {result.perFile.map((d) => (
                  <li key={d.fileName} className="border-b border-border-light/80 pb-2 last:border-b-0">
                    <div className="font-medium text-text">{d.fileName}</div>
                    {!d.ok ? (
                      <div className="mt-1 text-danger">{d.error ?? '—'}</div>
                    ) : (
                      <>
                        <div className="mt-1 text-text-3">
                          {t.importUpload.sheetCoverageSheetsInBook}：{d.allSheetNames.join('、') || '—'}
                        </div>
                        {d.unmatchedInFile.length > 0 ? (
                          <div className="mt-1 text-[#8a6d00]">
                            {t.importUpload.sheetCoverageUnmatchedInThisFile}：{d.unmatchedInFile.join('、')}
                          </div>
                        ) : null}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      ) : null}
    </Card>
  )
}
