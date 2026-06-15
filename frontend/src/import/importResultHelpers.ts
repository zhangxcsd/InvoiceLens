import type { PickedExcel } from '../components/UploadZone'
import type { ImportEvent, ImportFailureRecord } from './eventTypes'

export type ImportRunSnapshot = {
  source: 'api' | 'sim'
  /** 本地 API 不可用或调用失败时回退到模拟导入（生产构建默认不回退） */
  simDueToApiFailure?: boolean
  batchDate: string
  success: number
  failed: number
  skipped: number
  events: ImportEvent[]
  failures: ImportFailureRecord[]
  runQueue: PickedExcel[]
  importSessionId?: string
  fieldMappingTemplate?: {
    template_id: string
    template_name: string
    template_updated_at?: string
  }
}

export type ImportFieldMappingTemplateMeta = NonNullable<ImportRunSnapshot['fieldMappingTemplate']>

export function extractImportSessionMeta(events: ImportEvent[]): {
  importSessionId?: string
  fieldMappingTemplate?: ImportFieldMappingTemplateMeta
} {
  let importSessionId: string | undefined
  let fieldMappingTemplate: ImportFieldMappingTemplateMeta | undefined
  for (const ev of events) {
    if (ev.type !== 'session_start' && ev.type !== 'session_end') continue
    const p = ev.payload as Record<string, unknown>
    const sid = String(p.import_session_id ?? ev.import_session_id ?? '').trim()
    if (sid) importSessionId = sid
    const raw = p.field_mapping_template
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      const template_id = String(o.template_id ?? '').trim()
      if (template_id) {
        fieldMappingTemplate = {
          template_id,
          template_name: String(o.template_name ?? '').trim() || template_id,
          template_updated_at: String(o.template_updated_at ?? '').trim() || undefined,
        }
      }
    }
  }
  return { importSessionId, fieldMappingTemplate }
}

function escapeCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 从 file_result 汇总拒收样本（成功写出但含行级拒收） */
export function collectRejectRowsForExport(events: ImportEvent[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const ev of events) {
    if (ev.type !== 'file_result') continue
    if (ev.payload.result !== 'success') continue
    const p = ev.payload as Record<string, unknown>
    const fileName = String(p.file_name ?? '')
    const samples = p.reject_row_samples
    if (!Array.isArray(samples)) continue
    for (const s of samples) {
      if (s && typeof s === 'object') {
        rows.push({ file_name: fileName, ...(s as Record<string, unknown>) })
      }
    }
  }
  return rows
}

export function buildExportJson(snapshot: ImportRunSnapshot): string {
  const reject_rows = collectRejectRowsForExport(snapshot.events)
  const meta = extractImportSessionMeta(snapshot.events)
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      batch_date: snapshot.batchDate,
      import_session_id: snapshot.importSessionId ?? meta.importSessionId ?? null,
      field_mapping_template: snapshot.fieldMappingTemplate ?? meta.fieldMappingTemplate ?? null,
      source: snapshot.source,
      summary: {
        success_files: snapshot.success,
        failed_files: snapshot.failed,
        skipped_files: snapshot.skipped,
        sim_due_to_api_failure: snapshot.simDueToApiFailure === true,
      },
      failures: snapshot.failures,
      file_events: snapshot.events.filter((e) => e.type === 'file_result'),
      reject_rows,
    },
    null,
    2,
  )
}

export function downloadRejectRowsCsv(snapshot: ImportRunSnapshot): void {
  const reject_rows = collectRejectRowsForExport(snapshot.events)
  const headers = ['file_name', 'sheet', 'seq_no', 'field', 'reason', 'exception_type']
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const r of reject_rows) {
    lines.push(
      [
        r.file_name,
        r.sheet,
        r.seq_no,
        r.field,
        r.reason,
        r.exception_type,
      ].map(escapeCsvCell).join(','),
    )
  }
  const bom = '\uFEFF'
  const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `InvoiceLens_拒收行样本_${snapshot.batchDate}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function downloadJson(snapshot: ImportRunSnapshot): void {
  const blob = new Blob([buildExportJson(snapshot)], { type: 'application/json;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `InvoiceLens_导入结果_${snapshot.batchDate}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

/** 优先使用 file_index；否则按失败记录中的 file_name 匹配（兼容旧事件） */
export function getFailedQueueRows(snapshot: ImportRunSnapshot): PickedExcel[] {
  const idxSet = new Set<number>()
  for (const ev of snapshot.events) {
    if (ev.type !== 'file_result') continue
    if (ev.payload.result !== 'failed') continue
    const fi = (ev.payload as { file_index?: number }).file_index
    if (typeof fi === 'number' && fi >= 1) idxSet.add(fi - 1)
  }
  if (idxSet.size > 0) {
    return [...idxSet].sort((a, b) => a - b).map((i) => snapshot.runQueue[i]).filter(Boolean)
  }
  const names = new Set(snapshot.failures.map((f) => f.file_name))
  return snapshot.runQueue.filter((r) => names.has(r.file.name))
}
