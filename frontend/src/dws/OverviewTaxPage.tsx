import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import {
  barHeightPx,
  CHART_BAR_STRIP_CLASS,
  CHART_MONTHS,
  chartTypography,
  dataTableClasses,
  filterPillClasses,
  TaxRatioLineChart,
  type TaxRatioTrendPoint,
  type TaxRatioTrendSeries,
} from '../components/charts'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDwsOverviewTax,
  fetchDwsOverviewTaxMonthly,
  type DwsTaxBucketRow,
  type DwsTaxMonthlyRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { InvoiceDetailDrillPanel } from './InvoiceDetailDrillPanel'
import { formatDwsAmount, useDwsFilters, useDwsUrlDeepLinkFilter } from './useDwsFilters'
import { useDimDictDomain } from '../dim/useDimDict'

const BUCKET_ORDER = ['13%', '9%', '6%', '3%', '免税/零税率', '其他'] as const

const BUCKET_COLORS: Record<string, string> = {
  '13%': 'bg-[#5b9bd5]',
  '9%': 'bg-[#70ad47]',
  '6%': 'bg-[#ffc000]',
  '3%': 'bg-[#ed7d31]',
  '免税/零税率': 'bg-[#a5a5a5]',
  其他: 'bg-[#7030a0]',
}

const BUCKET_STROKE: Record<string, string> = {
  '13%': '#5b9bd5',
  '9%': '#70ad47',
  '6%': '#ffc000',
  '3%': '#ed7d31',
  '免税/零税率': '#a5a5a5',
  其他: '#7030a0',
}

type TaxWideRow = {
  tax_bucket: string
  input_amount_je: number | null
  input_amount_ratio: number | null
  input_line_cnt: number | null
  output_amount_je: number | null
  output_amount_ratio: number | null
  output_line_cnt: number | null
}

function bucketMap(rows: DwsTaxBucketRow[]): Map<string, DwsTaxBucketRow> {
  return new Map(rows.map((r) => [r.tax_bucket, r]))
}

function pivotTaxWideRows(inputRows: DwsTaxBucketRow[], outputRows: DwsTaxBucketRow[]): TaxWideRow[] {
  const inputMap = bucketMap(inputRows)
  const outputMap = bucketMap(outputRows)
  const extraBuckets = [...inputMap.keys(), ...outputMap.keys()].filter(
    (b) => !BUCKET_ORDER.includes(b as (typeof BUCKET_ORDER)[number]),
  )
  const buckets = [...BUCKET_ORDER, ...extraBuckets]
  return buckets.map((tax_bucket) => {
    const inp = inputMap.get(tax_bucket)
    const out = outputMap.get(tax_bucket)
    return {
      tax_bucket,
      input_amount_je: inp ? inp.amount_je : null,
      input_amount_ratio: inp ? inp.amount_ratio : null,
      input_line_cnt: inp ? inp.line_cnt : null,
      output_amount_je: out ? out.amount_je : null,
      output_amount_ratio: out ? out.amount_ratio : null,
      output_line_cnt: out ? out.line_cnt : null,
    }
  })
}

function taxChartMeta(
  roleType: 'all' | string,
  ui: (typeof t)['overviewTaxUi'],
): { title: string; hint: string } {
  if (roleType === '销项') {
    return { title: ui.chartTitleOutput, hint: ui.chartHintOutput }
  }
  if (roleType === '进项') {
    return { title: ui.chartTitleInput, hint: ui.chartHintInput }
  }
  return { title: ui.chartTitleAll, hint: ui.chartHintAll }
}

function taxTrendChartMeta(
  roleType: 'all' | string,
  ui: (typeof t)['overviewTaxUi'],
): { title: string; hint: string } {
  if (roleType === '销项') {
    return { title: ui.trendChartTitleOutput, hint: ui.trendChartHintOutput }
  }
  if (roleType === '进项') {
    return { title: ui.trendChartTitleInput, hint: ui.trendChartHintInput }
  }
  return { title: ui.trendChartTitleAll, hint: ui.trendChartHintAll }
}

