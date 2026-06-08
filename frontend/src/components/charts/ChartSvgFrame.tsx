import type { ReactNode } from 'react'
import { chartOverlayStyle, chartTypography, CHART_TREND_LAYOUT } from './chartStyles'

type ChartSvgFrameProps = {
  /** 默认使用 CHART_TREND_LAYOUT；自定义时需同步调整 pad* 与 viewBox */
  layout?: typeof CHART_TREND_LAYOUT
  yTickLabels?: string[]
  xTickLabels?: ReactNode[]
  ariaLabel?: string
  children: ReactNode
  legend?: ReactNode
}

/**
 * 响应式 SVG 图表容器：图形在 SVG 内缩放，坐标轴文字用 HTML 固定字号 overlay，避免 viewBox 拉伸导致字号漂移。
 */
export function ChartSvgFrame({
  layout = CHART_TREND_LAYOUT,
  yTickLabels,
  xTickLabels,
  ariaLabel,
  children,
  legend,
}: ChartSvgFrameProps) {
  const { W, H } = layout

  return (
    <div>
      <div className="relative w-full max-w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={ariaLabel}
        >
          {children}
        </svg>
        {yTickLabels && yTickLabels.length > 0 ? (
          <div
            className={`pointer-events-none absolute flex w-7 flex-col justify-between text-right ${chartTypography.axisY}`}
            style={chartOverlayStyle(layout, 'yLabels')}
            aria-hidden
          >
            {yTickLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        ) : null}
        {xTickLabels && xTickLabels.length > 0 ? (
          <div
            className={`pointer-events-none absolute flex items-center ${chartTypography.axisX}`}
            style={chartOverlayStyle(layout, 'xLabels')}
            aria-hidden
          >
            {xTickLabels.map((label, idx) => (
              <span key={idx} className="min-w-0 flex-1 text-center">
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {legend}
    </div>
  )
}
