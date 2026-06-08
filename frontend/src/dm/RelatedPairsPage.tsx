import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchAuditMeta,
  fetchAuditRelatedCircular,
  postAuditRun,
  type CircularInvRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

function riskBadgeClass(level: string): string {
  if (level === '高风险') return 'bg-danger/10 text-danger'
  if (level === '中风险') return 'bg-warn/10 text-warn'
  return 'bg-text-3/10 text-text-2'
}

export function RelatedPairsPage() {
  const ui = t.relatedPairsUi
  const pagUi = t.dimDataTableUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<CircularInvRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [scanBusy, setScanBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  const effectiveYear = useMemo(() => {
    const y = statYear.trim()
    if (y && statYears.includes(y)) return y
    return statYears[0] ?? y
  }, [statYear, statYears])

  useEffect(() => {
    const ac = new AbortController()
    void fetchAuditMeta(ac.signal).then((res) => {
      if (res.ok && res.stat_years?.length) {
        setStatYears(res.stat_years)
        const cy = String(new Date().getFullYear())
        setStatYear((prev) => (res.stat_years!.includes(prev) ? prev : res.stat_years!.includes(cy) ? cy : res.stat_years![0]))
      }
    })
    return () => ac.abort()
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditRelatedCircular(
        {
          statYear: effectiveYear,
          keyword: keyword.trim() || undefined,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        },
        signal,
      )
      if (signal?.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        return
      }
      setRows(res.rows ?? [])
      setTotal(res.total ?? 0)
      if ((res.total ?? 0) === 0) setHint(ui.emptyHint)
      else setHint(null)
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, keyword, page, pageSize, ui.loadFailed, ui.emptyHint])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [effectiveYear, keyword, pageSize])

  const onScan = async () => {
    setScanBusy(true)
    try {
      await postAuditRun({ statYear: effectiveYear, ruleIds: ['RULE-09'] })
      await load()
    } finally {
      setScanBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {hint ? <div className="rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-il-meta text-text-2">{hint}</div> : null}

      <Card title={ui.filterTitle}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.statYearLabel}</span>
            <select
              className="h-9 min-w-[120px] rounded-sm border border-border-light bg-white px-2"
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
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.keywordLabel}</span>
            <input
              className="h-9 min-w-[200px] rounded-sm border border-border-light bg-white px-2"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
            />
          </label>
          <button
            type="button"
            className="h-9 rounded-sm bg-accent px-4 text-il-meta font-medium text-white disabled:opacity-50"
            disabled={scanBusy}
            onClick={() => void onScan()}
          >
            {scanBusy ? ui.scanBusy : ui.scanBtn}
          </button>
        </div>
      </Card>

      <Card title={ui.listTitle.replace('{count}', String(total))}>
        {loading ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
        {err ? <p className="text-il-meta text-danger">{err}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-il-meta">
            <thead>
              <tr className="border-b border-border-light text-left text-text-3">
                <th className="py-2 pr-2">{ui.colPartyA}</th>
                <th className="py-2 pr-2">{ui.colPartyB}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmtAB}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmtBA}</th>
                <th className="py-2 pr-2 text-right">{ui.colRatio}</th>
                <th className="py-2">{ui.colRisk}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.circ_id} className="border-b border-border-light/70 text-text">
                  <td className="py-2 pr-2">{row.party_a_name ?? row.party_a_tax}</td>
                  <td className="py-2 pr-2">{row.party_b_name ?? row.party_b_tax}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.amount_a_to_b.toLocaleString('zh-CN')}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.amount_b_to_a.toLocaleString('zh-CN')}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{(row.circular_ratio * 100).toFixed(1)}%</td>
                  <td className="py-2">
                    <span className={`rounded px-1.5 py-0.5 ${riskBadgeClass(row.risk_level)}`}>{row.risk_level}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DimTablePagination
          total={total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          ui={pagUi}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  )
}
