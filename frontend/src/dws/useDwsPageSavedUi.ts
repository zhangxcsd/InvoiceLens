import { useMemo } from 'react'
import type { NavKey } from '../types'
import { readDwsPageUiSnapshot, type DwsPageUiSnapshot } from './dwsPageUiState'

/** 读取 DWS 页 sessionStorage 快照（需在 useDwsFilters 之前调用）。 */
export function useDwsPageSavedUi(host: NavKey, embedMode?: boolean): DwsPageUiSnapshot | null {
  return useMemo(() => (embedMode ? null : readDwsPageUiSnapshot(host)), [host, embedMode])
}
