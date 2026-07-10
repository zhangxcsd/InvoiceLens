import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { buildStatYearOptions } from '../utils/statYearOptions'
import {
  parseFirstShareholder,
  registryRowsToRelationRows,
} from './auditedEnterpriseRegistryHelpers'

type TreeMode = 'management' | 'equity'

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

function collectRegistryRows(nodes: AuditedEnterpriseRelationTreeNode[]): AuditedEnterpriseRegistryRow[] {
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

function collectExpandableIds(nodes: AuditedEnterpriseRelationTreeNode[]): string[] {
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

function TreeBranch(props: {
  node: AuditedEnterpriseRelationTreeNode
  depth: number
  expanded: Set<string>
  activeId: string
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}) {
  const { node, depth, expanded, activeId, onToggle, onSelect } = props
  const hasChildren = (node.children?.length ?? 0) > 0
  const isOpen = expanded.has(node.id)
  const isHierDiff = computeHierDiff(node.registry).isDiff

  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
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
          className={[
            'flex min-w-0 flex-1 items-center gap-1 rounded-sm px-2 py-1.5 text-left text-il-page-desc',
            activeId === node.id ? 'bg-[#f0f7ff] text-accent' : 'text-text-2 hover:bg-[#f8fafc]',
          ].join(' ')}
          onClick={() => onSelect(node.id)}
        >
          {isHierDiff ? <span className="text-danger" title="管产分离">●</span> : null}
          {node.name}
        </button>
      </div>
      {hasChildren && isOpen
        ? node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeId={activeId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
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

type TreeUi = typeof t.auditedEnterpriseManageTreeUi

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

function TreeSkeletonExample(props: { ui: TreeUi; importUi: typeof t.auditedEnterpriseTreeImportUi; message: string }) {
  const { ui, importUi, message } = props
  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-center gap-2">
        <span className="rounded-sm border border-border-light bg-[#f5f7fa] px-2 py-0.5 text-il-meta text-text-3">
          {importUi.treePreviewBadge}
        </span>
      </div>
      <div className="mb-3 text-center text-il-page-desc text-text-3">{message}</div>
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

function NodeDetailPanel(props: {
  ui: TreeUi
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
}) {
  const {
    ui,
    importUi,
    isManage,
    activeNode,
    activePath,
    snapshotYear,
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
  } = props
  const reg = activeNode?.registry
  const { isDiff, note } = computeHierDiff(reg)
  const emptyHint = hasTreeData ? ui.nodeDetailEmptySelect : ui.nodeDetailEmptyNoData

  const shareRatio = (() => {
    if (isManage || !reg) return null
    const { ratio } = parseFirstShareholder(reg.shareholders)
    if (!ratio) return null
    return ratio.includes('%') ? ratio : `${ratio}%`
  })()

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
            <DetailField label={ui.nodeLevelLabel}>
              {activeNode ? (
                activeNode.level
              ) : showMockPreview ? (
                <MockPreviewValue>{importUi.treeMockLevel}</MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
            </DetailField>
            <DetailField label={ui.nodeParentLabel}>
              {activeNode?.parent_name ? (
                activeNode.parent_name
              ) : showMockPreview ? (
                <MockPreviewValue>{importUi.treeMockParent}</MockPreviewValue>
              ) : (
                <DetailPlaceholder />
              )}
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
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-il-label font-medium text-text-3">{ui.nodeDetailGroupMark}</div>
          <div className="space-y-2">
            <DetailField label={ui.nodeHierDiffLabel}>
              {isDiff ? (
                <span className="text-danger">{note || '未填写说明'}</span>
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
        {activeNode && !showMockPreview ? (
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

export function AuditedEnterpriseTreePage(props: { mode: TreeMode; onNav?: (k: NavKey) => void }) {
  const isManage = props.mode === 'management'
  const ui = isManage ? t.auditedEnterpriseManageTreeUi : t.auditedEnterpriseEquityTreeUi
  const importUi = t.auditedEnterpriseTreeImportUi

  const [treeNodes, setTreeNodes] = useState<AuditedEnterpriseRelationTreeNode[]>([])
  const [statYears, setStatYears] = useState<string[]>([])
  const [selectedYear, setSelectedYear] = useState<string>(ui.filterYearAll)
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')
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
  const [bootstrapBusy, setBootstrapBusy] = useState(false)
  const [hierarchySaveBusy, setHierarchySaveBusy] = useState(false)
  const [hierarchySaveMsg, setHierarchySaveMsg] = useState('')
  const [hierarchySaveErr, setHierarchySaveErr] = useState('')
  const [editParentName, setEditParentName] = useState('')
  const [editShareRatio, setEditShareRatio] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const effectiveYear = selectedYear === ui.filterYearAll ? undefined : selectedYear
  const pathMap = useMemo(() => buildPathMap(treeNodes, isManage), [treeNodes, isManage])
  const flatRows = useMemo(() => flattenTree(treeNodes, pathMap), [treeNodes, pathMap])

  const years = useMemo(() => buildStatYearOptions(statYears), [statYears])

  const filteredFlat = useMemo(
    () =>
      flatRows.filter((row) => {
        const yearMatched = selectedYear === ui.filterYearAll || row.snapshotYear === selectedYear
        const enterpriseMatched =
          enterpriseKeyword.trim().length === 0 ||
          row.name.toLowerCase().includes(enterpriseKeyword.trim().toLowerCase()) ||
          row.id.toLowerCase().includes(enterpriseKeyword.trim().toLowerCase())
        return yearMatched && enterpriseMatched
      }),
    [enterpriseKeyword, flatRows, selectedYear, ui.filterYearAll],
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

  const canReset = selectedYear !== ui.filterYearAll || enterpriseKeyword.trim().length > 0

  const resetFilters = () => {
    if (!canReset) return
    setSelectedYear(ui.filterYearAll)
    setEnterpriseKeyword('')
  }

  const loadTree = useCallback(async () => {
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
    setTreeNodes(res.nodes ?? [])
    setEmptyHint(res.empty_hint ?? '')
    if (res.selected_year && selectedYear === ui.filterYearAll) {
      setSelectedYear(res.selected_year)
    }
    setExpanded(new Set(collectExpandableIds(res.nodes ?? [])))
    setLoading(false)
  }, [effectiveYear, isManage, selectedYear, ui.filterYearAll, ui.loadFailed])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  useEffect(() => {
    if (treeNodes.length === 0) {
      setActiveNodeId('')
      return
    }
    setActiveNodeId((prev) => {
      if (prev && findNodeById(treeNodes, prev)) return prev
      const first = flattenTree(treeNodes, pathMap)[0]
      return first?.id ?? ''
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
    if (!rowId) {
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
  const collapseAll = () => setExpanded(new Set())

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

  const emptyMessage = loading ? '…' : loadError || emptyHint || (flatRows.length === 0 ? ui.loadEmptyHint : ui.filterEmpty)
  const hasTreeData = flatRows.length > 0
  const showStructurePreview = !loading && !hasTreeData
  const noTreeData = showStructurePreview && !loadError
  const snapshotYear = effectiveYear || years[0] || ''

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.pageNote}
        noteTone="plain"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {exported ? <span className="text-il-meta text-[#1b6b3a]">{ui.exportSuccess}</span> : null}
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
              onClick={collapseAll}
            >
              {ui.collapseAll}
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
          </div>
        }
      />

      <Card
        title={importUi.cardTitle}
        className={[
          'mb-4',
          noTreeData ? 'border-accent/30 bg-[#f8fbff] ring-1 ring-accent/15' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {noTreeData ? (
          <div className="mb-3 rounded-sm border border-border-light bg-white px-3 py-2.5">
            <div className="mb-1.5 text-il-label font-medium text-text-2">{importUi.importChecklistTitle}</div>
            <ol className="list-inside list-decimal space-y-0.5 text-il-meta text-text-2">
              <li>{importUi.importChecklistLedger}</li>
              <li>{importUi.importChecklistImport}</li>
              <li>{importUi.importChecklistDemo}</li>
            </ol>
          </div>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-il-label text-text-2">
            <div className="mb-1 text-text-3">{importUi.fileLabel}</div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="block max-w-xs text-il-page-desc"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void runImport(f)
                e.target.value = ''
              }}
            />
          </label>
          <button
            type="button"
            disabled={importBusy}
            className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
            onClick={() => fileRef.current?.click()}
          >
            {importBusy ? importUi.importing : importUi.importButton}
          </button>
          {noTreeData ? (
            <button
              type="button"
              disabled={bootstrapBusy || importBusy}
              className="rounded-sm border border-accent/40 bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f0f7ff] disabled:opacity-60"
              onClick={() => void runBootstrapDemo()}
            >
              {bootstrapBusy ? '…' : importUi.bootstrapDemoButton}
            </button>
          ) : null}
          {props.onNav ? (
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f8fafc]"
              onClick={() => props.onNav?.('dim_audited_registry')}
            >
              {importUi.goToLedgerLink}
            </button>
          ) : null}
        </div>
        {importMsg ? <p className="mt-2 text-il-meta text-[#1b6b3a]">{importMsg}</p> : null}
        {importErr ? <p className="mt-2 text-il-meta text-red-600">{importErr}</p> : null}
        <p className="mt-2 text-il-meta text-text-3">{importUi.hint}</p>
      </Card>

      {loadError ? <p className="mb-3 text-il-meta text-red-600">{loadError}</p> : null}

      <Card title={ui.treeCardTitle}>
        <AuditedEnterpriseFilters
          hideStateInvestor
          yearLabel={ui.filterYearLabel}
          yearAllLabel={ui.filterYearAll}
          years={statYears}
          selectedYear={selectedYear}
          onYearChange={setSelectedYear}
          stateInvestorLabel={ui.filterStateInvestorLabel}
          stateInvestorAllLabel={ui.filterStateInvestorAll}
          stateInvestorOptions={[]}
          selectedStateInvestor={ui.filterStateInvestorAll}
          onStateInvestorChange={() => {}}
          enterpriseLabel={ui.filterEnterpriseLabel}
          enterprisePlaceholder={ui.filterEnterprisePlaceholder}
          enterpriseKeyword={enterpriseKeyword}
          onEnterpriseKeywordChange={setEnterpriseKeyword}
          resetLabel={ui.filterReset}
          canReset={canReset}
          onReset={resetFilters}
        />
        <div className="-mt-1 mb-4 border-b border-border-light pb-3 text-il-meta text-text-3">
          <span className="text-text-3">{ui.nodeCountLabel}</span>
          <span className="ml-1 font-semibold tabular-nums text-text">{filteredFlat.length}</span>
        </div>
        {exportError ? <div className="mb-2 text-il-meta text-[#c2410c]">{exportError}</div> : null}
        <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
          <div className="min-h-[280px] rounded-sm border border-border-light bg-white px-3 py-3">
            {visibleTree.length === 0 ? (
              showStructurePreview ? (
                <TreeSkeletonExample ui={ui} importUi={importUi} message={emptyMessage} />
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
                  expanded={expanded}
                  activeId={activeNodeId}
                  onToggle={toggleExpand}
                  onSelect={setActiveNodeId}
                />
              ))
            )}
          </div>
          <aside className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-3">
            <div className="mb-2 text-il-label font-medium text-text-2">{ui.nodeDetailTitle}</div>
            <NodeDetailPanel
              ui={ui}
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
            />
          </aside>
        </div>
      </Card>
    </div>
  )
}
