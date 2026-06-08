import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import {
  barHeightPx,
  CHART_BAR_STRIP_CLASS,
  chartTypography,
  dataTableClasses,
  filterPillClasses,
} from '../components/charts'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsOverviewTrend, type DwsTrendRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, useDwsFilters } from './useDwsFilters'

type TrendWideRow = {
  stat_month: number
  input_net_jshj: number | null
  input_invoice_cnt: number | null
  output_net_jshj: number | null
  output_invoice_cnt: number | null
}

function pivotTrendWideRows(rows: DwsTrendRow[]): TrendWideRow[] {
  const byMonth = new Map<number, TrendWideRow>()
  for (const r of rows) {
    let entry = byMonth.get(r.stat_month)
    if (!entry) {
      entry = {
        stat_month: r.stat_month,
        input_net_jshj: null,
        input_invoice_cnt: null,
        output_net_jshj: null,
        output_invoice_cnt: null,
      }
      byMonth.set(r.stat_month, entry)
    }
    if (r.role_type === '进项') {
      entry.input_net_jshj = r.net_jshj
      entry.input_invoice_cnt = r.invoice_cnt
    } else if (r.role_type === '销项') {
      entry.output_net_jshj = r.net_jshj
      entry.output_invoice_cnt = r.invoice_cnt
    }
  }
  return Array.from(byMonth.values()).sort((a, b) => a.stat_month - b.stat_month)
}

function trendChartMeta(
  roleType: 'all' | '销项' | '进项',
  ui: (typeof t)['dwsDashboardUi'],
): { title: string; hint: string } {
  if (roleType === '销项') {
    return { title: ui.trendChartTitleOutput, hint: ui.trendChartHintOutput }
  }
  if (roleType === '进项') {
    return { title: ui.trendChartTitleInput, hint: ui.trendChartHintInput }
  }
  return { title: ui.trendChartTitleAll, hint: ui.trendChartHintAll }
}

