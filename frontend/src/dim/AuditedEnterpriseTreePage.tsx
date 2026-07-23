import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AuditedEnterpriseFilters } from '../components/AuditedEnterpriseFilters'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { SearchableCombobox, type SearchableComboboxOption } from '../components/SearchableCombobox'
import {
  fetchAuditedEnterpriseRelationTree,
  postAuditedEnterpriseRegistryBootstrapDemo,
  postAuditedEnterpriseRegistryHierarchyUpdate,
  postAuditedEnterpriseRegistryImportExcel,
  type AuditedEnterpriseRegistryRow,
  type AuditedEnterpriseRelationTreeNode,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import type { OrgHierTreeMode } from '../utils/navHelpers'
import { buildStatYearOptions, defaultPracticeStatYear } from '../utils/statYearOptions'
import { readNavQueryParams, writeNavQueryParams } from '../utils/navHelpers'
import { AuditedEnterpriseRelationViewPage } from './AuditedEnterpriseRelationViewPage'
import { OrgHierTreeTabs } from './OrgHierTreeTabs'
import type { OrgTreeSharedFilters } from './orgTreeSharedFilters'
import {
  parseFirstShareholder,
  registryRowsToRelationRows,
} from './auditedEnterpriseRegistryHelpers'
import {
  buildMgmtTreeWithUnassigned,
  collectAncestorIds,
  collectExpandedIdsUpToDepth,
  collectExpandableIds,
  collectRegistryRows,
  collectVisibleTreeNodeIds,
  deriveOwnershipRelation,
  extractStateInvestorOptions,
  findFirstNodeMatchingKeyword,
  formatTreeNodeDisplayLabel,
  highlightKeywordSegments,
  isVirtualTreeNode,
  nodeMatchesKeyword,
  ownershipRelationKind,
  treeNodeLabelClass,
} from './auditedEnterpriseTreeHelpers'

type TreeMode = OrgHierTreeMode

type TreeModeUiState = { expanded: string[]; activeNodeId: string }

const FILTER_DEBOUNCE_MS = 320

function parseTreeMode(raw: string | undefined): TreeMode {
  if (raw === 'equity') return 'equity'
  if (raw === 'relation') return 'relation'
  return 'management'
}

type FlatFilterRow = {
  id: string
  name: string
  level: number
  parentName: string
  snapshotYear: string
  path: string
  sortNo: number
  isHierDiff: boolean
  note: string
}

function exportStamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function normEnterpriseName(value: string): string {
  return value
    .trim()
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim()
    .toLowerCase()
}

function computeHierDiff(reg?: AuditedEnterpriseRegistryRow): { isDiff: boolean; note: string } {
  if (!reg) return { isDiff: false, note: '' }
  const mgmt = normEnterpriseName(reg.mgmtParent)
  const equity = normEnterpriseName(parseFirstShareholder(reg.shareholders).name)
  const isDiff = mgmt !== equity && Boolean(mgmt || equity)
  if (!isDiff) return { isDiff: false, note: '' }
  const eqParent = parseFirstShareholder(reg.shareholders).name || '—'
  return {
    isDiff: true,
    note: `管理上级：${reg.mgmtParent.trim() || '—'}；产权上级：${eqParent}`,
  }
}

function buildPathMap(
  nodes: AuditedEnterpriseRelationTreeNode[],
  isManage: boolean,
): Map<string, string> {
  const regs = collectRegistryRows(nodes)
  const relRows = registryRowsToRelationRows(regs)
  const map = new Map<string, string>()
  regs.forEach((reg, index) => {
    const id = reg.rowId || `${reg.code}-${reg.snapshotYear}`
    map.set(id, isManage ? relRows[index]?.mgmtPath ?? '' : relRows[index]?.equityPath ?? '')
  })
  return map
}

function flattenTree(
  nodes: AuditedEnterpriseRelationTreeNode[],
  pathMap: Map<string, string>,
): FlatFilterRow[] {
  const out: FlatFilterRow[] = []
  const walk = (list: AuditedEnterpriseRelationTreeNode[]) => {
    for (const node of list) {
      const reg = node.registry
      const { isDiff, note } = computeHierDiff(reg)
      out.push({
        id: node.id,
        name: node.name,
        level: node.level,
        parentName: node.parent_name || '—',
        snapshotYear: reg?.snapshotYear ?? '',
        path: pathMap.get(node.id) ?? '',
        sortNo: node.level,
        isHierDiff: isDiff,
        note: note || reg?.mainBusiness?.trim() || reg?.enterpriseCategory?.trim() || '—',
      })
      if (node.children?.length) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

function TreeLegend(props: { ui: TreeUi; showHierDiff: boolean }) {
  const { ui, showHierDiff } = props
  const items = [
    { cls: 'bg-[#1b6b3a]', label: ui.legendWhollyOwned },
    { cls: 'bg-[#b45309]', label: ui.legendHolding },
    { cls: 'bg-text-3', label: ui.legendParticipating },
    { cls: 'bg-accent', label: ui.legendUnlisted },
    { cls: 'bg-[#7c3aed]', label: ui.legendLimitedPartnership },
  ]
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-il-meta text-text-3">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${item.cls}`} />
          {item.label}
        </span>
      ))}
      {showHierDiff ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-danger">●</span>
          {ui.legendHierDiff}
        </span>
      ) : null}
    </div>
  )
}

