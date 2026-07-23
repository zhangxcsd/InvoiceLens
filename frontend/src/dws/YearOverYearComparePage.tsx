import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import type { DwsYearOverYearCompare } from '../config/localApi'
import { fetchDwsYearOverYearCompare } from '../config/dwsDplusApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { DwsFilterBar } from './DwsFilterBar'
import { formatDwsAmount, formatDwsPct, useDwsFilters } from './useDwsFilters'
import { FlagAnalysisShell } from '../dm/FlagAnalysisShell'
import { useDwsPageAnalysisShell } from './useDwsPageAnalysisShell'
import { useDwsPageSavedUi } from './useDwsPageSavedUi'
import type { NavKey } from '../types'
import type { EmbedModeProps } from '../types/embedMode'

type Props = { onNav?: (key: NavKey) => void } & EmbedModeProps

export function YearOverYearComparePage({ onNav, embedMode }: Props) {
  const ui = t.yearOverYearUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const savedUi = useDwsPageSavedUi('year_over_year_compare', embedMode)
  const f = useDwsFilters(true, {
    entityPool: 'analysis',
    requireBuyer: true,
    initFromUrl: true,
    initialStatYear: urlQuery.stat_year ?? savedUi?.statYear,
    initialEntityId: urlQuery.entity_id ?? savedUi?.entityId,
    initialMinInvoiceCount: savedUi?.minInvoiceCount ?? undefined,
  })
  const [data, setData] = useState<DwsYearOverYearCompare | null>(null)
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
    host: 'year_over_year_compare',
    onNav,
    embedMode,
    onHostReturn,
    savedUi,
    persistUi: {
      statYear: f.effectiveYear,
      entityId: f.entityId,
      minInvoiceCount: f.minInvoiceCount,
      loading,
    },
  })

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!f.effectiveYear || !f.entityId.trim()) {
        setData(null)
        return
      }
      setLoading(true)
      setErr(null)
      try {
        const res = await fetchDwsYearOverYearCompare(
          { statYear: f.effectiveYear, entityId: f.entityId.trim() },
          signal,
        )
        if (signal?.aborted || res.aborted) return
        if (!res.ok) {
          setErr(res.error?.message ?? ui.loadFailed)
          setData(null)
          return
        }
        setData(res.data ?? null)
      } finally {
        setLoading(false)
      }
    },
    [f.effectiveYear, f.entityId, ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const priorYear = data?.prior_year ?? String(Number(f.effectiveYear) - 1)

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
          {onNav && f.entityId.trim() ? (
            <button
              type="button"
              className="mt-2 text-il-meta text-accent hover:underline"
              onClick={() =>
                goAnalysis('entity_profile', { statYear: f.effectiveYear, entityId: f.entityId.trim() })
              }
            >
              {ui.linkEntityProfile}
            </button>
          ) : null}
        </Card>

        {!f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : loading ? (
          <p className="text-il-meta text-text-3">{ui.loading}</p>
        ) : data ? (
          <>
            <Card title={ui.churnTitle}>
              <p className="text-il-page-desc text-text-2">
                {ui.churnHint
                  .replace('{new}', String(data.churn_summary?.new_total ?? 0))
                  .replace('{dis}', String(data.churn_summary?.disappeared_total ?? 0))
                  .replace('{prior}', priorYear)
                  .replace('{current}', data.stat_year)}
              </p>
            </Card>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card title={ui.taxBucketTitle.replace('{year}', data.stat_year)}>
                <CompareBucketList rows={data.tax_buckets?.current ?? []} />
              </Card>
              <Card title={ui.taxBucketTitle.replace('{year}', priorYear)}>
                <CompareBucketList rows={data.tax_buckets?.prior ?? []} />
              </Card>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card title={ui.supplierTitle.replace('{year}', data.stat_year)}>
                <CompareNamedAmount rows={data.top_suppliers?.current ?? []} nameKey="supplier_name" amtKey="net_jshj" />
              </Card>
              <Card title={ui.supplierTitle.replace('{year}', priorYear)}>
                <CompareNamedAmount rows={data.top_suppliers?.prior ?? []} nameKey="supplier_name" amtKey="net_jshj" />
              </Card>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card title={ui.customerTitle.replace('{year}', data.stat_year)}>
                <CompareNamedAmount rows={data.top_customers?.current ?? []} />
              </Card>
              <Card title={ui.customerTitle.replace('{year}', priorYear)}>
                <CompareNamedAmount rows={data.top_customers?.prior ?? []} />
              </Card>
            </div>
          </>
        ) : null}
      </div>
      {shellProps && !embedMode ? <FlagAnalysisShell {...shellProps} /> : null}
    </>
  )
}

function CompareBucketList({ rows }: { rows: Array<{ tax_bucket: string; amount_ratio: number }> }) {
  const ui = t.yearOverYearUi
  if (rows.length === 0) return <p className="text-il-meta text-text-3">{ui.noData}</p>
  return (
    <ul className="space-y-1 text-il-page-desc text-text-2">
      {rows.map((r) => (
        <li key={r.tax_bucket} className="flex justify-between gap-2">
          <span>{r.tax_bucket}</span>
          <span className="tabular-nums">{formatDwsPct(r.amount_ratio)}</span>
        </li>
      ))}
    </ul>
  )
}

function CompareNamedAmount({
  rows,
  nameKey,
  amtKey,
}: {
  rows: Array<Record<string, unknown>>
  nameKey?: string
  amtKey?: string
}) {
  const ui = t.yearOverYearUi
  if (rows.length === 0) return <p className="text-il-meta text-text-3">{ui.noData}</p>
  return (
    <ul className="space-y-1 text-il-page-desc text-text-2">
      {rows.map((r, i) => {
        const name = String(r[nameKey ?? 'name'] ?? r.supplier_name ?? r.id ?? i)
        const amt = Number(r[amtKey ?? 'amount'] ?? r.net_jshj ?? 0)
        return (
          <li key={`${name}-${i}`} className="flex justify-between gap-2">
            <span className="truncate">{name}</span>
            <span className="shrink-0 tabular-nums">{formatDwsAmount(amt)}</span>
          </li>
        )
      })}
    </ul>
  )
}
