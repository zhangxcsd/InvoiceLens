import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchEnterpriseYearRosterBootstrap,
  fetchEnterpriseYearRosterKpi,
  fetchEnterpriseYearRosterList,
  postEnterpriseYearRosterRebuild,
  type EnterpriseYearRosterRow,
} from '../config/localApi'
import { DimTablePagination } from './DimTablePagination'
import {
  cellOrDash,
  DIM_TABLE_BASE,
  DIM_TABLE_SCROLL_WRAPPER,
  DIM_TABLE_TH_STICKY,
} from './dimDataTableShared'

const TABLE_COL_COUNT = 8
const FILTER_DEBOUNCE_MS = 320

type RosterKpi = {
  groups: number
  members: number
  active: number
  conflict: number
}

const EMPTY_KPI: RosterKpi = { groups: 0, members: 0, active: 0, conflict: 0 }

function kpiFromApi(r: {
  group_count?: number
  total_members?: number
  active_member_count?: number
  conflict_count?: number
}): RosterKpi {
  return {
    groups: r.group_count ?? 0,
    members: r.total_members ?? 0,
    active: r.active_member_count ?? 0,
    conflict: r.conflict_count ?? 0,
  }
}

export function EnterpriseYearRosterPage(props: { onNav?: (key: string) => void }) {
  const ui = t.enterpriseYearRosterUi
  const tableUi = t.dimDataTableUi
  const [yearOptions, setYearOptions] = useState<string[]>([])
  const [statYear, setStatYear] = useState('')
  const [ready, setReady] = useState(false)
  const [stateInvestorKw, setStateInvestorKw] = useState('')
  const [enterpriseKw, setEnterpriseKw] = useState('')
  const [debouncedStateInvestorKw, setDebouncedStateInvestorKw] = useState('')
  const [debouncedEnterpriseKw, setDebouncedEnterpriseKw] = useState('')
  const [kpi, setKpi] = useState<RosterKpi>(EMPTY_KPI)
  const [rows, setRows] = useState<EnterpriseYearRosterRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [summaryBusy, setSummaryBusy] = useState(true)
  const [listBusy, setListBusy] = useState(true)
  const [rebuildBusy, setRebuildBusy] = useState(false)
  const [summaryErr, setSummaryErr] = useState('')
  const [listErr, setListErr] = useState('')
  const [rebuildMsg, setRebuildMsg] = useState('')
  const skipSubsequentLoadRef = useRef(false)
  const prevYearRef = useRef('')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedStateInvestorKw(stateInvestorKw)
      setDebouncedEnterpriseKw(enterpriseKw)
    }, FILTER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [stateInvestorKw, enterpriseKw])

  const effectiveYear = useMemo(() => {
    if (!ready) return ''
    const y = statYear.trim()
    if (y && yearOptions.includes(y)) return y
    return yearOptions[0] ?? String(new Date().getFullYear())
  }, [ready, statYear, yearOptions])

  const loadKpi = useCallback(
    async (year: string, signal?: AbortSignal) => {
      setSummaryBusy(true)
      const r = await fetchEnterpriseYearRosterKpi({ statYear: year }, signal)
      if (signal?.aborted) return
      setSummaryBusy(false)
      if (!r.ok) {
        setSummaryErr(r.error?.message ?? ui.loadFailed)
        setKpi(EMPTY_KPI)
        return
      }
      setSummaryErr('')
      setKpi(kpiFromApi(r))
    },
    [ui.loadFailed],
  )

  const loadList = useCallback(
    async (
      year: string,
      filters: { stateInvestorKw: string; enterpriseKw: string },
      paging: { page: number; pageSize: number },
      signal?: AbortSignal,
    ) => {
      setListBusy(true)
      const r = await fetchEnterpriseYearRosterList(
        {
          statYear: year,
          stateInvestorKw: filters.stateInvestorKw,
          enterpriseKw: filters.enterpriseKw,
          limit: paging.pageSize,
          offset: (paging.page - 1) * paging.pageSize,
        },
        signal,
      )
      if (signal?.aborted) return
      setListBusy(false)
      if (!r.ok) {
        setListErr(r.error?.message ?? ui.loadFailed)
        setRows([])
        setTotal(0)
        return
      }
      setListErr('')
      setRows(r.rows ?? [])
      setTotal(r.total ?? 0)
    },
    [ui.loadFailed],
  )

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      setSummaryBusy(true)
      setListBusy(true)
      setSummaryErr('')
      setListErr('')
      const r = await fetchEnterpriseYearRosterBootstrap({ limit: pageSize, offset: 0 }, ac.signal)
      if (ac.signal.aborted) return
      setSummaryBusy(false)
      setListBusy(false)
      if (!r.ok) {
        setSummaryErr(r.error?.message ?? ui.loadFailed)
        setReady(true)
        return
      }
      const opts = r.stat_years?.length ? r.stat_years : r.data_stat_years ?? []
      setYearOptions(opts)
      const def = r.default_stat_year ?? opts[0] ?? ''
      setStatYear((prev) => (prev && opts.includes(prev) ? prev : def))
      setKpi(kpiFromApi(r))
      setRows(r.rows ?? [])
      setTotal(r.total ?? 0)
      prevYearRef.current = def
      skipSubsequentLoadRef.current = true
      setReady(true)
    })()
    return () => ac.abort()
  }, [pageSize, ui.loadFailed])

  useEffect(() => {
    if (!ready || !effectiveYear) return
    if (skipSubsequentLoadRef.current) {
      skipSubsequentLoadRef.current = false
      return
    }
    const ac = new AbortController()
    void loadList(
      effectiveYear,
      { stateInvestorKw: debouncedStateInvestorKw, enterpriseKw: debouncedEnterpriseKw },
      { page, pageSize },
      ac.signal,
    )
    return () => ac.abort()
  }, [ready, effectiveYear, debouncedStateInvestorKw, debouncedEnterpriseKw, page, pageSize, loadList])

  useEffect(() => {
    if (!ready || !effectiveYear) return
    if (prevYearRef.current === effectiveYear) return
    prevYearRef.current = effectiveYear
    if (skipSubsequentLoadRef.current) return
    const ac = new AbortController()
    void loadKpi(effectiveYear, ac.signal)
    return () => ac.abort()
  }, [ready, effectiveYear, loadKpi])

  useEffect(() => {
    setPage(1)
  }, [effectiveYear, debouncedStateInvestorKw, debouncedEnterpriseKw, pageSize])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const effectivePage = Math.min(page, totalPages)

  useEffect(() => {
    if (page !== effectivePage) setPage(effectivePage)
  }, [effectivePage, page])

  const rebuild = async () => {
    setRebuildBusy(true)
    setRebuildMsg('')
    setSummaryErr('')
    setListErr('')
    const y = parseInt(effectiveYear, 10)
    const r = await postEnterpriseYearRosterRebuild({
      statYears: Number.isFinite(y) ? [y] : undefined,
      replaceYears: true,
    })
    setRebuildBusy(false)
    if (!r.ok) {
      setSummaryErr(r.error?.message ?? ui.rebuildFailed)
      return
    }
    setRebuildMsg(ui.rebuildSuccess.replace('{rows}', String(r.rows_written ?? 0)))
    setPage(1)
    await Promise.all([
      loadKpi(effectiveYear),
      loadList(
        effectiveYear,
        { stateInvestorKw: debouncedStateInvestorKw, enterpriseKw: debouncedEnterpriseKw },
        { page: 1, pageSize },
      ),
    ])
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageNote}
        note={ui.pageDesc}
        noteTone="plain"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
              onClick={() => props.onNav?.('dim_audited_registry')}
            >
              {ui.goRegistry}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
              onClick={() => props.onNav?.('processing_derived_dim_tasks')}
            >
              {ui.goProcessing}
            </button>
            <button
              type="button"
              className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-meta font-medium text-white disabled:opacity-50"
              disabled={rebuildBusy}
              onClick={() => void rebuild()}
            >
              {rebuildBusy ? ui.rebuilding : ui.rebuildBtn}
            </button>
          </div>
        }
      />

      {rebuildMsg ? <p className="mb-2 text-il-meta text-[#1b6b3a]">{rebuildMsg}</p> : null}
      {summaryErr ? <p className="mb-3 text-il-meta text-red-600">{summaryErr}</p> : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta shadow-sm">
          <span className="font-medium text-accent-mid">{ui.statYearLabel}</span>
          <select
            className="cursor-pointer rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-page-desc font-semibold tabular-nums text-accent outline-none focus:border-accent"
            value={effectiveYear}
            onChange={(e) => setStatYear(e.target.value)}
            disabled={!ready}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <span className="text-il-meta text-text-3">{ui.kpiScopeHint.replace('{year}', effectiveYear || '…')}</span>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [ui.kpiGroups, kpi.groups],
          [ui.kpiMembers, kpi.members],
          [ui.kpiActive, kpi.active],
          [ui.kpiConflicts, kpi.conflict],
        ].map(([label, val]) => (
          <div key={String(label)} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{label}</div>
            <div className="mt-1 text-[20px] font-bold tabular-nums text-text">
              {summaryBusy ? '…' : val}
            </div>
          </div>
        ))}
      </div>

      <Card title={ui.listTitle}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="text-il-meta text-text-3">
            {listBusy ? '…' : ui.listHint.replace('{year}', effectiveYear).replace('{count}', String(total))}
          </div>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.stateInvestorFilterLabel}
            <input
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={stateInvestorKw}
              onChange={(e) => setStateInvestorKw(e.target.value)}
              placeholder={ui.stateInvestorFilterPlaceholder}
            />
          </label>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.enterpriseKwLabel}
            <input
              className="min-w-[360px] rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={enterpriseKw}
              onChange={(e) => setEnterpriseKw(e.target.value)}
              placeholder={ui.enterpriseKwPlaceholder}
            />
          </label>
        </div>

        {listErr ? <p className="mb-3 text-il-meta text-red-600">{listErr}</p> : null}

        <div className={DIM_TABLE_SCROLL_WRAPPER}>
          <table className={`${DIM_TABLE_BASE} min-w-[1080px]`}>
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th className={`${DIM_TABLE_TH_STICKY} w-[52px]`}>{ui.colSeqNo}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colStatYear}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colEnterpriseId}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colEnterpriseName}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colStateInvestor}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colActive}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colQuality}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colQualityIssue}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {listBusy ? (
                <tr>
                  <td colSpan={TABLE_COL_COUNT} className="px-3 py-8 text-center text-il-page-desc text-text-3">
                    {tableUi.tableLoading}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={TABLE_COL_COUNT} className="px-3 py-8 text-center text-il-page-desc text-text-3">
                    {kpi.members > 0 ? ui.emptyFiltered : ui.emptyYear}
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const seqNo = (effectivePage - 1) * pageSize + index + 1
                  return (
                    <tr
                      key={`${row.enterprise_id}-${seqNo}`}
                      className="border-b border-border-light last:border-b-0"
                    >
                      <td className="px-3 py-2.5 tabular-nums text-text-3">{seqNo}</td>
                      <td className="px-3 py-2.5 tabular-nums">{effectiveYear}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-text">{cellOrDash(row.enterprise_id)}</td>
                      <td className="px-3 py-2.5 font-medium text-text">{cellOrDash(row.enterprise_name)}</td>
                      <td className="px-3 py-2.5 max-w-[220px]" title={row.state_investor}>
                        {cellOrDash(row.state_investor)}
                      </td>
                      <td className="px-3 py-2.5">{row.is_member ? '是' : '否'}</td>
                      <td className="px-3 py-2.5">
                        {row.quality_status === 'conflict' ? ui.qualityConflict : ui.qualityOk}
                      </td>
                      <td className="max-w-[240px] truncate px-3 py-2.5 text-text-3" title={row.quality_issue}>
                        {cellOrDash(row.quality_issue)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <DimTablePagination
          total={total}
          page={page}
          pageSize={pageSize}
          loading={listBusy}
          ui={tableUi}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  )
}
