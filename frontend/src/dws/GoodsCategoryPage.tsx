import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import type { DwsGoodsCatRow } from '../config/localApi'
import { fetchDwsGoodsCatList, fetchDwsGoodsCatOverview } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { InvoiceDetailDrillPanel } from './InvoiceDetailDrillPanel'
import { formatDwsAmount, useDwsFilters } from './useDwsFilters'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

type Props = { onNav?: (key: NavKey) => void } & EmbedModeProps

export function GoodsCategoryPage({ onNav, embedMode }: Props) {
  const ui = t.goodsCategoryUi
  const drillUi = t.invoiceDetailDrillUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('goods_category', embedMode)
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    requireBuyer: true,
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })
  const [quarter, setQuarter] = useState(() => String(savedUi?.extra?.quarter ?? ''))
  const [overviewHint, setOverviewHint] = useState<string | null>(null)
  const [quarterly, setQuarterly] = useState<Array<{ stat_quarter: number; net_jshj: number; category_cnt: number }>>([])
  const [rows, setRows] = useState<DwsGoodsCatRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillGoods, setDrillGoods] = useState<string | null>(null)

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
    },
    [f],
  )

  const { goAnalysis, shellProps } = useDwsPageAnalysisShell({
    host: 'goods_category',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      loading,
      extra: { quarter },
    },
  })

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim()) {
        setRows([])
        setQuarterly([])
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const [ov, list] = await Promise.all([
          fetchDwsGoodsCatOverview(
            { statYear: f.effectiveYear, entityId: f.entityId.trim(), statQuarter: quarter || undefined },
            signal,
          ),
          fetchDwsGoodsCatList(
            { statYear: f.effectiveYear, entityId: f.entityId.trim(), statQuarter: quarter || undefined, limit: 100 },
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
        setOverviewHint(ov.hint ?? null)
        setQuarterly(ov.quarterly ?? [])
        setRows(list.rows ?? [])
        setTotal(list.total ?? 0)
      } finally {
        setLoading(false)
      }
    },
    [f.effectiveYear, f.entityId, quarter, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const totalAmt = useMemo(() => rows.reduce((s, r) => s + r.net_jshj, 0), [rows])

  return (
    <>
      <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
        {!embedMode ? <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" /> : null}
        {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
        {overviewHint ? <p className="mb-2 text-il-meta text-amber-800">{overviewHint}</p> : null}
        {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

        <Card title={ui.filterTitle}>
          <DwsFilterBar
            effectiveYear={f.effectiveYear}
            yearOptions={f.yearOptions}
            onYearChange={f.setStatYear}
            entityId={f.entityId}
            onEntityChange={f.setEntityId}
            entityOptions={f.entityOptions}
            requireEntity
            showMinInvoiceCount
            minInvoiceCount={f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10}
            onMinInvoiceCountChange={f.setMinInvoiceCount}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-il-meta text-text-3">{ui.quarterFilter}</label>
            <select
              className="rounded border border-border-light px-2 py-1 text-il-page-desc"
              value={quarter}
              onChange={(e) => setQuarter(e.target.value)}
            >
              <option value="">{ui.allQuarters}</option>
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={String(q)}>
                  Q{q}
                </option>
              ))}
            </select>
          </div>
          {onNav && f.entityId.trim() ? (
            <button
              type="button"
              className="mt-2 text-il-meta text-accent hover:underline"
              onClick={() =>
                goAnalysis('entity_profile', { statYear: f.effectiveYear, entityId: f.entityId.trim() })
              }
            >
              {ui.linkEntityProfile}
            </button>
          ) : null}
        </Card>

        {!f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : loading ? (
          <p className="text-il-meta text-text-3">{ui.loading}</p>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title={ui.quarterlyTitle}>
                {quarterly.length === 0 ? (
                  <p className="text-il-meta text-text-3">{ui.noData}</p>
                ) : (
                  <ul className="space-y-1 text-il-page-desc text-text-2">
                    {quarterly.map((q) => (
                      <li key={q.stat_quarter} className="flex justify-between gap-2">
                        <span>Q{q.stat_quarter}</span>
                        <span className="tabular-nums">
                          {formatDwsAmount(q.net_jshj)} · {q.category_cnt} {ui.categoryUnit}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={ui.summaryTitle}>
                <p className="text-il-page-desc text-text-2">
                  {ui.totalHint.replace('{amount}', formatDwsAmount(totalAmt)).replace('{count}', String(total))}
                </p>
              </Card>
            </div>

            <Card title={ui.tableTitle.replace('{count}', String(total))}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-il-page-desc">
                  <thead>
                    <tr className="border-b border-border-light text-il-label text-text-3">
                      <th className="py-2 pr-2">{ui.colQuarter}</th>
                      <th className="py-2 pr-2">{ui.colTaxShort}</th>
                      <th className="py-2 pr-2">{ui.colTaxLevel2}</th>
                      <th className="py-2 pr-2 text-right">{ui.colAmount}</th>
                      <th className="py-2 pr-2 text-right">{ui.colInvoiceCnt}</th>
                      <th className="py-2 pr-2 text-right">{ui.colSupplierCnt}</th>
                      <th className="py-2">{ui.colAction}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.stat_quarter}-${r.tax_code_short}`} className="border-b border-border-light/60">
                        <td className="py-2 pr-2">Q{r.stat_quarter}</td>
                        <td className="py-2 pr-2 font-mono">{r.tax_code_short || '—'}</td>
                        <td className="py-2 pr-2">{r.tax_code_level2 || '—'}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatDwsAmount(r.net_jshj)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{r.invoice_cnt}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{r.supplier_cnt}</td>
                        <td className="py-2">
                          <button
                            type="button"
                            className="text-accent hover:underline"
                            onClick={() => {
                              setDrillGoods(r.tax_code_level2 || r.tax_code_short)
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
            entityId: f.entityId.trim() || undefined,
            goodsName: drillGoods ?? undefined,
          }}
        />
      </div>
      {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
