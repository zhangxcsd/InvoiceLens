import type { AuditedEnterpriseRegistryRow, AuditedEnterpriseRelationTreeNode } from '../config/localApi'
import { parseFirstShareholder } from './auditedEnterpriseRegistryHelpers'

export type OwnershipRelationKind =
  | 'wholly_owned'
  | 'holding'
  | 'participating'
  | 'limited_partnership'
  | 'unlisted'
  | 'inactive'
  | 'default'

export type OwnershipRelationLabel = '全资' | '控股' | '参股' | '有限合伙' | '未列入一级' | '非在营' | ''

/** 由持股比例/企业类别/名称推断出资关系（参考 SOETree rel_to_invest_parent） */
export function deriveOwnershipRelation(reg?: AuditedEnterpriseRegistryRow): OwnershipRelationLabel {
  if (!reg) return ''
  const name = reg.name.trim()
  const category = reg.enterpriseCategory.trim()
  if (name.includes('有限合伙') || category.includes('有限合伙')) return '有限合伙'

  const { ratio } = parseFirstShareholder(reg.shareholders)
  const pct = parseShareRatioPercent(ratio)
  if (pct != null) {
    if (pct >= 99.995) return '全资'
    if (pct >= 50) return '控股'
    if (pct > 0) return '参股'
  }

  const cat = category.toLowerCase()
  if (cat.includes('全资')) return '全资'
  if (cat.includes('控股') || cat.includes('实际控制')) return '控股'
  if (cat.includes('参股')) return '参股'

  return ''
}

function parseShareRatioPercent(ratio: string): number | null {
  const raw = ratio.trim().replace(/%$/, '').replace(/,/g, '')
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n <= 1 && n > 0 ? n * 100 : n
}

export function ownershipRelationKind(label: OwnershipRelationLabel): OwnershipRelationKind {
  switch (label) {
    case '全资':
      return 'wholly_owned'
    case '控股':
      return 'holding'
    case '参股':
      return 'participating'
    case '有限合伙':
      return 'limited_partnership'
    case '未列入一级':
      return 'unlisted'
    case '非在营':
      return 'inactive'
    default:
      return 'default'
  }
}

export function treeNodeLabelClass(kind: OwnershipRelationKind, isHierDiff: boolean): string {
  if (isHierDiff) return 'text-danger font-medium'
  switch (kind) {
    case 'wholly_owned':
      return 'font-medium text-[#1b6b3a]'
    case 'holding':
      return 'font-medium text-[#b45309]'
    case 'participating':
      return 'font-medium text-text-3'
    case 'limited_partnership':
      return 'font-semibold text-[#7c3aed]'
    case 'unlisted':
      return 'font-medium text-accent'
    case 'inactive':
      return 'text-danger line-through'
    default:
      return 'font-medium text-text-2'
  }
}

export function formatTreeNodeDisplayLabel(
  node: AuditedEnterpriseRelationTreeNode,
  isManage: boolean,
): string {
  if (isVirtualTreeNode(node)) return node.name
  const reg = node.registry
  const baseName = reg?.name?.trim() || node.name.replace(/（[^）]*）$/, '').trim() || node.name
  const levelTag = isManage ? '管理' : '产权'
  const relation = deriveOwnershipRelation(reg)
  const suffix = relation ? ` · ${relation}` : ''
  return `${baseName}（${levelTag} ${node.level}级${suffix}）`
}

