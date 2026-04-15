import type { PickedExcel } from '../components/UploadZone'
import { runInvoiceXlsxFormatPrecheck, type FieldMappingConfig } from './formatPrecheckInvoice'
import { peekOfficeExcelKind } from './importQueueUtils'

export type FormatValidationResult = {
  browserIssues: string[]
  yamlIssues: string[]
}

/**
 * 与上传页「格式检测」一致：扩展名/大小/文件头 + 勾选目标的 .xlsx 结构预审与 YAML 表头覆盖。
 */
export async function validateImportQueueFormat(params: {
  queue: PickedExcel[]
  targetSheetKeys: string[]
  fieldMappingConfig: FieldMappingConfig
  maxUploadMb: number
  /** 每处理完队列中的一个文件后回调（done 为已完成个数，含校验失败但已读过的项） */
  onProgress?: (done: number, total: number) => void
}): Promise<FormatValidationResult> {
  const { queue, targetSheetKeys, fieldMappingConfig, maxUploadMb, onProgress } = params
  const browserIssues: string[] = []
  const yamlIssues: string[] = []

  if (targetSheetKeys.length === 0) {
    browserIssues.push('请至少勾选一个目标 Sheet')
  }

  const total = queue.length
  for (let i = 0; i < total; i++) {
    const row = queue[i]!
    try {
      const f = row.file
      const lower = f.name.toLowerCase()
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
        browserIssues.push(`${f.name}：仅支持 .xlsx / .xls`)
        continue
      }
      if (f.size === 0) {
        browserIssues.push(`${f.name}：文件为空`)
        continue
      }
      const maxBytes = maxUploadMb * 1024 * 1024
      if (f.size > maxBytes) {
        browserIssues.push(`${f.name}：单文件超过 ${maxUploadMb}MB`)
        continue
      }
      const kind = await peekOfficeExcelKind(f)
      if (lower.endsWith('.xlsx') && kind !== 'xlsx') {
        browserIssues.push(`${f.name}：文件头与 .xlsx 不符`)
        continue
      }
      if (lower.endsWith('.xls') && kind !== 'xls') {
        browserIssues.push(`${f.name}：文件头与 .xls 不符`)
        continue
      }

      if (targetSheetKeys.length > 0 && lower.endsWith('.xlsx') && kind === 'xlsx') {
        const pre = await runInvoiceXlsxFormatPrecheck(f, targetSheetKeys, fieldMappingConfig, {
          maxUploadMb,
        })
        browserIssues.push(...pre.browserIssues)
        yamlIssues.push(...pre.yamlCoverageIssues)
      }
    } finally {
      onProgress?.(i + 1, total)
    }
  }

  return { browserIssues, yamlIssues }
}
