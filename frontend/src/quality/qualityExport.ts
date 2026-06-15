import type { DqDomainDetailRow, RedInvoiceQualityDetailRow } from '../config/localApi'
import { DIM_DICT_BUILTIN_DEFAULTS } from '../dim/dimDictHelpers'

function severityLabel(code: string, fn?: (code: string) => string): string {
  if (fn) {
    const v = fn(code)
    if (v) return v
  }
  const baked = DIM_DICT_BUILTIN_DEFAULTS.quality_severity?.find((o) => o.code === code)
  return baked?.label ?? code
}

function escapeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function downloadDqDomainDetailsCsv(
  rows: DqDomainDetailRow[],
  opts?: {
    batchId?: string
    domainLabel?: string
    fileStem?: string
    lineageReject?: boolean
    dwdLineage?: boolean
    severityLabelFn?: (code: string) => string
  },
) {
  const domain = opts?.domainLabel ?? '质量异常'
  const headers = opts?.lineageReject
    ? ['序号/范围', '源 Excel', 'Sheet', '质量域', '规则', '严重度', '拒收原因', '导入批次', '字段', '异常类型']
    : opts?.dwdLineage
      ? ['票键', '源 Excel', 'Sheet', '逻辑行号', '质量域', '规则', '严重度', '摘要', '导入批次', 'header_uuid']
      : ['票键', '质量域', '规则', '严重度', '摘要', '导入批次', 'header_uuid', '差额']
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const r of rows) {
    if (opts?.lineageReject) {
      lines.push(
        [
          r.ticket_key,
          String(r.extra?.file_name ?? r.extra?.source_excel_file ?? ''),
          String(r.extra?.sheet ?? ''),
          domain,
          r.rule_id,
          severityLabel(r.severity, opts?.severityLabelFn),
          r.summary,
          r.import_batch_id,
          String(r.extra?.field ?? ''),
          String(r.extra?.exception_type ?? ''),
        ].map(escapeCsvCell).join(','),
      )
    } else if (opts?.dwdLineage) {
      lines.push(
        [
          r.ticket_key,
          String(r.extra?.file_name ?? r.extra?.source_excel_file ?? ''),
          String(r.extra?.source_sheet ?? r.extra?.sheet ?? ''),
          r.extra?.logic_line_no != null ? String(r.extra.logic_line_no) : '',
          domain,
          r.rule_id,
          severityLabel(r.severity, opts?.severityLabelFn),
          r.summary,
          r.import_batch_id,
          r.header_uuid,
        ].map(escapeCsvCell).join(','),
      )
    } else {
      lines.push(
        [
          r.ticket_key,
          domain,
          r.rule_id,
          severityLabel(r.severity, opts?.severityLabelFn),
          r.summary,
          r.import_batch_id,
          r.header_uuid,
          r.delta_value ?? '',
        ].map(escapeCsvCell).join(','),
      )
    }
  }
  const bom = '\uFEFF'
  const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  const suffix = opts?.batchId?.trim() ? `_${opts.batchId.trim()}` : ''
  const stem = opts?.fileStem?.trim() || '质量明细'
  a.href = URL.createObjectURL(blob)
  a.download = `InvoiceLens_${stem}${suffix}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function downloadRedInvoiceQualityCsv(
  rows: RedInvoiceQualityDetailRow[],
  opts?: { batchId?: string; domainLabel?: string },
) {
  const mapped: DqDomainDetailRow[] = rows.map((r) => ({
    ticket_key: r.sdfphm || `${r.fpdm}-${r.fphm}`,
    header_uuid: r.header_uuid,
    domain: 'red_link',
    rule_id: 'red_blue_link_unmatched',
    severity: r.is_orphan_red ? 'block' : 'warn',
    summary: r.quality_reason,
    import_batch_id: r.import_batch_id,
    import_session_id: r.import_session_id,
    delta_value: r.jshj,
    extra: { bz: r.bz },
  }))
  downloadDqDomainDetailsCsv(mapped, {
    batchId: opts?.batchId,
    domainLabel: opts?.domainLabel ?? '红票蓝票关联质量',
    fileStem: '红票质量明细',
  })
}
