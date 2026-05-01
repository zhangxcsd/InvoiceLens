import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuditedEnterpriseFilters } from '../components/AuditedEnterpriseFilters'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import { useAuditedEnterpriseFilters } from '../hooks/useAuditedEnterpriseFilters'

type TreeMode = 'management' | 'equity'

type TreeNode = {
  id: string
  name: string
  level: number
  parentName: string
  snapshotYear: string
  stateInvestorEnterprise: string
  note: string
}

const manageNodes: TreeNode[] = [
  { id: 'm1', name: '山东XX能源集团有限公司', level: 1, parentName: '省属企业', snapshotYear: '2026', stateInvestorEnterprise: '山东省国资委', note: '管理总部节点' },
  { id: 'm2', name: '青岛XX工程建设有限公司', level: 2, parentName: '山东XX能源集团有限公司', snapshotYear: '2026', stateInvestorEnterprise: '山东省国资委', note: '工程建设条线' },
  { id: 'm3', name: '济南XX贸易有限公司', level: 3, parentName: '青岛XX工程建设有限公司', snapshotYear: '2025', stateInvestorEnterprise: '山东省国资委', note: '贸易执行主体' },
  { id: 'm4', name: '烟台XX物流有限公司', level: 2, parentName: '山东XX能源集团有限公司', snapshotYear: '2026', stateInvestorEnterprise: '山东省国资委', note: '物流供应链主体' },
]

const equityNodes: TreeNode[] = [
  { id: 'e1', name: '山东省国资委', level: 1, parentName: '-', snapshotYear: '2026', stateInvestorEnterprise: '山东省国资委', note: '最终国资出资方' },
  { id: 'e2', name: '山东XX能源集团有限公司(100%)', level: 2, parentName: '山东省国资委', snapshotYear: '2026', stateInvestorEnterprise: '山东省国资委', note: '一级国家出资企业' },
  { id: 'e3', name: '山东XX建设投资控股有限公司(60%)', level: 3, parentName: '山东XX能源集团有限公司', snapshotYear: '2025', stateInvestorEnterprise: '山东省国资委', note: '多股东场景（控股）' },
  { id: 'e4', name: '烟台XX物流有限公司(70%)', level: 3, parentName: '山东XX能源集团有限公司', snapshotYear: '2026', stateInvestorEnterprise: '山东省国资委', note: '多股东场景（参股）' },
]

function exportStamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function AuditedEnterpriseTreePage(props: { mode: TreeMode }) {
  const isManage = props.mode === 'management'
  const ui = isManage ? t.auditedEnterpriseManageTreeUi : t.auditedEnterpriseEquityTreeUi
  const nodes = isManage ? manageNodes : equityNodes
  const [activeNodeId, setActiveNodeId] = useState(nodes[0]?.id ?? '')
  const [exportError, setExportError] = useState('')
  const [exported, setExported] = useState(false)
  const {
    selectedYear,
    setSelectedYear,
    selectedStateInvestor,
    setSelectedStateInvestor,
    enterpriseKeyword,
    setEnterpriseKeyword,
    years,
    stateInvestorEnterprises,
    filteredRows: filteredNodes,
    canReset,
    resetFilters,
  } = useAuditedEnterpriseFilters(nodes, {
    yearAll: ui.filterYearAll,
    stateInvestorAll: ui.filterStateInvestorAll,
  })

  useEffect(() => {
    if (filteredNodes.length === 0) {
      setActiveNodeId('')
      return
    }
    if (!filteredNodes.some((node) => node.id === activeNodeId)) {
      setActiveNodeId(filteredNodes[0].id)
    }
  }, [activeNodeId, filteredNodes])

  const activeNode = useMemo(() => filteredNodes.find((n) => n.id === activeNodeId) ?? null, [activeNodeId, filteredNodes])

  const exportCurrent = useCallback(async () => {
    if (filteredNodes.length === 0) return
    try {
      setExportError('')
      const XLSX = await import('xlsx')
      const header = [ui.nodeNameLabel, ui.nodeLevelLabel, ui.nodeParentLabel, ui.nodeSnapshotLabel, ui.nodeNoteLabel]
      const body = filteredNodes.map((n) => [n.name, n.level, n.parentName, n.snapshotYear, n.note])
      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '节点')
      XLSX.writeFile(wb, `${ui.exportFileNamePrefix}_${exportStamp()}.xlsx`)
      setExported(true)
      window.setTimeout(() => setExported(false), 2000)
    } catch {
      setExportError(ui.exportFailed)
    }
  }, [filteredNodes, ui])

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.pageNote}
        badgeText={ui.prototypeBadge}
        expandLabel={ui.moreTipsToggle}
        collapseLabel={ui.lessTipsToggle}
        actions={
          <div className="flex items-center gap-2">
            {exported ? <span className="text-il-meta text-[#1b6b3a]">{ui.exportSuccess}</span> : null}
            <button
              type="button"
              className={[
                'rounded-sm border px-3 py-1.5 text-il-meta transition-colors',
                filteredNodes.length > 0
                  ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                  : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
              ].join(' ')}
              disabled={filteredNodes.length === 0}
              onClick={() => void exportCurrent()}
            >
              {ui.exportCurrentNodes}
            </button>
          </div>
        }
      />

      <Card title={ui.treeCardTitle}>
        <AuditedEnterpriseFilters
          yearLabel={ui.filterYearLabel}
          yearAllLabel={ui.filterYearAll}
          years={years}
          selectedYear={selectedYear}
          onYearChange={setSelectedYear}
          stateInvestorLabel={ui.filterStateInvestorLabel}
          stateInvestorAllLabel={ui.filterStateInvestorAll}
          stateInvestorOptions={stateInvestorEnterprises}
          selectedStateInvestor={selectedStateInvestor}
          onStateInvestorChange={setSelectedStateInvestor}
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
          <span className="ml-1 font-semibold tabular-nums text-text">{filteredNodes.length}</span>
        </div>
        {exportError ? <div className="mb-2 text-il-meta text-[#c2410c]">{exportError}</div> : null}
        <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
          <div className="rounded-sm border border-border-light bg-white px-3 py-3">
            {filteredNodes.length === 0 ? (
              <div className="rounded-sm border border-dashed border-border-light bg-[#fafbfd] px-3 py-4 text-center text-il-page-desc text-text-3">
                {ui.filterEmpty}
              </div>
            ) : (
              filteredNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={[
                    'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-il-page-desc',
                    activeNodeId === node.id ? 'bg-[#f0f7ff] text-accent' : 'text-text-2 hover:bg-[#f8fafc]',
                  ].join(' ')}
                  style={{ paddingLeft: `${node.level * 18}px` }}
                  onClick={() => setActiveNodeId(node.id)}
                >
                  <span className="mr-2 text-text-3">├</span>
                  <span>{node.name}</span>
                </button>
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
                  {activeNode.parentName}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeSnapshotLabel}：</span>
                  {activeNode.snapshotYear}
                </div>
                <div>
                  <span className="text-text-3">{ui.nodeNoteLabel}：</span>
                  {activeNode.note}
                </div>
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

