/** 维度主数据清单类表格的共享样式（与 AuditedEnterpriseLedgerPage 等保持一致） */

export const DIM_TABLE_TH_STICKY =
  'sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]'

export const DIM_TABLE_SCROLL_WRAPPER =
  'max-h-[min(calc(100vh-22rem),640px)] min-h-[240px] overflow-auto rounded-sm border border-border-light'

export const DIM_TABLE_BASE = 'w-full border-separate border-spacing-0 text-il-page-desc'

/** 清单行单元格：略宽松的垂直内边距，便于宽表扫读 */
export const DIM_TABLE_TD = 'border-b border-border-light px-3 py-3'

/**
 * 宽表单行省略单元格：table-fixed 下必须配合 max-width:0，
 * 仅靠 Tailwind truncate 在部分浏览器对中文长句会失效。
 */
export const DIM_TABLE_TD_ELLIPSIS = `${DIM_TABLE_TD} il-table-ellipsis-cell`

/**
 * 行底色：选中 > 悬停 > 暗格（偶数行）。
 * idx 为当前渲染列表中的行下标（从 0 起）。
 */
export function dimTableRowTone(opts: { idx: number; active?: boolean }): string {
  if (opts.active) return 'bg-[#f0f7ff]'
  if (opts.idx % 2 === 1) return 'bg-[#f7f9fc] hover:bg-[#eef4fb]'
  return 'bg-white hover:bg-[#fafcff]'
}

export const DIM_TABLE_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const

export function cellOrDash(value: string): string {
  return value.trim() ? value : '—'
}

/** 折叠空白后供单行展示；空则返回破折号。 */
export function cellSingleLine(value: string | null | undefined): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text || '—'
}