function mergeMonthlyTaxRows(inputRows: DwsTaxMonthlyRow[], outputRows: DwsTaxMonthlyRow[]): DwsTaxMonthlyRow[] {
  const byMonthBucket = new Map<string, { amount_je: number; line_cnt: number }>()
  for (const r of [...inputRows, ...outputRows]) {
    const key = `${r.stat_month}|${r.tax_bucket}`
    const cur = byMonthBucket.get(key) ?? { amount_je: 0, line_cnt: 0 }
    cur.amount_je += r.amount_je
    cur.line_cnt += r.line_cnt
    byMonthBucket.set(key, cur)
  }
  const monthTotals = new Map<number, number>()
  for (const [key, v] of byMonthBucket) {
    const m = Number(key.split('|')[0])
    monthTotals.set(m, (monthTotals.get(m) ?? 0) + v.amount_je)
  }
  const out: DwsTaxMonthlyRow[] = []
  for (const [key, v] of byMonthBucket) {
    const [ms, bucket] = key.split('|')
    const m = Number(ms)
    const total = monthTotals.get(m) ?? 0
    out.push({
      stat_month: m,
      tax_bucket: bucket,
      amount_je: v.amount_je,
      line_cnt: v.line_cnt,
      amount_ratio: total > 0 ? v.amount_je / total : 0,
      month_total_amount_je: total,
    })
  }
  return out.sort((a, b) => a.stat_month - b.stat_month || a.tax_bucket.localeCompare(b.tax_bucket))
}

type TrendPoint = TaxRatioTrendPoint

type TrendSeries = TaxRatioTrendSeries

function buildTrendSeries(rows: DwsTaxMonthlyRow[]): TrendSeries[] {
  const monthTotals = new Map<number, number>()
  for (const r of rows) {
    if (r.month_total_amount_je != null && r.month_total_amount_je > 0) {
      monthTotals.set(r.stat_month, r.month_total_amount_je)
    } else if (r.amount_je > 0) {
      monthTotals.set(r.stat_month, (monthTotals.get(r.stat_month) ?? 0) + r.amount_je)
    }
  }
  const ratioByBucketMonth = new Map<string, Map<number, number>>()
  for (const r of rows) {
    if (!ratioByBucketMonth.has(r.tax_bucket)) {
      ratioByBucketMonth.set(r.tax_bucket, new Map())
    }
    ratioByBucketMonth.get(r.tax_bucket)!.set(r.stat_month, r.amount_ratio)
  }
  const extraBuckets = [...ratioByBucketMonth.keys()].filter(
    (b) => !BUCKET_ORDER.includes(b as (typeof BUCKET_ORDER)[number]),
  )
  const buckets = [...BUCKET_ORDER, ...extraBuckets]
  return buckets
    .map((tax_bucket) => {
      const monthMap = ratioByBucketMonth.get(tax_bucket)
      const points: TrendPoint[] = CHART_MONTHS.map((month) => {
        const total = monthTotals.get(month) ?? 0
        if (total <= 0) return { month, ratio: null }
        const ratio = monthMap?.get(month)
        return { month, ratio: ratio ?? 0 }
      })
      const hasData = points.some((p) => p.ratio !== null && p.ratio > 0)
      if (!hasData) return null
      return {
        tax_bucket,
        color: BUCKET_STROKE[tax_bucket] ?? '#5b9bd5',
        points,
      }
    })
    .filter((s): s is TrendSeries => s !== null)
}

function formatRatio(ratio: number | null, empty: string): string {
  return ratio === null ? empty : `${(ratio * 100).toFixed(2)}%`
}

type BucketDataCtx = {
  roleType: 'all' | string
  rows: DwsTaxBucketRow[]
  inputRows: DwsTaxBucketRow[]
  outputRows: DwsTaxBucketRow[]
  monthlyRows: DwsTaxMonthlyRow[]
  inputMonthlyRows: DwsTaxMonthlyRow[]
  outputMonthlyRows: DwsTaxMonthlyRow[]
}

function bucketHasAnnualData(bucket: string, ctx: BucketDataCtx): boolean {
  const annualHas = (r: DwsTaxBucketRow | undefined) => (r?.amount_je ?? 0) > 0 || (r?.line_cnt ?? 0) > 0
  if (ctx.roleType === 'all') {
    const inpMap = bucketMap(ctx.inputRows)
    const outMap = bucketMap(ctx.outputRows)
    return annualHas(inpMap.get(bucket)) || annualHas(outMap.get(bucket))
  }
  return annualHas(bucketMap(ctx.rows).get(bucket))
}

