import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'

const q = t.dataQualityPrototype

const WEEKS = [
  { label: 'W13', anomaly: 42, block: 3 },
  { label: 'W14', anomaly: 55, block: 5 },
  { label: 'W15', anomaly: 38, block: 2 },
  { label: 'W16', anomaly: 61, block: 6 },
  { label: 'W17', anomaly: 48, block: 4 },
]

const maxVal = Math.max(...WEEKS.flatMap((w) => [w.anomaly, w.block * 8])) // scale blocks visually

export function DataQualityTrendPage(props: { onNav: (k: NavKey) => void }) {
  return (
    <div className="mx-auto max-w-[900px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{q.trendTitle}</h1>
            <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
              {q.prototypeBadge}
            </span>
          </div>
          <p className="mt-2 text-il-page-desc leading-relaxed text-text-2">{q.trendLead}</p>
          <p className="mt-1 text-il-meta text-text-3">{q.trendNote}</p>
        </div>
        <button
          type="button"
          className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
          onClick={() => props.onNav('import_quality_overview')}
        >
          ← {q.linkBackOverview}
        </button>
      </div>

      <Card title={`${q.trendWeek} · ${q.trendAnomaly} / ${q.trendBlock}`}>
        <div className="flex h-[220px] items-end justify-between gap-3 border-b border-border-light pb-1 pl-1 pr-2 pt-4">
          {WEEKS.map((w) => {
            const h1 = Math.round((w.anomaly / maxVal) * 160)
            const h2 = Math.round(((w.block * 8) / maxVal) * 160)
            return (
              <div key={w.label} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-[168px] w-full max-w-[56px] items-end justify-center gap-1">
                  <div
                    className="w-[40%] min-h-[6px] rounded-t-sm bg-accent/85"
                    style={{ height: `${Math.max(h1, 6)}px` }}
                    title={`${q.trendAnomaly}: ${w.anomaly}`}
                  />
                  <div
                    className="w-[40%] min-h-[4px] rounded-t-sm bg-danger/80"
                    style={{ height: `${Math.max(h2, 4)}px` }}
                    title={`${q.trendBlock}: ${w.block}`}
                  />
                </div>
                <div className="text-il-label tabular-nums text-text-3">{w.label}</div>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-il-meta text-text-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-accent/85" />
            {q.trendAnomaly}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-danger/80" />
            {q.trendBlock}
          </span>
        </div>
      </Card>
    </div>
  )
}
