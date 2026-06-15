import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { DimTablePagination } from '../dim/DimTablePagination'
import { fetchAuditRelatedShell, postAuditRun, type ShellCoRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { navigateToFlagsList, navigateWithQuery } from '../utils/navHelpers'
import { DwsFilterBar } from '../dws/DwsFilterBar'
import { useDwsFilters } from '../dws/useDwsFilters'
import type { NavKey } from '../types'
import { auditRiskLevelBadgeClass } from '../dim/dimDictHelpers'
import { useDimDictDomain } from '../dim/useDimDict'

type Props = { onNav?: (key: NavKey) => void }

export function RelatedShellPage({ onNav }: Props) {
  const ui = t.relatedShellUi
  const dash = t.dwsDashboardUi
  const pagUi = t.dimDataTableUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const f = useDwsFilters(false, { entityPool: 'analysis', initFromUrl: true })
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<ShellCoRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [scanBusy, setScanBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditRelatedShell(
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
      await postAuditRun({ statYear: f.effectiveYear })
      await load()
    } finally {
      setScanBusy(false)
    }
  }

  return (
    <div className="space-y-4 px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} noteTone="plain" />
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
                onClick={() => navigateWithQuery(onNav, 'flags_rules', { stat_year: f.effectiveYear })}
              >
                {ui.rulesLink}
              </button>
              <button
                type="button"
                className="h-9 rounded-sm border border-border-light px-3 text-il-meta text-accent hover:underline"
                onClick={() => navigateToFlagsList(onNav, { statYear: f.effectiveYear, ruleId: 'RULE-SHELL' })}
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
          <table className="w-full min-w-[960px] border-collapse text-il-meta">
            <thead>
              <tr className="border-b border-border-light text-left text-text-3">
                <th className="py-2 pr-2">{ui.colMember}</th>
                <th className="py-2 pr-2">{ui.colIntermediary}</th>
                <th className="py-2 pr-2">{ui.colTarget}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmtIn}</th>
                <th className="py-2 pr-2 text-right">{ui.colAmtOut}</th>
                <th className="py-2 pr-2 text-right">{ui.colRatio}</th>
                <th className="py-2">{ui.colRisk}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.shell_id} className="border-b border-border-light/70 text-text">
                  <td className="py-2 pr-2">{row.group_member_name ?? row.group_member_tax}</td>
                  <td className="py-2 pr-2">{row.intermediary_name ?? row.intermediary_tax}</td>
                  <td className="py-2 pr-2">{row.final_target_name ?? row.final_target_tax ?? '—'}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.amount_in.toLocaleString('zh-CN')}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.amount_out.toLocaleString('zh-CN')}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{(row.passthrough_ratio * 100).toFixed(1)}%</td>
                  <td className="py-2">
                    {row.risk_level ? (
                      <span className={`rounded px-1.5 py-0.5 ${auditRiskLevelBadgeClass(row.risk_level)}`}>
                        {riskLevelDict.getLabel(row.risk_level)}
                      </span>
                    ) : (
                      '—'
                    )}
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
