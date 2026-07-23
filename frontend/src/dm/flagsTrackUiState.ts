const STORAGE_KEY = 'invoicelens.flags_track.ui'

export type FlagsTrackUiSnapshot = {
  statYear: string
  trackTab: 'pending' | 'confirmed' | 'all'
  riskTab: string
  ruleFilter: string
  keyword: string
  page: number
  pageSize: number
  scrollY: number
  shellStack: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>
}

export function readFlagsTrackUiSnapshot(): FlagsTrackUiSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as FlagsTrackUiSnapshot
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function writeFlagsTrackUiSnapshot(snapshot: FlagsTrackUiSnapshot) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
}

export function clearFlagsTrackUiSnapshot() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
