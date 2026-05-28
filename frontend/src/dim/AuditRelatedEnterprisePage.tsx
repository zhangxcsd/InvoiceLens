import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchInvoiceCoverageMembers,
  fetchInvoiceCoverageMeta,
  fetchInvoiceCoverageSoeOptions,
  fetchInvoiceCoverageSummary,
  type InvoiceCoverageMemberRow,
  type InvoiceCoverageSoeOption,
} from '../config/localApi'

/** 与后端返回的年度合并本地近年份，避免「无集团成员表」时统计年度下拉被禁用。 */
function buildYearOptions(apiYears: string[]): string[] {
  const cy = new Date().getFullYear()
  const fallback = Array.from({ length: 16 }, (_, i) => String(cy - i))
  const s = new Set<string>()
  for (const x of apiYears) {
    const t = String(x ?? '').trim()
    if (t) s.add(t)
  }
  for (const x of fallback) s.add(x)
  return Array.from(s).sort((a, b) => Number(b) - Number(a))
}

export function AuditRelatedEnterprisePage() {
  const ui = t.auditRelatedEnterpriseUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState('')
  const [viewsReady, setViewsReady] = useState<boolean | null>(null)
  const [metaHint, setMetaHint] = useState<string | undefined>(undefined)
  const [level1Kw, setLevel1Kw] = useState('')
  const [soeSelectId, setSoeSelectId] = useState('')
  const [soeKw, setSoeKw] = useState('')
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')
  const [listView, setListView] = useState<'unreported' | 'reported' | 'all'>('unreported')
  const [soeOptions, setSoeOptions] = useState<InvoiceCoverageSoeOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [summary, setSummary] = useState<{
    member_row_count: number
    denominator_mapped_members: number
    reported_both_members: number
    unmapped_member_rows: number
    coverage_ratio: number | null
  } | null>(null)
  const [listRows, setListRows] = useState<InvoiceCoverageMemberRow[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listLimit, setListLimit] = useState(2000)

  const yearOptions = useMemo(() => buildYearOptions(statYears), [statYears])
  const effectiveStatYear = useMemo(() => {
    const t = statYear.trim()
    if (t && yearOptions.includes(t)) return t
    return yearOptions[0] ?? ''
  }, [statYear, yearOptions])

  const fetchParams = useMemo(
    () => ({
      statYear: effectiveStatYear,
      soeAnchorId: soeSelectId.trim(),
      soeAnchorKw: soeSelectId.trim() ? '' : soeKw.trim(),
      level1GroupKw: level1Kw.trim(),
      enterpriseKw: enterpriseKeyword.trim(),
    }),
    [effectiveStatYear, soeSelectId, soeKw, level1Kw, enterpriseKeyword],
  )

  const reloadMeta = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const m = await fetchInvoiceCoverageMeta(signal)
      if (signal?.aborted || m.aborted) return
      if (!m.ok) {
        setLoadErr(m.error?.message ?? '加载失败')
        setStatYears([])
        setViewsReady(false)
        return
      }
      setViewsReady(Boolean(m.views_ready))
      setMetaHint(m.hint)
      const ys = m.stat_years ?? []
      setStatYears(ys)
      const merged = buildYearOptions(ys)
      const defRaw = m.default_stat_year != null ? String(m.default_stat_year).trim() : ''
      const def =
        defRaw && merged.includes(defRaw) ? defRaw : (merged[0] ?? '')
      setStatYear((prev) => {
        const p = prev.trim()
        if (p && merged.includes(p)) return prev
        return def
      })
      if (!m.views_ready) setLoadErr(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadSoeOptions = useCallback(
    async (year: string, signal?: AbortSignal) => {
      if (!year) {
        setSoeOptions([])
        return
      }
      const o = await fetchInvoiceCoverageSoeOptions(year, signal)
      if (signal?.aborted || o.aborted) return
      if (o.ok && o.options) setSoeOptions(o.options)
      else setSoeOptions([])
    },
    [],
  )

  const reloadData = useCallback(
    async (signal?: AbortSignal) => {
      const y = fetchParams.statYear
      if (!y) {
        setSummary(null)
        setListRows([])
        setListTotal(0)
        setLoading(false)
        return
      }
      setLoading(true)
      setLoadErr(null)
      try {
        const [su, mem] = await Promise.all([
          fetchInvoiceCoverageSummary(fetchParams, signal),
          fetchInvoiceCoverageMembers({ ...fetchParams, listView, limit: 2000 }, signal),
        ])
        if (signal?.aborted) return
        if (!su.ok) {
          if (!su.aborted) {
            setLoadErr(su.error?.message ?? '汇总失败')
            setSummary(null)
          }
        } else {
          setViewsReady((v) => (su.views_ready != null ? Boolean(su.views_ready) : v))
          setSummary({
            member_row_count: su.member_row_count ?? 0,
            denominator_mapped_members: su.denominator_mapped_members ?? 0,
            reported_both_members: su.reported_both_members ?? 0,
            unmapped_member_rows: su.unmapped_member_rows ?? 0,
            coverage_ratio: su.coverage_ratio ?? null,
          })
        }
        if (!mem.ok) {
          if (!mem.aborted) {
            setLoadErr(mem.error?.message ?? '列表失败')
            setListRows([])
            setListTotal(0)
          }
        } else {
          setListRows(mem.rows ?? [])
          setListTotal(mem.total ?? 0)
          setListLimit(mem.limit ?? 2000)
        }
      } finally {
        setLoading(false)
      }
    },
    [fetchParams, listView],
  )

  useEffect(() => {
    const ac = new AbortController()
    void reloadMeta(ac.signal)
    return () => ac.abort()
  }, [reloadMeta])

  useEffect(() => {
    const ac = new AbortController()
    if (effectiveStatYear) void reloadSoeOptions(effectiveStatYear, ac.signal)
    return () => ac.abort()
  }, [effectiveStatYear, reloadSoeOptions])

  useEffect(() => {
    const ac = new AbortController()
    void reloadData(ac.signal)
    return () => ac.abort()
  }, [reloadData])

  const coverageRateStr = useMemo(() => {
    if (!summary) return '—'
    if (summary.coverage_ratio == null) return '—'
    return `${(summary.coverage_ratio * 100).toFixed(2)}%`
  }, [summary])

  const pendingInDenominator = useMemo(() => {
    if (!summary) return 0
    const d = summary.denominator_mapped_members
    const r = summary.reported_both_members
    return Math.max(0, d - r)
  }, [summary])

  const currentListTitle =
    listView === 'reported'
      ? ui.reportedTitle
      : listView === 'all'
        ? ui.allListTitle
        : ui.unreportedTitle
  const currentListHint =
    listView === 'reported'
      ? ui.reportedHint.replace('{year}', effectiveStatYear || '—').replace('{count}', String(listTotal))
      : listView === 'all'
        ? ui.allListHint.replace('{year}', effectiveStatYear || '—').replace('{count}', String(listTotal))
        : ui.unreportedHint.replace('{year}', effectiveStatYear || '—').replace('{count}', String(listTotal))

  const hasApiGroupYears = statYears.length > 0
  const emptyListMessage =
    viewsReady === false || viewsReady === null
      ? ui.emptyByData
      : viewsReady && !hasApiGroupYears
        ? ui.emptyNoGroupYear
        : ui.emptyByFilter
  const showBadge = String(ui.prototypeBadge ?? '').trim().length > 0

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
          {showBadge ? (
            <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
              {ui.prototypeBadge}
            </span>
          ) : null}
        </div>
        <p className="mt-2 max-w-[820px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
        <p className="mt-2 text-il-meta text-text-3">{ui.prototypeNote}</p>
        {metaHint ? <p className="mt-2 text-il-meta text-amber-800">{metaHint}</p> : null}
        {loadErr ? <p className="mt-2 text-il-meta text-red-600">{loadErr}</p> : null}
        {loading ? <p className="mt-2 text-il-meta text-text-3">加载中…</p> : null}
      </div>

      <Card title={ui.compareTitle}>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-3 sm:gap-y-3">
          <div className="w-full shrink-0 sm:w-[7.25rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.compareYearLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={effectiveStatYear}
              onChange={(e) => setStatYear(e.target.value)}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="w-full shrink-0 sm:w-[15.5rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.compareGroupLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={level1Kw}
              onChange={(e) => setLevel1Kw(e.target.value)}
              placeholder={ui.compareGroupPlaceholder}
            />
          </div>
          <div className="w-full shrink-0 sm:w-[15.5rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">国家出资企业（精确）</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={soeSelectId}
              onChange={(e) => setSoeSelectId(e.target.value)}
              disabled={!effectiveStatYear}
            >
              <option value="">全部（不按锚点过滤）</option>
              {soeOptions.map((o) => (
                <option key={o.soe_anchor_enterprise_id} value={o.soe_anchor_enterprise_id}>
                  {o.soe_anchor_enterprise_name || o.soe_anchor_enterprise_id}
                </option>
              ))}
            </select>
          </div>
          <div className="w-full shrink-0 sm:w-[15.5rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.compareStateInvestorLabel}（关键字）</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={soeKw}
              onChange={(e) => setSoeKw(e.target.value)}
              placeholder={ui.compareStateInvestorPlaceholder}
              disabled={Boolean(soeSelectId.trim())}
            />
          </div>
          <div className="min-w-0 w-full flex-1 sm:min-w-[12rem]">
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.enterpriseFilterLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={enterpriseKeyword}
              onChange={(e) => setEnterpriseKeyword(e.target.value)}
              placeholder={ui.enterpriseFilterPlaceholder}
            />
          </div>
        </div>
        <div className="mb-3 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">
          {ui.compareCaliberHint.replace('{year}', effectiveStatYear || '—')}
        </div>
        <div className="rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2.5">
          <div className="mb-2 text-il-label text-text-3">{ui.coreMetricsTitle}</div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: ui.auditKpiAll, value: summary ? String(summary.member_row_count) : '—' },
              { label: ui.auditKpiRelated, value: summary ? String(summary.reported_both_members) : '—' },
              { label: ui.auditKpiUnreported, value: summary ? String(pendingInDenominator) : '—' },
              { label: ui.compareCoverageLabel, value: coverageRateStr },
            ].map((item) => (
              <div key={item.label}>
                <div className="text-il-label text-text-3">{item.label}</div>
                <div className="mt-1 text-[16px] font-semibold tabular-nums text-text">{item.value}</div>
              </div>
            ))}
          </div>
          {summary && summary.unmapped_member_rows > 0 ? (
            <div className="mt-2 text-il-meta text-text-3">
              未映射到主体库 org 的成员行：{summary.unmapped_member_rows}（不参与覆盖率分母）
            </div>
          ) : null}
        </div>
      </Card>

      <Card title={currentListTitle}>
        <div className="mb-3 flex items-center gap-2">
          {[
            { key: 'unreported' as const, label: ui.listViewUnreported },
            { key: 'reported' as const, label: ui.listViewReported },
            { key: 'all' as const, label: ui.listViewAll },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={[
                'rounded-sm border px-2.5 py-1 text-il-page-desc transition-colors',
                listView === item.key
                  ? 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
                  : 'border-border bg-white text-text-2 hover:border-accent hover:text-accent',
              ].join(' ')}
              onClick={() => setListView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mb-2 text-il-meta text-text-3">{currentListHint}</div>
        {listTotal > listLimit ? (
          <div className="mb-2 text-il-meta text-amber-800">
            当前仅展示前 {listLimit} 条，共命中 {listTotal} 条，请缩小筛选条件。
          </div>
        ) : null}
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1320px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colEnterpriseName}</th>
                <th className="px-3 py-2 font-medium">{ui.colTaxpayerId}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColStateInvestor}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColMgmtLevel}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColMgmtParent}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColPropertyLevel}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColPropertyParent}</th>
                <th className="px-3 py-2 font-medium">{ui.unreportedColLastBatch}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {listRows.length > 0 ? (
                listRows.map((row) => (
                  <tr key={`${row.enterprise_id}_${row.soe_anchor_enterprise_id}`} className="border-b border-border-light last:border-b-0">
                    <td className="px-3 py-2.5 font-medium text-text">{row.enterprise_name || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.enterprise_id || '—'}</td>
                    <td className="px-3 py-2.5">{row.soe_anchor_enterprise_name || row.soe_anchor_enterprise_id || '—'}</td>
                    <td className="px-3 py-2.5">{row.mgmt_level != null ? row.mgmt_level : '—'}</td>
                    <td className="px-3 py-2.5">{row.mgmt_parent_enterprise_name || '—'}</td>
                    <td className="px-3 py-2.5">{row.equity_level != null ? row.equity_level : '—'}</td>
                    <td className="px-3 py-2.5">{row.equity_parent_enterprise_name || '—'}</td>
                    <td className="px-3 py-2.5">{row.year_last_seen_batch_id || '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-3 py-6 text-center text-text-3" colSpan={8}>
                    {emptyListMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
