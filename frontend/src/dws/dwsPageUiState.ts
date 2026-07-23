import type { NavKey } from '../types'

const storageKey = (host: NavKey) => `invoicelens.dws.${host}.ui`

export type DwsPageUiSnapshot = {
  statYear: string
  entityId: string
  minInvoiceCount?: number | null
  scrollY: number
  shellStack: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>
  extra?: Record<string, unknown>
}

export function readDwsPageUiSnapshot(host: NavKey): DwsPageUiSnapshot | null {
  try {
    const raw = sessionStorage.getItem(storageKey(host))
    if (!raw) return null
    const parsed = JSON.parse(raw) as DwsPageUiSnapshot
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function writeDwsPageUiSnapshot(host: NavKey, snapshot: DwsPageUiSnapshot) {
  try {
    sessionStorage.setItem(storageKey(host), JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
}

export function clearDwsPageUiSnapshot(host: NavKey) {
  try {
    sessionStorage.removeItem(storageKey(host))
  } catch {
    /* ignore */
  }
}
