import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuditedEnterpriseFilters } from '../components/AuditedEnterpriseFilters'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchDimOrgHierTree,
  postDimOrgHierImport,
  type DimOrgHierTreeNode,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'

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

function flattenTree(nodes: DimOrgHierTreeNode[], statYear: string): FlatFilterRow[] {
  const out: FlatFilterRow[] = []
  const walk = (list: DimOrgHierTreeNode[]) => {
    for (const node of list) {
      out.push({
        id: node.id,
        name: node.name,
        level: node.level,
        parentName: node.parent_name || '—',
        snapshotYear: statYear,
        path: node.path || '',
        sortNo: node.sort_no ?? 0,
        isHierDiff: Boolean(node.is_hier_diff),
        note: node.hier_diff_note?.trim() || node.entity_fullname?.trim() || '—',
      })
      if (node.children?.length) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

function collectExpandableIds(nodes: DimOrgHierTreeNode[]): string[] {
  const ids: string[] = []
  const walk = (list: DimOrgHierTreeNode[]) => {
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
  node: DimOrgHierTreeNode
  depth: number
  expanded: Set<string>
  activeId: string
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}) {
  const { node, depth, expanded, activeId, onToggle, onSelect } = props
  const hasChildren = (node.children?.length ?? 0) > 0
  const isOpen = expanded.has(node.id)

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
          {node.is_hier_diff ? <span className="text-danger" title="管产分离">●</span> : null}
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

function findNodeById(nodes: DimOrgHierTreeNode[], id: string): DimOrgHierTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children?.length) {
      const hit = findNodeById(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

export function AuditedEnterpriseTreePage(props: { mode: TreeMode; onNav?: (k: NavKey) => void }) {
  const isManage = props.mode === 'management'
  const ui = isManage ? t.auditedEnterpriseManageTreeUi : t.auditedEnterpriseEquityTreeUi
  const importUi = t.dimOrgHierImportUi

  const [treeNodes, setTreeNodes] = useState<DimOrgHierTreeNode[]>([])
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
  const [importDryRun, setImportDryRun] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [importErr, setImportErr] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const effectiveYear = selectedYear === ui.filterYearAll ? undefined : selectedYear
  const flatRows = useMemo(
    () => flattenTree(treeNodes, effectiveYear || statYears[0] || ''),
    [treeNodes, effectiveYear, statYears],
  )

  const years = useMemo(() => {
    const fromApi = statYears.length ? statYears : Array.from(new Set(flatRows.map((r) => r.snapshotYear).filter(Boolean)))
    return fromApi.sort((a, b) => Number(b) - Number(a))
  }, [flatRows, statYears])

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
    const filterNodes = (nodes: DimOrgHierTreeNode[]): DimOrgHierTreeNode[] =>
      nodes
        .map((n) => {
          const children = filterNodes(n.children ?? [])
          if (filteredIdSet.has(n.id) || children.length > 0) {
            return { ...n, children }
          }
          return null
        })
        .filter(Boolean) as DimOrgHierTreeNode[]
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
    const res = await fetchDimOrgHierTree({
      tree: isManage ? 'mg' : 'eq',
      statYear: effectiveYear,
      keyword: enterpriseKeyword.trim() || undefined,
    })
    if (!res.ok) {
      setLoadError(res.error?.message ?? ui.loadFailed)
      setTreeNodes([])
      setLoading(false)
      return
    }
    setStatYears(res.stat_years ?? [])
    setTreeNodes(res.nodes ?? [])
    setEmptyHint(res.empty_hint ?? '')
    if (res.selected_year && selectedYear === ui.filterYearAll) {
      setSelectedYear(res.selected_year)
    }
    setExpanded(new Set(collectExpandableIds(res.nodes ?? [])))
    setLoading(false)
  }, [effectiveYear, enterpriseKeyword, isManage, selectedYear, ui.filterYearAll, ui.loadFailed])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  useEffect(() => {
    if (filteredFlat.length === 0) {
      setActiveNodeId('')
      return
    }
    if (!filteredFlat.some((node) => node.id === activeNodeId)) {
      setActiveNodeId(filteredFlat[0].id)
    }
  }, [activeNodeId, filteredFlat])

  const activeNode = useMemo(
    () => (activeNodeId ? findNodeById(treeNodes, activeNodeId) : null),
    [activeNodeId, treeNodes],
  )

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
    const res = await postDimOrgHierImport({ file, dryRun: importDryRun })
    setImportBusy(false)
    if (!res.ok) {
      setImportErr(res.errors?.join('；') || res.error?.message || importUi.importFailed)
      return
    }
    if (res.dry_run) {
      setImportMsg(
        importUi.dryRunSuccess
          .replace('{count}', String(res.row_count ?? res.success ?? 0))
          .replace('{diff}', String(res.hier_diff_count ?? 0)),
      )
      return
    }
    setImportMsg(
      importUi.importSuccess
        .replace('{count}', String(res.success ?? 0))
        .replace('{updated}', String(res.updated ?? 0))
        .replace('{diff}', String(res.hier_diff_count ?? 0)),
    )
    if (res.stat_year) setSelectedYear(String(res.stat_year))
    void loadTree()
  }

  const emptyMessage = loading ? '…' : loadError || emptyHint || (flatRows.length === 0 ? ui.loadEmptyHint : ui.filterEmpty)

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

      <Card title={importUi.cardTitle} className="mb-4">
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
          <label className="inline-flex items-center gap-2 text-il-page-desc text-text-2">
            <input type="checkbox" checked={importDryRun} onChange={(e) => setImportDryRun(e.target.checked)} />
            {importUi.dryRunLabel}
          </label>
          <button
            type="button"
            disabled={importBusy}
            className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
            onClick={() => fileRef.current?.click()}
          >
            {importBusy ? importUi.importing : importUi.importButton}
          </button>
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
          years={years}
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
          <div className="rounded-sm border border-border-light bg-white px-3 py-3">
            {visibleTree.length === 0 ? (
              <div className="rounded-sm border border-dashed border-border-light bg-[#fafbfd] px-3 py-4 text-center text-il-page-desc text-text-3">
                {emptyMessage}
              </div>
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
            {activeNode ? (
              <div className="space-y-2 text-il-page-desc text-text-2">
                <div>
                  <span className="text-text-3">{ui.nodeNameLabel}：</span>
                  {activeNode.name}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeLevelLabel}：</span>
                  {activeNode.level}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeParentLabel}：</span>
                  {activeNode.parent_name}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeSnapshotLabel}：</span>
                  {effectiveYear || years[0] || '—'}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodePathLabel ?? '组织路径'}：</span>
                  {activeNode.path || '—'}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeSortLabel ?? '排序号'}：</span>
                  {activeNode.sort_no ?? '—'}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeCodeLabel}：</span>
                  <span className="font-mono text-[12px]">{activeNode.id}</span>
                </div>
                {activeNode.is_hier_diff ? (
                  <div className="text-danger">
                    <span className="text-text-3">{ui.nodeHierDiffLabel ?? '管产差异'}：</span>
                    {activeNode.hier_diff_note || '未填写说明'}
                  </div>
                ) : null}
                {!isManage && activeNode.eq_shareholding_ratio != null ? (
                  <div>
                    <span className="text-text-3">{ui.nodeShareRatioLabel ?? '持股比例'}：</span>
                    {(activeNode.eq_shareholding_ratio * 100).toFixed(2)}%
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-il-page-desc text-text-3">{ui.nodeDetailEmpty}</div>
            )}
          </aside>
        </div>
      </Card>
    </div>
  )
}