function TreeBranch(props: {
  node: AuditedEnterpriseRelationTreeNode
  depth: number
  isManage: boolean
  keywordHighlight: string
  expanded: Set<string>
  activeId: string
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}) {
  const { node, depth, isManage, keywordHighlight, expanded, activeId, onToggle, onSelect } = props
  const isVirtual = isVirtualTreeNode(node)
  const hasChildren = (node.children?.length ?? 0) > 0
  const isOpen = expanded.has(node.id)
  const { isDiff } = computeHierDiff(node.registry)
  const relation = deriveOwnershipRelation(node.registry)
  const labelCls = isVirtual
    ? 'font-medium italic text-text-3'
    : treeNodeLabelClass(ownershipRelationKind(relation), isDiff)
  const displayLabel = formatTreeNodeDisplayLabel(node, isManage)
  const labelSegments = highlightKeywordSegments(displayLabel, keywordHighlight)
  const lastClickRef = useRef<{ id: string; time: number }>({ id: '', time: 0 })

  const handleSelect = () => {
    const now = Date.now()
    if (lastClickRef.current.id === node.id && now - lastClickRef.current.time < 320 && hasChildren) {
      onToggle(node.id)
    } else {
      onSelect(node.id)
    }
    lastClickRef.current = { id: node.id, time: now }
  }

  return (
    <div className={depth > 0 ? 'org-tree-branch' : ''}>
      <div
        className="org-tree-row flex items-center"
        style={{ paddingLeft: depth > 0 ? `${depth * 24}px` : undefined }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-3 hover:bg-[#eef2f7]"
            aria-label={isOpen ? '收起' : '展开'}
            onClick={() => onToggle(node.id)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="mr-1 inline-block w-5 shrink-0 text-center text-text-3">·</span>
        )}
        <button
          type="button"
          data-org-tree-node={node.id}
          className={[
            'flex min-w-0 flex-1 items-center gap-1 rounded-sm px-2 py-1.5 text-left text-[13px]',
            activeId === node.id ? 'bg-[#f0f7ff]' : 'hover:bg-[#f8fafc]',
          ].join(' ')}
          onClick={handleSelect}
        >
          {!isVirtual && isDiff ? <span className="text-danger" title="管产分离">●</span> : null}
          <span className={labelCls}>
            {labelSegments.map((seg, index) =>
              seg.match ? (
                <mark key={index} className="rounded-sm bg-[#fef08a] px-0.5 text-inherit">
                  {seg.text}
                </mark>
              ) : (
                <span key={index}>{seg.text}</span>
              ),
            )}
          </span>
        </button>
      </div>
      {hasChildren && isOpen ? (
        <div className="relative ml-3 border-l border-[#b1b3b8] pl-3">
          {node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              isManage={isManage}
              keywordHighlight={keywordHighlight}
              expanded={expanded}
              activeId={activeId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function findNodeById(nodes: AuditedEnterpriseRelationTreeNode[], id: string): AuditedEnterpriseRelationTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children?.length) {
      const hit = findNodeById(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

type TreeUi = typeof t.auditedEnterpriseManageTreeUi | typeof t.auditedEnterpriseEquityTreeUi

function DetailField(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="text-text-3">{props.label}：</span>
      {props.children}
    </div>
  )
}

function DetailPlaceholder() {
  return <span className="text-text-3">—</span>
}

function TreeSkeletonExample(props: {
  ui: TreeUi
  importUi: typeof t.auditedEnterpriseTreeImportUi
  message: string
  actions?: ReactNode
}) {
  const { ui, importUi, message, actions } = props
  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-center gap-2">
        <span className="rounded-sm border border-border-light bg-[#f5f7fa] px-2 py-0.5 text-il-meta text-text-3">
          {importUi.treePreviewBadge}
        </span>
      </div>
      <div className="mb-3 text-center text-il-page-desc text-text-3">{message}</div>
      {actions ? <div className="mb-4 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
      <div className="border-t border-dashed border-border-light pt-3 opacity-70">
        <div className="flex items-center">
          <span className="mr-1 inline-block w-5 shrink-0 text-center text-text-3">▾</span>
          <span className="rounded-sm px-2 py-1.5 text-il-page-desc text-text-3">{ui.treeSkeletonGroup}</span>
        </div>
        <div className="flex items-center" style={{ paddingLeft: '16px' }}>
          <span className="mr-1 inline-block w-5 shrink-0 text-center text-text-3">▾</span>
          <span className="rounded-sm px-2 py-1.5 text-il-page-desc text-text-3">{ui.treeSkeletonChild}</span>
        </div>
        <div className="flex items-center" style={{ paddingLeft: '32px' }}>
          <span className="mr-1 inline-block w-5 shrink-0 text-center text-text-3">·</span>
          <span className="flex min-w-0 items-center gap-1 rounded-sm px-2 py-1.5 text-il-page-desc text-text-3">
            <span className="text-danger">●</span>
            {ui.treeSkeletonChild}
          </span>
        </div>
      </div>
      <p className="mt-3 text-center text-il-meta text-text-3">{ui.treeEmptyLegend}</p>
    </div>
  )
}

function MockPreviewValue(props: { children: ReactNode }) {
  return <span className="text-text-3 italic">{props.children}</span>
}

function formatLevelLabel(level: number | undefined | null): string | null {
  if (level == null || level <= 0) return null
  return `${level}级`
}

function NodeDetailPanel(props: {
  ui: TreeUi
  orgTreeUi: typeof t.auditedEnterpriseOrgTreeUi
  importUi: typeof t.auditedEnterpriseTreeImportUi
  isManage: boolean
  activeNode: AuditedEnterpriseRelationTreeNode | null
  activePath?: string
  snapshotYear: string
  hasTreeData: boolean
  showMockPreview: boolean
  parentOptions: SearchableComboboxOption[]
  editParentName: string
  editShareRatio: string
  onEditParentName: (value: string) => void
  onEditShareRatio: (value: string) => void
  onSaveHierarchy: () => void
  hierarchySaveBusy: boolean
  hierarchySaveMsg: string
  hierarchySaveErr: string
  onViewInRelation?: () => void
}) {
  const {
    ui,
    orgTreeUi,
    importUi,
    isManage,
    activeNode,
    activePath,
    hasTreeData,
    showMockPreview,
    parentOptions,
    editParentName,
    editShareRatio,
    onEditParentName,
    onEditShareRatio,
    onSaveHierarchy,
    hierarchySaveBusy,
    hierarchySaveMsg,
    hierarchySaveErr,
    onViewInRelation,
  } = props
  const reg = activeNode?.registry
  const isVirtual = activeNode ? isVirtualTreeNode(activeNode) : false
  const { isDiff, note } = computeHierDiff(reg)
  const emptyHint = hasTreeData ? ui.nodeDetailEmptySelect : ui.nodeDetailEmptyNoData

  const shareRatio = (() => {
    if (isManage || !reg) return null
    const { ratio } = parseFirstShareholder(reg.shareholders)
    if (!ratio) return null
    return ratio.includes('%') ? ratio : `${ratio}%`
  })()

  const equityLevelText = (() => {
    if (!activeNode) return null
    return formatLevelLabel(reg?.equityLevel) ?? (!isManage ? formatLevelLabel(activeNode.level) : null)
  })()

  const equityParentText = (() => {
    if (!activeNode) return null
    if (!isManage) {
      const fromTree = activeNode.parent_name?.trim()
      if (fromTree) return fromTree
    }
    const fromReg = parseFirstShareholder(reg?.shareholders ?? '').name.trim()
    return fromReg || null
  })()

  const manageLevelText = (() => {
    if (!activeNode) return null
    return formatLevelLabel(reg?.mgmtLevel) ?? (isManage ? formatLevelLabel(activeNode.level) : null)
  })()

  const manageParentText = (() => {
    if (!activeNode) return null
    if (isManage) {
      const fromTree = activeNode.parent_name?.trim()
      if (fromTree) return fromTree
    }
    return reg?.mgmtParent?.trim() || null
  })()

  const stateInvestorText = reg?.stateInvestor?.trim() || null
  const categoryText = reg?.enterpriseCategory?.trim() || null
  const mainBusinessText = reg?.mainBusiness?.trim() || null

  const primaryLevelText = isManage ? manageLevelText : equityLevelText
  const primaryParentText = isManage ? manageParentText : equityParentText
  const crossLevelLabel = isManage ? orgTreeUi.hoverEquityLevel : orgTreeUi.hoverMgmtLevel
  const crossParentLabel = isManage ? orgTreeUi.hoverShareholders : orgTreeUi.hoverMgmtParent
  const crossLevelText = isManage ? equityLevelText : manageLevelText
  const crossParentText = isManage ? equityParentText : manageParentText

  return (
    <div>
      {showMockPreview ? (
        <div className="mb-2">
          <span className="rounded-sm border border-border-light bg-[#f5f7fa] px-2 py-0.5 text-il-meta text-text-3">
            {importUi.treePreviewBadge}
          </span>
        </div>
      ) : null}
      {!activeNode && !showMockPreview ? <p className="mb-2 text-il-meta text-text-3">{emptyHint}</p> : null}
      {!activeNode && showMockPreview ? (
        <p className="mb-2 text-il-meta text-text-3">{emptyHint}</p>
      ) : null}
      {activeNode && isVirtual ? (
        <p className="mb-2 text-il-meta text-text-3">{orgTreeUi.virtualNodeHint}</p>
      ) : null}
      <div className="space-y-3 text-il-page-desc text-text-2">
        <div>
          <div className="mb-1.5 text-il-label font-medium text-text-3">{ui.nodeDetailGroupOrg}</div>
          <div className="space-y-2">
            <DetailField label={ui.nodeNameLabel}>
              {activeNode ? (
                activeNode.name
              ) : showMockPreview ? (
                <MockPreviewValue>{ui.treeSkeletonChild}</MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
            <DetailField label={ui.nodeCodeLabel}>
              {reg?.code ? (
                <span className="font-mono text-[12px]">{reg.code}</span>
              ) : showMockPreview ? (
                <MockPreviewValue>
                  <span className="font-mono text-[12px]">{importUi.treeMockCode}</span>
                </MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
            <DetailField label={ui.nodeLevelLabel}>
              {primaryLevelText ??
                (showMockPreview ? <MockPreviewValue>{importUi.treeMockLevel}</MockPreviewValue> : <DetailPlaceholder />)}
            </DetailField>
            <DetailField label={ui.nodeParentLabel}>
              {primaryParentText ??
                (showMockPreview ? <MockPreviewValue>{importUi.treeMockParent}</MockPreviewValue> : <DetailPlaceholder />)}
            </DetailField>
            <DetailField label={crossLevelLabel}>
              {crossLevelText ??
                (showMockPreview ? <MockPreviewValue>{importUi.treeMockLevel}</MockPreviewValue> : <DetailPlaceholder />)}
            </DetailField>
            <DetailField label={crossParentLabel}>
              {crossParentText ??
                (showMockPreview ? <MockPreviewValue>{importUi.treeMockParent}</MockPreviewValue> : <DetailPlaceholder />)}
            </DetailField>
            <DetailField label={orgTreeUi.hoverStateInvestor}>
              {stateInvestorText ?? <DetailPlaceholder />}
            </DetailField>
            <DetailField label={orgTreeUi.hoverCategory}>
              {categoryText ?? <DetailPlaceholder />}
            </DetailField>
            <DetailField label={orgTreeUi.hoverMainBusiness}>
              {mainBusinessText ?? <DetailPlaceholder />}
            </DetailField>
            <DetailField label={ui.nodeSnapshotLabel}>
              {reg?.snapshotYear ? (
                reg.snapshotYear
              ) : showMockPreview ? (
                <MockPreviewValue>{importUi.treeMockSnapshotYear}</MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
            <DetailField label={ui.nodePathLabel}>
              {activePath ? (
                activePath
              ) : showMockPreview ? (
                <MockPreviewValue>{importUi.treeMockPath}</MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
            <DetailField label={ui.nodeSortLabel}>
              {activeNode ? (
                activeNode.level
              ) : showMockPreview ? (
                <MockPreviewValue>{importUi.treeMockSort}</MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-il-label font-medium text-text-3">{ui.nodeDetailGroupMark}</div>
          <div className="space-y-2">
            <DetailField label={ui.nodeHierDiffLabel}>
              {isDiff ? (
                <div className="space-y-1">
                  <span className="text-danger">{note || '未填写说明'}</span>
                  {onViewInRelation ? (
                    <button
                      type="button"
                      className="block text-il-meta text-accent hover:underline"
                      onClick={onViewInRelation}
                    >
                      {orgTreeUi.viewInRelationBtn}
                    </button>
                  ) : null}
                </div>
              ) : showMockPreview ? (
                <MockPreviewValue>
                  <span className="text-danger">{importUi.treeMockHierDiff}</span>
                </MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
            {!isManage ? (
              <DetailField label={ui.nodeShareRatioLabel}>
                {shareRatio ?? (showMockPreview ? <MockPreviewValue>{importUi.treeMockShareRatio}</MockPreviewValue> : <DetailPlaceholder />)}
              </DetailField>
            ) : null}
          </div>
        </div>
        {activeNode && !showMockPreview && !isVirtual ? (
          <div className="mt-4 border-t border-border-light pt-3">
            <div className="mb-2 text-il-label font-medium text-text-2">{importUi.hierarchyEditTitle}</div>
            <div className="space-y-2">
              <label className="block text-il-meta text-text-3">
                <div className="mb-1">{importUi.hierarchyEditParentLabel}</div>
                <SearchableCombobox
                  options={parentOptions}
                  value={editParentName}
                  onChange={onEditParentName}
                  placeholder={importUi.hierarchyEditParentPlaceholder}
                  allowEmpty
                  emptyLabel="（无上级 / 一级企业）"
                />
              </label>
              {!isManage ? (
                <label className="block text-il-meta text-text-3">
                  <div className="mb-1">{importUi.hierarchyEditShareRatioLabel}</div>
                  <input
                    type="text"
                    className="h-9 w-full rounded-sm border border-border bg-white px-2.5 text-il-page-desc text-text outline-none focus:border-accent"
                    value={editShareRatio}
                    onChange={(e) => onEditShareRatio(e.target.value)}
                    placeholder={importUi.hierarchyEditShareRatioPlaceholder}
                  />
                </label>
              ) : null}
              {hierarchySaveErr ? <p className="text-il-meta text-red-600">{hierarchySaveErr}</p> : null}
              {hierarchySaveMsg ? <p className="text-il-meta text-[#1b6b3a]">{hierarchySaveMsg}</p> : null}
              <button
                type="button"
                disabled={hierarchySaveBusy}
                className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
                onClick={onSaveHierarchy}
              >
                {hierarchySaveBusy ? importUi.hierarchyEditSaving : importUi.hierarchyEditSave}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AuditedEnterpriseTreePage(props: {
  initialMode?: TreeMode
  onNav?: (k: NavKey) => void
}) {
  const orgTreeUi = t.auditedEnterpriseOrgTreeUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const [viewMode, setViewModeState] = useState<TreeMode>(() =>
    parseTreeMode(urlQuery.tree_mode ?? props.initialMode),
  )
  const isManage = viewMode === 'management'
  const isRelation = viewMode === 'relation'
  const ui = isManage ? t.auditedEnterpriseManageTreeUi : t.auditedEnterpriseEquityTreeUi
  const importUi = t.auditedEnterpriseTreeImportUi

  const unassignedLabels = useMemo(
    () => ({
      prefix: orgTreeUi.unassignedGroupPrefix,
      noLevel: orgTreeUi.unassignedNoLevel,
      l2: orgTreeUi.unassignedL2,
      l3: orgTreeUi.unassignedL3,
      l4: orgTreeUi.unassignedL4,
      l5Plus: orgTreeUi.unassignedL5Plus,
    }),
    [orgTreeUi],
  )

  const [treeNodes, setTreeNodes] = useState<AuditedEnterpriseRelationTreeNode[]>([])
  const [statYears, setStatYears] = useState<string[]>([])
  const [selectedYear, setSelectedYear] = useState<string>(() =>
    urlQuery.stat_year?.trim() || defaultPracticeStatYear(buildStatYearOptions([])),
  )
  const [selectedStateInvestor, setSelectedStateInvestor] = useState<string>(
    () => urlQuery.state_investor?.trim() || ui.filterStateInvestorAll,
  )
  const [enterpriseKeyword, setEnterpriseKeyword] = useState(() => urlQuery.keyword ?? '')
  const [debouncedEnterpriseKeyword, setDebouncedEnterpriseKeyword] = useState(() => urlQuery.keyword ?? '')
  const relationUi = t.auditedEnterpriseRelationUi
  const [selectedRelationType, setSelectedRelationType] = useState<string>(() => {
    const raw = urlQuery.relation_type?.trim()
    if (raw === relationUi.filterRelationTypeMatch || raw === relationUi.filterRelationTypeMismatch) return raw
    return relationUi.filterRelationTypeAll
  })
  const [selectedMatchStatus, setSelectedMatchStatus] = useState<string>(() => {
    const raw = urlQuery.match_status?.trim()
    if (raw === relationUi.filterMatchStatusMapped || raw === relationUi.filterMatchStatusUnmapped) return raw
    return relationUi.filterMatchStatusAll
  })
  const [inAnalysisPoolOnly, setInAnalysisPoolOnly] = useState(() => urlQuery.in_analysis_pool?.trim() === '1')
  const [fullscreen, setFullscreen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [emptyHint, setEmptyHint] = useState('')
  const [activeNodeId, setActiveNodeId] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [exportError, setExportError] = useState('')
  const [exported, setExported] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [importErr, setImportErr] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [bootstrapBusy, setBootstrapBusy] = useState(false)
  const [hierarchySaveBusy, setHierarchySaveBusy] = useState(false)
  const [hierarchySaveMsg, setHierarchySaveMsg] = useState('')
  const [hierarchySaveErr, setHierarchySaveErr] = useState('')
  const [editParentName, setEditParentName] = useState('')
  const [editShareRatio, setEditShareRatio] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const treeScrollRef = useRef<HTMLDivElement | null>(null)
  const enterpriseInputRef = useRef<HTMLInputElement | null>(null)
  const treeUiByModeRef = useRef<Partial<Record<'management' | 'equity', TreeModeUiState>>>({})
  const skipDefaultExpandRef = useRef(false)
  const pendingFocusRef = useRef<{ keyword: string } | null>(
    urlQuery.keyword?.trim() ? { keyword: urlQuery.keyword.trim() } : null,
  )

  const setViewMode = useCallback(
    (mode: TreeMode) => {
      if (viewMode === 'management' || viewMode === 'equity') {
        treeUiByModeRef.current[viewMode] = {
          expanded: Array.from(expanded),
          activeNodeId,
        }
        skipDefaultExpandRef.current = mode === 'management' || mode === 'equity'
      } else {
        skipDefaultExpandRef.current = false
      }
      setViewModeState(mode)
      writeNavQueryParams({ tree_mode: mode })
    },
    [activeNodeId, expanded, viewMode],
  )

  useEffect(() => {
    if (props.initialMode) setViewModeState(props.initialMode)
  }, [props.initialMode])

  const syncFiltersFromUrl = useCallback(() => {
    const q = readNavQueryParams()
    if (q.stat_year?.trim()) setSelectedYear(q.stat_year.trim())
    if (q.state_investor?.trim()) setSelectedStateInvestor(q.state_investor.trim())
    if (q.keyword != null) {
      setEnterpriseKeyword(q.keyword)
      setDebouncedEnterpriseKeyword(q.keyword)
    }
    const rel = q.relation_type?.trim()
    if (rel === relationUi.filterRelationTypeMatch || rel === relationUi.filterRelationTypeMismatch) {
      setSelectedRelationType(rel)
    } else if (!rel) {
      setSelectedRelationType(relationUi.filterRelationTypeAll)
    }
    const ms = q.match_status?.trim()
    if (ms === relationUi.filterMatchStatusMapped || ms === relationUi.filterMatchStatusUnmapped) {
      setSelectedMatchStatus(ms)
    } else if (!ms) {
      setSelectedMatchStatus(relationUi.filterMatchStatusAll)
    }
    setInAnalysisPoolOnly(q.in_analysis_pool?.trim() === '1')
  }, [
    relationUi.filterMatchStatusAll,
    relationUi.filterMatchStatusMapped,
    relationUi.filterMatchStatusUnmapped,
    relationUi.filterRelationTypeAll,
    relationUi.filterRelationTypeMatch,
    relationUi.filterRelationTypeMismatch,
  ])

  useEffect(() => {
    syncFiltersFromUrl()
  }, [viewMode, syncFiltersFromUrl])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedEnterpriseKeyword(enterpriseKeyword), FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [enterpriseKeyword])

  useEffect(() => {
    if (isRelation) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        enterpriseInputRef.current?.focus()
        enterpriseInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isRelation])

  useEffect(() => {
    writeNavQueryParams({
      tree_mode: viewMode,
      stat_year: selectedYear === ui.filterYearAll ? undefined : selectedYear,
      state_investor: selectedStateInvestor === ui.filterStateInvestorAll ? undefined : selectedStateInvestor,
      keyword: debouncedEnterpriseKeyword.trim() || undefined,
      relation_type:
        viewMode === 'relation' && selectedRelationType !== relationUi.filterRelationTypeAll
          ? selectedRelationType
          : undefined,
      match_status:
        viewMode === 'relation' && selectedMatchStatus !== relationUi.filterMatchStatusAll
          ? selectedMatchStatus
          : undefined,
      in_analysis_pool: viewMode === 'relation' && inAnalysisPoolOnly ? '1' : undefined,
    })
  }, [
    debouncedEnterpriseKeyword,
    inAnalysisPoolOnly,
    relationUi.filterMatchStatusAll,
    relationUi.filterRelationTypeAll,
    selectedMatchStatus,
    selectedRelationType,
    selectedStateInvestor,
    selectedYear,
    ui.filterStateInvestorAll,
    ui.filterYearAll,
    viewMode,
  ])

  const effectiveYear = selectedYear === ui.filterYearAll ? undefined : selectedYear
  const pathMap = useMemo(() => buildPathMap(treeNodes, isManage), [treeNodes, isManage])
  const flatRows = useMemo(() => flattenTree(treeNodes, pathMap), [treeNodes, pathMap])

  const years = useMemo(() => buildStatYearOptions(statYears), [statYears])

  const stateInvestorOptions = useMemo(
    () => extractStateInvestorOptions(collectRegistryRows(treeNodes)),
    [treeNodes],
  )

  const filteredFlat = useMemo(
    () =>
      flatRows.filter((row) => {
        const yearMatched = selectedYear === ui.filterYearAll || row.snapshotYear === selectedYear
        const node = findNodeById(treeNodes, row.id)
        const stateInvestorMatched =
          selectedStateInvestor === ui.filterStateInvestorAll ||
          (node?.registry?.stateInvestor.trim() || '') === selectedStateInvestor
        const enterpriseMatched =
          debouncedEnterpriseKeyword.trim().length === 0 ||
          nodeMatchesKeyword(node ?? { id: row.id, name: row.name, level: row.level, parent_name: row.parentName, parent_id: null, children: [] }, debouncedEnterpriseKeyword)
        return yearMatched && stateInvestorMatched && enterpriseMatched
      }),
    [debouncedEnterpriseKeyword, flatRows, selectedStateInvestor, selectedYear, treeNodes, ui.filterStateInvestorAll, ui.filterYearAll],
  )

  const filteredIdSet = useMemo(() => new Set(filteredFlat.map((r) => r.id)), [filteredFlat])

  const visibleTree = useMemo(() => {
    if (filteredIdSet.size === flatRows.length) return treeNodes
    const filterNodes = (nodes: AuditedEnterpriseRelationTreeNode[]): AuditedEnterpriseRelationTreeNode[] =>
      nodes
        .map((n) => {
          const children = filterNodes(n.children ?? [])
          if (filteredIdSet.has(n.id) || children.length > 0) {
            return { ...n, children }
          }
          return null
        })
        .filter(Boolean) as AuditedEnterpriseRelationTreeNode[]
    return filterNodes(treeNodes)
  }, [filteredIdSet, flatRows.length, treeNodes])

  const canReset =
    selectedYear !== defaultPracticeStatYear(years) ||
    selectedStateInvestor !== ui.filterStateInvestorAll ||
    enterpriseKeyword.trim().length > 0 ||
    selectedRelationType !== relationUi.filterRelationTypeAll ||
    selectedMatchStatus !== relationUi.filterMatchStatusAll ||
    inAnalysisPoolOnly

  const resetFilters = useCallback(() => {
    if (!canReset) return
    setSelectedYear(defaultPracticeStatYear(years))
    setSelectedStateInvestor(ui.filterStateInvestorAll)
    setEnterpriseKeyword('')
    setDebouncedEnterpriseKeyword('')
    setSelectedRelationType(relationUi.filterRelationTypeAll)
    setSelectedMatchStatus(relationUi.filterMatchStatusAll)
    setInAnalysisPoolOnly(false)
  }, [
    canReset,
    relationUi.filterMatchStatusAll,
    relationUi.filterRelationTypeAll,
    ui.filterStateInvestorAll,
    years,
  ])

  const sharedFilters = useMemo((): OrgTreeSharedFilters => {
    return {
      selectedYear,
      selectedStateInvestor,
      enterpriseKeyword,
      debouncedEnterpriseKeyword,
      selectedRelationType,
      selectedMatchStatus,
      inAnalysisPoolOnly,
      onYearChange: setSelectedYear,
      onStateInvestorChange: setSelectedStateInvestor,
      onEnterpriseKeywordChange: setEnterpriseKeyword,
      onRelationTypeChange: setSelectedRelationType,
      onMatchStatusChange: setSelectedMatchStatus,
      onInAnalysisPoolOnlyChange: setInAnalysisPoolOnly,
      onReset: resetFilters,
      canReset,
    }
  }, [
    canReset,
    debouncedEnterpriseKeyword,
    enterpriseKeyword,
    inAnalysisPoolOnly,
    resetFilters,
    selectedMatchStatus,
    selectedRelationType,
    selectedStateInvestor,
    selectedYear,
  ])

  const orgTreeTabLabels = useMemo(
    () => ({
      manage: orgTreeUi.tabManageTree,
      equity: orgTreeUi.tabEquityTree,
      relation: orgTreeUi.tabRelationView,
    }),
    [orgTreeUi.tabEquityTree, orgTreeUi.tabManageTree, orgTreeUi.tabRelationView],
  )

  const loadTree = useCallback(async () => {
    if (isRelation) return
    setLoading(true)
    setLoadError('')
    const res = await fetchAuditedEnterpriseRelationTree({
      mode: isManage ? 'management' : 'equity',
      snapshotYear: effectiveYear,
    })
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.loadFailed)
      setTreeNodes([])
      setLoading(false)
      return
    }
    setStatYears(res.snapshot_years ?? [])
    const rawNodes = res.nodes ?? []
    const processed = isManage ? buildMgmtTreeWithUnassigned(rawNodes, unassignedLabels) : rawNodes
    setTreeNodes(processed)
    setEmptyHint(res.empty_hint ?? '')
    const mergedYears = buildStatYearOptions(res.snapshot_years ?? [])
    if (res.selected_year) {
      setSelectedYear((prev) =>
        prev === ui.filterYearAll || !mergedYears.includes(prev)
          ? defaultPracticeStatYear(mergedYears, res.selected_year)
          : prev,
      )
    }
    const modeKey = isManage ? 'management' : 'equity'
    if (pendingFocusRef.current?.keyword) {
      const kw = pendingFocusRef.current.keyword
      pendingFocusRef.current = null
      const hit = findFirstNodeMatchingKeyword(processed, kw)
      if (hit) {
        setActiveNodeId(hit.id)
        setExpanded(new Set(collectAncestorIds(processed, hit.id)))
      } else {
        setActiveNodeId('')
        setExpanded(new Set(collectExpandedIdsUpToDepth(processed, 2)))
      }
    } else if (skipDefaultExpandRef.current && treeUiByModeRef.current[modeKey]) {
      skipDefaultExpandRef.current = false
      const saved = treeUiByModeRef.current[modeKey]!
      const validExpanded = saved.expanded.filter((id) => !!findNodeById(processed, id))
      setExpanded(new Set(validExpanded))
      const validActive =
        saved.activeNodeId && findNodeById(processed, saved.activeNodeId) ? saved.activeNodeId : ''
      setActiveNodeId(validActive)
    } else {
      setExpanded(new Set(collectExpandedIdsUpToDepth(processed, 2)))
    }
    setLoading(false)
  }, [effectiveYear, isManage, isRelation, ui.loadFailed, unassignedLabels])

  useEffect(() => {
    if (!debouncedEnterpriseKeyword.trim()) return
    setExpanded(new Set(collectExpandableIds(visibleTree)))
  }, [debouncedEnterpriseKeyword, visibleTree])

  useEffect(() => {
    if (isRelation) {
      setLoading(false)
      return
    }
    void loadTree()
  }, [isRelation, loadTree])

  useEffect(() => {
    if (treeNodes.length === 0) {
      setActiveNodeId('')
      return
    }
    setActiveNodeId((prev) => {
      if (prev && findNodeById(treeNodes, prev)) return prev
      return ''
    })
  }, [treeNodes, pathMap])

  useEffect(() => {
    if (!activeNodeId) return
    if (filteredIdSet.has(activeNodeId)) return
    setActiveNodeId('')
  }, [activeNodeId, filteredIdSet])

  const activeNode = useMemo(
    () => (activeNodeId ? findNodeById(treeNodes, activeNodeId) : null),
    [activeNodeId, treeNodes],
  )

  const parentOptions = useMemo((): SearchableComboboxOption[] => {
    const regs = collectRegistryRows(treeNodes)
    const sy = activeNode?.registry?.snapshotYear
    const seen = new Set<string>()
    const opts: SearchableComboboxOption[] = []
    for (const reg of regs) {
      if (sy && reg.snapshotYear !== sy) continue
      const name = reg.name.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      opts.push({ value: name, label: name, searchText: `${name} ${reg.code}` })
    }
    opts.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
    return opts
  }, [activeNode?.registry?.snapshotYear, treeNodes])

  useEffect(() => {
    setHierarchySaveMsg('')
    setHierarchySaveErr('')
    if (!activeNode?.registry) {
      setEditParentName('')
      setEditShareRatio('')
      return
    }
    const reg = activeNode.registry
    if (isManage) {
      setEditParentName(reg.mgmtParent.trim())
    } else {
      const { name, ratio } = parseFirstShareholder(reg.shareholders)
      setEditParentName(name)
      setEditShareRatio(ratio.replace(/%$/, '').trim())
    }
  }, [activeNode, isManage])

  const saveHierarchy = useCallback(async () => {
    const rowId = activeNode?.registry?.rowId
    if (!rowId || (activeNode && isVirtualTreeNode(activeNode))) {
      setHierarchySaveErr(importUi.hierarchyEditNeedNode)
      return
    }
    setHierarchySaveBusy(true)
    setHierarchySaveErr('')
    setHierarchySaveMsg('')
    const res = await postAuditedEnterpriseRegistryHierarchyUpdate({
      rowId,
      mode: isManage ? 'management' : 'equity',
      parentName: editParentName.trim(),
      shareRatio: isManage ? undefined : editShareRatio.trim() || undefined,
    })
    setHierarchySaveBusy(false)
    if (!res.ok) {
      setHierarchySaveErr(res.error?.message ?? importUi.hierarchyEditFailed)
      return
    }
    setHierarchySaveMsg(importUi.hierarchyEditSuccess)
    void loadTree()
  }, [activeNode, editParentName, editShareRatio, importUi, isManage, loadTree])

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = () => setExpanded(new Set(collectExpandableIds(visibleTree)))
  const collapseToLevel2 = () => setExpanded(new Set(collectExpandedIdsUpToDepth(visibleTree, 2)))

  const exportCurrent = useCallback(async () => {
    if (filteredFlat.length === 0) return
    try {
      setExportError('')
      const XLSX = await import('xlsx')
      const header = [ui.nodeNameLabel, ui.nodeLevelLabel, ui.nodeParentLabel, ui.nodeSnapshotLabel, ui.nodeNoteLabel]
      const body = filteredFlat.map((n) => [n.name, n.level, n.parentName, n.snapshotYear, n.note])
      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '节点')
      XLSX.writeFile(wb, `${ui.exportFileNamePrefix}_${exportStamp()}.xlsx`)
      setExported(true)
      window.setTimeout(() => setExported(false), 2000)
    } catch {
      setExportError(ui.exportFailed)
    }
  }, [filteredFlat, ui])

  const runImport = async (file: File) => {
    setImportBusy(true)
    setImportErr('')
    setImportMsg('')
    const res = await postAuditedEnterpriseRegistryImportExcel(file)
    setImportBusy(false)
    if (!res.ok) {
      setImportErr(
        (res.file_blocking ? importUi.importFileBlocking : importUi.importFailed) +
          (res.error?.message ? `：${res.error.message}` : ''),
      )
      return
    }
    setImportMsg(
      importUi.importSuccess
        .replace('{imported}', String(res.imported ?? 0))
        .replace('{rejected}', String(res.rejected ?? 0)),
    )
    if ((res.rejected ?? 0) > 0 && res.reject_row_samples?.length) {
      const sample = res.reject_row_samples[0]
      setImportMsg(
        (prev) =>
          `${prev} ${importUi.importRejectSample.replace('{seq}', String(sample.seq_no ?? '')).replace('{reason}', String(sample.reason ?? ''))}`,
      )
    }
    void loadTree()
  }

  const runBootstrapDemo = async () => {
    setBootstrapBusy(true)
    setImportErr('')
    setImportMsg('')
    const res = await postAuditedEnterpriseRegistryBootstrapDemo()
    setBootstrapBusy(false)
    if (!res.ok) {
      setImportErr(res.error?.message || importUi.bootstrapDemoFail)
      return
    }
    setImportMsg(importUi.bootstrapDemoOk)
    void loadTree()
  }

  const hasTreeData = flatRows.length > 0
  const showStructurePreview = !loading && !hasTreeData
  const noTreeData = showStructurePreview && !loadError
  const emptyMessage = loading
    ? '…'
    : loadError ||
      emptyHint ||
      (flatRows.length === 0 ? (noTreeData ? importUi.emptyStateHint : ui.loadEmptyHint) : ui.filterEmpty)
  const snapshotYear = effectiveYear || years[0] || ''

  const openOrgTreeFromRelation = useCallback(
    (params: {
      statYear?: string
      keyword?: string
      stateInvestor?: string
      treeMode?: 'management' | 'equity'
    }) => {
      if (params.statYear) setSelectedYear(params.statYear)
      if (params.stateInvestor?.trim()) setSelectedStateInvestor(params.stateInvestor.trim())
      if (params.keyword != null) {
        setEnterpriseKeyword(params.keyword)
        setDebouncedEnterpriseKeyword(params.keyword)
        if (params.keyword.trim()) {
          pendingFocusRef.current = { keyword: params.keyword.trim() }
        }
      }
      setViewMode(params.treeMode ?? 'management')
    },
    [setViewMode],
  )

  useEffect(() => {
    if (!activeNodeId || isRelation) return
    const el = treeScrollRef.current?.querySelector(`[data-org-tree-node="${CSS.escape(activeNodeId)}"]`)
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeNodeId, isRelation, visibleTree])

  const openRelationFromNode = useCallback(() => {
    const reg = activeNode?.registry
    if (!reg || (activeNode && isVirtualTreeNode(activeNode))) return
    if (reg.snapshotYear) setSelectedYear(reg.snapshotYear)
    if (reg.stateInvestor?.trim()) setSelectedStateInvestor(reg.stateInvestor.trim())
    const name = reg.name.trim() || activeNode?.name.trim() || ''
    if (name) {
      setEnterpriseKeyword(name)
      setDebouncedEnterpriseKeyword(name)
    }
    const { isDiff } = computeHierDiff(reg)
    if (isDiff) {
      setSelectedRelationType(relationUi.filterRelationTypeMismatch)
      setSelectedMatchStatus(relationUi.filterMatchStatusAll)
      setInAnalysisPoolOnly(false)
    }
    setViewMode('relation')
  }, [activeNode, relationUi.filterMatchStatusAll, relationUi.filterRelationTypeMismatch, setViewMode])

  const visibleNodeIds = useMemo(
    () => collectVisibleTreeNodeIds(visibleTree, expanded),
    [expanded, visibleTree],
  )

  const findParentNodeId = useCallback(
    (nodeId: string): string | null => {
      const walk = (nodes: AuditedEnterpriseRelationTreeNode[], parentId: string | null): string | null => {
        for (const node of nodes) {
          if (node.id === nodeId) return parentId
          if (node.children?.length) {
            const hit = walk(node.children, node.id)
            if (hit != null) return hit
          }
        }
        return null
      }
      return walk(visibleTree, null)
    },
    [visibleTree],
  )

  const handleTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isRelation || visibleNodeIds.length === 0) return
      const { key } = event
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(key)) return
      event.preventDefault()
      if (key === 'Enter') {
        const node = activeNodeId ? findNodeById(visibleTree, activeNodeId) : null
        if (node && !isVirtualTreeNode(node) && node.registry) openRelationFromNode()
        return
      }
      const currentIdx = activeNodeId ? visibleNodeIds.indexOf(activeNodeId) : -1
      if (key === 'Home') {
        setActiveNodeId(visibleNodeIds[0] ?? '')
        return
      }
      if (key === 'End') {
        setActiveNodeId(visibleNodeIds[visibleNodeIds.length - 1] ?? '')
        return
      }
      if (key === 'ArrowDown') {
        const next = visibleNodeIds[Math.min(currentIdx + 1, visibleNodeIds.length - 1)] ?? visibleNodeIds[0]
        if (next) setActiveNodeId(next)
        return
      }
      if (key === 'ArrowUp') {
        const prev =
          currentIdx <= 0
            ? visibleNodeIds[0]
            : visibleNodeIds[Math.max(currentIdx - 1, 0)]
        if (prev) setActiveNodeId(prev)
        return
      }
      if (!activeNodeId) return
      const node = findNodeById(visibleTree, activeNodeId)
      if (!node) return
      const hasChildren = (node.children?.length ?? 0) > 0
      if (key === 'ArrowRight') {
        if (hasChildren && !expanded.has(activeNodeId)) toggleExpand(activeNodeId)
        return
      }
      if (key === 'ArrowLeft') {
        if (hasChildren && expanded.has(activeNodeId)) {
          toggleExpand(activeNodeId)
          return
        }
        const parentId = findParentNodeId(activeNodeId)
        if (parentId) setActiveNodeId(parentId)
      }
    },
    [activeNodeId, expanded, findParentNodeId, isRelation, openRelationFromNode, toggleExpand, visibleNodeIds, visibleTree],
  )

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={orgTreeUi.pageTitle}
        description={orgTreeUi.pageDesc}
        note={orgTreeUi.pageNote}
        noteTone="plain"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isRelation ? (
              <button
                type="button"
                className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid"
                onClick={() => {
                  setImportErr('')
                  setImportMsg('')
                  setShowImportModal(true)
                }}
              >
                {importUi.toolbarImportBtn}
              </button>
            ) : null}
            {props.onNav ? (
              <>
                <button
                  type="button"
                  className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f8fafc]"
                  onClick={() => props.onNav?.('dim_audited_registry')}
                >
                  {orgTreeUi.goToLedgerLink}
                </button>
                {!isRelation ? (
                  <button
                    type="button"
                    className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f8fafc]"
                    onClick={() => setViewMode('relation')}
                  >
                    {orgTreeUi.goToRelationViewLink}
                  </button>
                ) : null}
              </>
            ) : null}
            {!isRelation && exported ? <span className="text-il-meta text-[#1b6b3a]">{ui.exportSuccess}</span> : null}
            {!isRelation ? (
              <>
                <button
                  type="button"
                  className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
                  onClick={expandAll}
                >
                  {ui.expandAll}
                </button>
                <button
                  type="button"
                  className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
                  onClick={collapseToLevel2}
                >
                  {ui.collapseToLevel2}
                </button>
                <button
                  type="button"
                  className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
                  onClick={() => setFullscreen((v) => !v)}
                >
                  {fullscreen ? ui.exitFullscreen : ui.fullscreen}
                </button>
                <button
                  type="button"
                  className={[
                    'rounded-sm border px-3 py-1.5 text-il-meta transition-colors',
                    filteredFlat.length > 0
                      ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                      : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
                  ].join(' ')}
                  disabled={filteredFlat.length === 0}
                  onClick={() => void exportCurrent()}
                >
                  {ui.exportCurrentNodes}
                </button>
              </>
            ) : null}
          </div>
        }
      />

      {!isRelation && !showImportModal && (importMsg || importErr) ? (
        <div className="-mt-2 mb-3">
          {importMsg ? <p className="text-il-meta text-[#1b6b3a]">{importMsg}</p> : null}
          {importErr ? <p className="text-il-meta text-red-600">{importErr}</p> : null}
        </div>
      ) : null}

      {!isRelation && loadError ? <p className="mb-3 text-il-meta text-red-600">{loadError}</p> : null}

      {isRelation ? (
        <>
          <OrgHierTreeTabs mode={viewMode} onModeChange={setViewMode} labels={orgTreeTabLabels} className="mb-3" />
          <AuditedEnterpriseRelationViewPage
            embedded
            sharedFilters={sharedFilters}
            onNav={props.onNav}
            onOpenOrgTree={openOrgTreeFromRelation}
          />
        </>
      ) : (
      <Card title={ui.treeCardTitle}>
        <OrgHierTreeTabs mode={viewMode} onModeChange={setViewMode} labels={orgTreeTabLabels} className="mb-3" />
        <AuditedEnterpriseFilters
          yearLabel={ui.filterYearLabel}
          yearAllLabel={ui.filterYearAll}
          years={statYears}
          selectedYear={selectedYear}
          onYearChange={setSelectedYear}
          stateInvestorLabel={ui.filterStateInvestorLabel}
          stateInvestorAllLabel={ui.filterStateInvestorAll}
          stateInvestorOptions={stateInvestorOptions}
          selectedStateInvestor={selectedStateInvestor}
          onStateInvestorChange={setSelectedStateInvestor}
          enterpriseLabel={ui.filterEnterpriseLabel}
          enterprisePlaceholder={ui.filterEnterprisePlaceholder}
          resetLabel={ui.filterReset}
          canReset={canReset}
          onReset={resetFilters}
          enterpriseKeyword={enterpriseKeyword}
          onEnterpriseKeywordChange={setEnterpriseKeyword}
          enterpriseInputRef={enterpriseInputRef}
        />
        <TreeLegend ui={ui} showHierDiff />
        <p className="-mt-2 mb-4 text-il-meta text-text-3">{orgTreeUi.treeKeyboardHint}</p>
        <div className="-mt-1 mb-4 border-b border-border-light pb-3 text-il-meta text-text-3">
          <span className="text-text-3">{ui.nodeCountLabel}</span>
          <span className="ml-1 font-semibold tabular-nums text-text">{filteredFlat.length}</span>
        </div>
        {exportError ? <div className="mb-2 text-il-meta text-[#c2410c]">{exportError}</div> : null}
        <div
          className={[
            // 双栏等高锁视口：左侧树内滚动，右侧详情始终可见（不依赖 sticky，避免祖先 overflow 失效）
            'grid gap-3 lg:grid-cols-[1fr_340px]',
            fullscreen
              ? 'fixed inset-0 z-50 grid-cols-1 bg-white p-4 lg:grid-cols-[1fr_340px]'
              : 'h-[min(760px,calc(100vh-11rem))] min-h-[320px]',
          ].join(' ')}
        >
          <div
            ref={treeScrollRef}
            tabIndex={0}
            role="tree"
            data-testid="org-hier-tree-panel"
            aria-label={isManage ? orgTreeUi.tabManageTree : orgTreeUi.tabEquityTree}
            onKeyDown={handleTreeKeyDown}
            className={[
              'min-h-0 overflow-auto rounded-sm border border-border-light bg-white px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
              fullscreen ? 'h-[calc(100vh-8rem)]' : 'h-full',
            ].join(' ')}
          >
            {visibleTree.length === 0 ? (
              showStructurePreview ? (
                <TreeSkeletonExample
                  ui={ui}
                  importUi={importUi}
                  message={emptyMessage}
                  actions={
                    noTreeData ? (
                      <>
                        <button
                          type="button"
                          className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid"
                          onClick={() => {
                            setImportErr('')
                            setImportMsg('')
                            setShowImportModal(true)
                          }}
                        >
                          {importUi.toolbarImportBtn}
                        </button>
                        <button
                          type="button"
                          disabled={bootstrapBusy || importBusy}
                          className="rounded-sm border border-accent/40 bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f0f7ff] disabled:opacity-60"
                          onClick={() => void runBootstrapDemo()}
                        >
                          {bootstrapBusy ? '…' : importUi.bootstrapDemoButton}
                        </button>
                      </>
                    ) : undefined
                  }
                />
              ) : (
                <div className="rounded-sm border border-dashed border-border-light bg-[#fafbfd] px-3 py-4 text-center text-il-page-desc text-text-3">
                  {emptyMessage}
                </div>
              )
            ) : (
              visibleTree.map((node) => (
                <TreeBranch
                  key={node.id}
                  node={node}
                  depth={0}
                  isManage={isManage}
                  keywordHighlight={debouncedEnterpriseKeyword}
                  expanded={expanded}
                  activeId={activeNodeId}
                  onToggle={toggleExpand}
                  onSelect={setActiveNodeId}
                />
              ))
            )}
          </div>
          <aside
            data-testid="org-hier-node-detail"
            className={[
              'min-h-0 overflow-auto rounded-sm border border-border-light bg-[#fafbfd] px-3 py-3',
              fullscreen ? 'max-h-[calc(100vh-8rem)]' : 'h-full',
            ].join(' ')}
          >
            <div className="mb-2 text-il-label font-medium text-text-2">{ui.nodeDetailTitle}</div>
            <NodeDetailPanel
              ui={ui}
              orgTreeUi={orgTreeUi}
              importUi={importUi}
              isManage={isManage}
              activeNode={activeNode}
              activePath={activeNodeId ? pathMap.get(activeNodeId) : undefined}
              snapshotYear={snapshotYear}
              hasTreeData={hasTreeData}
              showMockPreview={showStructurePreview && !activeNode}
              parentOptions={parentOptions}
              editParentName={editParentName}
              editShareRatio={editShareRatio}
              onEditParentName={setEditParentName}
              onEditShareRatio={setEditShareRatio}
              onSaveHierarchy={() => void saveHierarchy()}
              hierarchySaveBusy={hierarchySaveBusy}
              hierarchySaveMsg={hierarchySaveMsg}
              hierarchySaveErr={hierarchySaveErr}
              onViewInRelation={!isRelation ? openRelationFromNode : undefined}
            />
          </aside>
        </div>
      </Card>
      )}

      {showImportModal && !isRelation ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowImportModal(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="org-hier-import-modal-title"
            className="w-full max-w-[560px] rounded-[12px] border border-border-light bg-white p-4 shadow-xl"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 id="org-hier-import-modal-title" className="text-[16px] font-semibold text-text">
                {importUi.importModalTitle}
              </h3>
              <button
                type="button"
                className="text-il-page-desc text-text-3 hover:text-text"
                onClick={() => setShowImportModal(false)}
              >
                {importUi.modalClose}
              </button>
            </div>

            {noTreeData ? (
              <div className="mb-3 rounded-sm border border-border-light bg-[#f8fbff] px-3 py-2.5">
                <div className="mb-1.5 text-il-label font-medium text-text-2">{importUi.importChecklistTitle}</div>
                <ol className="list-inside list-decimal space-y-0.5 text-il-meta text-text-2">
                  <li>{importUi.importChecklistLedger}</li>
                  <li>{importUi.importChecklistImport}</li>
                  <li>{importUi.importChecklistDemo}</li>
                </ol>
              </div>
            ) : null}

            <div className="rounded-sm border border-dashed border-[#9fc5f5] bg-[#f8fbff] px-4 py-6 text-center">
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void runImport(f)
                  e.target.value = ''
                }}
              />
              <div className="text-il-page-desc font-medium text-text">{importUi.importDropTitle}</div>
              <div className="mt-1 text-il-meta text-text-3">{importUi.importDropHint}</div>
              <button
                type="button"
                disabled={importBusy}
                className="mt-3 rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
                onClick={() => fileRef.current?.click()}
              >
                {importBusy ? importUi.importing : importUi.importButton}
              </button>
              {noTreeData ? (
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={bootstrapBusy || importBusy}
                    className="rounded-sm border border-accent/40 bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f0f7ff] disabled:opacity-60"
                    onClick={() => void runBootstrapDemo()}
                  >
                    {bootstrapBusy ? '…' : importUi.bootstrapDemoButton}
                  </button>
                </div>
              ) : null}
              {importMsg ? <p className="mt-3 text-il-meta text-[#1b6b3a]">{importMsg}</p> : null}
              {importErr ? <p className="mt-3 text-il-meta text-red-600">{importErr}</p> : null}
            </div>

            <p className="mt-3 text-il-meta text-text-3">{importUi.hint}</p>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {props.onNav ? (
                <button
                  type="button"
                  className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f8fafc]"
                  onClick={() => {
                    setShowImportModal(false)
                    props.onNav?.('dim_audited_registry')
                  }}
                >
                  {orgTreeUi.goToLedgerLink}
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text-2 hover:bg-[#f8fafc]"
                onClick={() => setShowImportModal(false)}
              >
                {importUi.modalCancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