function bucketHasMonthlyData(bucket: string, ctx: BucketDataCtx): boolean {
  const monthlyHas = (rows: DwsTaxMonthlyRow[]) =>
    rows.some((r) => r.tax_bucket === bucket && (r.amount_je > 0 || r.line_cnt > 0))
  if (ctx.roleType === 'all') {
    return monthlyHas(ctx.inputMonthlyRows) || monthlyHas(ctx.outputMonthlyRows)
  }
  return monthlyHas(ctx.monthlyRows)
}

function orderedBucketsWithData(
  ctx: BucketDataCtx,
  hasData: (bucket: string, ctx: BucketDataCtx) => boolean,
): string[] {
  const extra = new Set<string>()
  for (const r of [...ctx.rows, ...ctx.inputRows, ...ctx.outputRows]) extra.add(r.tax_bucket)
  for (const r of [...ctx.monthlyRows, ...ctx.inputMonthlyRows, ...ctx.outputMonthlyRows]) extra.add(r.tax_bucket)
  const ordered = BUCKET_ORDER.filter((b) => hasData(b, ctx))
  const extras = [...extra].filter((b) => !BUCKET_ORDER.includes(b as (typeof BUCKET_ORDER)[number]) && hasData(b, ctx))
  return [...ordered, ...extras]
}

