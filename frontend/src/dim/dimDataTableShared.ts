/** 维度主数据清单类表格的共享样式（与 AuditedEnterpriseLedgerPage 等保持一致） */

export const DIM_TABLE_TH_STICKY =
  'sticky top-0 z-10 border-b border-border-light bg-[#fafbfd] px-3 py-2 font-medium shadow-[0_1px_0_0_rgba(15,23,42,0.06)]'

export const DIM_TABLE_SCROLL_WRAPPER =
  'max-h-[min(calc(100vh-22rem),640px)] min-h-[240px] overflow-auto rounded-sm border border-border-light'

export const DIM_TABLE_BASE = 'w-full border-separate border-spacing-0 text-il-page-desc'

export const DIM_TABLE_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const

export function cellOrDash(value: string): string {
  return value.trim() ? value : '—'
}
