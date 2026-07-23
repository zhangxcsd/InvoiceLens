import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsInvoiceTimingOverview } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsPct, useDwsFilters } from './useDwsFilters'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import { readNavQueryParams } from '../utils/navHelpers'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

const DOW_LABELS = ['', '周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function InvoiceTimingPage({ onNav, embedMode }: { onNav?: (key: NavKey) => void } & EmbedModeProps) {
  const ui = t.invoiceTimingUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('invoice_timing', embedMode)
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    requireBuyer: true,
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })
  const [roleType, setRoleType] = useState<'进项' | '销项'>(() => {
    const saved = savedUi?.extra?.roleType
    return saved === '销项' ? '销项' : '进项'
  })
  const [stats, setStats] = useState<Record<string, number | null>>({})
  const [dow, setDow] = useState<Array<{ dow: number; cnt: number }>>([])
  const [monthly, setMonthly] = useState<Array<{ stat_month: number; holiday_cnt: number; weekend_large_cnt: number }>>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onHostReturn = useCallback(
    (params: Record<string, string>) => {
      if (params.stat_year) f.setStatYear(params.stat_year)
      if (params.entity_id) f.setEntityId(params.entity_id)
    },
    [f],
  )

  const { goAnalysis, shellProps } = useDwsPageAnalysisShell({
    host: 'invoice_timing',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      loading,
      extra: { roleType },
    },
  })

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim()) return
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsInvoiceTimingOverview(
          { statYear: f.effectiveYear, entityId: f.entityId.trim(), roleType },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          return
        }
        setStats(res.data?.stats ?? {})
        setDow(res.data?.day_of_week ?? [])
        setMonthly(res.data?.monthly ?? [])
      } finally {
        setLoading(false)
      }
    },
    [f.effectiveYear, f.entityId, roleType, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <>
    <div className={embedMode ? 'w-full' : 'w-full px-5 py-6'}>
      {!embedMode ? <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" /> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

      <Card title={ui.filterTitle}>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.entityOptions}
          requireEntity
        />
        <div className="mt-3 flex gap-2">
          {(['进项', '销项'] as const).map((rt) => (
            <button
              key={rt}
              type="button"
              className={[
                'rounded border px-2 py-1 text-il-meta',
                roleType === rt ? 'border-accent bg-accent/5 text-accent' : 'border-border-light text-text-3',
              ].join(' ')}
              onClick={() => setRoleType(rt)}
            >
              {rt}
            </button>
          ))}
        </div>
        {onNav && f.entityId.trim() ? (
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() =>
              goAnalysis('flags_list', {
                stat_year: f.effectiveYear,
                rule_id: 'RULE-02',
                entity_id: f.entityId.trim(),
              })
            }
          >
            {ui.linkRule02}
          </button>
        ) : null}
      </Card>

      {!f.entityId.trim() ? (
        <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
      ) : loading ? (
        <p className="text-il-meta text-text-3">{ui.loading}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: ui.kpiHoliday, value: String(stats.holiday_cnt ?? 0) },
              { label: ui.kpiWeekendLarge, value: String(stats.weekend_large_cnt ?? 0) },
              { label: ui.kpiYearendRatio, value: formatDwsPct(stats.yearend_ratio as number | null) },
              { label: ui.kpiYearendCnt, value: String(stats.yearend_cnt ?? 0) },
            ].map((item) => (
              <div key={item.label} className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2">
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 font-semibold tabular-nums text-text">{item.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card title={ui.dowTitle}>
              <ul className="space-y-1 text-il-page-desc text-text-2">
                {dow.map((d) => (
                  <li key={d.dow} className="flex justify-between gap-2">
                    <span>{DOW_LABELS[d.dow] ?? `D${d.dow}`}</span>
                    <span className="tabular-nums">{d.cnt}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={ui.monthlyTitle}>
              <ul className="space-y-1 text-il-page-desc text-text-2">
                {monthly.map((m) => (
                  <li key={m.stat_month} className="flex justify-between gap-2">
                    <span>
                      {m.stat_month}
                      {ui.monthUnit}
                    </span>
                    <span className="tabular-nums">
                      {ui.holidayTag}
                      {m.holiday_cnt} · {ui.weekendTag}
                      {m.weekend_large_cnt}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
    {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}
