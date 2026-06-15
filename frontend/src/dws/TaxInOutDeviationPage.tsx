import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDwsTaxInOutDeviation,
  type DwsTaxInOutDeviationRow,
  type TaxDevFlagSummary,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { navigateToFlagsList, navigateToReportConfig } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'

const BUCKET_COLORS: Record<string, string> = {
  '13%': 'bg-[#5b9bd5]',
  '9%': 'bg-[#70ad47]',
  '6%': 'bg-[#ffc000]',
  '3%': 'bg-[#ed7d31]',
  '免税/零税率': 'bg-[#a5a5a5]',
  其他: 'bg-[#7030a0]',
}

type Props = { onNav?: (key: import('../types').NavKey) => void }

export function TaxInOutDeviationPage({ onNav }: Props) {
  const ui = t.taxInOutDeviationUi
  const dash = t.dwsDashboardUi
  const f = useDwsFilters(true, { entityPool: 'analysis', requireBothRoles: true })
  const [rows, setRows] = useState<DwsTaxInOutDeviationRow[]>([])
  const [inputTotal, setInputTotal] = useState(0)
  const [outputTotal, setOutputTotal] = useState(0)
  const [amountRatio, setAmountRatio] = useState<number | null>(null)
  const [mixDeviation, setMixDeviation] = useState(0)
  const [deviationThresholdPct, setDeviationThresholdPct] = useState(10)
  const [exceededBucketCount, setExceededBucketCount] = useState(0)
  const [taxDevFlags, setTaxDevFlags] = useState<TaxDevFlagSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectBothRolesCaliberHint.replace('{n}', String(effectiveN))

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setRows([])
      setInputTotal(0)
      setOutputTotal(0)
      setAmountRatio(null)
      setMixDeviation(0)
      setTaxDevFlags(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsTaxInOutDeviation(
        { statYear: f.effectiveYear, entityId: f.entityId.trim() },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        return
      }
      setRows(res.rows ?? [])
      setInputTotal(res.input_total_amount_je ?? 0)
      setOutputTotal(res.output_total_amount_je ?? 0)
      setAmountRatio(res.amount_ratio_input_over_output ?? null)
      setMixDeviation(res.mix_deviation_l1 ?? 0)
      setDeviationThresholdPct(res.deviation_threshold_pct ?? 10)
      setExceededBucketCount(res.exceeded_bucket_count ?? 0)
      setTaxDevFlags(res.tax_dev_flags ?? null)
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const chartRows = useMemo(
    () => rows.filter((r) => r.input_amount_je > 0 || r.output_amount_je > 0),
    [rows],
  )
  const maxRatio = useMemo(
    () => Math.max(...chartRows.map((r) => Math.max(r.input_amount_ratio, r.output_amount_ratio)), 0.01),
    [chartRows],
  )

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {f.poolHint ? <p className="mb-2 text-il-meta text-amber-800">{f.poolHint}</p> : null}
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
          minInvoiceCount={effectiveN}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <p className="mt-2 text-il-meta text-text-3">{caliberHint}</p>
        {onNav ? (
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() =>
              navigateToReportConfig(onNav, {
                statYear: f.effectiveYear,
                entityId: f.entityId.trim(),
                chapters: ['tax_in_out_deviation', 'audit_flags'],
              })
            }
          >
            {ui.reportLink}
          </button>
        ) : null}
      </Card>

      {!f.entityId.trim() ? (
        <Card title={ui.kpiTitle}>
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        </Card>
      ) : (
        <>
          <Card title={ui.kpiTitle}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                { label: ui.kpiInputTotal, value: formatDwsAmount(inputTotal) },
                { label: ui.kpiOutputTotal, value: formatDwsAmount(outputTotal) },
                {
                  label: ui.kpiAmountRatio,
                  value: amountRatio != null ? amountRatio.toFixed(4) : '—',
                },
                {
                  label: ui.kpiMixDeviation,
                  value: mixDeviation.toFixed(4),
                  warn: exceededBucketCount > 0,
                },
                {
                  label: ui.kpiExceededBuckets,
                  value: String(exceededBucketCount),
                  warn: exceededBucketCount > 0,
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className={[
                    'rounded-sm border px-3 py-2.5',
                    item.warn ? 'border-danger/40 bg-danger/5' : 'border-border-light bg-[#fafbfd]',
                  ].join(' ')}
                >
                  <div className="text-il-label text-text-3">{item.label}</div>
                  <div
                    className={[
                      'mt-1 text-[18px] font-semibold tabular-nums',
                      item.warn ? 'text-danger' : 'text-text',
                    ].join(' ')}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-il-meta text-text-3">
              {ui.mixDeviationHint}{' '}
              {ui.thresholdHint.replace('{pct}', String(deviationThresholdPct))}
            </p>
            {taxDevFlags && taxDevFlags.total > 0 ? (
              <div className="mt-3 rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2">
                <p className="text-il-meta text-text-2">
                  {ui.taxDevFlagSummary
                    .replace('{total}', String(taxDevFlags.total))
                    .replace('{pending}', String(taxDevFlags.pending))
                    .replace('{confirmed}', String(taxDevFlags.confirmed))}
                </p>
                {onNav ? (
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      type="button"
                      className="text-il-meta text-accent hover:underline"
                      onClick={() =>
                        navigateToFlagsList(onNav, {
                          statYear: f.effectiveYear,
                          entityId: f.entityId.trim(),
                          ruleId: 'RULE-TAX-DEV',
                        })
                      }
                    >
                      {ui.viewTaxDevFlags}
                    </button>
                    {taxDevFlags.pending > 0 ? (
                      <button
                        type="button"
                        className="text-il-meta text-warn hover:underline"
                        onClick={() =>
                          navigateToFlagsList(onNav, {
                            statYear: f.effectiveYear,
                            entityId: f.entityId.trim(),
                            ruleId: 'RULE-TAX-DEV',
                            trackStatus: 'pending',
                          })
                        }
                      >
                        {ui.viewPendingTaxDevFlags.replace('{n}', String(taxDevFlags.pending))}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card title={ui.chartTitle}>
            {loading ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
            {!loading && chartRows.length === 0 ? (
              <p className="text-il-meta text-text-3">{ui.emptyHint}</p>
            ) : (
              <div className="space-y-4">
                {chartRows.map((r) => {
                  const inH = Math.round((r.input_amount_ratio / maxRatio) * 100)
                  const outH = Math.round((r.output_amount_ratio / maxRatio) * 100)
                  const color = BUCKET_COLORS[r.tax_bucket] ?? 'bg-[#5b9bd5]'
                  return (
                    <div key={r.tax_bucket} className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-il-label text-text-3">{r.tax_bucket}</span>
                      <div className="flex flex-1 items-end gap-1">
                        <div
                          className={`w-6 rounded-t-sm ${color} opacity-80`}
                          style={{ height: `${Math.max(inH, 2)}px` }}
                          title={`进项 ${formatDwsPct(r.input_amount_ratio)}`}
                        />
                        <div
                          className={`w-6 rounded-t-sm ${color}`}
                          style={{ height: `${Math.max(outH, 2)}px` }}
                          title={`销项 ${formatDwsPct(r.output_amount_ratio)}`}
                        />
                      </div>
                      <span className="w-28 shrink-0 text-right text-il-meta text-text-3 tabular-nums">
                        {(r.ratio_diff * 100).toFixed(1)}pp
                      </span>
                    </div>
                  )
                })}
                <p className="text-il-meta text-text-3">左柱=进项占比，右柱=销项占比；右侧为占比差（百分点）。</p>
              </div>
            )}
          </Card>

          <Card title={ui.tableTitle}>
            <div className="overflow-x-auto rounded-sm border border-border-light">
              <table className="w-full min-w-[720px] border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="px-3 py-2 font-medium">{ui.colBucket}</th>
                    <th className="px-3 py-2 font-medium text-right">{ui.colInputAmount}</th>
                    <th className="px-3 py-2 font-medium text-right">{ui.colInputRatio}</th>
                    <th className="px-3 py-2 font-medium text-right">{ui.colOutputAmount}</th>
                    <th className="px-3 py-2 font-medium text-right">{ui.colOutputRatio}</th>
                    <th className="px-3 py-2 font-medium text-right">{ui.colRatioDiff}</th>
                    <th className="px-3 py-2 font-medium text-center">{ui.colExceeded}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {rows.length > 0 ? (
                    rows.map((r) => (
                      <tr
                        key={r.tax_bucket}
                        className={[
                          'border-b border-border-light last:border-b-0',
                          r.exceeded_threshold ? 'bg-danger/5' : '',
                        ].join(' ')}
                      >
                        <td className="px-3 py-2">{r.tax_bucket}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatDwsAmount(r.input_amount_je)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatDwsPct(r.input_amount_ratio)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatDwsAmount(r.output_amount_je)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatDwsPct(r.output_amount_ratio)}</td>
                        <td
                          className={[
                            'px-3 py-2 text-right tabular-nums',
                            Math.abs(r.ratio_diff) >= 0.1 ? 'font-medium text-warn' : '',
                          ].join(' ')}
                        >
                          {(r.ratio_diff * 100).toFixed(2)}pp
                        </td>
                        <td className="px-3 py-2 text-center text-il-meta">
                          {r.exceeded_threshold ? (
                            <span className="font-medium text-danger">{ui.exceededYes}</span>
                          ) : (
                            ui.exceededNo
                          )}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-text-3">
                        {loading ? ui.loading : ui.emptyHint}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
