import type { NavKey } from '../types'

/** sessionStorage：从覆盖分析等页跳转到主体库时预填检索关键字 */
export const SUBJECT_LIBRARY_PREFILL_KEY = 'invoicelens_subject_library_prefill'

export function readSubjectLibraryPrefill(): string | null {
  try {
    const raw = sessionStorage.getItem(SUBJECT_LIBRARY_PREFILL_KEY)
    if (!raw) return null
    const trimmed = raw.trim()
    return trimmed || null
  } catch {
    return null
  }
}

export function clearSubjectLibraryPrefill(): void {
  try {
    sessionStorage.removeItem(SUBJECT_LIBRARY_PREFILL_KEY)
  } catch {
    /* ignore */
  }
}

export function navToSubjectLibrary(onNav: (k: NavKey) => void, keyword: string) {
  try {
    const kw = keyword.trim()
    if (kw) sessionStorage.setItem(SUBJECT_LIBRARY_PREFILL_KEY, kw)
    else sessionStorage.removeItem(SUBJECT_LIBRARY_PREFILL_KEY)
  } catch {
    /* ignore */
  }
  onNav('dim_enterprise_library')
}
