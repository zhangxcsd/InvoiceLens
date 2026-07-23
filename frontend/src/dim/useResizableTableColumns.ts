import { useEffect, useRef, useState } from 'react'

export type ResizableColDef = {
  key: string
  defaultWidth: number
  minWidth: number
}

function readStoredWidths(storageKey: string, cols: ResizableColDef[]): number[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return cols.map((c) => c.defaultWidth)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return cols.map((c) => {
      const w = parsed[c.key]
      return typeof w === 'number' && Number.isFinite(w) && w >= c.minWidth ? Math.round(w) : c.defaultWidth
    })
  } catch {
    return cols.map((c) => c.defaultWidth)
  }
}

function persistWidths(storageKey: string, cols: ResizableColDef[], widths: number[]) {
  try {
    const map: Record<string, number> = {}
    cols.forEach((c, i) => {
      map[c.key] = widths[i] ?? c.defaultWidth
    })
    localStorage.setItem(storageKey, JSON.stringify(map))
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * 表头拖拽调列宽：像素宽度 + localStorage 记忆。
 * 配合 table-layout:fixed 与单行省略，列宽变化后文字截断位置自动跟随。
 */
export function useResizableTableColumns(storageKey: string, cols: ResizableColDef[]) {
  const colsRef = useRef(cols)
  colsRef.current = cols
  const colKeySig = cols.map((c) => c.key).join('|')

  const [widths, setWidths] = useState(() => readStoredWidths(storageKey, cols))
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const dragRef = useRef<{ index: number; startX: number; startW: number } | null>(null)

  useEffect(() => {
    setWidths(readStoredWidths(storageKey, colsRef.current))
  }, [storageKey, colKeySig])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const min = colsRef.current[drag.index]?.minWidth ?? 40
      const next = Math.max(min, Math.round(drag.startW + (e.clientX - drag.startX)))
      setWidths((prev) => {
        if (prev[drag.index] === next) return prev
        const copy = prev.slice()
        copy[drag.index] = next
        return copy
      })
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setActiveIndex(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setWidths((prev) => {
        persistWidths(storageKey, colsRef.current, prev)
        return prev
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [storageKey])

  const beginResize = (index: number, clientX: number) => {
    const startW = widths[index] ?? colsRef.current[index]?.defaultWidth ?? 80
    dragRef.current = { index, startX: clientX, startW }
    setActiveIndex(index)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const tableWidth = widths.reduce((sum, w) => sum + w, 0)

  return { widths, tableWidth, activeIndex, beginResize }
}
