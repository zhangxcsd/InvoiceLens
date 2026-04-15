import type { PickedExcel } from '../components/UploadZone'

/**
 * Office 在文档打开时生成的锁/占位文件（常见 `~$工作簿.xlsx`）。
 * 扩展名往往是 .xlsx/.xls，但内容不是 ZIP/OLE 工作簿，格式检测会报「文件头与 .xlsx 不符」等。
 */
export function isOfficeExcelLockFileName(fileName: string): boolean {
  const base = fileName.trim()
  if (base.length === 0) return false
  if (base.startsWith('~$')) return true
  if (base.startsWith('._')) return true
  return false
}

export function filterOutOfficeLockFiles(items: PickedExcel[]): PickedExcel[] {
  return items.filter((p) => !isOfficeExcelLockFileName(p.file.name))
}

export function queueRowKey(row: PickedExcel): string {
  const f = row.file
  return `${row.pathLabel ?? ''}|${f.name}|${f.size}|${f.lastModified}`
}

/** 读取文件头判断是否为有效 Office Excel（.xlsx 为 ZIP；.xls 为 OLE） */
export async function peekOfficeExcelKind(file: File): Promise<'xlsx' | 'xls' | 'unknown'> {
  const buf = await file.slice(0, 8).arrayBuffer()
  const u8 = new Uint8Array(buf)
  if (u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b) return 'xlsx'
  if (u8.length >= 4 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return 'xls'
  return 'unknown'
}
