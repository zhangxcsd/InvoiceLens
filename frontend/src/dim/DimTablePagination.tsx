import { DIM_TABLE_PAGE_SIZE_OPTIONS } from './dimDataTableShared'

export type DimTablePaginationUi = {
  tablePagedTotalHint: string
  tablePageSizeLabel: string
  tablePagePrev: string
  tablePageNext: string
  tablePageOf: string
}

type DimTablePaginationProps = {
  total: number
  page: number
  pageSize: number
  loading?: boolean
  ui: DimTablePaginationUi
  pageSizeOptions?: readonly number[]
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

export function DimTablePagination(props: DimTablePaginationProps) {
  const {
    total,
    page,
    pageSize,
    loading = false,
    ui,
    pageSizeOptions = DIM_TABLE_PAGE_SIZE_OPTIONS,
    onPageChange,
    onPageSizeChange,
  } = props

  if (total <= 0) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const effectivePage = Math.min(page, totalPages)

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-2">
      <div className="text-il-meta text-text-3">
        {ui.tablePagedTotalHint.replace('{total}', String(total))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-il-meta text-text-2">
          <span>{ui.tablePageSizeLabel}</span>
          <select
            className="h-8 rounded-sm border border-border-light bg-white px-2 text-il-meta text-text outline-none focus:border-accent"
            value={String(pageSize)}
            disabled={loading}
            onChange={(e) => {
              onPageSizeChange(Number(e.target.value))
              onPageChange(1)
            }}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loading || effectivePage <= 1}
          className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
          onClick={() => onPageChange(Math.max(1, effectivePage - 1))}
        >
          {ui.tablePagePrev}
        </button>
        <span className="tabular-nums text-il-meta text-text-3">
          {ui.tablePageOf.replace('{page}', String(effectivePage)).replace('{pages}', String(totalPages))}
        </span>
        <button
          type="button"
          disabled={loading || effectivePage >= totalPages}
          className="rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text disabled:opacity-50"
          onClick={() => onPageChange(Math.min(totalPages, effectivePage + 1))}
        >
          {ui.tablePageNext}
        </button>
      </div>
    </div>
  )
}
