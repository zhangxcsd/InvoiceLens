import type { QualityDomainKey } from '../config/localApi'
import type { NavKey } from '../types'

export type QualityNavKey = 'import_quality_overview' | 'import_quality_detail' | 'import_quality_trend'

export type { QualityDomainKey }

export function readQualityBatchParams(): { batchId: string; sessionId: string } {
  try {
    const sp = new URL(window.location.href).searchParams
    return {
      batchId: (sp.get('batch_id') ?? '').trim(),
      sessionId: (sp.get('session_id') ?? '').trim(),
    }
  } catch {
    return { batchId: '', sessionId: '' }
  }
}

export function writeQualityBatchParams(batchId: string, sessionId?: string) {
  try {
    const url = new URL(window.location.href)
    if (batchId.trim()) url.searchParams.set('batch_id', batchId.trim())
    else url.searchParams.delete('batch_id')
    const sid = (sessionId ?? '').trim()
    if (sid) url.searchParams.set('session_id', sid)
    else url.searchParams.delete('session_id')
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
}

export function readQualityDomainParam(): QualityDomainKey {
  try {
    const v = (new URL(window.location.href).searchParams.get('domain') ?? '').trim()
    const allowed: QualityDomainKey[] = [
      'uniqueness',
      'tax_id',
      'cross_table',
      'header_detail',
      'semantic',
      'red_link',
      'lineage_reject',
      'dwd_lineage',
    ]
    return (allowed.includes(v as QualityDomainKey) ? v : 'red_link') as QualityDomainKey
  } catch {
    return 'red_link'
  }
}

export function writeQualityDomainParam(domain: QualityDomainKey) {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('domain', domain)
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
}

export function navigateToQualityPage(
  onNav: (k: NavKey) => void,
  nav: QualityNavKey,
  params?: { batchId?: string; sessionId?: string; domain?: QualityDomainKey },
) {
  const cur = readQualityBatchParams()
  const batchId = params?.batchId ?? cur.batchId
  const sessionId = params?.sessionId ?? cur.sessionId
  const domain = params?.domain ?? (nav === 'import_quality_detail' ? readQualityDomainParam() : undefined)
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('nav', nav)
    if (batchId) url.searchParams.set('batch_id', batchId)
    else url.searchParams.delete('batch_id')
    if (sessionId) url.searchParams.set('session_id', sessionId)
    else url.searchParams.delete('session_id')
    if (domain && nav === 'import_quality_detail') url.searchParams.set('domain', domain)
    else if (nav !== 'import_quality_detail') url.searchParams.delete('domain')
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
  onNav(nav)
}
