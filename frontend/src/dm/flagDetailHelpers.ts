import type { AuditFlagRow } from '../config/localApi'
import type { FlagActionTarget } from './flagActionTarget'

const CACHE_KEY = 'invoicelens.flag_detail.row_cache'

export function buildFlagDetailTitle(row: Pick<AuditFlagRow, 'rule_id' | 'entity_name' | 'entity_id' | 'flag_id'>): string {
  const entity = (row.entity_name ?? row.entity_id ?? '').trim()
  if (entity) return `${row.rule_id} · ${entity}`
  return row.rule_id || row.flag_id
}

export function cacheFlagDetailRow(row: AuditFlagRow) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    const map: Record<string, AuditFlagRow> = raw ? (JSON.parse(raw) as Record<string, AuditFlagRow>) : {}
    map[row.flag_id] = row
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function readCachedFlagDetailRow(flagId: string): AuditFlagRow | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, AuditFlagRow>
    return map[flagId] ?? null
  } catch {
    return null
  }
}

export function resolveFlagDetailTarget(row: AuditFlagRow, statYear: string): FlagActionTarget {
  cacheFlagDetailRow(row)
  return {
    nav: 'flag_detail',
    params: { flag_id: row.flag_id, stat_year: statYear },
    tier: 'wide',
    title: buildFlagDetailTitle(row),
  }
}
