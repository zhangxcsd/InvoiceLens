import type { FinanceReconcileDetailRow } from '../config/localApi'

function escapeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function periodLabel(year: number, month: number | null): string {
  if (month == null || month <= 0) return `${year} 年度`
  return `${year}-${String(month).padStart(2, '0')}`
}

function fmtAmount(n: number | null): string {
  if (n == null) return ''
  return n.toFixed(2)
}

export type FinanceDiffTypeLabel = { readonly code: string; readonly name: string }

export function downloadFinanceReconcileDetailsCsv(
  rows: FinanceReconcileDetailRow[],
  opts?: {
    batchId?: string
    diffTypeLabels?: readonly FinanceDiffTypeLabel[]
    headers?: readonly string[]
    fileStem?: string
  },
) {
  const typeMap = new Map((opts?.diffTypeLabels ?? []).map((d) => [d.code, d.name]))
  const diffTypeLabel = (code: string) => {
    const name = typeMap.get(code)
    return name ? `${code} · ${name}` : code
  }

  const headers =
    opts?.headers ??
    [
      '差异编号',
      '纳税人识别号',
      '主体名称',
      '统计年度',
      '期间',
      '购销标志',
      '科目编码',
      '科目名称',
      '账表金额',
      '发票净额',
      '差异金额',
      '差异类型',
      '状态',
      '导入批次',
    ]

  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.diff_id,
        r.tax_id,
        r.entity_name,
        r.stat_year,
        periodLabel(r.stat_year, r.stat_month),
        r.role_type,
        r.subject_code,
        r.subject_name,
        fmtAmount(r.ledger_amount),
        fmtAmount(r.invoice_net),
        fmtAmount(r.diff_amount),
        diffTypeLabel(r.diff_type),
        r.status,
        r.batch_id,
      ].map(escapeCsvCell).join(','),
    )
  }

  const bom = '\uFEFF'
  const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  const suffix = opts?.batchId?.trim() ? `_${opts.batchId.trim()}` : ''
  const stem = opts?.fileStem?.trim() || '差异明细'
  a.href = URL.createObjectURL(blob)
  a.download = `InvoiceLens_${stem}${suffix}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
