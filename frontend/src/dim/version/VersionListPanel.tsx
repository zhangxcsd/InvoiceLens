import { Card } from '../../components/Card'
import { zhCN as t } from '../../copy/zh-CN'
import type { DimVersion } from './types'
import { VersionStatusTag } from './VersionStatusTag'

type Ui = typeof t.dimVersionUi

function statusLabel(status: DimVersion['status'], ui: Ui) {
  if (status === 'draft') return ui.statusDraft
  if (status === 'published') return ui.statusPublished
  return ui.statusArchived
}

export function VersionListPanel(props: {
  ui: Ui
  yearVersions: DimVersion[]
  selected: DimVersion | null
  onSelectVersion: (id: string) => void
}) {
  const { ui, yearVersions, selected, onSelectVersion } = props
  return (
    <Card title={ui.listTitle}>
      <div className="space-y-2">
        {yearVersions.map((v) => (
          <button
            key={v.id}
            type="button"
            className={[
              'w-full rounded-sm border px-3 py-2 text-left transition-colors',
              selected?.id === v.id ? 'border-[#c8dff7] bg-[#f0f7ff]' : 'border-border-light bg-white hover:bg-[#f8fafc]',
            ].join(' ')}
            onClick={() => onSelectVersion(v.id)}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-il-page-desc font-medium text-text">{`v${v.versionNo}`}</div>
              <VersionStatusTag status={v.status} label={statusLabel(v.status, ui)} />
            </div>
            <div className="mt-1 text-il-meta text-text-3">{`${ui.updatedAtLabel}：${v.updatedAt}`}</div>
            {v.isCurrent ? <div className="mt-1 text-il-meta font-medium text-accent">{ui.currentActiveLabel}</div> : null}
          </button>
        ))}
      </div>
    </Card>
  )
}
