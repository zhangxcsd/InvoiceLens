import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAnalysisOrgScopeMembers,
  fetchAuditedEnterpriseRelationTree,
  type AnalysisOrgScopeMember,
  type AuditedEnterpriseRelationTreeNode,
  type DwsEntityOption,
} from '../config/localApi'
import { readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { useDwsFilters, type DwsFilterPoolOptions } from './useDwsFilters'

export type DwsScopeMode = 'entity' | 'org_mg' | 'org_eq'

export type OrgScopeFlatNode = {
  id: string
  name: string
  level: number
  label: string
}

export type DwsScopeHookOptions = DwsFilterPoolOptions & {
  /** 组织成员来源：pool=L1 池∩子树；org_subtree=子树全部成员 */
  memberSource?: 'pool' | 'org_subtree'
  initialScopeMode?: DwsScopeMode
  initialScopeEntityId?: string
}

function normScopeEntityId(code: string): string {
  return code.trim().replace(/[\s-]+/g, '').toUpperCase()
}

function flattenRelationOrgTree(
  nodes: AuditedEnterpriseRelationTreeNode[],
  depth = 0,
): OrgScopeFlatNode[] {
  const out: OrgScopeFlatNode[] = []
  for (const node of nodes) {
    const code = node.registry?.code?.trim()
    if (!code) {
      if (node.children?.length) out.push(...flattenRelationOrgTree(node.children, depth + 1))
      continue
    }
    const prefix = depth > 0 ? `${'　'.repeat(depth)}└ ` : ''
    out.push({
      id: normScopeEntityId(code),
      name: node.name,
      level: node.level,
      label: `${prefix}${node.name}`,
    })
    if (node.children?.length) out.push(...flattenRelationOrgTree(node.children, depth + 1))
  }
  return out
}

function parseScopeMode(raw: string | undefined): DwsScopeMode {
  if (raw === 'org_mg' || raw === 'org_eq' || raw === 'entity') return raw
  return 'entity'
}

function parseExcludedEntityIds(raw: string | undefined, fallback: string[] = []): string[] {
  if (raw?.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return fallback
}

export function useDwsAnalysisScope(requireEntity = false, poolOptions: DwsScopeHookOptions = {}) {
  const initFromUrl = Boolean(poolOptions.initFromUrl)
  const urlQuery = useMemo(() => (initFromUrl ? readNavQueryParams() : {}), [initFromUrl])
  const memberSource = poolOptions.memberSource ?? 'pool'
  const useOrgSubtree = memberSource === 'org_subtree'
  const f = useDwsFilters(requireEntity, poolOptions)

  const [scopeMode, setScopeModeState] = useState<DwsScopeMode>(() =>
    parseScopeMode(urlQuery.scope_mode ?? poolOptions.initialScopeMode ?? undefined),
  )
  const [scopeEntityId, setScopeEntityIdState] = useState(
    () => urlQuery.scope_entity_id ?? poolOptions.initialScopeEntityId ?? '',
  )
  const [orgFlatNodes, setOrgFlatNodes] = useState<OrgScopeFlatNode[]>([])
  const [orgTreeLoading, setOrgTreeLoading] = useState(false)
  const [orgTreeHint, setOrgTreeHint] = useState<string | null>(null)
  const [orgMembers, setOrgMembers] = useState<AnalysisOrgScopeMember[]>([])
  const [orgMembersLoading, setOrgMembersLoading] = useState(false)
  const [orgMembersHint, setOrgMembersHint] = useState<string | null>(null)
  const [scopeEntityName, setScopeEntityName] = useState('')
  const [excludedEntityIds, setExcludedEntityIdsState] = useState<string[]>(() =>
    parseExcludedEntityIds(urlQuery.excluded_entity_ids, poolOptions.initialExcludedEntityIds ?? []),
  )

  const isOrgScope = scopeMode === 'org_mg' || scopeMode === 'org_eq'
  const orgTree: 'mg' | 'eq' = scopeMode === 'org_eq' ? 'eq' : 'mg'

  const setExcludedEntityIds = useCallback((ids: string[]) => {
    const next = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    setExcludedEntityIdsState(next)
    writeNavQueryParams({ excluded_entity_ids: next.length ? next.join(',') : undefined })
  }, [])

  const setScopeMode = useCallback((mode: DwsScopeMode) => {
    setScopeModeState(mode)
    writeNavQueryParams({ scope_mode: mode })
  }, [])

  const setScopeEntityId = useCallback(
    (id: string) => {
      setScopeEntityIdState((prev) => {
        if (prev.trim() && prev.trim() !== id.trim()) {
          setExcludedEntityIdsState([])
          writeNavQueryParams({ excluded_entity_ids: undefined })
        }
        return id
      })
      writeNavQueryParams({ scope_entity_id: id || undefined })
    },
    [],
  )

  const setStatYearWithScopeReset = useCallback(
    (y: string) => {
      const prev = f.statYear.trim()
      if (prev && prev !== y.trim()) {
        setExcludedEntityIds([])
      }
      f.setStatYear(y)
    },
    [f, setExcludedEntityIds],
  )

  useEffect(() => {
    if (!isOrgScope || !f.effectiveYear) {
      setOrgFlatNodes([])
      setOrgTreeHint(null)
      return
    }
    const ac = new AbortController()
    setOrgTreeLoading(true)
    void fetchAuditedEnterpriseRelationTree(
      {
        snapshotYear: f.effectiveYear,
        mode: orgTree === 'eq' ? 'equity' : 'management',
      },
      ac.signal,
    ).then((res) => {
      if (ac.signal.aborted) return
      setOrgTreeLoading(false)
      if (res.ok && res.nodes) {
        setOrgFlatNodes(flattenRelationOrgTree(res.nodes))
        setOrgTreeHint(res.empty_hint || (res.nodes.length ? null : null))
      } else {
        setOrgFlatNodes([])
        setOrgTreeHint(res.error?.message ?? null)
      }
    })
    return () => ac.abort()
  }, [isOrgScope, f.effectiveYear, orgTree])

  const requireBuyer = Boolean(poolOptions.requireBuyer)
  const requireBothRoles = Boolean(poolOptions.requireBothRoles)
  const minN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10

  useEffect(() => {
    if (!isOrgScope || !f.effectiveYear || !scopeEntityId.trim()) {
      setOrgMembers([])
      setOrgMembersHint(null)
      setScopeEntityName('')
      return
    }
    if (!useOrgSubtree && f.minInvoiceCount == null) {
      setOrgMembers([])
      setOrgMembersHint(null)
      setScopeEntityName('')
      return
    }
    const ac = new AbortController()
    setOrgMembersLoading(true)
    void fetchAnalysisOrgScopeMembers(
      {
        statYear: f.effectiveYear,
        tree: orgTree,
        scopeEntityId: scopeEntityId.trim(),
        requireBuyer: useOrgSubtree ? undefined : requireBuyer,
        requireBothRoles: useOrgSubtree ? undefined : requireBothRoles,
        minInvoiceCount: useOrgSubtree ? undefined : minN,
        memberSource: useOrgSubtree ? 'org_subtree' : 'pool',
      },
      ac.signal,
    ).then((res) => {
      if (ac.signal.aborted || res.aborted) return
      setOrgMembersLoading(false)
      if (res.ok && res.members) {
        setOrgMembers(res.members)
        setOrgMembersHint(res.hint ?? null)
        setScopeEntityName(res.scope_entity_name ?? '')
      } else {
        setOrgMembers([])
        setOrgMembersHint(res.error?.message ?? null)
        setScopeEntityName('')
      }
    })
    return () => ac.abort()
  }, [
    isOrgScope,
    f.effectiveYear,
    scopeEntityId,
    orgTree,
    requireBuyer,
    requireBothRoles,
    minN,
    f.minInvoiceCount,
    useOrgSubtree,
  ])

  const scopedEntityOptions: DwsEntityOption[] = useMemo(() => {
    if (!isOrgScope) return f.entityOptions
    return orgMembers.map((m) => ({
      entity_id: m.entity_id,
      entity_name: m.entity_name,
      total_net_jshj: m.total_net_jshj,
    }))
  }, [isOrgScope, f.entityOptions, orgMembers])

  const activeOrgMembers = useMemo(() => {
    if (!excludedEntityIds.length) return orgMembers
    const excluded = new Set(excludedEntityIds)
    return orgMembers.filter((m) => !excluded.has(m.entity_id))
  }, [orgMembers, excludedEntityIds])

  useEffect(() => {
    if (!isOrgScope || !f.entityId.trim()) return
    if (!scopedEntityOptions.some((o) => o.entity_id === f.entityId)) {
      f.setEntityId('')
    }
  }, [isOrgScope, scopedEntityOptions, f.entityId, f.setEntityId])

  const scopeValid = !isOrgScope || Boolean(scopeEntityId.trim())
  const entityValid = isOrgScope
    ? scopeValid
    : !requireEntity || Boolean(f.entityId.trim())
  const filtersReady = isOrgScope ? scopeValid : entityValid

  return {
    ...f,
    setStatYear: setStatYearWithScopeReset,
    scopeMode,
    setScopeMode,
    scopeEntityId,
    setScopeEntityId,
    isOrgScope,
    orgTree,
    orgFlatNodes,
    orgTreeLoading,
    orgTreeHint,
    orgMembers,
    activeOrgMembers,
    orgMembersLoading,
    orgMembersHint,
    scopeEntityName,
    scopedEntityOptions,
    excludedEntityIds,
    setExcludedEntityIds,
    memberSource,
    scopeValid,
    entityValid,
    filtersReady,
  }
}
