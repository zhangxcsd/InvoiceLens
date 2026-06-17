import { useCallback, useEffect, useState } from 'react'
import {
  dwsInvoiceDetailExportUrl,
  fetchDwsInvoiceDetailList,
  type DwsInvoiceDetailFilters,
  type DwsInvoiceDetailRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { formatDwsAmount } from './useDwsFilters'

type Props = {
  open: boolean
  onClose: () => void
  title?: string
  filters: DwsInvoiceDetailFilters
  canExport?: boolean
}

export function InvoiceDetailDrillPanel({ open, onClose, title, filters, canExport = true }: Props) {
  const ui = t.invoiceDetailDrillUi
  const pagUi = t.dimDataTableUi
  const [rows, setRows] = useState<DwsInvoiceDetailRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pageSize = 50

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!open || !filters.statYear.trim()) return
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsInvoiceDetailList(
          {
            ...filters,
            limit: pageSize,
            offset: (page - 1) * pageSize,
          },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          setRows([])
          setTotal(0)
          return
        }
        setRows(res.rows ?? [])
        setTotal(res.total ?? 0)
      } finally {
        setLoading(false)
      }
    },
    [filters, open, page, ui.loadFailed],
  )

  useEffect(() => {
    if (!open) return
    setPage(1)
  }, [open, filters.statYear, filters.entityId, filters.statMonth, filters.sellerTaxNo, filters.goodsName, filters.slvNum])

  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load, open])

  if (!open) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const exportUrl = canExport ? dwsInvoiceDetailExportUrl(filters) : null

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="presentation" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[960px] flex-col bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-light px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-text">{title ?? ui.defaultTitle}</h2>
            <p className="mt-0.5 text-il-meta text-text-3">{ui.totalHint.replace('{count}', String(total))}</p>
          </div>
          <div className="flex items-center gap-2">
            {exportUrl ? (
              <a
                href={exportUrl}
                className="rounded-sm border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                download
              >
                {ui.exportCsv}
              </a>
            ) : null}
            <button
              type="button"
              className="rounded-sm border border-border px-2.5 py-1 text-il-btn text-text-2 hover:border-accent"
              onClick={onClose}
            >
              {ui.closeBtn}
            </button>
          </div>
        </div>

        {err ? <p className="px-5 py-2 text-il-meta text-red-600">{err}</p> : null}

        <div className="flex-1 overflow-auto px-5 py-3">
          <div className="overflow-x-auto rounded-sm border border-border-light">
            <table className="w-full min-w-[880px] border-collapse text-il-page-desc">
              <thead>
                <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                  <th className="px-2 py-2 font-medium">{ui.colInvoiceNo}</th>
                  <th className="px-2 py-2 font-medium">{ui.colDate}</th>
                  <th className="px-2 py-2 font-medium">{ui.colSeller}</th>
                  <th className="px-2 py-2 font-medium">{ui.colGoods}</th>
                  <th className="px-2 py-2 font-medium">{ui.colAmount}</th>
                  <th className="px-2 py-2 font-medium">{ui.colTaxRate}</th>
                </tr>
              </thead>
              <tbody className="text-text-2">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-il-meta text-text-3">
                      {pagUi.tableLoading}
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-il-meta text-text-3">
                      {ui.emptyRows}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={`${row.sdfphm}-${row.fphm}-${row.logic_line_no}`}
                      className="border-b border-border-light last:border-b-0"
                    >
                      <td className="px-2 py-2 font-mono text-[11px]">{row.sdfphm || row.fphm || '—'}</td>
                      <td className="px-2 py-2">{row.kprq || '—'}</td>
                      <td className="px-2 py-2">
                        <div className="max-w-[140px] truncate" title={row.xfmc}>
                          {row.xfmc || '—'}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <div className="max-w-[160px] truncate" title={row.hwlwmc}>
                          {row.hwlwmc || '—'}
                        </div>
                      </td>
                      <td className="px-2 py-2 tabular-nums">{formatDwsAmount(row.jshj)}</td>
                      <td className="px-2 py-2">{row.slv || (row.slv_num != null ? `${(row.slv_num * 100).toFixed(1)}%` : '—')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border-light px-5 py-3 text-il-meta text-text-3">
          <span>{ui.pageHint.replace('{page}', String(page)).replace('{total}', String(totalPages))}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              className="rounded-sm border border-border px-2 py-1 disabled:opacity-50"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {pagUi.tablePagePrev}
            </button>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              className="rounded-sm border border-border px-2 py-1 disabled:opacity-50"
              onClick={() => setPage((p) => p + 1)}
            >
              {pagUi.tablePageNext}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
