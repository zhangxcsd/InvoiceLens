import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchAllAuditFlagsList,
  fetchAuditFlagsList,
  fetchAuditMeta,
  postAuditRun,
  type AuditFlagRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams, writeNavQueryParams, navigateToEntityProfile } from '../utils/navHelpers'
import type { NavKey } from '../types'
import { FlagActionButtons } from './FlagActionButtons'
import { navigateFlagAction } from './flagActionHelpers'
import { downloadAuditFlagsCsv } from './flagsExport'
import { auditRiskLevelBadgeClass } from '../dim/dimDictHelpers'
import { useDimDictDomain } from '../dim/useDimDict'
import { useLicense } from '../settings/useLicense'
import { WriteGateButton } from '../users/useWriteGate'

type RiskTab = 'all' | string

type Props = { onNav?: (key: NavKey) => void }

function riskBadgeClass(level: string): string {
  return auditRiskLevelBadgeClass(level)
}

export function FlagsListPage({ onNav }: Props) {
  const ui = t.auditFlagUi
  const license = useLicense()
  const pagUi = t.dimDataTableUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const initialQuery = useMemo(() => readNavQueryParams(), [])
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => initialQuery.stat_year ?? String(new Date().getFullYear()))
  const [rules, setRules] = useState<{ rule_id: string; name: string; enabled: boolean }[]>([])
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [riskTab, setRiskTab] = useState<RiskTab>('all')
  const [ruleFilter, setRuleFilter] = useState(initialQuery.rule_id ?? 'all')
  const [batchFilter, setBatchFilter] = useState(initialQuery.batch_id ?? '')
  const [keyword, setKeyword] = useState(initialQuery.entity_id ?? '')
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
  const [exporting, setExporting] = useState(false)

  const riskTabs = useMemo(
    () => [
      { id: 'all', label: ui.riskTabAll },
      ...riskLevelDict.options.map((o) => ({ id: o.code, label: o.label })),
    ],
    [riskLevelDict.options, ui.riskTabAll],
  )

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

  useEffect(() => {
    writeNavQueryParams({
      stat_year: effectiveYear,
      rule_id: ruleFilter === 'all' ? undefined : ruleFilter,
      entity_id: keyword.trim() || undefined,
      batch_id: batchFilter.trim() || undefined,
    })
  }, [effectiveYear, ruleFilter, keyword, batchFilter])

  const listParams = useMemo(
    () => ({
      statYear: effectiveYear,
      riskLevel: riskTab === 'all' ? undefined : riskTab,
      ruleId: ruleFilter === 'all' ? undefined : ruleFilter,
      keyword: keyword.trim() || undefined,
      batchId: batchFilter.trim() || undefined,
    }),
    [effectiveYear, riskTab, ruleFilter, keyword, batchFilter],
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
      setSummary(res.summary ?? { total: 0, high: 0, medium: 0, low: 0 })
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, listParams, page, pageSize, ui.loadFailed])

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
      downloadAuditFlagsCsv(res.rows, { statYear: effectiveYear, fileStem: '疑点清单' })
    } finally {
      setExporting(false)
    }
  }

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
  }, [effectiveYear, riskTab, ruleFilter, keyword, batchFilter, pageSize])

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
      <LicenseGateBanner hint={license.trialHint} />

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
            <span>{ui.batchFilterLabel}</span>
            <input
              className="h-9 min-w-[200px] rounded-sm border border-border-light bg-white px-2 text-il-body text-text outline-none focus:border-accent"
              value={batchFilter}
              placeholder={ui.batchFilterPlaceholder}
              onChange={(e) => setBatchFilter(e.target.value)}
            />
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
          <WriteGateButton
            className="h-9 rounded-sm bg-accent px-4 text-il-meta font-medium text-white disabled:opacity-50"
            disabled={scanBusy || !effectiveYear}
            onClick={() => void onScan()}
          >
            {scanBusy ? ui.scanBusy : ui.scanBtn}
          </WriteGateButton>
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
          {riskTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                'rounded-sm px-3 py-1 text-il-meta',
                riskTab === tab.id ? 'bg-accent text-white' : 'border border-border-light bg-white text-text-2',
              ].join(' ')}
              onClick={() => setRiskTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </Card>

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
                          {riskLevelDict.getLabel(row.risk_level)}
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
                        <FlagActionButtons
                          row={row}
                          statYear={effectiveYear}
                          onNav={onNav}
                          showReport={false}
                          extraBefore={
                            <button
                              type="button"
                              className="text-accent underline-offset-2 hover:underline"
                              onClick={() => setExpandedId(open ? null : row.flag_id)}
                            >
                              {open ? ui.collapseBtn : ui.expandBtn}
                            </button>
                          }
                          extraAfter={
                            <>
                              {onNav && row.entity_id ? (
                                <button
                                  type="button"
                                  className="text-accent underline-offset-2 hover:underline"
                                  onClick={() =>
                                    navigateToEntityProfile(onNav, {
                                      statYear: effectiveYear,
                                      entityId: row.entity_id ?? undefined,
                                    })
                                  }
                                >
                                  {t.sidebar.entityProfile}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="text-accent underline-offset-2 hover:underline"
                                onClick={() =>
                                  navigateFlagAction(onNav!, 'flags_track', row, effectiveYear)
                                }
                              >
                                {ui.viewTrackBtn}
                              </button>
                            </>
                          }
                        />
                      </td>
                    </tr>
                    {open ? (
                      <tr className="bg-surface-2/40">
                        <td colSpan={8} className="px-3 py-3 text-il-meta text-text-2">
                          <p className="font-medium text-text">{ui.descLabel}</p>
                          <p className="mt-1 whitespace-pre-wrap">{row.description}</p>
                          <p className="mt-2 font-medium text-text">{ui.suggestionLabel}</p>
                          <p className="mt-1 whitespace-pre-wrap">{row.suggestion}</p>
                          {onNav ? (
                            <FlagActionButtons
                              row={row}
                              statYear={effectiveYear}
                              onNav={onNav}
                              className="mt-3 flex flex-wrap gap-3"
                            />
                          ) : null}
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
