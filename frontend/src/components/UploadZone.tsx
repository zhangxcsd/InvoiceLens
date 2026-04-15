import { useCallback, useMemo, useRef, useState } from 'react'
import { zhCN } from '../copy/zh-CN'
import { UploadIcon } from '../design/icons'
import { isOfficeExcelLockFileName } from '../import/importQueueUtils'

/** 浏览器内可展示的「路径」多为相对所选文件夹的路径，一般不是完整盘符路径 */
export type PickedExcel = {
  file: File
  pathLabel?: string
}

export type UploadZoneProps = {
  accept?: string
  multiple?: boolean
  helperText?: string
  onFiles: (files: PickedExcel[]) => void
}

function isExcelFile(file: File): boolean {
  const name = file.name.toLowerCase()
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) return false
  if (isOfficeExcelLockFileName(file.name)) return false
  return true
}

type FsEntry = {
  isFile: boolean
  isDirectory: boolean
  fullPath?: string
  file?: (success: (f: File) => void) => void
  createReader?: () => {
    readEntries: (
      success: (entries: FsEntry[]) => void,
      error?: (err: Error) => void,
    ) => void
  }
}

function fsEntryRelativePath(entry: FsEntry): string | undefined {
  const fp = entry.fullPath
  if (typeof fp !== 'string' || fp.length === 0) return undefined
  return fp.replace(/^\//, '')
}

function filePathLabel(file: File): string | undefined {
  const rel = file.webkitRelativePath?.trim()
  if (rel) return rel
  const p = (file as File & { path?: string }).path
  if (typeof p === 'string' && p.length > 0) return p
  return undefined
}

/** 拖放时同时支持文件与文件夹（Chromium / Edge 等 webkitGetAsEntry） */
async function collectFilesFromDataTransfer(dt: DataTransfer): Promise<PickedExcel[]> {
  const out: PickedExcel[] = []
  const items = dt.items
  if (!items?.length) {
    return Array.from(dt.files)
      .filter(isExcelFile)
      .map((file) => ({ file, pathLabel: filePathLabel(file) }))
  }

  let usedEntryApi = false
  const tasks: Promise<void>[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const raw = item as DataTransferItem & {
      webkitGetAsEntry?: () => FsEntry | null
    }
    const entry = raw.webkitGetAsEntry?.() ?? null
    if (!entry) {
      const f = item.getAsFile()
      if (f && isExcelFile(f)) out.push({ file: f, pathLabel: filePathLabel(f) })
      continue
    }
    usedEntryApi = true
    tasks.push(traverseEntry(entry))
  }

  async function traverseEntry(entry: FsEntry): Promise<void> {
    if (entry.isFile && entry.file) {
      const rel = fsEntryRelativePath(entry)
      await new Promise<void>((resolve) => {
        entry.file!((f) => {
          if (isExcelFile(f)) {
            const pathLabel = rel || filePathLabel(f)
            out.push({ file: f, pathLabel })
          }
          resolve()
        })
      })
      return
    }
    if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader()
      const readAll = (): Promise<void> =>
        new Promise((resolve, reject) => {
          reader.readEntries(
            async (entries) => {
              if (entries.length === 0) {
                resolve()
                return
              }
              for (const ent of entries) {
                await traverseEntry(ent)
              }
              await readAll()
              resolve()
            },
            (err) => reject(err),
          )
        })
      await readAll()
    }
  }

  await Promise.all(tasks)

  if (!usedEntryApi && out.length === 0 && dt.files?.length) {
    return Array.from(dt.files)
      .filter(isExcelFile)
      .map((file) => ({ file, pathLabel: filePathLabel(file) }))
  }
  return out
}

export function UploadZone(props: UploadZoneProps) {
  const { accept = '.xlsx,.xls', multiple = true, helperText, onFiles } = props
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setDragging] = useState(false)

  const borderClass = useMemo(() => {
    if (isDragging) return 'border-accent bg-[#f5f9ff]'
    return 'border-border hover:border-accent hover:bg-[#f5f9ff]'
  }, [isDragging])

  const emitExcelFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return
      const picked: PickedExcel[] = Array.from(fileList)
        .filter(isExcelFile)
        .map((file) => ({ file, pathLabel: filePathLabel(file) }))
      if (picked.length === 0) return
      onFiles(picked)
    },
    [onFiles],
  )

  const pickFiles = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const pickFolder = useCallback(() => {
    folderInputRef.current?.click()
  }, [])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(false)
      try {
        const files = await collectFilesFromDataTransfer(e.dataTransfer)
        if (files.length > 0) onFiles(files)
      } catch {
        emitExcelFiles(e.dataTransfer.files)
      }
    },
    [emitExcelFiles, onFiles],
  )

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={zhCN.uploadZone.ariaMainAction}
        onClick={pickFolder}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') pickFolder()
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragging(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragging(false)
        }}
        onDrop={onDrop}
        className={[
          'cursor-pointer select-none transition-all',
          'flex flex-row items-center gap-3 border-2 border-dashed rounded-[10px] py-2.5 px-4 sm:gap-4 sm:py-3 sm:px-5',
          borderClass,
        ].join(' ')}
      >
        <div className="min-w-0 flex-1 text-left">
          <p className="text-[12px] leading-snug text-text sm:text-[13px] sm:leading-relaxed">
            <span>{zhCN.uploadZone.primaryLine}</span>
            <span>，{zhCN.uploadZone.actionHint}</span>{' '}
            <button
              type="button"
              className="inline cursor-pointer border-0 bg-transparent p-0 align-baseline font-medium text-accent underline underline-offset-2 hover:text-accent-mid"
              onClick={(e) => {
                e.stopPropagation()
                pickFiles()
              }}
            >
              {zhCN.uploadZone.pickFiles}
            </button>
            <span className="text-text-3"> · </span>
            <button
              type="button"
              className="inline cursor-pointer border-0 bg-transparent p-0 align-baseline font-medium text-accent underline underline-offset-2 hover:text-accent-mid"
              onClick={(e) => {
                e.stopPropagation()
                pickFolder()
              }}
            >
              {zhCN.uploadZone.pickFolder}
            </button>
            。
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-text-3 sm:mt-0.5 sm:text-[11px]">
            {helperText ?? zhCN.uploadZone.helperDefault}
          </p>
        </div>
        <div
          className="flex shrink-0 items-center justify-center text-accent [&_svg]:h-7 [&_svg]:w-7 sm:[&_svg]:h-8 sm:[&_svg]:w-8"
          aria-hidden
        >
          <UploadIcon />
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          emitExcelFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(e) => {
          emitExcelFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
