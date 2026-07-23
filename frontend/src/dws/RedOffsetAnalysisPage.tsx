import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import type { DwsRedOffsetRow } from '../config/localApi'
import { fetchDwsRedOffsetList, fetchDwsRedOffsetOverview } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { InvoiceDetailDrillPanel } from './InvoiceDetailDrillPanel'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

export function RedOffsetAnalysisPage({ onNav, embedMode }: { onNav?: (key: NavKey) => void } & EmbedModeProps) {
  const ui = t.redOffsetUi
  const drillUi = t.invoiceDetailDrillUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('red_offset_analysis', embedMode)
  const f = useDwsFilters(false, {
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
  })
  const [kind, setKind] = useState(() => {
    if (urlQuery.fpzt === '红字') return 'orphan'
    const saved = savedUi?.extra?.kind
    return saved === 'orphan' ? 'orphan' : 'all'
  })
  const [kpis, setKpis] = useState<Record<string, number | null>>({})
  const [monthly, setMonthly] = useState<Array<{ stat_month: number; red_cnt: number; orphan_cnt: number }>>([])
  const [rows, setRows] = useState<DwsRedOffsetRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillSeller, setDrillSeller] = useState<string | null>(null)

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
    },
    [f],
  )

  const { goAnalysis, shellProps } = useDwsPageAnalysisShell({
    host: 'red_offset_analysis',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      loading,
      extra: { kind },
    },
  })

  const entityId = f.entityId.trim() || urlQuery.entity_id?.trim() || ''

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear) return
      setLoading(true)
      setErr(null)
      try {
        const [ov, list] = await Promise.all([
          fetchDwsRedOffsetOverview({ statYear: f.effectiveYear, entityId: entityId || undefined }, signal),
          fetchDwsRedOffsetList(
            { statYear: f.effectiveYear, entityId: entityId || undefined, kind, limit: 50 },
            signal,
          ),
        ])
        if (signal?.aborted || ov.aborted || list.aborted) return
        if (!ov.ok) {
          setErr(ov.error?.message ?? ui.loadFailed)
          return
        }
        if (!list.ok) {
          setErr(list.error?.message ?? ui.loadFailed)
          return
        }
        setKpis(ov.data?.kpis ?? {})
        setMonthly(ov.data?.monthly_trend ?? [])
        setRows(list.rows ?? [])
        setTotal(list.total ?? 0)
      } finally {
        setLoading(false)
      }
    },
    [entityId, f.effectiveYear, kind, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <>
    <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" /> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

      <Card title={ui.filterTitle}>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.entityOptions}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {(['all', 'red', 'orphan', 'fully_reversed'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={[
                'rounded border px-2 py-1 text-il-meta',
                kind === k ? 'border-accent bg-accent/5 text-accent' : 'border-border-light text-text-3',
              ].join(' ')}
              onClick={() => setKind(k)}
            >
              {ui.kindLabels[k]}
            </button>
          ))}
        </div>
        {onNav ? (
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() =>
              goAnalysis('flags_list', {
                stat_year: f.effectiveYear,
                rule_id: 'RULE-03',
                entity_id: entityId || undefined,
              })
            }
          >
            {ui.linkRule03}
          </button>
        ) : null}
      </Card>

      {loading ? (
        <p className="text-il-meta text-text-3">{ui.loading}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: ui.kpiRedRatio, value: formatDwsPct(kpis.red_ratio as number | null) },
              { label: ui.kpiOrphan, value: String(kpis.orphan_cnt ?? 0) },
              { label: ui.kpiFullyReversed, value: String(kpis.fully_reversed_cnt ?? 0) },
              { label: ui.kpiRedAmt, value: formatDwsAmount(kpis.red_offset_amt as number | null) },
            ].map((item) => (
              <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2">
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 font-semibold tabular-nums text-text">{item.value}</div>
              </div>
            ))}
          </div>

          <Card title={ui.monthlyTitle} className="mt-4">
            {monthly.length === 0 ? (
              <p className="text-il-meta text-text-3">{ui.noData}</p>
            ) : (
              <ul className="space-y-1 text-il-page-desc text-text-2">
                {monthly.map((m) => (
                  <li key={m.stat_month} className="flex justify-between gap-2">
                    <span>
                      {m.stat_month}
                      {ui.monthUnit}
                    </span>
                    <span className="tabular-nums">
                      {ui.redTag}
                      {m.red_cnt} · {ui.orphanTag}
                      {m.orphan_cnt}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={ui.tableTitle.replace('{count}', String(total))} className="mt-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light text-il-label text-text-3">
                    <th className="py-2 pr-2">{ui.colDate}</th>
                    <th className="py-2 pr-2">{ui.colInvoiceNo}</th>
                    <th className="py-2 pr-2">{ui.colSeller}</th>
                    <th className="py-2 pr-2">{ui.colStatus}</th>
                    <th className="py-2 pr-2 text-right">{ui.colRedAmt}</th>
                    <th className="py-2">{ui.colAction}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.invoice_no}-${r.invoice_date}`} className="border-b border-border-light/60">
                      <td className="py-2 pr-2">{r.invoice_date || '—'}</td>
                      <td className="py-2 pr-2 font-mono text-[12px]">{r.invoice_no || '—'}</td>
                      <td className="py-2 pr-2">{r.seller_name || r.seller_tax_no}</td>
                      <td className="py-2 pr-2">
                        {r.is_orphan_red ? ui.orphanBadge : r.fpzt || r.net_calc_status || '—'}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatDwsAmount(r.red_offset_jshj)}</td>
                      <td className="py-2">
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => {
                            setDrillSeller(r.seller_tax_no)
                            setDrillOpen(true)
                          }}
                        >
                          {drillUi.drillBtn}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <InvoiceDetailDrillPanel
        open={drillOpen}
        onClose={() => setDrillOpen(false)}
        title={drillUi.defaultTitle}
        filters={{
          statYear: f.effectiveYear,
          entityId: entityId || undefined,
          sellerTaxNo: drillSeller ?? undefined,
        }}
      />
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
