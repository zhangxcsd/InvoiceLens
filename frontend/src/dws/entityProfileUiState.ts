const STORAGE_KEY = 'invoicelens.entity_profile.ui'

export type EntityProfileUiSnapshot = {
  statYear: string
  entityId: string
  minInvoiceCount: number | null
  activeTab: 'overview' | 'behavior'
  scrollY: number
  shellStack: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>
}

export function readEntityProfileUiSnapshot(): EntityProfileUiSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as EntityProfileUiSnapshot
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function writeEntityProfileUiSnapshot(snapshot: EntityProfileUiSnapshot) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
}

export function clearEntityProfileUiSnapshot() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
