import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchAllAuditFlagsList,
  fetchAuditFlagsList,
  fetchAuditMeta,
  postAuditFlagConfirm,
  type AuditFlagRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import {
  navigateToFlagsList,
  navigateToReportConfig,
  readFlagsTrackTab,
  readNavQueryParams,
  writeNavQueryParams,
} from '../utils/navHelpers'
import { FlagActionButtons } from './FlagActionButtons'
import { reportChaptersForRule } from './flagActionHelpers'
import { downloadAuditFlagsCsv } from './flagsExport'
import { auditRiskLevelBadgeClass } from '../dim/dimDictHelpers'
import { useDimDictDomain } from '../dim/useDimDict'
import { useLicense } from '../settings/useLicense'
import { WriteGateButton } from '../users/useWriteGate'
type TrackTab = 'pending' | 'confirmed' | 'all'
type RiskTab = 'all' | string

type Props = { onNav?: (key: NavKey) => void }

function riskBadgeClass(level: string): string {
  return auditRiskLevelBadgeClass(level)
}

function trackTabToStatus(tab: TrackTab): 'pending' | 'confirmed' | 'all' {
  return tab
}

export function FlagsTrackPage({ onNav }: Props) {
  const ui = t.auditTrackUi
  const license = useLicense()
  const initialQuery = useMemo(() => readNavQueryParams(), [])
  const pagUi = t.dimDataTableUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const [statYears, setStatYears] = useState<string[]>([])
  const [rules, setRules] = useState<{ rule_id: string; name: string; enabled: boolean }[]>([])
  const [statYear, setStatYear] = useState(() => initialQuery.stat_year ?? String(new Date().getFullYear()))
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [trackTab, setTrackTab] = useState<TrackTab>(() => readFlagsTrackTab())
  const [riskTab, setRiskTab] = useState<RiskTab>('all')
  const [ruleFilter, setRuleFilter] = useState(initialQuery.rule_id ?? 'all')
  const [keyword, setKeyword] = useState(initialQuery.entity_id ?? '')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
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

  useEffect(() => {
    writeNavQueryParams({
      stat_year: effectiveYear,
      track_tab: trackTab,
      track_status: trackTab,
      rule_id: ruleFilter === 'all' ? undefined : ruleFilter,
      entity_id: keyword.trim() || undefined,
    })
  }, [effectiveYear, trackTab, ruleFilter, keyword])

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    const res = await fetchAuditMeta(signal)
    if (signal?.aborted || res.aborted) return
    if (!res.ok) {
      setMetaHint(res.error?.message ?? ui.loadFailed)
      return
    }
    const years = res.stat_years ?? []
    setStatYears(years)
    setRules(res.rules ?? [])
    if (years.length) {
      const cy = String(new Date().getFullYear())
      setStatYear((prev) => (years.includes(prev) ? prev : years.includes(cy) ? cy : years[0]))
    }
    setMetaHint(res.hint ?? null)
  }, [ui.loadFailed])

  const listParams = useMemo(
    () => ({
      statYear: effectiveYear,
      riskLevel: riskTab === 'all' ? undefined : riskTab,
      ruleId: ruleFilter === 'all' ? undefined : ruleFilter,
      keyword: keyword.trim() || undefined,
      trackStatus: trackTabToStatus(trackTab),
    }),
    [effectiveYear, riskTab, ruleFilter, keyword, trackTab],
  )

  const loadList = useCallback(async (signal?: AbortSignal) => {
    if (!effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditFlagsList(
        { ...listParams, limit: pageSize, offset: (page - 1) * pageSize },
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
  }, [effectiveYear, listParams, page, pageSize, ui.loadFailed])

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
  }, [effectiveYear, trackTab, riskTab, ruleFilter, keyword, pageSize])

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

  const onBatchReject = async () => {
    const ids = [...selected]
    if (!ids.length) return
    setActionBusy(true)
    setActionMsg(null)
    try {
      const res = await postAuditFlagConfirm({ flagIds: ids, isConfirmed: false })
      if (!res.ok) {
        setActionMsg(res.error?.message ?? ui.rejectFailed)
        return
      }
      setActionMsg(res.message ?? ui.rejectSuccess.replace('{count}', String(ids.length)))
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

  const exportCsv = async () => {
    if (!license.exportAllowed) {
      setErr(license.trialHint ?? ui.exportLicenseDenied)
      return
    }
    setExporting(true)
    setErr(null)
    try {
      const res = await fetchAllAuditFlagsList(listParams)
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      if (res.rows.length === 0) {
        setErr(ui.exportEmpty)
        return
      }
      downloadAuditFlagsCsv(res.rows, { statYear: effectiveYear, fileStem: '疑点跟踪' })
    } finally {
      setExporting(false)
    }
  }

  const riskTabs = useMemo(
    () => [
      { id: 'all', label: ui.riskTabAll },
      ...riskLevelDict.options.map((o) => ({ id: o.code, label: o.label })),
    ],
    [riskLevelDict.options, ui.riskTabAll],
  )

  const trackTabs: { id: TrackTab; label: string }[] = [
    { id: 'pending', label: ui.tabPending },
    { id: 'confirmed', label: ui.tabConfirmed },
    { id: 'all', label: ui.tabAll },
  ]

  const renderRowActions = (row: AuditFlagRow) => (
    <FlagActionButtons
      row={row}
      statYear={effectiveYear}
      onNav={onNav}
      showReport={false}
      extraBefore={
        <>
          <button
            type="button"
            className="text-il-meta text-accent hover:underline"
            onClick={() => setExpandedId((id) => (id === row.flag_id ? null : row.flag_id))}
          >
            {expandedId === row.flag_id ? ui.collapseBtn : ui.expandBtn}
          </button>
          {row.is_confirmed ? (
            <WriteGateButton
              requires="audit_flags"
              className="text-il-meta text-text-3 hover:text-text-2 disabled:opacity-50"
              disabled={actionBusy}
              onClick={() => void onUnconfirm([row.flag_id])}
            >
              {ui.unconfirmBtn}
            </WriteGateButton>
          ) : null}
        </>
      }
      extraAfter={
        onNav ? (
          <>
            <button
              type="button"
              className="text-il-meta text-accent hover:underline"
              onClick={() =>
                navigateToReportConfig(onNav, {
                  statYear: effectiveYear,
                  entityId: row.entity_id ?? undefined,
                  chapters: reportChaptersForRule(row.rule_id),
                })
              }
            >
              {ui.genReportBtn}
            </button>
            <button
              type="button"
              className="text-il-meta text-accent hover:underline"
              onClick={() =>
                navigateToFlagsList(onNav, {
                  statYear: effectiveYear,
                  ruleId: row.rule_id,
                  entityId: row.entity_id ?? undefined,
                })
              }
            >
              {ui.viewFlagsListBtn}
            </button>
          </>
        ) : null
      }
      className="flex flex-wrap gap-2"
    />
  )

  return (
    <div className="space-y-4">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      <LicenseGateBanner hint={license.trialHint} />

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
          {onNav ? (
            <button
              type="button"
              className="mt-3 text-il-meta text-accent hover:underline"
              onClick={() =>
                navigateToReportConfig(onNav, {
                  statYear: effectiveYear,
                  chapters: ['flags_track', 'audit_flags', 'related'],
                })
              }
            >
              {ui.reportLink}
            </button>
          ) : null}
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

      {(trackTab === 'pending' || trackTab === 'confirmed') && selected.size > 0 ? (
        <Card
          title={
            trackTab === 'pending'
              ? ui.batchConfirmTitle.replace('{count}', String(selected.size))
              : ui.batchRejectTitle.replace('{count}', String(selected.size))
          }
        >
          <div className="flex flex-wrap items-end gap-3">
            {trackTab === 'pending' ? (
              <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-il-meta text-text-2">
                <span>{ui.confirmNoteLabel}</span>
                <textarea
                  className="min-h-[72px] rounded-sm border border-border-light bg-white px-2 py-1.5 text-il-body text-text outline-none focus:border-accent"
                  value={noteDraft}
                  placeholder={ui.confirmNotePlaceholder}
                  onChange={(e) => setNoteDraft(e.target.value)}
                />
              </label>
            ) : null}
            {trackTab === 'pending' ? (
              <WriteGateButton
                requires="audit_flags"
                className="h-9 rounded-sm bg-accent px-4 text-il-body text-white disabled:opacity-50"
                disabled={actionBusy || !noteDraft.trim()}
                onClick={() => void onConfirm()}
              >
                {actionBusy ? ui.confirmBusy : ui.confirmBtn}
              </WriteGateButton>
            ) : null}
            <WriteGateButton
              requires="audit_flags"
              className="h-9 rounded-sm border border-danger bg-white px-4 text-il-body text-danger hover:bg-danger/5 disabled:opacity-50"
              disabled={actionBusy}
              onClick={() => void onBatchReject()}
            >
              {actionBusy ? ui.rejectBusy : ui.rejectBtn}
            </WriteGateButton>
          </div>
          {actionMsg ? <p className="mt-2 text-il-meta text-text-2">{actionMsg}</p> : null}
        </Card>
      ) : null}

      {actionMsg && trackTab !== 'pending' && trackTab !== 'confirmed' ? (
        <div className="rounded-sm border border-accent/30 bg-accent/5 px-3 py-2 text-il-meta text-text-2">{actionMsg}</div>
      ) : null}

      <Card title={ui.listTitle.replace('{count}', String(total))}>
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            disabled={loading || exporting || !license.exportAllowed}
            className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
            onClick={() => void exportCsv()}
          >
            {exporting ? ui.exportBusy : ui.exportCsv}
          </button>
        </div>
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
                    {trackTab === 'pending' || trackTab === 'confirmed' ? (
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
                    <th className="py-2 pr-3">{ui.colRule}</th>
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
                        {trackTab === 'pending' || trackTab === 'confirmed' ? (
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
                        <td className="py-2 pr-3 font-mono text-il-soon text-text-2">{row.rule_id}</td>
                        <td className="py-2 pr-3">
                          <span className={`rounded px-1.5 py-0.5 text-il-soon ${riskBadgeClass(row.risk_level)}`}>
                            {riskLevelDict.getLabel(row.risk_level)}
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
                        <td className="py-2">{renderRowActions(row)}</td>
                      </tr>
                      {expandedId === row.flag_id ? (
                        <tr className="border-b border-border-light bg-bg-2/30">
                          <td
                            colSpan={trackTab === 'pending' || trackTab === 'confirmed' ? 9 : 8}
                            className="px-3 py-3 text-il-meta text-text-2"
                          >
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
