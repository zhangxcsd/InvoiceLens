import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import { fetchHealthScoreSnapshot, type HealthIndicatorRow } from '../config/localApi'

type Level = 'normal' | 'warning' | 'alert'

function levelTag(level: Level) {
  if (level === 'alert') {
    return <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 py-0.5 text-il-label text-danger">异常</span>
  }
  if (level === 'warning') {
    return <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 py-0.5 text-il-label text-warn">预警</span>
  }
  return <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-1.5 py-0.5 text-il-label text-accent">正常</span>
}

export function HealthScorePage() {
  const q = t.healthScoreUi
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [overview, setOverview] = useState({
    total_score: 0,
    grade: '-',
    change_vs_prev: 0,
    score_formula: '',
    grade_rule: '',
  })
  const [dimensions, setDimensions] = useState<Array<{ dimension_name: string; weight: number; score: number }>>([])
  const [indicators, setIndicators] = useState<HealthIndicatorRow[]>([])
  const [topDeductions, setTopDeductions] = useState<Array<{ indicator_name: string; explain_text: string }>>([])
  const [selected, setSelected] = useState<HealthIndicatorRow | null>(null)
  const [onlyAbnormal, setOnlyAbnormal] = useState(false)
  const [levelFilter, setLevelFilter] = useState<'all' | Level>('all')
  const [dimensionFilter, setDimensionFilter] = useState('all')
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    void fetchHealthScoreSnapshot({ signal: ac.signal }).then((res) => {
      if (!alive) return
      setLoading(false)
      if (!res.ok || !res.overview) {
        setErr(res.error?.message ?? '加载失败')
        return
      }
      setOverview(res.overview)
      setDimensions((res.dimensions ?? []).map((x) => ({ dimension_name: x.dimension_name, weight: x.weight, score: x.score })))
      setIndicators((res.indicators ?? []) as HealthIndicatorRow[])
      setTopDeductions((res.top_deductions ?? []).map((x) => ({ indicator_name: x.indicator_name, explain_text: x.explain_text })))
      setErr('')
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [])

  const rows = useMemo(() => {
    return indicators.filter((x) => {
      if (onlyAbnormal && x.level === 'normal') return false
      if (levelFilter !== 'all' && x.level !== levelFilter) return false
      if (dimensionFilter !== 'all' && x.dimension_code !== dimensionFilter) return false
      return true
    })
  }, [onlyAbnormal, levelFilter, dimensionFilter, indicators])

  const dimensionOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const item of indicators) {
      if (!seen.has(item.dimension_code)) {
        seen.set(item.dimension_code, item.dimension_name)
      }
    }
    return Array.from(seen.entries()).map(([code, name]) => ({ code, name }))
  }, [indicators])

  useEffect(() => {
    if (rows.length === 0) {
      setSelected(null)
      return
    }
    setSelected((prev) => {
      if (!prev) return rows[0] ?? null
      const exists = rows.some((r) => r.indicator_code === prev.indicator_code)
      return exists ? prev : (rows[0] ?? null)
    })
  }, [rows])

  useEffect(() => {
    if (!selected) return
    const el = rowRefs.current[selected.indicator_code]
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{q.pageTitle}</h1>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
            {q.prototypeBadge}
          </span>
        </div>
        <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{q.pageDesc}</p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
          <div className="text-il-label text-text-3">{q.kpiTotalScore}</div>
          <div className="mt-1 text-[24px] font-bold tabular-nums text-text">{overview.total_score.toFixed(2)}</div>
        </div>
        <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
          <div className="text-il-label text-text-3">{q.kpiGrade}</div>
          <div className="mt-1 text-[24px] font-bold tabular-nums text-accent">{overview.grade}</div>
        </div>
        <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
          <div className="text-il-label text-text-3">{q.kpiChange}</div>
          <div className={['mt-1 text-[24px] font-bold tabular-nums', overview.change_vs_prev <= 0 ? 'text-danger' : 'text-green-600'].join(' ')}>
            {overview.change_vs_prev > 0 ? '+' : ''}
            {overview.change_vs_prev.toFixed(2)}
          </div>
        </div>
        <div className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
          <div className="text-il-label text-text-3">{q.kpiRule}</div>
          <div className="mt-1 text-il-meta leading-relaxed text-text-2">{overview.grade_rule || '-'}</div>
        </div>
      </div>

      <Card title={q.dimensionTitle}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {dimensions.map((d) => (
            <div key={d.dimension_name} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2">
              <div className="text-il-label text-text-3">
                {d.dimension_name} · {(d.weight * 100).toFixed(0)}%
              </div>
              <div className="mt-1 text-[20px] font-semibold tabular-nums text-text">{d.score.toFixed(2)}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title={q.topDeductionTitle}>
        {topDeductions.length === 0 ? (
          <p className="text-il-meta text-text-3">{q.emptyHint}</p>
        ) : (
          <ul className="list-inside list-disc space-y-1 text-il-page-desc text-text-2">
            {topDeductions.map((x) => (
              <li key={x.indicator_name}>
                <span className="font-medium text-text">{x.indicator_name}</span>：{x.explain_text}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={q.indicatorTableTitle}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-il-meta text-text-3">{q.tableLead}</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="min-w-[140px] rounded-sm border border-border bg-white px-2 py-1 text-il-page-desc text-text outline-none focus:border-accent"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as 'all' | Level)}
            >
              <option value="all">{q.levelAll}</option>
              <option value="normal">{q.levelNormal}</option>
              <option value="warning">{q.levelWarning}</option>
              <option value="alert">{q.levelAlert}</option>
            </select>
            <select
              className="min-w-[170px] rounded-sm border border-border bg-white px-2 py-1 text-il-page-desc text-text outline-none focus:border-accent"
              value={dimensionFilter}
              onChange={(e) => setDimensionFilter(e.target.value)}
            >
              <option value="all">{q.dimensionAll}</option>
              {dimensionOptions.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-il-page-desc text-text-2">
              <input type="checkbox" checked={onlyAbnormal} onChange={(e) => setOnlyAbnormal(e.target.checked)} />
              {q.onlyAbnormal}
            </label>
            <button
              type="button"
              className="rounded-sm border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => {
                setLevelFilter('all')
                setDimensionFilter('all')
                setOnlyAbnormal(false)
              }}
            >
              {q.resetFilters}
            </button>
          </div>
        </div>
        <div className="flex items-stretch gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="h-[560px] overflow-auto rounded-sm border border-border-light outline-none focus:ring-2 focus:ring-accent/20"
              tabIndex={0}
              onKeyDown={(e) => {
                if (rows.length === 0) return
                const idx = selected ? rows.findIndex((r) => r.indicator_code === selected.indicator_code) : -1
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  const next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)
                  setSelected(rows[next] ?? null)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  const prev = idx < 0 ? 0 : Math.max(0, idx - 1)
                  setSelected(rows[prev] ?? null)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  if (idx >= 0) setSelected(rows[idx] ?? null)
                }
              }}
            >
              <table className="w-full min-w-[1080px] border-collapse text-il-page-desc">
                <thead>
                  <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                    <th className="px-2 py-2 font-medium">{q.colIndicator}</th>
                    <th className="px-2 py-2 font-medium">{q.colValue}</th>
                    <th className="px-2 py-2 font-medium">{q.colScore}</th>
                    <th className="px-2 py-2 font-medium">{q.colThreshold}</th>
                    <th className="px-2 py-2 font-medium">{q.colJudgement}</th>
                    <th className="px-2 py-2 font-medium">{q.colSuspicion}</th>
                  </tr>
                </thead>
                <tbody className="text-text-2">
                  {rows.map((r) => (
                    <tr
                      key={r.indicator_code}
                      ref={(el) => {
                        rowRefs.current[r.indicator_code] = el
                      }}
                      className={[
                        'border-b border-border-light align-top last:border-0 cursor-pointer',
                        selected?.indicator_code === r.indicator_code ? 'bg-[#f0f7ff]' : 'hover:bg-[#f8fbff]',
                      ].join(' ')}
                      onClick={() => setSelected(r)}
                    >
                      <td className="px-2 py-2">
                        <div className="font-medium text-text">{r.indicator_name}</div>
                        <div className="mt-1 text-il-meta text-text-3">{r.dimension_name}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.indicator_value.toFixed(4)}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.score.toFixed(2)}</td>
                      <td className="px-2 py-2">{r.threshold_text}</td>
                      <td className="whitespace-nowrap px-2 py-2">{levelTag(r.level)}</td>
                      <td className="px-2 py-2">
                        {r.suspicion_directions.length === 0 ? (
                          <span className="text-il-meta text-text-3">-</span>
                        ) : (
                          <div className="space-y-1">
                            {r.suspicion_directions.slice(0, 2).map((s) => (
                              <p key={s.code}>
                                <span className="font-medium text-text">{s.title}</span>：{s.detail}
                              </p>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="hidden h-[560px] w-[420px] shrink-0 rounded-[10px] border border-border-light bg-[#fcfdff] xl:block">
            {selected ? (
              <div className="h-full overflow-auto">
                <div className="sticky top-0 z-10 border-b border-border-light bg-white/95 px-4 py-3 backdrop-blur">
                  <div className="flex items-center justify-between">
                    <h2 className="text-il-card-title font-semibold text-text">{q.drawerTitle}</h2>
                    <button
                      type="button"
                      className="rounded-sm border border-border px-2 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                      onClick={() => setSelected(null)}
                    >
                      {q.close}
                    </button>
                  </div>
                  <p className="mt-1 text-il-meta text-text-3">{selected.indicator_name}</p>
                </div>
                <div className="space-y-3 px-4 py-3">
                  <div className="rounded-[10px] border border-border-light bg-white p-3">
                    <div className="grid gap-2 text-il-page-desc text-text-2">
                      <p><span className="font-medium text-text">{q.formulaLabel}</span>：{selected.formula_text}</p>
                      <p><span className="font-medium text-text">{q.thresholdLabel}</span>：{selected.threshold_text}</p>
                      <p><span className="font-medium text-text">{q.sourceLabel}</span>：{selected.data_source_text}</p>
                      <p><span className="font-medium text-text">{q.hitBandLabel}</span>：[{selected.hit_band_min ?? '-'}, {selected.hit_band_max ?? '-'}）</p>
                      <p><span className="font-medium text-text">{q.evidenceLabel}</span>：{selected.evidence_count}</p>
                      <p><span className="font-medium text-text">{q.explainLabel}</span>：{selected.explain_text}</p>
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-il-page-desc font-semibold text-text">{q.suspicionBlockTitle}</div>
                    {selected.suspicion_directions.length === 0 ? (
                      <p className="rounded-[10px] border border-border-light bg-white px-3 py-2 text-il-page-desc text-text-2">{q.emptyHint}</p>
                    ) : (
                      <div className="space-y-2">
                        {selected.suspicion_directions.map((s) => (
                          <div key={s.code} className="rounded-[10px] border border-border-light bg-white px-3 py-2.5">
                            <p className="text-il-page-desc font-medium text-text">{s.title}</p>
                            <p className="mt-1 leading-relaxed text-il-page-desc text-text-2">{s.detail}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="mb-2 text-il-page-desc font-semibold text-text">{q.actionBlockTitle}</div>
                    {selected.suggest_actions.length === 0 ? (
                      <p className="rounded-[10px] border border-border-light bg-white px-3 py-2 text-il-page-desc text-text-2">{q.emptyHint}</p>
                    ) : (
                      <ul className="rounded-[10px] border border-border-light bg-white px-3 py-2.5 text-il-page-desc text-text-2">
                        {selected.suggest_actions.map((x) => (
                          <li key={x} className="ml-4 list-disc py-0.5">
                            {x}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-il-meta text-text-3">{q.selectHint}</div>
            )}
          </div>
        </div>
        {loading ? <p className="mt-3 text-il-meta text-text-3">{q.loadingText}</p> : null}
        {err ? <p className="mt-3 text-il-meta text-danger">{q.loadFailedPrefix}{err}</p> : null}
      </Card>
    </div>
  )
}
