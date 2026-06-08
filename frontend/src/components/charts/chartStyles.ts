/**
 * InvoiceLens 图表与数据概览页视觉规范（唯一实现来源）。
 * 文档说明见 docs/frontend-typography.md §10。
 */

/** 柱形图单柱最大高度（px） */
export const CHART_BAR_MAX_PX = 120

/** 简易柱形图容器高度（Tailwind 类） */
export const CHART_BAR_STRIP_CLASS = 'h-40'

/** 折线图 viewBox 与内边距（与 ChartSvgFrame 配套） */
export const CHART_TREND_LAYOUT = {
  W: 640,
  H: 200,
  PAD_L: 40,
  PAD_R: 12,
  PAD_T: 10,
  PAD_B: 28,
} as const

export const CHART_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

/** 图表网格与轴线颜色 */
export const CHART_GRID_STROKE = '#e8ecf1'
export const CHART_AXIS_STROKE = '#c5cdd8'

/**
 * 图表文字层级（必须使用 il-* token，禁止 SVG 内写 text 或 text-[Npx]）。
 * - axisY：折线 Y 轴刻度，与表头同级（9px）
 * - axisX：折线 X 轴 / 柱形类别标签（10px）
 * - hint / legend：口径说明、图例（11px）
 */
export const chartTypography = {
  axisY: 'text-il-label leading-none text-text-3 tabular-nums',
  axisX: 'text-il-chart-axis leading-tight text-text-3',
  hint: 'text-il-meta text-text-3',
  legend: 'text-il-meta text-text-3',
  legendSwatch: 'inline-block h-0.5 w-4 rounded-full',
  legendItem: 'inline-flex items-center gap-1.5 text-il-meta text-text-3',
  filterPill: 'text-il-page-desc',
} as const

/** 数据概览明细表（与图表同页时使用） */
export const dataTableClasses = {
  table: 'w-full border-collapse text-il-page-desc',
  headerRow: 'border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3',
  headerCell: 'px-3 py-2 font-medium',
  headerCellRight: 'px-3 py-2 font-medium text-right',
  body: 'text-text-2',
  cell: 'px-3 py-2',
  cellRight: 'px-3 py-2 text-right tabular-nums',
  row: 'border-b border-border-light last:border-b-0',
  emptyCell: 'px-3 py-6 text-center text-text-3',
  wrap: 'overflow-x-auto rounded-sm border border-border-light',
} as const

/** 筛选胶囊按钮（全部 / 进项 / 销项等） */
export const filterPillClasses = {
  base: 'rounded-sm border px-2.5 py-1 text-il-page-desc',
  active: 'border-[#c8dff7] bg-[#f0f7ff] text-accent',
  inactive: 'border-border bg-white text-text-2 hover:border-accent',
} as const

/** 柱形图高度（px），零值返回 0，非零至少 3px 以保证可见 */
export function barHeightPx(value: number, max: number): number {
  if (value === 0 || max <= 0) return 0
  return Math.max(Math.round((Math.abs(value) / max) * CHART_BAR_MAX_PX), 3)
}

/** 折线图 overlay 定位：按 viewBox 比例换算为百分比 */
export function chartOverlayStyle(
  layout: typeof CHART_TREND_LAYOUT,
  region: 'yLabels' | 'xLabels',
): { top?: string; height?: string; left?: string; right?: string; bottom?: string } {
  const plotH = layout.H - layout.PAD_T - layout.PAD_B
  if (region === 'yLabels') {
    return {
      top: `${(layout.PAD_T / layout.H) * 100}%`,
      height: `${(plotH / layout.H) * 100}%`,
    }
  }
  return {
    left: `${(layout.PAD_L / layout.W) * 100}%`,
    right: `${(layout.PAD_R / layout.W) * 100}%`,
    bottom: '0',
    height: `${(layout.PAD_B / layout.H) * 100}%`,
  }
}
