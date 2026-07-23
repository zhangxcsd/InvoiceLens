const STORAGE_KEY = 'invoicelens.flags_list.ui'

export type FlagsListUiSnapshot = {
  statYear: string
  ruleFilter: string
  batchFilter: string
  keyword: string
  riskTab: string
  page: number
  pageSize: number
  scrollY: number
  shellStack: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>
}

export function readFlagsListUiSnapshot(): FlagsListUiSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as FlagsListUiSnapshot
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function writeFlagsListUiSnapshot(snapshot: FlagsListUiSnapshot) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
}

export function clearFlagsListUiSnapshot() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
