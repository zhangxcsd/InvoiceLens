import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import type { DwsCounterpartyRiskRow } from '../config/localApi'
import { fetchDwsCounterpartyRiskList } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { navigateToEntityProfile, navigateToFlagsList } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { InvoiceDetailDrillPanel } from './InvoiceDetailDrillPanel'
import { formatDwsAmount, useDwsFilters } from './useDwsFilters'
import type { NavKey } from '../types'

export function CounterpartyRiskPage({ onNav }: { onNav?: (key: NavKey) => void }) {
  const ui = t.counterpartyRiskUi
  const drillUi = t.invoiceDetailDrillUi
  const f = useDwsFilters(true, { entityPool: 'analysis', requireBuyer: true, initFromUrl: true })
  const [rows, setRows] = useState<DwsCounterpartyRiskRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillSeller, setDrillSeller] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim()) {
        setRows([])
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsCounterpartyRiskList(
          { statYear: f.effectiveYear, entityId: f.entityId.trim(), limit: 50 },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          return
        }
        setRows(res.rows ?? [])
        setTotal(res.total ?? 0)
      } finally {
        setLoading(false)
      }
    },
    [f.effectiveYear, f.entityId, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
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
        />
        {onNav && f.entityId.trim() ? (
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() => navigateToEntityProfile(onNav, { statYear: f.effectiveYear, entityId: f.entityId.trim() })}
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
        <Card title={ui.tableTitle.replace('{count}', String(total))}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-il-page-desc">
              <thead>
                <tr className="border-b border-border-light text-il-label text-text-3">
                  <th className="py-2 pr-2">{ui.colCounterparty}</th>
                  <th className="py-2 pr-2 text-right">{ui.colTradeAmt}</th>
                  <th className="py-2 pr-2 text-right">{ui.colFlagCnt}</th>
                  <th className="py-2 pr-2 text-right">{ui.colRiskScore}</th>
                  <th className="py-2">{ui.colAction}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.counterparty_id} className="border-b border-border-light/60">
                    <td className="py-2 pr-2">
                      <div>{r.counterparty_name}</div>
                      <div className="font-mono text-[11px] text-text-3">{r.counterparty_id}</div>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatDwsAmount(r.trade_amount)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.flag_count}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold">{r.risk_score.toFixed(1)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        {onNav ? (
                          <button
                            type="button"
                            className="text-accent hover:underline"
                            onClick={() =>
                              navigateToFlagsList(onNav, {
                                statYear: f.effectiveYear,
                                entityId: f.entityId.trim(),
                              })
                            }
                          >
                            {ui.viewFlags}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => {
                            setDrillSeller(r.counterparty_id)
                            setDrillOpen(true)
                          }}
                        >
                          {drillUi.drillBtn}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <InvoiceDetailDrillPanel
        open={drillOpen}
        onClose={() => setDrillOpen(false)}
        title={drillUi.defaultTitle}
        filters={{
          statYear: f.effectiveYear,
          entityId: f.entityId.trim() || undefined,
          sellerTaxNo: drillSeller ?? undefined,
        }}
      />
    </div>
  )
}