export function collectRegistryRows(nodes: AuditedEnterpriseRelationTreeNode[]): AuditedEnterpriseRegistryRow[] {
  const out: AuditedEnterpriseRegistryRow[] = []
  const walk = (list: AuditedEnterpriseRelationTreeNode[]) => {
    for (const node of list) {
      if (node.registry) out.push(node.registry)
      if (node.children?.length) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function collectExpandableIds(nodes: AuditedEnterpriseRelationTreeNode[]): string[] {
  const ids: string[] = []
  const walk = (list: AuditedEnterpriseRelationTreeNode[]) => {
    for (const n of list) {
      if (n.children?.length) {
        ids.push(n.id)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return ids
}

/** 默认展开到指定深度（SOETree：收起到 2 级 ≈ 展开 depth<=1） */
export function collectExpandedIdsUpToDepth(
  nodes: AuditedEnterpriseRelationTreeNode[],
  maxDepth: number,
): string[] {
  const ids: string[] = []
  const walk = (list: AuditedEnterpriseRelationTreeNode[], depth: number) => {
    for (const n of list) {
      if (n.children?.length && depth < maxDepth) {
        ids.push(n.id)
        walk(n.children, depth + 1)
      }
    }
  }
  walk(nodes, 0)
  return ids
}

export function nodeMatchesKeyword(
  node: AuditedEnterpriseRelationTreeNode,
  keyword: string,
): boolean {
  const k = keyword.trim().toLowerCase()
  if (!k) return true
  const reg = node.registry
  const name = (reg?.name || node.name).toLowerCase()
  const code = (reg?.code || '').toLowerCase()
  const id = node.id.toLowerCase()
  if (name.includes(k) || code.includes(k) || id.includes(k)) return true
  return (node.children ?? []).some((c) => nodeMatchesKeyword(c, k))
}

export function findFirstNodeMatchingKeyword(
  nodes: AuditedEnterpriseRelationTreeNode[],
  keyword: string,
): AuditedEnterpriseRelationTreeNode | null {
  const k = keyword.trim().toLowerCase()
  if (!k) return null
  const walk = (list: AuditedEnterpriseRelationTreeNode[]): AuditedEnterpriseRelationTreeNode | null => {
    for (const n of list) {
      const reg = n.registry
      const name = (reg?.name || n.name).toLowerCase()
      const code = (reg?.code || '').toLowerCase()
      if (name.includes(k) || code.includes(k)) return n
      const hit = walk(n.children ?? [])
      if (hit) return hit
    }
    return null
  }
  return walk(nodes)
}

export function collectAncestorIds(
  nodes: AuditedEnterpriseRelationTreeNode[],
  targetId: string,
): string[] {
  const ancestors: string[] = []
  const walk = (list: AuditedEnterpriseRelationTreeNode[], chain: string[]): boolean => {
    for (const n of list) {
      const nextChain = [...chain, n.id]
      if (n.id === targetId) {
        ancestors.push(...chain)
        return true
      }
      if (walk(n.children ?? [], nextChain)) return true
    }
    return false
  }
  walk(nodes, [])
  return ancestors
}

export function extractStateInvestorOptions(rows: AuditedEnterpriseRegistryRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    const v = row.stateInvestor.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/** 虚拟「未指定上级」分组节点（参考 SOETree virtual-unassigned） */
export function isVirtualTreeNode(node: AuditedEnterpriseRelationTreeNode): boolean {
  return node.id.startsWith('virtual-unassigned-')
}

function parseMgmtLevel(node: AuditedEnterpriseRelationTreeNode): number | null {
  const lv = node.registry?.mgmtLevel ?? node.level
  return lv > 0 ? lv : null
}

function cloneTreeNode(node: AuditedEnterpriseRelationTreeNode): AuditedEnterpriseRelationTreeNode {
  return { ...node, children: [] }
}

function flattenForest(roots: AuditedEnterpriseRelationTreeNode[]): AuditedEnterpriseRelationTreeNode[] {
  const seen = new Set<string>()
  const out: AuditedEnterpriseRelationTreeNode[] = []
  const walk = (n: AuditedEnterpriseRelationTreeNode) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    out.push(n)
    for (const c of n.children ?? []) walk(c)
  }
  for (const r of roots) walk(r)
  return out
}

function resolveMgmtGroupRoot(
  flat: AuditedEnterpriseRelationTreeNode[],
): AuditedEnterpriseRelationTreeNode | null {
  const l1 = flat.filter((n) => parseMgmtLevel(n) === 1)
  if (l1.length === 1) return l1[0]
  if (l1.length > 1) {
    return l1.sort((a, b) => (a.registry?.name ?? a.name).localeCompare(b.registry?.name ?? b.name, 'zh-CN'))[0]
  }
  return flat[0] ?? null
}

type UnassignedLabels = {
  prefix: string
  noLevel: string
  l2: string
  l3: string
  l4: string
  l5Plus: string
}

function buildMgmtTreeFromFlat(
  flat: AuditedEnterpriseRelationTreeNode[],
  rootOrig: AuditedEnterpriseRelationTreeNode,
  labels: UnassignedLabels,
): AuditedEnterpriseRelationTreeNode {
  const origById = new Map(flat.map((n) => [n.id, n]))
  const cloneById = new Map(flat.map((n) => [n.id, cloneTreeNode(n)]))
  const root = cloneById.get(rootOrig.id)
  if (!root) return rootOrig

  const unassignedNoLevel: AuditedEnterpriseRelationTreeNode[] = []
  const unassigned2: AuditedEnterpriseRelationTreeNode[] = []
  const unassigned3: AuditedEnterpriseRelationTreeNode[] = []
  const unassigned4: AuditedEnterpriseRelationTreeNode[] = []
  const unassigned5plus: AuditedEnterpriseRelationTreeNode[] = []

  const sorted = [...flat].sort(
    (a, b) => (parseMgmtLevel(a) ?? 99) - (parseMgmtLevel(b) ?? 99),
  )

  for (const orig of sorted) {
    if (orig.id === rootOrig.id) continue
    const levelNum = parseMgmtLevel(orig)
    const clone = cloneById.get(orig.id)
    if (!clone) continue
    const parentId = orig.parent_id
    const parentOrig = parentId ? origById.get(parentId) : null
    const parentClone = parentOrig ? cloneById.get(parentOrig.id) : null
    const parentLevelOk =
      parentOrig != null && parseMgmtLevel(parentOrig) === (levelNum != null ? levelNum - 1 : null)
    const parentOk = levelNum != null && levelNum >= 2 && parentClone && parentLevelOk

    if (parentOk) {
      parentClone.children.push(clone)
    } else if (levelNum == null) {
      unassignedNoLevel.push(clone)
    } else if (levelNum === 2) {
      unassigned2.push(clone)
    } else if (levelNum === 3) {
      unassigned3.push(clone)
    } else if (levelNum === 4) {
      unassigned4.push(clone)
    } else if (levelNum >= 5) {
      unassigned5plus.push(clone)
    } else {
      root.children.push(clone)
    }
  }

  const makeVirtual = (
    label: string,
    bucket: AuditedEnterpriseRelationTreeNode[],
    level: number | null,
  ) => {
    if (!bucket.length) return
    const id = `virtual-unassigned-${root.id}-${label.replace(/\s/g, '')}`
    const displayName = `${labels.prefix}（${label}）-${bucket.length}家`
    root.children.push({
      id,
      name: displayName,
      level: level ?? 0,
      parent_id: root.id,
      parent_name: root.registry?.name?.trim() || root.name,
      children: bucket,
    })
  }

  makeVirtual(labels.noLevel, unassignedNoLevel, null)
  makeVirtual(labels.l2, unassigned2, 2)
  makeVirtual(labels.l3, unassigned3, 3)
  makeVirtual(labels.l4, unassigned4, 4)
  makeVirtual(labels.l5Plus, unassigned5plus, 5)

  return root
}

/** 管理树：将无有效管理上级节点归入「未指定上级」虚拟分组（参考 SOETree buildMgmtTreeWithUnassigned） */
export function buildMgmtTreeWithUnassigned(
  rawRoots: AuditedEnterpriseRelationTreeNode[],
  labels: UnassignedLabels,
): AuditedEnterpriseRelationTreeNode[] {
  const flat = flattenForest(rawRoots)
  if (!flat.length) return []

  const byInvestor = new Map<string, AuditedEnterpriseRelationTreeNode[]>()
  for (const n of flat) {
    const key = n.registry?.stateInvestor?.trim() || '__NO_GROUP__'
    if (!byInvestor.has(key)) byInvestor.set(key, [])
    byInvestor.get(key)!.push(n)
  }

  const out: AuditedEnterpriseRelationTreeNode[] = []
  for (const nodes of byInvestor.values()) {
    const rootOrig = resolveMgmtGroupRoot(nodes)
    if (rootOrig) out.push(buildMgmtTreeFromFlat(nodes, rootOrig, labels))
  }

  return out.length ? out : rawRoots
}

export function formatRegistryHoverLines(
  reg: AuditedEnterpriseRegistryRow,
  labels: {
    code: string
    mgmtLevel: string
    mgmtParent: string
    equityLevel: string
    shareholders: string
    stateInvestor: string
    category: string
    mainBusiness: string
  },
): Array<{ label: string; value: string }> {
  const dash = '—'
  return [
    { label: labels.code, value: reg.code.trim() || dash },
    {
      label: labels.mgmtLevel,
      value: reg.mgmtLevel > 0 ? `${reg.mgmtLevel}级` : dash,
    },
    { label: labels.mgmtParent, value: reg.mgmtParent.trim() || dash },
    {
      label: labels.equityLevel,
      value: reg.equityLevel > 0 ? `${reg.equityLevel}级` : dash,
    },
    { label: labels.shareholders, value: reg.shareholders.trim() || dash },
    { label: labels.stateInvestor, value: reg.stateInvestor.trim() || dash },
    { label: labels.category, value: reg.enterpriseCategory.trim() || dash },
    { label: labels.mainBusiness, value: reg.mainBusiness.trim() || dash },
  ]
}

function isEmptyPath(path?: string): boolean {
  const v = (path ?? '').trim()
  return !v || v === '—'
}

/** 管产对照行 → 打开组织树时建议的 Tab；不一致默认产权树，若仅一侧有路径则打开缺失侧。 */
export function resolveOrgTreeModeFromRelationRow(row: {
  relation_type: string
  mgmt_path?: string
  equity_path?: string
}): 'management' | 'equity' | undefined {
  if (row.relation_type !== '不一致') return undefined
  const mgmtEmpty = isEmptyPath(row.mgmt_path)
  const equityEmpty = isEmptyPath(row.equity_path)
  if (mgmtEmpty && !equityEmpty) return 'management'
  if (equityEmpty && !mgmtEmpty) return 'equity'
  return 'equity'
}

/** 管产对照行 → 打开组织层级树的导航参数。 */
export function relationRowOrgTreeParams(
  row: {
    name: string
    snapshot_year: string
    state_investor_enterprise?: string
    relation_type: string
    mgmt_path?: string
    equity_path?: string
  },
  selectedStateInvestor: string,
  filterStateInvestorAll: string,
): {
  statYear?: string
  keyword?: string
  stateInvestor?: string
  treeMode?: 'management' | 'equity'
} {
  return {
    statYear: row.snapshot_year,
    keyword: row.name,
    stateInvestor:
      row.state_investor_enterprise?.trim() ||
      (selectedStateInvestor !== filterStateInvestorAll ? selectedStateInvestor : undefined),
    treeMode: resolveOrgTreeModeFromRelationRow(row),
  }
}

export type KeywordHighlightSegment = { text: string; match: boolean }

/** 树节点标签关键字高亮分段（大小写不敏感）。 */
export function highlightKeywordSegments(text: string, keyword: string): KeywordHighlightSegment[] {
  const k = keyword.trim()
  if (!k) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const kl = k.toLowerCase()
  const segments: KeywordHighlightSegment[] = []
  let start = 0
  let idx = lower.indexOf(kl)
  while (idx >= 0) {
    if (idx > start) segments.push({ text: text.slice(start, idx), match: false })
    segments.push({ text: text.slice(idx, idx + k.length), match: true })
    start = idx + k.length
    idx = lower.indexOf(kl, start)
  }
  if (start < text.length) segments.push({ text: text.slice(start), match: false })
  return segments.length ? segments : [{ text, match: false }]
}

/** 管产对照表格行唯一键（与列表 key 一致）。 */
export function relationListRowKey(row: { name: string; snapshot_year: string; code?: string }) {
  return `${row.name}-${row.snapshot_year}-${row.code ?? ''}`
}

/** 按展开状态收集当前可见树节点 id（深度优先）。 */
export function collectVisibleTreeNodeIds(
  nodes: AuditedEnterpriseRelationTreeNode[],
  expanded: Set<string>,
): string[] {
  const out: string[] = []
  const walk = (list: AuditedEnterpriseRelationTreeNode[]) => {
    for (const node of list) {
      out.push(node.id)
      const children = node.children ?? []
      if (children.length > 0 && expanded.has(node.id)) walk(children)
    }
  }
  walk(nodes)
  return out
}
