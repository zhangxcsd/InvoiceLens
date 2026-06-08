import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchAuditFlagsList,
  fetchAuditMeta,
  postAuditRun,
  type AuditFlagRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

type RiskTab = 'all' | '高风险' | '中风险' | '低风险'

function riskBadgeClass(level: string): string {
  if (level === '高风险') return 'bg-danger/10 text-danger'
  if (level === '中风险') return 'bg-warn/10 text-warn'
  return 'bg-text-3/10 text-text-2'
}

export function FlagsListPage() {
  const ui = t.auditFlagUi
  const pagUi = t.dimDataTableUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [rules, setRules] = useState<{ rule_id: string; name: string; enabled: boolean }[]>([])
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [riskTab, setRiskTab] = useState<RiskTab>('all')
  const [ruleFilter, setRuleFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<AuditFlagRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState({ total: 0, high: 0, medium: 0, low: 0 })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)

  const effectiveYear = useMemo(() => {
    const y = statYear.trim()
    if (y && statYears.includes(y)) return y
    return statYears[0] ?? y
  }, [statYear, statYears])

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    const res = await fetchAuditMeta(signal)
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
    setRules(res.rules ?? [])
    setMetaHint(res.hint ?? null)
  }, [ui.loadFailed])

  const loadList = useCallback(async (signal?: AbortSignal) => {
    if (!effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditFlagsList(
        {
          statYear: effectiveYear,
          riskLevel: riskTab === 'all' ? undefined : riskTab,
          ruleId: ruleFilter === 'all' ? undefined : ruleFilter,
          keyword: keyword.trim() || undefined,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        return
      }
      setRows(res.rows ?? [])
      setTotal(res.total ?? 0)
      setSummary(res.summary ?? { total: 0, high: 0, medium: 0, low: 0 })
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, riskTab, ruleFilter, keyword, page, pageSize, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void loadMeta(ac.signal)
    return () => ac.abort()
  }, [loadMeta])

  useEffect(() => {
    const ac = new AbortController()
    void loadList(ac.signal)
    return () => ac.abort()
  }, [loadList])

  useEffect(() => {
    setPage(1)
  }, [effectiveYear, riskTab, ruleFilter, keyword, pageSize])

  const onScan = async () => {
    setScanBusy(true)
    setScanMsg(null)
    try {
      const res = await postAuditRun({ statYear: effectiveYear })
      if (!res.ok) {
        setScanMsg(res.error?.message ?? ui.scanFailed)
        return
      }
      setScanMsg(ui.scanSuccess.replace('{count}', String(res.total_flag_count ?? 0)))
      await loadMeta()
      await loadList()
    } finally {
      setScanBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />

      {metaHint ? (
        <div className="rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-il-meta text-text-2">{metaHint}</div>
      ) : null}

      <Card title={ui.filterTitle}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.statYearLabel}</span>
            <select
              className="h-9 min-w-[120px] rounded-sm border border-border-light bg-white px-2 text-il-body text-text"
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
            <span>{ui.ruleFilterLabel}</span>
            <select
              className="h-9 min-w-[180px] rounded-sm border border-border-light bg-white px-2 text-il-body text-text"
              value={ruleFilter}
              onChange={(e) => setRuleFilter(e.target.value)}
            >
              <option value="all">{ui.ruleFilterAll}</option>
              {rules.map((r) => (
                <option key={r.rule_id} value={r.rule_id}>
                  {r.rule_id} · {r.name}
                  {!r.enabled ? ui.ruleDisabledSuffix : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.keywordLabel}</span>
            <input
              className="h-9 min-w-[200px] rounded-sm border border-border-light bg-white px-2 text-il-body text-text outline-none focus:border-accent"
              value={keyword}
              placeholder={ui.keywordPlaceholder}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="h-9 rounded-sm bg-accent px-4 text-il-meta font-medium text-white disabled:opacity-50"
            disabled={scanBusy || !effectiveYear}
            onClick={() => void onScan()}
          >
            {scanBusy ? ui.scanBusy : ui.scanBtn}
          </button>
        </div>
        {scanMsg ? <p className="mt-2 text-il-meta text-text-2">{scanMsg}</p> : null}
      </Card>

      <Card title={ui.summaryTitle}>
        <div className="flex flex-wrap gap-4 text-il-body text-text">
          <span>{ui.summaryTotal.replace('{n}', String(summary.total))}</span>
          <span className="text-danger">{ui.summaryHigh.replace('{n}', String(summary.high))}</span>
          <span className="text-warn">{ui.summaryMedium.replace('{n}', String(summary.medium))}</span>
          <span className="text-text-2">{ui.summaryLow.replace('{n}', String(summary.low))}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['all', '高风险', '中风险', '低风险'] as RiskTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              className={[
                'rounded-sm px-3 py-1 text-il-meta',
                riskTab === tab ? 'bg-accent text-white' : 'border border-border-light bg-white text-text-2',
              ].join(' ')}
              onClick={() => setRiskTab(tab)}
            >
              {tab === 'all' ? ui.riskTabAll : tab}
            </button>
          ))}
        </div>
      </Card>

      <Card title={ui.listTitle.replace('{count}', String(total))}>
        {loading ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
        {err ? <p className="text-il-meta text-danger">{err}</p> : null}
        {!loading && !err && rows.length === 0 ? (
          <p className="text-il-meta text-text-3">{ui.emptyList}</p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-il-meta">
            <thead>
              <tr className="border-b border-border-light text-left text-text-3">
                <th className="py-2 pr-2">{ui.colFlagId}</th>
                <th className="py-2 pr-2">{ui.colRisk}</th>
                <th className="py-2 pr-2">{ui.colRule}</th>
                <th className="py-2 pr-2">{ui.colType}</th>
                <th className="py-2 pr-2">{ui.colEntity}</th>
                <th className="py-2 pr-2">{ui.colSeller}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmount}</th>
                <th className="py-2">{ui.colAction}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = expandedId === row.flag_id
                return (
                  <Fragment key={row.flag_id}>
                    <tr className="border-b border-border-light/70 text-text">
                      <td className="py-2 pr-2 font-mono text-[11px]">{row.flag_id}</td>
                      <td className="py-2 pr-2">
                        <span className={`rounded px-1.5 py-0.5 ${riskBadgeClass(row.risk_level)}`}>
                          {row.risk_level}
                        </span>
                      </td>
                      <td className="py-2 pr-2">{row.rule_id}</td>
                      <td className="py-2 pr-2">{row.flag_type}</td>
                      <td className="py-2 pr-2">{row.entity_name ?? row.entity_id ?? '—'}</td>
                      <td className="py-2 pr-2">{row.seller_name ?? '—'}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {row.amount != null ? row.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—'}
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          className="text-accent underline-offset-2 hover:underline"
                          onClick={() => setExpandedId(open ? null : row.flag_id)}
                        >
                          {open ? ui.collapseBtn : ui.expandBtn}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="bg-surface-2/40">
                        <td colSpan={8} className="px-3 py-3 text-il-meta text-text-2">
                          <p className="font-medium text-text">{ui.descLabel}</p>
                          <p className="mt-1 whitespace-pre-wrap">{row.description}</p>
                          <p className="mt-2 font-medium text-text">{ui.suggestionLabel}</p>
                          <p className="mt-1 whitespace-pre-wrap">{row.suggestion}</p>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
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
