import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchAuditFlagsList,
  fetchAuditMeta,
  postAuditFlagConfirm,
  type AuditFlagRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

type TrackTab = 'pending' | 'confirmed' | 'all'
type RiskTab = 'all' | '高风险' | '中风险' | '低风险'

function riskBadgeClass(level: string): string {
  if (level === '高风险') return 'bg-danger/10 text-danger'
  if (level === '中风险') return 'bg-warn/10 text-warn'
  return 'bg-text-3/10 text-text-2'
}

function trackTabToStatus(tab: TrackTab): 'pending' | 'confirmed' | 'all' {
  return tab
}

export function FlagsTrackPage() {
  const ui = t.auditTrackUi
  const pagUi = t.dimDataTableUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [trackTab, setTrackTab] = useState<TrackTab>('pending')
  const [riskTab, setRiskTab] = useState<RiskTab>('all')
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<AuditFlagRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState({ total: 0, pending: 0, confirmed: 0, high: 0 })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [noteDraft, setNoteDraft] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

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
          keyword: keyword.trim() || undefined,
          trackStatus: trackTabToStatus(trackTab),
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
      setSummary({
        total: res.summary?.total ?? 0,
        pending: res.summary?.pending ?? 0,
        confirmed: res.summary?.confirmed ?? 0,
        high: res.summary?.high ?? 0,
      })
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, riskTab, keyword, trackTab, page, pageSize, ui.loadFailed])

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
  }, [effectiveYear, trackTab, riskTab, keyword, pageSize])

  const toggleSelect = (flagId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(flagId)) next.delete(flagId)
      else next.add(flagId)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === rows.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(rows.map((r) => r.flag_id)))
    }
  }

  const onConfirm = async () => {
    const ids = [...selected]
    if (!ids.length) return
    setActionBusy(true)
    setActionMsg(null)
    try {
      const res = await postAuditFlagConfirm({
        flagIds: ids,
        isConfirmed: true,
        confirmNote: noteDraft.trim(),
      })
      if (!res.ok) {
        setActionMsg(res.error?.message ?? ui.confirmFailed)
        return
      }
      setActionMsg(res.message ?? ui.confirmSuccess.replace('{count}', String(ids.length)))
      setNoteDraft('')
      await loadList()
    } finally {
      setActionBusy(false)
    }
  }

  const onUnconfirm = async (flagIds: string[]) => {
    if (!flagIds.length) return
    setActionBusy(true)
    setActionMsg(null)
    try {
      const res = await postAuditFlagConfirm({ flagIds, isConfirmed: false })
      if (!res.ok) {
        setActionMsg(res.error?.message ?? ui.unconfirmFailed)
        return
      }
      setActionMsg(res.message ?? ui.unconfirmSuccess)
      await loadList()
    } finally {
      setActionBusy(false)
    }
  }

  const trackTabs: { id: TrackTab; label: string }[] = [
    { id: 'pending', label: ui.tabPending },
    { id: 'confirmed', label: ui.tabConfirmed },
    { id: 'all', label: ui.tabAll },
  ]

  const riskTabs: { id: RiskTab; label: string }[] = [
    { id: 'all', label: ui.riskTabAll },
    { id: '高风险', label: ui.riskTabHigh },
    { id: '中风险', label: ui.riskTabMedium },
    { id: '低风险', label: ui.riskTabLow },
  ]

  return (
    <div className="space-y-4">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />

      {metaHint ? (
        <div className="rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-il-meta text-text-2">{metaHint}</div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <Card title={ui.kpiPending}>
          <div className="text-2xl font-semibold text-warn">{summary.pending}</div>
        </Card>
        <Card title={ui.kpiConfirmed}>
          <div className="text-2xl font-semibold text-accent">{summary.confirmed}</div>
        </Card>
        <Card title={ui.kpiHighRisk}>
          <div className="text-2xl font-semibold text-danger">{summary.high}</div>
        </Card>
        <Card title={ui.kpiTotal}>
          <div className="text-2xl font-semibold text-text">{summary.total}</div>
        </Card>
      </div>

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
            <span>{ui.keywordLabel}</span>
            <input
              className="h-9 min-w-[200px] rounded-sm border border-border-light bg-white px-2 text-il-body text-text outline-none focus:border-accent"
              value={keyword}
              placeholder={ui.keywordPlaceholder}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {trackTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                'rounded-sm border px-3 py-1 text-il-meta',
                trackTab === tab.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-light bg-white text-text-2 hover:border-accent/40',
              ].join(' ')}
              onClick={() => setTrackTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {riskTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                'rounded-sm border px-2 py-0.5 text-il-soon',
                riskTab === tab.id
                  ? 'border-text bg-text/5 text-text'
                  : 'border-border-light text-text-3 hover:text-text-2',
              ].join(' ')}
              onClick={() => setRiskTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </Card>

      {trackTab === 'pending' && selected.size > 0 ? (
        <Card title={ui.batchConfirmTitle.replace('{count}', String(selected.size))}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-il-meta text-text-2">
              <span>{ui.confirmNoteLabel}</span>
              <textarea
                className="min-h-[72px] rounded-sm border border-border-light bg-white px-2 py-1.5 text-il-body text-text outline-none focus:border-accent"
                value={noteDraft}
                placeholder={ui.confirmNotePlaceholder}
                onChange={(e) => setNoteDraft(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={actionBusy || !noteDraft.trim()}
              className="h-9 rounded-sm bg-accent px-4 text-il-body text-white disabled:opacity-50"
              onClick={() => void onConfirm()}
            >
              {actionBusy ? ui.confirmBusy : ui.confirmBtn}
            </button>
          </div>
          {actionMsg ? <p className="mt-2 text-il-meta text-text-2">{actionMsg}</p> : null}
        </Card>
      ) : null}

      {actionMsg && trackTab !== 'pending' ? (
        <div className="rounded-sm border border-accent/30 bg-accent/5 px-3 py-2 text-il-meta text-text-2">{actionMsg}</div>
      ) : null}

      <Card title={ui.listTitle.replace('{count}', String(total))}>
        {loading ? (
          <p className="text-il-meta text-text-3">{ui.loading}</p>
        ) : err ? (
          <p className="text-il-meta text-danger">{err}</p>
        ) : rows.length === 0 ? (
          <p className="text-il-meta text-text-3">{ui.emptyList}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse text-il-body">
                <thead>
                  <tr className="border-b border-border-light text-left text-il-meta text-text-3">
                    {trackTab === 'pending' ? (
                      <th className="w-8 py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={rows.length > 0 && selected.size === rows.length}
                          onChange={toggleSelectAll}
                          aria-label={ui.selectAll}
                        />
                      </th>
                    ) : null}
                    <th className="py-2 pr-3">{ui.colFlagId}</th>
                    <th className="py-2 pr-3">{ui.colRisk}</th>
                    <th className="py-2 pr-3">{ui.colType}</th>
                    <th className="py-2 pr-3">{ui.colEntity}</th>
                    <th className="py-2 pr-3">{ui.colAmount}</th>
                    <th className="py-2 pr-3">{ui.colTrackStatus}</th>
                    <th className="py-2">{ui.colAction}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Fragment key={row.flag_id}>
                      <tr className="border-b border-border-light/70 hover:bg-bg-2/40">
                        {trackTab === 'pending' ? (
                          <td className="py-2 pr-2">
                            <input
                              type="checkbox"
                              checked={selected.has(row.flag_id)}
                              onChange={() => toggleSelect(row.flag_id)}
                              aria-label={ui.selectRow}
                            />
                          </td>
                        ) : null}
                        <td className="py-2 pr-3 font-mono text-il-soon text-text-2">{row.flag_id}</td>
                        <td className="py-2 pr-3">
                          <span className={`rounded px-1.5 py-0.5 text-il-soon ${riskBadgeClass(row.risk_level)}`}>
                            {row.risk_level}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-text-2">{row.flag_type}</td>
                        <td className="py-2 pr-3 text-text-2">{row.entity_name ?? row.entity_id ?? '—'}</td>
                        <td className="py-2 pr-3 tabular-nums text-text-2">
                          {row.amount != null ? row.amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'}
                        </td>
                        <td className="py-2 pr-3">
                          {row.is_confirmed ? (
                            <span className="text-accent">{ui.statusConfirmed}</span>
                          ) : (
                            <span className="text-warn">{ui.statusPending}</span>
                          )}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="text-il-meta text-accent hover:underline"
                              onClick={() => setExpandedId((id) => (id === row.flag_id ? null : row.flag_id))}
                            >
                              {expandedId === row.flag_id ? ui.collapseBtn : ui.expandBtn}
                            </button>
                            {row.is_confirmed ? (
                              <button
                                type="button"
                                disabled={actionBusy}
                                className="text-il-meta text-text-3 hover:text-text-2 disabled:opacity-50"
                                onClick={() => void onUnconfirm([row.flag_id])}
                              >
                                {ui.unconfirmBtn}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {expandedId === row.flag_id ? (
                        <tr className="border-b border-border-light bg-bg-2/30">
                          <td colSpan={trackTab === 'pending' ? 8 : 7} className="px-3 py-3 text-il-meta text-text-2">
                            <p>
                              <span className="font-medium text-text">{ui.descLabel}：</span>
                              {row.description || '—'}
                            </p>
                            <p className="mt-1">
                              <span className="font-medium text-text">{ui.suggestionLabel}：</span>
                              {row.suggestion || '—'}
                            </p>
                            {row.confirm_note ? (
                              <p className="mt-1">
                                <span className="font-medium text-text">{ui.confirmNoteLabel}：</span>
                                {row.confirm_note}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <DimTablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              ui={pagUi}
            />
          </>
        )}
      </Card>
    </div>
  )
}