export function OverviewTrendPage() {
  const ui = t.dwsDashboardUi
  const f = useDwsFilters(false)
  const [roleType, setRoleType] = useState<'all' | '销项' | '进项'>('all')
  const [rows, setRows] = useState<DwsTrendRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsOverviewTrend(
        {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim() || undefined,
          roleType,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        return
      }
      setRows(res.rows ?? [])
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, roleType, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const chartRows = useMemo(() => {
    const byMonth = new Map<number, number>()
    for (const r of rows) {
      byMonth.set(r.stat_month, (byMonth.get(r.stat_month) ?? 0) + r.net_jshj)
    }
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1
      return { month: m, net_jshj: byMonth.get(m) ?? 0 }
    })
  }, [rows])

  const maxNet = useMemo(() => Math.max(...chartRows.map((x) => Math.abs(x.net_jshj)), 1), [chartRows])

  const wideRows = useMemo(
    () => (roleType === 'all' ? pivotTrendWideRows(rows) : []),
    [rows, roleType],
  )

  const isWideTable = roleType === 'all'
  const chartMeta = useMemo(() => trendChartMeta(roleType, ui), [roleType, ui])
  const hasChartData = useMemo(() => chartRows.some((x) => x.net_jshj !== 0), [chartRows])

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.overviewTrendTitle} note={ui.overviewTrendDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
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
        <div className="mb-2 flex gap-2">
          {(['all', '销项', '进项'] as const).map((rt) => (
            <button
              key={rt}
              type="button"
              className={[
                filterPillClasses.base,
                roleType === rt ? filterPillClasses.active : filterPillClasses.inactive,
              ].join(' ')}
              onClick={() => setRoleType(rt)}
            >
              {rt === 'all' ? ui.roleAll : rt}
            </button>
          ))}
        </div>
      </Card>

      <Card title={chartMeta.title}>
        {loading ? <p className={chartTypography.hint}>{ui.loading}</p> : null}
        {!loading && !hasChartData ? (
          <p className={chartTypography.hint}>{ui.emptyTrend}</p>
        ) : (
          <div className={`flex ${CHART_BAR_STRIP_CLASS} gap-1 border-b border-border-light pb-1`}>
            {chartRows.map((p) => {
              const barPx = barHeightPx(p.net_jshj, maxNet)
              return (
                <div key={p.month} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className={[
                      'w-full max-w-[2rem] rounded-t-sm',
                      p.net_jshj >= 0 ? 'bg-[#5b9bd5]' : 'bg-[#e07a5f]',
                    ].join(' ')}
                    style={{ height: `${barPx}px` }}
                    title={`${p.month}月: ${formatDwsAmount(p.net_jshj)}`}
                  />
                  <span className={chartTypography.axisX}>{p.month}</span>
                </div>
              )
            })}
          </div>
        )}
        <p className={`mt-2 ${chartTypography.hint}`}>{chartMeta.hint}</p>
      </Card>

      <Card title={ui.trendTableTitle}>
        <div className={dataTableClasses.wrap}>
          <table
            className={[dataTableClasses.table, isWideTable ? 'min-w-[720px]' : 'min-w-[640px]'].join(' ')}
          >
            <thead>
              {isWideTable ? (
                <tr className={dataTableClasses.headerRow}>
                  <th className={dataTableClasses.headerCell}>{ui.colMonth}</th>
                  <th className={dataTableClasses.headerCell}>{ui.trendColInputNet}</th>
                  <th className={dataTableClasses.headerCell}>{ui.trendColInputCnt}</th>
                  <th className={dataTableClasses.headerCell}>{ui.trendColOutputNet}</th>
                  <th className={dataTableClasses.headerCell}>{ui.trendColOutputCnt}</th>
                </tr>
              ) : (
                <tr className={dataTableClasses.headerRow}>
                  <th className={dataTableClasses.headerCell}>{ui.colMonth}</th>
                  <th className={dataTableClasses.headerCell}>{ui.colRole}</th>
                  <th className={dataTableClasses.headerCell}>{ui.colNetJshj}</th>
                  <th className={dataTableClasses.headerCell}>{ui.colInvoiceCnt}</th>
                </tr>
              )}
            </thead>
            <tbody className={dataTableClasses.body}>
              {isWideTable ? (
                wideRows.length > 0 ? (
                  wideRows.map((r) => (
                    <tr key={r.stat_month} className={dataTableClasses.row}>
                      <td className={dataTableClasses.cell}>{r.stat_month}</td>
                      <td className={`${dataTableClasses.cell} tabular-nums`}>
                        {r.input_net_jshj === null ? ui.trendEmptyCell : formatDwsAmount(r.input_net_jshj)}
                      </td>
                      <td className={`${dataTableClasses.cell} tabular-nums`}>
                        {r.input_invoice_cnt === null ? ui.trendEmptyCell : r.input_invoice_cnt}
                      </td>
                      <td className={`${dataTableClasses.cell} tabular-nums`}>
                        {r.output_net_jshj === null ? ui.trendEmptyCell : formatDwsAmount(r.output_net_jshj)}
                      </td>
                      <td className={`${dataTableClasses.cell} tabular-nums`}>
                        {r.output_invoice_cnt === null ? ui.trendEmptyCell : r.output_invoice_cnt}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className={dataTableClasses.emptyCell}>
                      {loading ? ui.loading : ui.emptyTrend}
                    </td>
                  </tr>
                )
              ) : rows.length > 0 ? (
                rows.map((r) => (
                  <tr key={`${r.stat_month}_${r.role_type}`} className={dataTableClasses.row}>
                    <td className={dataTableClasses.cell}>{r.stat_month}</td>
                    <td className={dataTableClasses.cell}>{r.role_type}</td>
                    <td className={`${dataTableClasses.cell} tabular-nums`}>{formatDwsAmount(r.net_jshj)}</td>
                    <td className={`${dataTableClasses.cell} tabular-nums`}>{r.invoice_cnt}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className={dataTableClasses.emptyCell}>
                    {loading ? ui.loading : ui.emptyTrend}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
