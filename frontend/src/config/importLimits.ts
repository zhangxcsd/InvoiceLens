/**
 * 浏览器端「格式检测」单文件大小上限（金税导出等场景可能出现 >100MB 文件）。
 * 默认 200MB；可通过 `VITE_MAX_IMPORT_FILE_MB` 覆盖（构建时注入）。
 */
function parseMaxImportFileMb(): number {
  const raw = (import.meta as any).env?.VITE_MAX_IMPORT_FILE_MB
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 200
  // 防止误填极大值导致浏览器/内存问题
  return Math.min(Math.floor(n), 2048)
}

export const MAX_IMPORT_FILE_MB = parseMaxImportFileMb()
export const MAX_IMPORT_FILE_BYTES = Math.round(MAX_IMPORT_FILE_MB * 1024 * 1024)
