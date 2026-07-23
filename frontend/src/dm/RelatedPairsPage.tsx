import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import {
  fetchAuditRelatedCircular,
  postAuditRun,
  type CircularInvRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { handleNavAnalysisAction } from './flagAnalysisNavigate'
import { FlagAnalysisShell } from './FlagAnalysisShell'
import { useFlagAnalysisShell } from './useFlagAnalysisShell'
import { DwsFilterBar } from '../dws/DwsFilterBar'
import { useDwsFilters } from '../dws/useDwsFilters'
import type { NavKey } from '../types'
import { useDimDictDomain } from '../dim/useDimDict'
import { AUDIT_RISK_COL_CLASS, AuditRiskLevelBadge, TableCellTruncate } from './auditRiskBadge'

function normTaxId(v: string): string {
  return v.replace(/[\s-]+/g, '').toUpperCase()
}

import type { EmbedModeProps } from '../types/embedMode'

type Props = { onNav?: (key: NavKey) => void } & EmbedModeProps

export function RelatedPairsPage({ onNav, embedMode }: Props) {
  const ui = t.relatedPairsUi
  const dash = t.dwsDashboardUi
  const pagUi = t.dimDataTableUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'related_pairs',
    enabled: Boolean(onNav) && !embedMode,
    onNav,
    breadcrumbRootLabel: ui.pageTitle,
  })
  const goAnalysis = useCallback(
    (nav: NavKey, params: Record<string, string | undefined>) => {
      if (!onNav) return
      const compact: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') compact[k] = v
      }
      handleNavAnalysisAction(nav, compact, onNav, analysisHandlers, {
        closeShell: shellProps ? closeShell : undefined,
      })
    },
    [onNav, analysisHandlers, shellProps, closeShell],
  )
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const f = useDwsFilters(false, { entityPool: 'analysis', initFromUrl: true })
  const [keyword, setKeyword] = useState(
    urlQuery.keyword ?? urlQuery.party_b_tax ?? urlQuery.party_a_tax ?? '',
  )
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<CircularInvRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [scanBusy, setScanBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))
  const highlightPartyA = urlQuery.party_a_tax?.trim() ? normTaxId(urlQuery.party_a_tax) : ''
  const highlightPartyB = urlQuery.party_b_tax?.trim() ? normTaxId(urlQuery.party_b_tax) : ''
  const flagContextHint = useMemo(() => {
    if (!highlightPartyA && !highlightPartyB) return null
    return dash.flagContextPartyHint
      .replace('{partyA}', urlQuery.party_a_tax?.trim() || highlightPartyA)
      .replace('{partyB}', urlQuery.party_b_tax?.trim() || highlightPartyB)
  }, [dash, highlightPartyA, highlightPartyB, urlQuery.party_a_tax, urlQuery.party_b_tax])

  const rowMatchesHighlight = (row: CircularInvRow) => {
    if (!highlightPartyA && !highlightPartyB) return false
    const a = normTaxId(row.party_a_tax)
    const b = normTaxId(row.party_b_tax)
    if (highlightPartyA && highlightPartyB) {
      return (
        (a === highlightPartyA && b === highlightPartyB) ||
        (a === highlightPartyB && b === highlightPartyA)
      )
    }
    const target = highlightPartyB || highlightPartyA
    return a === target || b === target
  }

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditRelatedCircular(
        {
          statYear: f.effectiveYear,
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
  }, [f.effectiveYear, keyword, page, pageSize, ui.loadFailed, ui.emptyHint])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [f.effectiveYear, keyword, pageSize])

  const onScan = async () => {
    setScanBusy(true)
    try {
      await postAuditRun({ statYear: f.effectiveYear, ruleIds: ['RULE-09'] })
      await load()
    } finally {
      setScanBusy(false)
    }
  }

  return (
    <Fragment>
    <div className="space-y-4 px-5 py-6">
      {!embedMode ? <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} noteTone="plain" /> : null}
      {flagContextHint ? (
        <div className="mb-2 rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-il-meta text-text-2">
          {flagContextHint}
        </div>
      ) : null}
      {hint ? <div className="rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-il-meta text-text-2">{hint}</div> : null}

      <Card title={ui.filterTitle}>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId=""
          onEntityChange={() => {}}
          entityOptions={[]}
          showEntity={false}
          showMinInvoiceCount
          minInvoiceCount={effectiveN}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <label className="mt-3 flex flex-col gap-1 text-il-meta text-text-2">
          <span>{ui.keywordLabel}</span>
          <input
            className="h-9 max-w-md rounded-sm border border-border-light bg-white px-2"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={ui.keywordPlaceholder}
          />
        </label>
        <p className="mt-2 text-il-meta text-text-3">{caliberHint}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="h-9 rounded-sm bg-accent px-4 text-il-meta font-medium text-white disabled:opacity-50"
            disabled={scanBusy}
            onClick={() => void onScan()}
          >
            {scanBusy ? ui.scanBusy : ui.scanBtn}
          </button>
          {onNav ? (
            <>
              <button
                type="button"
                className="h-9 rounded-sm border border-border-light px-3 text-il-meta text-accent hover:underline"
                onClick={() => goAnalysis('flags_rules', { stat_year: f.effectiveYear })}
              >
                {ui.rulesLink}
              </button>
              <button
                type="button"
                className="h-9 rounded-sm border border-border-light px-3 text-il-meta text-accent hover:underline"
                onClick={() =>
                  goAnalysis('flags_list', { stat_year: f.effectiveYear, rule_id: 'RULE-09' })
                }
              >
                {ui.flagsLink}
              </button>
            </>
          ) : null}
        </div>
      </Card>

      <Card title={ui.listTitle.replace('{count}', String(total))}>
        {loading ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
        {err ? <p className="text-il-meta text-danger">{err}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-il-meta">
            <thead>
              <tr className="border-b border-border-light text-left text-text-3">
                <th className="max-w-[180px] py-2 pr-2">{ui.colPartyA}</th>
                <th className="max-w-[180px] py-2 pr-2">{ui.colPartyB}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmtAB}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmtBA}</th>
                <th className="py-2 pr-2 text-right">{ui.colRatio}</th>
                <th className={`py-2 ${AUDIT_RISK_COL_CLASS}`}>{ui.colRisk}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.circ_id}
                  className={[
                    'border-b border-border-light/70 text-text',
                    rowMatchesHighlight(row) ? 'bg-[#fff8ef]' : '',
                  ].join(' ')}
                >
                  <td className="py-2 pr-2">
                    <TableCellTruncate text={row.party_a_name ?? row.party_a_tax} maxWidth="max-w-[180px]" />
                  </td>
                  <td className="py-2 pr-2">
                    <TableCellTruncate text={row.party_b_name ?? row.party_b_tax} maxWidth="max-w-[180px]" />
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.amount_a_to_b.toLocaleString('zh-CN')}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.amount_b_to_a.toLocaleString('zh-CN')}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{(row.circular_ratio * 100).toFixed(1)}%</td>
                  <td className={`py-2 ${AUDIT_RISK_COL_CLASS}`}>
                    <AuditRiskLevelBadge level={row.risk_level} label={riskLevelDict.getLabel(row.risk_level)} />
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
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </Fragment>
  )
}
