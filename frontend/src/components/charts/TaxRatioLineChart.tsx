import {
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_MONTHS,
  CHART_TREND_LAYOUT,
  chartTypography,
} from './chartStyles'
import { ChartSvgFrame } from './ChartSvgFrame'

export type TaxRatioTrendPoint = { month: number; ratio: number | null }

export type TaxRatioTrendSeries = {
  tax_bucket: string
  color: string
  points: TaxRatioTrendPoint[]
}

function trendPathSegments(
  points: TaxRatioTrendPoint[],
  xAt: (month: number) => number,
  yAt: (ratio: number) => number,
): string[] {
  const segments: string[] = []
  let current = ''
  for (const p of points) {
    if (p.ratio === null) {
      if (current) {
        segments.push(current)
        current = ''
      }
      continue
    }
    const cmd = current ? 'L' : 'M'
    current += `${cmd}${xAt(p.month).toFixed(1)},${yAt(p.ratio).toFixed(1)} `
  }
  if (current) segments.push(current.trim())
  return segments
}

export function TaxRatioLineChart({
  series,
  yAxisLabel,
  monthLabel,
}: {
  series: TaxRatioTrendSeries[]
  yAxisLabel: string
  monthLabel: (month: number) => string
}) {
  const { W, H, PAD_L, PAD_R, PAD_T, PAD_B } = CHART_TREND_LAYOUT
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const xAt = (month: number) => PAD_L + ((month - 1) / 11) * plotW
  const yAt = (ratio: number) => PAD_T + plotH - ratio * plotH
  const yTicks = [0, 0.25, 0.5, 0.75, 1]
  const yTickLabels = [...yTicks].reverse().map((tick) => (tick * 100).toFixed(0))

  return (
    <ChartSvgFrame
      yTickLabels={yTickLabels}
      xTickLabels={CHART_MONTHS.map((month) => monthLabel(month))}
      ariaLabel={yAxisLabel}
      legend={
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s) => (
            <span key={s.tax_bucket} className={chartTypography.legendItem}>
              <span className={chartTypography.legendSwatch} style={{ backgroundColor: s.color }} />
              {s.tax_bucket}
            </span>
          ))}
        </div>
      }
    >
      {yTicks.map((tick) => {
        const y = yAt(tick)
        return (
          <line key={tick} x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={CHART_GRID_STROKE} strokeWidth={1} />
        )
      })}
      <line
        x1={PAD_L}
        y1={PAD_T + plotH}
        x2={W - PAD_R}
        y2={PAD_T + plotH}
        stroke={CHART_AXIS_STROKE}
        strokeWidth={1}
      />
      {series.map((s) =>
        trendPathSegments(s.points, xAt, yAt).map((d, idx) => (
          <path
            key={`${s.tax_bucket}-${idx}`}
            d={d}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )),
      )}
      {series.map((s) =>
        s.points
          .filter((p) => p.ratio !== null)
          .map((p) => (
            <circle key={`${s.tax_bucket}-${p.month}`} cx={xAt(p.month)} cy={yAt(p.ratio!)} r={2.5} fill={s.color}>
              <title>
                {s.tax_bucket} {monthLabel(p.month)}: {(p.ratio! * 100).toFixed(1)}%
              </title>
            </circle>
          )),
      )}
    </ChartSvgFrame>
  )
}
