import { Card } from '../../components/Card'
import { zhCN as t } from '../../copy/zh-CN'
import type { DetailTab, DimVersion, DiffRow } from './types'

type Ui = typeof t.dimVersionUi

export function VersionDetailTabs(props: {
  ui: Ui
  selected: DimVersion | null
  activeTab: DetailTab
  onTabChange: (tab: DetailTab) => void
  diffRows: DiffRow[]
}) {
  const { ui, selected, activeTab, onTabChange, diffRows } = props
  return (
    <Card title={ui.detailTitle}>
      {!selected ? (
        <div className="rounded-sm border border-dashed border-border-light bg-[#fafbfd] px-3 py-5 text-center text-il-page-desc text-text-3">
          {ui.noVersion}
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2 border-b border-border-light pb-3">
            {[
              { key: 'definition' as const, label: ui.tabDefinition },
              { key: 'impact' as const, label: ui.tabImpact },
              { key: 'diff' as const, label: ui.tabDiff },
              { key: 'log' as const, label: ui.tabLog },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={[
                  'rounded-sm border px-2.5 py-1 text-il-page-desc transition-colors',
                  activeTab === tab.key
                    ? 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
                    : 'border-border bg-white text-text-2 hover:border-accent hover:text-accent',
                ].join(' ')}
                onClick={() => onTabChange(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'definition' ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.ruleVersionLabel}</div>
                <div className="mt-1 text-il-page-desc text-text">{selected.ruleVersion}</div>
              </div>
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.batchRangeLabel}</div>
                <div className="mt-1 text-il-page-desc text-text">{`${selected.batchStart} ~ ${selected.batchEnd}`}</div>
              </div>
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.externalImportLabel}</div>
                <div className="mt-1 text-il-page-desc text-text">{selected.includeExternalImport ? ui.yes : ui.no}</div>
              </div>
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
                <div className="text-il-label text-text-3">{ui.externalBatchCountLabel}</div>
                <div className="mt-1 text-il-page-desc text-text">{selected.externalImportBatchCount}</div>
              </div>
              <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5 md:col-span-2">
                <div className="text-il-label text-text-3">{ui.changeNoteLabel}</div>
                <div className="mt-1 text-il-page-desc text-text">{selected.changeNote}</div>
              </div>
            </div>
          ) : null}

          {activeTab === 'impact' ? (
            <div className="space-y-2 text-il-page-desc text-text-2">
              <div>{ui.impactHint}</div>
              <ul className="list-disc space-y-1 pl-5 text-text-2">
                <li>{ui.impactItemEnterprise}</li>
                <li>{ui.impactItemTicket}</li>
                <li>{ui.impactItemTree}</li>
              </ul>
            </div>
          ) : null}

          {activeTab === 'diff' ? (
            <div className="overflow-x-auto rounded-sm border border-border-light">
              <table className="w-full min-w-[520px] border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="px-3 py-2 font-medium">{ui.diffColMetric}</th>
                    <th className="px-3 py-2 font-medium">{ui.diffColPrev}</th>
                    <th className="px-3 py-2 font-medium">{ui.diffColCurr}</th>
                    <th className="px-3 py-2 font-medium">{ui.diffColDelta}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {diffRows.map((r) => {
                    const delta = r.curr - r.prev
                    return (
                      <tr key={r.metric} className="border-b border-border-light last:border-b-0">
                        <td className="px-3 py-2.5">{r.metric}</td>
                        <td className="px-3 py-2.5">{r.prev}</td>
                        <td className="px-3 py-2.5">{r.curr}</td>
                        <td className={['px-3 py-2.5 font-medium', delta >= 0 ? 'text-[#1b6b3a]' : 'text-[#b45309]'].join(' ')}>
                          {delta >= 0 ? `+${delta}` : String(delta)}
                        </td>
                      </tr>
                    )
                  })}
                  {diffRows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-center text-text-3" colSpan={4}>
                        {ui.noDiff}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {activeTab === 'log' ? (
            <div className="space-y-2 text-il-page-desc text-text-2">
              <div>{`${ui.updatedAtLabel}：${selected.updatedAt}`}</div>
              <div>{`${ui.updatedByLabel}：${selected.updatedBy}`}</div>
              <div>{`${ui.publishedAtLabel}：${selected.publishedAt ?? '-'}`}</div>
              <div>{`${ui.publishedByLabel}：${selected.publishedBy ?? '-'}`}</div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}
