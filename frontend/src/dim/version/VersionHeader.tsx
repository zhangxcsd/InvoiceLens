import { Card } from '../../components/Card'
import { zhCN as t } from '../../copy/zh-CN'
import type { DimVersion } from './types'

type Ui = typeof t.dimVersionUi

export function VersionHeader(props: {
  ui: Ui
  statYear: string
  yearOptions: string[]
  onStatYearChange: (year: string) => void
  currentVersion: DimVersion | null
  selected: DimVersion | null
}) {
  const { ui, statYear, yearOptions, onStatYearChange, currentVersion, selected } = props
  return (
    <Card title={ui.headerCardTitle}>
      <div className="grid gap-3 md:grid-cols-[180px_1fr_1fr_1fr_1fr]">
        <label className="text-il-label text-text-2">
          <div className="mb-1 text-text-3">{ui.filterYearLabel}</div>
          <select
            className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text"
            value={statYear}
            onChange={(e) => onStatYearChange(e.target.value)}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        {[
          { label: ui.kpiCurrentVersion, value: currentVersion ? `v${currentVersion.versionNo}` : '-' },
          { label: ui.kpiSubjectTotal, value: selected ? String(selected.kpis.subjectTotal) : '-' },
          { label: ui.kpiEnterpriseRatio, value: selected ? `${selected.kpis.enterpriseRatio.toFixed(1)}%` : '-' },
          { label: ui.kpiCoverage, value: selected ? `${selected.kpis.mappingCoverage.toFixed(1)}%` : '-' },
        ].map((item) => (
          <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className="mt-1 text-[16px] font-semibold text-text">{item.value}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}
