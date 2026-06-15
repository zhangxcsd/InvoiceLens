import type { AuditFlagRow } from '../config/localApi'

function escapeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function fmtAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ''
  return n.toFixed(2)
}

function statYearFromGroupId(groupId: string | undefined, fallback: string): string {
  const m = (groupId ?? '').match(/^Y(\d{4})$/)
  return m ? m[1] : fallback
}

export function downloadAuditFlagsCsv(
  rows: AuditFlagRow[],
  opts?: {
    statYear?: string
    headers?: readonly string[]
    fileStem?: string
  },
) {
  const headers =
    opts?.headers ??
    [
      '疑点编号',
      '规则编号',
      '风险等级',
      '疑点类型',
      '主体税号',
      '涉及企业',
      '涉及金额',
      '已确认',
      '跟踪说明',
      '异常描述',
      '建议核查动作',
      '统计年度',
    ]

  const fallbackYear = opts?.statYear ?? ''
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.flag_id,
        r.rule_id,
        r.risk_level,
        r.flag_type,
        r.entity_id ?? '',
        r.entity_name ?? '',
        fmtAmount(r.amount),
        r.is_confirmed ? '是' : '否',
        r.confirm_note ?? '',
        r.description,
        r.suggestion,
        statYearFromGroupId(r.group_id, fallbackYear),
      ].map(escapeCsvCell).join(','),
    )
  }

  const bom = '\uFEFF'
  const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  const yearSuffix = fallbackYear ? `_${fallbackYear}` : ''
  const stem = opts?.fileStem?.trim() || '疑点跟踪'
  a.href = URL.createObjectURL(blob)
  a.download = `InvoiceLens_${stem}${yearSuffix}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