function BucketFilterButtons({
  label,
  hint,
  clearLabel,
  buckets,
  selected,
  onToggle,
  onClear,
}: {
  label: string
  hint: string
  clearLabel: string
  buckets: string[]
  selected: string[]
  onToggle: (bucket: string) => void
  onClear: () => void
}) {
  if (buckets.length === 0) return null
  return (
    <div className="mb-3 border-b border-border-light pb-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-il-label text-text-3">{label}</span>
        {selected.length > 0 ? (
          <button type="button" className="text-il-meta text-accent hover:underline" onClick={onClear}>
            {clearLabel}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {buckets.map((bucket) => {
          const active = selected.length === 0 || selected.includes(bucket)
          const color = BUCKET_STROKE[bucket] ?? '#5b9bd5'
          return (
            <button
              key={bucket}
              type="button"
              className={[
                'inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-il-page-desc transition-colors',
                active
                  ? 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
                  : 'border-border bg-white text-text-3 opacity-60 hover:border-accent hover:opacity-100',
              ].join(' ')}
              onClick={() => onToggle(bucket)}
              aria-pressed={selected.includes(bucket)}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              {bucket}
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-il-meta text-text-3">{hint}</p>
    </div>
  )
}

function matchesBucketFilter(bucket: string, selected: ReadonlySet<string>): boolean {
  return selected.size === 0 || selected.has(bucket)
}

function taxBucketToSlvNum(bucket: string): string | undefined {
  if (bucket === '13%') return '0.13'
  if (bucket === '9%') return '0.09'
  if (bucket === '6%') return '0.06'
  if (bucket === '3%') return '0.03'
  if (bucket === '免税/零税率') return '0'
  return undefined
}

export function OverviewTaxPage() {
  const ui = t.overviewTaxUi
  const drillUi = t.invoiceDetailDrillUi
  const deepLink = useDwsUrlDeepLinkFilter()
  const f = useDwsFilters(false, { initFromUrl: true })
  const roleTypeDict = useDimDictDomain('finance_role_type')
  const [roleType, setRoleType] = useState<'all' | string>('all')
  const [rows, setRows] = useState<DwsTaxBucketRow[]>([])
  const [inputRows, setInputRows] = useState<DwsTaxBucketRow[]>([])
  const [outputRows, setOutputRows] = useState<DwsTaxBucketRow[]>([])
  const [totalAmount, setTotalAmount] = useState(0)
  const [inputTotalAmount, setInputTotalAmount] = useState(0)
  const [outputTotalAmount, setOutputTotalAmount] = useState(0)
  const [monthlyRows, setMonthlyRows] = useState<DwsTaxMonthlyRow[]>([])
  const [inputMonthlyRows, setInputMonthlyRows] = useState<DwsTaxMonthlyRow[]>([])
  const [outputMonthlyRows, setOutputMonthlyRows] = useState<DwsTaxMonthlyRow[]>([])
  const [selectedBarBuckets, setSelectedBarBuckets] = useState<string[]>([])
  const [selectedTrendBuckets, setSelectedTrendBuckets] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillSlvNum, setDrillSlvNum] = useState<string | undefined>(undefined)

  const selectedBarBucketSet = useMemo(() => new Set(selectedBarBuckets), [selectedBarBuckets])
  const selectedTrendBucketSet = useMemo(() => new Set(selectedTrendBuckets), [selectedTrendBuckets])

  const toggleBarBucket = useCallback((bucket: string) => {
    setSelectedBarBuckets((prev) => {
      if (prev.includes(bucket)) return prev.filter((b) => b !== bucket)
      return [...prev, bucket]
    })
  }, [])

  const clearBarBucketSelection = useCallback(() => setSelectedBarBuckets([]), [])

  const toggleTrendBucket = useCallback((bucket: string) => {
    setSelectedTrendBuckets((prev) => {
      if (prev.includes(bucket)) return prev.filter((b) => b !== bucket)
      return [...prev, bucket]
    })
  }, [])

  const clearTrendBucketSelection = useCallback(() => setSelectedTrendBuckets([]), [])

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear) return
    setLoading(true)
    setErr(null)
    try {
      const timeParams = deepLink.timeFilterParams
      if (roleType === 'all') {
        const [inRes, outRes, inMonRes, outMonRes] = await Promise.all([
          fetchDwsOverviewTax(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim() || undefined,
              roleType: '进项',
              ...timeParams,
            },
            signal,
          ),
          fetchDwsOverviewTax(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim() || undefined,
              roleType: '销项',
              ...timeParams,
            },
            signal,
          ),
          fetchDwsOverviewTaxMonthly(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim() || undefined,
              roleType: '进项',
              ...timeParams,
            },
            signal,
          ),
          fetchDwsOverviewTaxMonthly(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim() || undefined,
              roleType: '销项',
              ...timeParams,
            },
            signal,
          ),
        ])
        if (signal?.aborted || inRes.aborted || outRes.aborted || inMonRes.aborted || outMonRes.aborted) return
        if (!inRes.ok || !outRes.ok || !inMonRes.ok || !outMonRes.ok) {
          setErr(
            inRes.error?.message ??
              outRes.error?.message ??
              inMonRes.error?.message ??
              outMonRes.error?.message ??
              ui.loadFailed,
          )
          setRows([])
          setInputRows([])
          setOutputRows([])
          setMonthlyRows([])
          setInputMonthlyRows([])
          setOutputMonthlyRows([])
          return
        }
        setRows([])
        setInputRows(inRes.rows ?? [])
        setOutputRows(outRes.rows ?? [])
        setMonthlyRows([])
        setInputMonthlyRows(inMonRes.rows ?? [])
        setOutputMonthlyRows(outMonRes.rows ?? [])
        setTotalAmount(0)
        setInputTotalAmount(inRes.total_amount_je ?? 0)
        setOutputTotalAmount(outRes.total_amount_je ?? 0)
      } else {
        const [res, monRes] = await Promise.all([
          fetchDwsOverviewTax(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim() || undefined,
              roleType,
              ...timeParams,
            },
            signal,
          ),
          fetchDwsOverviewTaxMonthly(
            {
              statYear: f.effectiveYear,
              entityId: f.entityId.trim() || undefined,
              roleType,
              ...timeParams,
            },
            signal,
          ),
        ])
        if (signal?.aborted || res.aborted || monRes.aborted) return
        if (!res.ok || !monRes.ok) {
          setErr(res.error?.message ?? monRes.error?.message ?? ui.loadFailed)
          setRows([])
          setInputRows([])
          setOutputRows([])
          setMonthlyRows([])
          setInputMonthlyRows([])
          setOutputMonthlyRows([])
          return
        }
        setRows(res.rows ?? [])
        setInputRows([])
        setOutputRows([])
        setMonthlyRows(monRes.rows ?? [])
        setInputMonthlyRows([])
        setOutputMonthlyRows([])
        setTotalAmount(res.total_amount_je ?? 0)
        setInputTotalAmount(0)
        setOutputTotalAmount(0)
      }
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, roleType, deepLink.timeFilterParams, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const wideRows = useMemo(
    () => (roleType === 'all' ? pivotTaxWideRows(inputRows, outputRows) : []),
    [roleType, inputRows, outputRows],
  )
  const isWideTable = roleType === 'all'
  const chartMeta = useMemo(() => taxChartMeta(roleType, ui), [roleType, ui])
  const trendChartMeta = useMemo(() => taxTrendChartMeta(roleType, ui), [roleType, ui])

  const effectiveMonthlyRows = useMemo(() => {
    if (roleType === 'all') return mergeMonthlyTaxRows(inputMonthlyRows, outputMonthlyRows)
    return monthlyRows
  }, [roleType, monthlyRows, inputMonthlyRows, outputMonthlyRows])

  const bucketCtx = useMemo(
    (): BucketDataCtx => ({
      roleType,
      rows,
      inputRows,
      outputRows,
      monthlyRows,
      inputMonthlyRows,
      outputMonthlyRows,
    }),
    [roleType, rows, inputRows, outputRows, monthlyRows, inputMonthlyRows, outputMonthlyRows],
  )

  const availableBarBuckets = useMemo(
    () => orderedBucketsWithData(bucketCtx, bucketHasAnnualData),
    [bucketCtx],
  )
  const availableTrendBuckets = useMemo(
    () => orderedBucketsWithData(bucketCtx, bucketHasMonthlyData),
    [bucketCtx],
  )

  const trendSeries = useMemo(() => {
    const all = buildTrendSeries(effectiveMonthlyRows)
    if (selectedTrendBucketSet.size === 0) return all
    return all.filter((s) => selectedTrendBucketSet.has(s.tax_bucket))
  }, [effectiveMonthlyRows, selectedTrendBucketSet])
  const hasTrendData = trendSeries.length > 0

  const chartRows = useMemo(() => {
    let base: { tax_bucket: string; amount_je: number; line_cnt: number; amount_ratio: number }[]
    if (roleType === 'all') {
      const inpMap = bucketMap(inputRows)
      const outMap = bucketMap(outputRows)
      base = BUCKET_ORDER.map((tax_bucket) => {
        const amount_je = (inpMap.get(tax_bucket)?.amount_je ?? 0) + (outMap.get(tax_bucket)?.amount_je ?? 0)
        const line_cnt = (inpMap.get(tax_bucket)?.line_cnt ?? 0) + (outMap.get(tax_bucket)?.line_cnt ?? 0)
        return { tax_bucket, amount_je, line_cnt, amount_ratio: 0 }
      }).filter((r) => r.amount_je > 0 || r.line_cnt > 0)
    } else {
      base = rows.filter((r) => r.amount_je > 0 || r.line_cnt > 0)
    }
    if (selectedBarBucketSet.size === 0) return base
    return base.filter((r) => selectedBarBucketSet.has(r.tax_bucket))
  }, [roleType, rows, inputRows, outputRows, selectedBarBucketSet])

  const maxAmt = useMemo(() => Math.max(...chartRows.map((r) => r.amount_je), 1), [chartRows])
  const hasChartData = chartRows.length > 0

  const filteredWideRows = useMemo(
    () =>
      wideRows.filter(
        (r) =>
          matchesBucketFilter(r.tax_bucket, selectedBarBucketSet) &&
          ((r.input_amount_je ?? 0) > 0 ||
            (r.input_line_cnt ?? 0) > 0 ||
            (r.output_amount_je ?? 0) > 0 ||
            (r.output_line_cnt ?? 0) > 0),
      ),
    [wideRows, selectedBarBucketSet],
  )
  const filteredRows = useMemo(
    () => rows.filter((r) => matchesBucketFilter(r.tax_bucket, selectedBarBucketSet)),
    [rows, selectedBarBucketSet],
  )
  const hasWideTableData = wideRows.some(
    (r) =>
      (r.input_amount_je ?? 0) > 0 ||
      (r.input_line_cnt ?? 0) > 0 ||
      (r.output_amount_je ?? 0) > 0 ||
      (r.output_line_cnt ?? 0) > 0,
  )
  const tableEmptyText =
    !loading && selectedBarBuckets.length > 0 && (hasWideTableData || rows.length > 0)
      ? ui.bucketFilterEmpty
      : loading
        ? ui.loading
        : ui.emptyHint

  const totalHintText = useMemo(() => {
    if (roleType === 'all') {
      return ui.totalHintAll
        .replace('{year}', f.effectiveYear)
        .replace('{inputAmount}', formatDwsAmount(inputTotalAmount))
        .replace('{outputAmount}', formatDwsAmount(outputTotalAmount))
    }
    return ui.totalHint.replace('{year}', f.effectiveYear).replace('{amount}', formatDwsAmount(totalAmount))
  }, [roleType, ui, f.effectiveYear, inputTotalAmount, outputTotalAmount, totalAmount])

  const rolePills = useMemo(
    () => [
      { id: 'all', label: ui.roleAll },
      ...roleTypeDict.options.map((o) => ({ id: o.code, label: o.label })),
    ],
    [roleTypeDict.options, ui.roleAll],
  )

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      {f.metaHint ? <p className="-mt-3 mb-2 text-il-meta text-amber-800">{f.metaHint}</p> : null}
      {deepLink.flagContextHint ? (
        <p className="mb-2 text-il-meta text-amber-800">{deepLink.flagContextHint}</p>
      ) : null}
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
          {rolePills.map((rt) => (
            <button
              key={rt.id}
              type="button"
              className={[
                filterPillClasses.base,
                roleType === rt.id ? filterPillClasses.active : filterPillClasses.inactive,
              ].join(' ')}
              onClick={() => setRoleType(rt.id)}
            >
              {rt.label}
            </button>
          ))}
        </div>
        <p className={chartTypography.hint}>{ui.caliberHint}</p>
      </Card>

      <Card title={trendChartMeta.title}>
        {!loading ? (
          <BucketFilterButtons
            label={ui.trendBucketFilterLabel}
            hint={ui.trendBucketFilterHint}
            clearLabel={ui.bucketFilterClear}
            buckets={availableTrendBuckets}
            selected={selectedTrendBuckets}
            onToggle={toggleTrendBucket}
            onClear={clearTrendBucketSelection}
          />
        ) : null}
        {loading ? <p className={chartTypography.hint}>{ui.loading}</p> : null}
        {!loading && selectedTrendBuckets.length > 0 && !hasTrendData ? (
          <p className={chartTypography.hint}>{ui.bucketFilterEmpty}</p>
        ) : !loading && !hasTrendData ? (
          <p className={chartTypography.hint}>{ui.emptyHint}</p>
        ) : (
          <TaxRatioLineChart
            series={trendSeries}
            yAxisLabel={ui.trendChartYAxis}
            monthLabel={(month) => ui.trendChartMonthLabel.replace('{month}', String(month))}
          />
        )}
        <p className={`mt-2 ${chartTypography.hint}`}>{trendChartMeta.hint}</p>
        {!loading && hasTrendData ? (
          <p className={`mt-1 ${chartTypography.hint}`}>{ui.trendChartVolatilityNote}</p>
        ) : null}
      </Card>

      <Card title={chartMeta.title}>
        {!loading ? (
          <BucketFilterButtons
            label={ui.barBucketFilterLabel}
            hint={ui.barBucketFilterHint}
            clearLabel={ui.bucketFilterClear}
            buckets={availableBarBuckets}
            selected={selectedBarBuckets}
            onToggle={toggleBarBucket}
            onClear={clearBarBucketSelection}
          />
        ) : null}
        {loading ? <p className={chartTypography.hint}>{ui.loading}</p> : null}
        {!loading && selectedBarBuckets.length > 0 && !hasChartData ? (
          <p className={chartTypography.hint}>{ui.bucketFilterEmpty}</p>
        ) : !loading && !hasChartData ? (
          <p className={chartTypography.hint}>{ui.emptyHint}</p>
        ) : (
          <div className={`flex ${CHART_BAR_STRIP_CLASS} gap-2 border-b border-border-light pb-1`}>
            {chartRows.map((r) => {
              const barPx = barHeightPx(r.amount_je, maxAmt)
              const color = BUCKET_COLORS[r.tax_bucket] ?? 'bg-[#5b9bd5]'
              const ratio =
                roleType === 'all'
                  ? maxAmt > 0
                    ? ((r.amount_je / (inputTotalAmount + outputTotalAmount)) * 100).toFixed(1)
                    : '0.0'
                  : (r.amount_ratio * 100).toFixed(1)
              return (
                <div key={r.tax_bucket} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className={`w-full max-w-[3rem] rounded-t-sm ${color}`}
                    style={{ height: `${barPx}px` }}
                    title={`${r.tax_bucket}: ${formatDwsAmount(r.amount_je)} (${ratio}%)`}
                  />
                  <span className={`text-center ${chartTypography.axisX}`}>{r.tax_bucket}</span>
                </div>
              )
            })}
          </div>
        )}
        <p className={`mt-2 ${chartTypography.hint}`}>{chartMeta.hint}</p>
        {!loading && hasChartData ? (
          <p className={`mt-1 ${chartTypography.hint}`}>{totalHintText}</p>
        ) : null}
      </Card>

      <Card title={ui.tableTitle}>
        <div className={dataTableClasses.wrap}>
          <table
            className={[dataTableClasses.table, isWideTable ? 'min-w-[880px]' : 'min-w-[520px]'].join(' ')}
          >
            <thead>
              {isWideTable ? (
                <tr className={dataTableClasses.headerRow}>
                  <th className={dataTableClasses.headerCell}>{ui.colBucket}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.taxColInputAmount}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.taxColInputRatio}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.taxColInputLines}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.taxColOutputAmount}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.taxColOutputRatio}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.taxColOutputLines}</th>
                </tr>
              ) : (
                <tr className={dataTableClasses.headerRow}>
                  <th className={dataTableClasses.headerCell}>{ui.colBucket}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.colAmount}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.colRatio}</th>
                  <th className={dataTableClasses.headerCellRight}>{ui.colLines}</th>
                  <th className={dataTableClasses.headerCell}>{drillUi.drillBtn}</th>
                </tr>
              )}
            </thead>
            <tbody className={dataTableClasses.body}>
              {isWideTable ? (
                filteredWideRows.length > 0 ? (
                  filteredWideRows.map((r) => (
                      <tr key={r.tax_bucket} className={dataTableClasses.row}>
                        <td className={dataTableClasses.cell}>{r.tax_bucket}</td>
                        <td className={dataTableClasses.cellRight}>
                          {r.input_amount_je === null ? ui.taxEmptyCell : formatDwsAmount(r.input_amount_je)}
                        </td>
                        <td className={dataTableClasses.cellRight}>
                          {formatRatio(r.input_amount_ratio, ui.taxEmptyCell)}
                        </td>
                        <td className={dataTableClasses.cellRight}>
                          {r.input_line_cnt === null ? ui.taxEmptyCell : r.input_line_cnt.toLocaleString()}
                        </td>
                        <td className={dataTableClasses.cellRight}>
                          {r.output_amount_je === null ? ui.taxEmptyCell : formatDwsAmount(r.output_amount_je)}
                        </td>
                        <td className={dataTableClasses.cellRight}>
                          {formatRatio(r.output_amount_ratio, ui.taxEmptyCell)}
                        </td>
                        <td className={dataTableClasses.cellRight}>
                          {r.output_line_cnt === null ? ui.taxEmptyCell : r.output_line_cnt.toLocaleString()}
                        </td>
                      </tr>
                    ))
                ) : (
                  <tr>
                    <td colSpan={7} className={dataTableClasses.emptyCell}>
                      {tableEmptyText}
                    </td>
                  </tr>
                )
              ) : filteredRows.length > 0 ? (
                filteredRows.map((r) => (
                  <tr key={r.tax_bucket} className={dataTableClasses.row}>
                    <td className={dataTableClasses.cell}>{r.tax_bucket}</td>
                    <td className={dataTableClasses.cellRight}>{formatDwsAmount(r.amount_je)}</td>
                    <td className={dataTableClasses.cellRight}>{(r.amount_ratio * 100).toFixed(2)}%</td>
                    <td className={dataTableClasses.cellRight}>{r.line_cnt.toLocaleString()}</td>
                    <td className={dataTableClasses.cell}>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => {
                          setDrillSlvNum(taxBucketToSlvNum(r.tax_bucket))
                          setDrillOpen(true)
                        }}
                      >
                        {drillUi.drillFromTaxBucket}
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className={dataTableClasses.emptyCell}>
                    {tableEmptyText}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <InvoiceDetailDrillPanel
        open={drillOpen}
        onClose={() => setDrillOpen(false)}
        title={drillUi.drillFromTaxBucket}
        filters={{
          statYear: f.effectiveYear,
          entityId: f.entityId.trim() || undefined,
          slvNum: drillSlvNum,
          statMonth: deepLink.timeFilterParams.statMonth,
          dateFrom: deepLink.timeFilterParams.dateFrom,
          dateTo: deepLink.timeFilterParams.dateTo,
        }}
      />
    </div>
  )
}
