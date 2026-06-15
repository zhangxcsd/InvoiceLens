import type { AuditedEnterpriseRegistryRow } from '../config/localApi'

export type AuditedEnterpriseTreeNode = {
  id: string
  name: string
  level: number
  parentName: string
  snapshotYear: string
  stateInvestorEnterprise: string
  note: string
}

export type AuditedEnterpriseRelationRow = {
  name: string
  snapshotYear: string
  stateInvestorEnterprise: string
  mgmtPath: string
  equityPath: string
  relationType: string
}

export function parseFirstShareholder(shareholders: string): { name: string; ratio: string } {
  const first = shareholders.split(/[;；]/)[0]?.trim() ?? ''
  if (!first) return { name: '', ratio: '' }
  const match = first.match(/^(.+?)[（(]([^）)]+)[）)]$/)
  if (match) return { name: match[1].trim(), ratio: match[2].trim() }
  return { name: first, ratio: '' }
}

function normName(value: string): string {
  return value.trim().replace(/[（(][^）)]*[）)]/g, '').trim()
}

export function registryRowToManageNode(row: AuditedEnterpriseRegistryRow): AuditedEnterpriseTreeNode {
  const parent = row.mgmtParent.trim()
  return {
    id: row.rowId || `${row.code}-${row.snapshotYear}`,
    name: row.name,
    level: row.mgmtLevel > 0 ? row.mgmtLevel : 1,
    parentName: parent || '—',
    snapshotYear: row.snapshotYear,
    stateInvestorEnterprise: row.stateInvestor.trim() || '—',
    note: row.mainBusiness.trim() || row.enterpriseCategory.trim() || '—',
  }
}

export function registryRowToEquityNode(row: AuditedEnterpriseRegistryRow): AuditedEnterpriseTreeNode {
  const sh = parseFirstShareholder(row.shareholders)
  const parent = row.equityLevel <= 1 ? '—' : sh.name || '—'
  const displayName = sh.ratio ? `${row.name}（${sh.ratio}）` : row.name
  return {
    id: row.rowId || `${row.code}-${row.snapshotYear}-eq`,
    name: displayName,
    level: row.equityLevel > 0 ? row.equityLevel : 1,
    parentName: parent,
    snapshotYear: row.snapshotYear,
    stateInvestorEnterprise: row.stateInvestor.trim() || '—',
    note: row.shareholders.trim() || '—',
  }
}

function findRegistryRow(
  rows: AuditedEnterpriseRegistryRow[],
  snapshotYear: string,
  name: string,
): AuditedEnterpriseRegistryRow | undefined {
  const target = normName(name)
  return rows.find((r) => r.snapshotYear === snapshotYear && normName(r.name) === target)
}

function buildPathChain(
  rows: AuditedEnterpriseRegistryRow[],
  snapshotYear: string,
  startName: string,
  getParent: (row: AuditedEnterpriseRegistryRow) => string,
  formatNode: (row: AuditedEnterpriseRegistryRow) => string,
): string {
  const chain: string[] = []
  let current = startName.trim()
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const row = findRegistryRow(rows, snapshotYear, current)
    chain.unshift(row ? formatNode(row) : current)
    if (!row) break
    const parent = getParent(row).trim()
    if (!parent || parent === '—' || parent === '-') break
    current = parent
  }
  return chain.join(' → ')
}

export function registryRowsToRelationRows(rows: AuditedEnterpriseRegistryRow[]): AuditedEnterpriseRelationRow[] {
  return rows.map((row) => {
    const mgmtParent = row.mgmtParent.trim()
    const equityParent = parseFirstShareholder(row.shareholders).name
    const mgmtPath = buildPathChain(
      rows,
      row.snapshotYear,
      row.name,
      (r) => r.mgmtParent,
      (r) => r.name,
    )
    const equityPath = buildPathChain(
      rows,
      row.snapshotYear,
      row.name,
      (r) => parseFirstShareholder(r.shareholders).name,
      (r) => {
        const sh = parseFirstShareholder(r.shareholders)
        return sh.ratio ? `${r.name}（${sh.ratio}）` : r.name
      },
    )
    const relationType =
      normName(mgmtParent) === normName(equityParent) || (!mgmtParent && !equityParent) ? '一致' : '不一致'
    return {
      name: row.name,
      snapshotYear: row.snapshotYear,
      stateInvestorEnterprise: row.stateInvestor.trim() || '—',
      mgmtPath,
      equityPath,
      relationType,
    }
  })
}

export async function fetchAllAuditedEnterpriseRegistryRows(
  fetchRegistry: (params: {
    snapshotYear: string
    limit?: number
    offset?: number
    includeYears?: boolean
  }) => Promise<{
    ok: boolean
    snapshot_years?: string[]
    selected_year?: string
    rows?: AuditedEnterpriseRegistryRow[]
    total?: number
    error?: { message?: string }
  }>,
): Promise<{ ok: boolean; rows: AuditedEnterpriseRegistryRow[]; error?: { message?: string } }> {
  const first = await fetchRegistry({ snapshotYear: '2026', limit: 500, offset: 0, includeYears: true })
  if (!first.ok) {
    return { ok: false, rows: [], error: first.error }
  }
  const years = first.snapshot_years?.length ? first.snapshot_years : [first.selected_year ?? '2026']
  const merged: AuditedEnterpriseRegistryRow[] = []

  const fetchYearAll = async (year: string, seed?: typeof first) => {
    const initial = seed ?? (await fetchRegistry({ snapshotYear: year, limit: 500, offset: 0, includeYears: false }))
    if (!initial.ok) return initial
    const total = initial.total ?? initial.rows?.length ?? 0
    const rows = [...(initial.rows ?? [])]
    for (let offset = rows.length; offset < total; offset += 500) {
      const part = await fetchRegistry({ snapshotYear: year, limit: 500, offset, includeYears: false })
      if (!part.ok) return part
      rows.push(...(part.rows ?? []))
    }
    merged.push(...rows)
    return { ok: true as const }
  }

  const anchorYear = first.selected_year ?? years[0]
  for (const year of years) {
    const res = year === anchorYear ? await fetchYearAll(year, first) : await fetchYearAll(year)
    if (!res.ok) {
      return { ok: false, rows: [], error: 'error' in res ? res.error : undefined }
    }
  }
  return { ok: true, rows: merged }
}
