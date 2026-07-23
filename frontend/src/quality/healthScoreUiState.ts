const STORAGE_KEY = 'invoicelens.health_score.ui'

export type HealthScoreUiSnapshot = {
  statYear: string
  entityId: string
  minInvoiceCount: number | null
  onlyAbnormal: boolean
  levelFilter: 'all' | 'normal' | 'warning' | 'alert'
  dimensionFilter: string
  selectedIndicatorCode: string | null
  scrollY: number
  shellStack: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>
}

export function readHealthScoreUiSnapshot(): HealthScoreUiSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as HealthScoreUiSnapshot
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function writeHealthScoreUiSnapshot(snapshot: HealthScoreUiSnapshot) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
}

export function clearHealthScoreUiSnapshot() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
