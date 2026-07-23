import type { NavKey } from '../types'
import { getEmbedNavQuery } from '../utils/embedNavQuery'

export type FinanceNavKey = 'finance_reconcile' | 'finance_diff'

export type FinanceFilterParams = {
  batchId?: string
  statYear?: string
  entityId?: string
  diffType?: string
}

export function readFinanceFilterParams(): FinanceFilterParams {
  const embed = getEmbedNavQuery()
  if (embed) {
    return {
      batchId: (embed.batch_id ?? '').trim() || undefined,
      statYear: (embed.stat_year ?? '').trim() || undefined,
      entityId: (embed.entity_id ?? '').trim() || undefined,
      diffType: (embed.diff_type ?? '').trim() || undefined,
    }
  }
  return readFinanceFilterParamsFromUrl()
}

function readFinanceFilterParamsFromUrl(): FinanceFilterParams {
  try {
    const sp = new URL(window.location.href).searchParams
    return {
      batchId: (sp.get('batch_id') ?? '').trim() || undefined,
      statYear: (sp.get('stat_year') ?? '').trim() || undefined,
      entityId: (sp.get('entity_id') ?? '').trim() || undefined,
      diffType: (sp.get('diff_type') ?? '').trim() || undefined,
    }
  } catch {
    return {}
  }
}

export function writeFinanceFilterParams(params: FinanceFilterParams) {
  try {
    const url = new URL(window.location.href)
    const set = (key: string, v?: string) => {
      const s = (v ?? '').trim()
      if (s) url.searchParams.set(key, s)
      else url.searchParams.delete(key)
    }
    set('batch_id', params.batchId)
    set('stat_year', params.statYear)
    set('entity_id', params.entityId)
    set('diff_type', params.diffType)
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
}

export function navigateToFinancePage(
  onNav: (k: NavKey) => void,
  nav: FinanceNavKey,
  params?: FinanceFilterParams,
) {
  const cur = readFinanceFilterParams()
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('nav', nav)
    const batchId = params?.batchId ?? cur.batchId
    const statYear = params?.statYear ?? cur.statYear
    const entityId = params?.entityId ?? cur.entityId
    const diffType = params?.diffType ?? (nav === 'finance_diff' ? cur.diffType : undefined)
    if (batchId) url.searchParams.set('batch_id', batchId)
    else url.searchParams.delete('batch_id')
    if (statYear) url.searchParams.set('stat_year', statYear)
    else url.searchParams.delete('stat_year')
    if (entityId) url.searchParams.set('entity_id', entityId)
    else url.searchParams.delete('entity_id')
    if (diffType && nav === 'finance_diff') url.searchParams.set('diff_type', diffType)
    else if (nav !== 'finance_diff') url.searchParams.delete('diff_type')
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
  onNav(nav)
}
