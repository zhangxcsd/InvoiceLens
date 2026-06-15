import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchEnterpriseYearRosterBootstrap,
  fetchEnterpriseYearRosterConsistency,
  fetchEnterpriseYearRosterKpi,
  fetchEnterpriseYearRosterList,
  postEnterpriseYearRosterCopyExecute,
  postEnterpriseYearRosterCopyPreview,
  postEnterpriseYearRosterManualDelete,
  postEnterpriseYearRosterManualUpsert,
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
import { useDimDict } from './useDimDict'
import {
  rosterDataSourceBadgeClass,
  rosterDataSourceCode,
  rosterQualityStatusBadgeClass,
} from './dimDictHelpers'

const TABLE_COL_COUNT = 10
const FILTER_DEBOUNCE_MS = 320

type RosterKpi = {
  groups: number
  members: number
  active: number
  conflict: number
}

const EMPTY_KPI: RosterKpi = { groups: 0, members: 0, active: 0, conflict: 0 }

type ManualTextField = 'enterpriseId' | 'enterpriseName' | 'stateInvestor' | 'stateInvestorCode' | 'manualNote'

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

function canDeleteManual(row: EnterpriseYearRosterRow): boolean {
  return Boolean(row.in_manual) && !row.in_registry
}

export function EnterpriseYearRosterPage(props: { onNav?: (key: string) => void }) {
  const ui = t.enterpriseYearRosterUi
  const tableUi = t.dimDataTableUi
  const dimDict = useDimDict()
  const dataSourceFilterOptions = useMemo(() => {
    const opts = dimDict.getOptions('roster_data_source')
    return [{ code: '', label: ui.dataSourceAll }, ...opts]
  }, [dimDict.domains, dimDict.getOptions, ui.dataSourceAll])
  const [yearOptions, setYearOptions] = useState<string[]>([])
  const [statYear, setStatYear] = useState('')
  const [ready, setReady] = useState(false)
  const [stateInvestorKw, setStateInvestorKw] = useState('')
  const [enterpriseKw, setEnterpriseKw] = useState('')
  const [dataSourceFilter, setDataSourceFilter] = useState('')
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
  const [consistencyBusy, setConsistencyBusy] = useState(false)
  const [consistencyMsg, setConsistencyMsg] = useState('')
  const [actionMsg, setActionMsg] = useState('')
  const skipSubsequentLoadRef = useRef(false)
  const prevYearRef = useRef('')

  const [showManualModal, setShowManualModal] = useState(false)
  const [manualBusy, setManualBusy] = useState(false)
  const [manualForm, setManualForm] = useState({
    enterpriseId: '',
    enterpriseName: '',
    stateInvestor: '',
    stateInvestorCode: '',
    isMember: true,
    manualNote: '',
  })

  const [showCopyModal, setShowCopyModal] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [copySourceYear, setCopySourceYear] = useState('')
  const [copyIncludePending, setCopyIncludePending] = useState(false)
  const [copyOverwriteManual, setCopyOverwriteManual] = useState(false)
  const [copyFillEmptyRegistry, setCopyFillEmptyRegistry] = useState(false)
  const [copyPreviewText, setCopyPreviewText] = useState('')

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

  const defaultCopySourceYear = useMemo(() => {
    const y = parseInt(effectiveYear, 10)
    if (!Number.isFinite(y)) return ''
    const prev = String(y - 1)
    return yearOptions.includes(prev) ? prev : ''
  }, [effectiveYear, yearOptions])

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
      filters: { stateInvestorKw: string; enterpriseKw: string; dataSource: string },
      paging: { page: number; pageSize: number },
      signal?: AbortSignal,
    ) => {
      setListBusy(true)
      const r = await fetchEnterpriseYearRosterList(
        {
          statYear: year,
          stateInvestorKw: filters.stateInvestorKw,
          enterpriseKw: filters.enterpriseKw,
          dataSource: filters.dataSource,
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

  const reloadAll = useCallback(
    async (year: string, paging: { page: number; pageSize: number }) => {
      await Promise.all([
        loadKpi(year),
        loadList(
          year,
          {
            stateInvestorKw: debouncedStateInvestorKw,
            enterpriseKw: debouncedEnterpriseKw,
            dataSource: dataSourceFilter,
          },
          paging,
        ),
      ])
    },
    [loadKpi, loadList, debouncedStateInvestorKw, debouncedEnterpriseKw, dataSourceFilter],
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
      {
        stateInvestorKw: debouncedStateInvestorKw,
        enterpriseKw: debouncedEnterpriseKw,
        dataSource: dataSourceFilter,
      },
      { page, pageSize },
      ac.signal,
    )
    return () => ac.abort()
  }, [
    ready,
    effectiveYear,
    debouncedStateInvestorKw,
    debouncedEnterpriseKw,
    dataSourceFilter,
    page,
    pageSize,
    loadList,
  ])

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
  }, [effectiveYear, debouncedStateInvestorKw, debouncedEnterpriseKw, dataSourceFilter, pageSize])

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
      replaceYears: false,
    })
    setRebuildBusy(false)
    if (!r.ok) {
      setSummaryErr(r.error?.message ?? ui.rebuildFailed)
      return
    }
    setRebuildMsg(ui.rebuildSuccess.replace('{rows}', String(r.rows_written ?? 0)))
    setPage(1)
    await reloadAll(effectiveYear, { page: 1, pageSize })
  }

  const runConsistencyCheck = async (repair: boolean) => {
    setConsistencyBusy(true)
    setConsistencyMsg('')
    setSummaryErr('')
    const r = await fetchEnterpriseYearRosterConsistency({ statYear: effectiveYear, repair })
    setConsistencyBusy(false)
    if (r.error?.message && !r.checks?.length) {
      setSummaryErr(r.error.message)
      return
    }
    const parts: string[] = []
    if (repair && (r.repaired_rows ?? 0) > 0) {
      parts.push(ui.consistencyRepaired.replace('{n}', String(r.repaired_rows)))
    }
    if (r.ok) {
      parts.push(ui.consistencyPass.replace('{year}', effectiveYear))
    } else {
      parts.push(ui.consistencyFail.replace('{count}', String(r.hard_fail_count ?? 0)))
    }
    setConsistencyMsg(parts.join('；'))
    if (repair && r.ok) {
      await reloadAll(effectiveYear, { page, pageSize })
    }
  }

  const openManualModal = () => {
    setManualForm({
      enterpriseId: '',
      enterpriseName: '',
      stateInvestor: '',
      stateInvestorCode: '',
      isMember: true,
      manualNote: '',
    })
    setShowManualModal(true)
  }

  const saveManual = async () => {
    if (!manualForm.enterpriseId.trim()) return
    setManualBusy(true)
    setActionMsg('')
    const r = await postEnterpriseYearRosterManualUpsert({
      statYear: effectiveYear,
      enterpriseId: manualForm.enterpriseId.trim(),
      enterpriseName: manualForm.enterpriseName.trim(),
      stateInvestor: manualForm.stateInvestor.trim(),
      stateInvestorUnifiedCreditCode: manualForm.stateInvestorCode.trim() || undefined,
      isMember: manualForm.isMember,
      manualNote: manualForm.manualNote.trim() || undefined,
    })
    setManualBusy(false)
    if (!r.ok) {
      setActionMsg(r.error?.message ?? ui.manualSaveFailed)
      return
    }
    setShowManualModal(false)
    setActionMsg(ui.manualSaveSuccess)
    setPage(1)
    await reloadAll(effectiveYear, { page: 1, pageSize })
  }

  const deleteManualRow = async (row: EnterpriseYearRosterRow) => {
    if (!canDeleteManual(row)) return
    if (!window.confirm(ui.deleteConfirm)) return
    setActionMsg('')
    const r = await postEnterpriseYearRosterManualDelete({
      statYear: effectiveYear,
      enterpriseId: row.enterprise_id,
    })
    if (!r.ok) {
      setActionMsg(r.error?.message ?? ui.manualDeleteFailed)
      return
    }
    await reloadAll(effectiveYear, { page, pageSize })
  }

  const openCopyModal = () => {
    setCopySourceYear(defaultCopySourceYear)
    setCopyIncludePending(false)
    setCopyOverwriteManual(false)
    setCopyFillEmptyRegistry(false)
    setCopyPreviewText('')
    setShowCopyModal(true)
  }

  const previewCopy = async () => {
    if (!copySourceYear || copySourceYear === effectiveYear) return
    setCopyBusy(true)
    const r = await postEnterpriseYearRosterCopyPreview({
      sourceYear: copySourceYear,
      targetYear: effectiveYear,
      includePending: copyIncludePending,
    })
    setCopyBusy(false)
    if (!r.ok) {
      setCopyPreviewText(r.error?.message ?? ui.copyFailed)
      return
    }
    setCopyPreviewText(
      ui.copyPreviewResult
        .replace('{source}', r.source_year ?? copySourceYear)
        .replace('{sourceCount}', String(r.source_row_count ?? 0))
        .replace('{target}', r.target_year ?? effectiveYear)
        .replace('{insert}', String(r.to_insert_count ?? 0))
        .replace('{skip}', String(r.to_skip_count ?? 0))
        .replace('{conflict}', String(r.conflict_hint_count ?? 0)),
    )
  }

  const executeCopy = async () => {
    if (!copySourceYear || copySourceYear === effectiveYear) return
    setCopyBusy(true)
    const r = await postEnterpriseYearRosterCopyExecute({
      sourceYear: copySourceYear,
      targetYear: effectiveYear,
      includePending: copyIncludePending,
      overwriteManual: copyOverwriteManual,
      fillEmptyRegistry: copyFillEmptyRegistry,
    })
    setCopyBusy(false)
    if (!r.ok) {
      setCopyPreviewText(r.error?.message ?? ui.copyFailed)
      return
    }
    setShowCopyModal(false)
    setActionMsg(
      ui.copyExecuteSuccess
        .replace('{inserted}', String(r.inserted ?? 0))
        .replace('{updated}', String(r.updated ?? 0))
        .replace('{skipped}', String(r.skipped ?? 0)),
    )
    setPage(1)
    await reloadAll(effectiveYear, { page: 1, pageSize })
  }

  const inputClass =
    'w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent'

  const manualTextFields: { label: string; key: ManualTextField }[] = [
    { label: ui.fieldEnterpriseId, key: 'enterpriseId' },
    { label: ui.fieldEnterpriseName, key: 'enterpriseName' },
    { label: ui.fieldStateInvestor, key: 'stateInvestor' },
    { label: ui.fieldStateInvestorCode, key: 'stateInvestorCode' },
    { label: ui.fieldManualNote, key: 'manualNote' },
  ]

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
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
              onClick={openManualModal}
            >
              {ui.addManualBtn}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
              onClick={openCopyModal}
              disabled={!defaultCopySourceYear}
            >
              {ui.copyFromPrevBtn}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc] disabled:opacity-50"
              disabled={consistencyBusy || !effectiveYear}
              onClick={() => void runConsistencyCheck(false)}
            >
              {consistencyBusy ? ui.consistencyChecking : ui.consistencyCheckBtn}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc] disabled:opacity-50"
              disabled={consistencyBusy || !effectiveYear}
              onClick={() => void runConsistencyCheck(true)}
            >
              {ui.consistencyRepairBtn}
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
      {consistencyMsg ? <p className="mb-2 text-il-meta text-text-2">{consistencyMsg}</p> : null}
      {actionMsg ? <p className="mb-2 text-il-meta text-[#1b6b3a]">{actionMsg}</p> : null}
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
            <div className="mt-1 text-[20px] font-bold tabular-nums text-text">{summaryBusy ? '…' : val}</div>
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
              className="min-w-[280px] rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={enterpriseKw}
              onChange={(e) => setEnterpriseKw(e.target.value)}
              placeholder={ui.enterpriseKwPlaceholder}
            />
          </label>
          <label className="flex items-center gap-2 text-il-label text-text-2">
            {ui.dataSourceFilterLabel}
            <select
              className="rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={dataSourceFilter}
              onChange={(e) => setDataSourceFilter(e.target.value)}
            >
              {dataSourceFilterOptions.map((opt) => (
                <option key={opt.code || 'all'} value={opt.code}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {listErr ? <p className="mb-3 text-il-meta text-red-600">{listErr}</p> : null}

        <div className={DIM_TABLE_SCROLL_WRAPPER}>
          <table className={`${DIM_TABLE_BASE} min-w-[1200px]`}>
            <thead>
              <tr className="text-left text-il-label text-text-3">
                <th className={`${DIM_TABLE_TH_STICKY} w-[52px]`}>{ui.colSeqNo}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colStatYear}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colEnterpriseId}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colEnterpriseName}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colStateInvestor}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colActive}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colSource}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colQuality}</th>
                <th className={DIM_TABLE_TH_STICKY}>{ui.colQualityIssue}</th>
                <th className={`${DIM_TABLE_TH_STICKY} w-[72px]`}>{ui.colActions}</th>
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
                  const sourceCode = rosterDataSourceCode(row)
                  const qualityCode = (row.quality_status || 'ok').trim() || 'ok'
                  const sourceLabel = sourceCode
                    ? dimDict.getLabel('roster_data_source', sourceCode)
                    : '—'
                  const qualityLabel = dimDict.getLabel('roster_quality_status', qualityCode)
                  return (
                    <tr
                      key={`${row.enterprise_id}-${seqNo}`}
                      className="border-b border-border-light last:border-b-0"
                    >
                      <td className="px-3 py-2.5 tabular-nums text-text-3">{seqNo}</td>
                      <td className="px-3 py-2.5 tabular-nums">{effectiveYear}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-text">{cellOrDash(row.enterprise_id)}</td>
                      <td className="px-3 py-2.5 font-medium text-text">{cellOrDash(row.enterprise_name)}</td>
                      <td className="max-w-[220px] px-3 py-2.5" title={row.state_investor}>
                        {cellOrDash(row.state_investor)}
                      </td>
                      <td className="px-3 py-2.5">{row.is_member ? '是' : '否'}</td>
                      <td className="px-3 py-2.5 text-il-meta">
                        {sourceCode ? (
                          <span
                            className={[
                              'inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold',
                              rosterDataSourceBadgeClass(sourceCode),
                            ].join(' ')}
                          >
                            {sourceLabel}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={[
                            'inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold',
                            rosterQualityStatusBadgeClass(qualityCode),
                          ].join(' ')}
                        >
                          {qualityLabel}
                        </span>
                      </td>
                      <td
                        className="max-w-[220px] truncate px-3 py-2.5 text-text-3"
                        title={row.quality_issue || row.manual_note}
                      >
                        {cellOrDash(row.quality_issue || row.manual_note)}
                      </td>
                      <td className="px-3 py-2.5">
                        {canDeleteManual(row) ? (
                          <button
                            type="button"
                            className="text-il-meta text-red-600 hover:underline"
                            onClick={() => void deleteManualRow(row)}
                          >
                            {ui.deleteManualBtn}
                          </button>
                        ) : (
                          '—'
                        )}
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

      {showManualModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[10px] border border-border-light bg-white p-5 shadow-lg">
            <h3 className="text-[16px] font-semibold text-text">{ui.manualModalTitle}</h3>
            <p className="mt-2 text-il-meta text-text-3">{ui.manualModalHint}</p>
            <div className="mt-4 space-y-3">
              {manualTextFields.map(({ label, key }) => (
                <label key={key} className="block text-il-label text-text-2">
                  {label}
                  <input
                    className={`${inputClass} mt-1`}
                    value={manualForm[key]}
                    onChange={(e) => setManualForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </label>
              ))}
              <label className="flex items-center gap-2 text-il-label text-text-2">
                <input
                  type="checkbox"
                  checked={manualForm.isMember}
                  onChange={(e) => setManualForm((f) => ({ ...f, isMember: e.target.checked }))}
                />
                {ui.fieldIsMember}
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-sm border border-border-light px-3 py-1.5 text-il-meta text-text"
                onClick={() => setShowManualModal(false)}
              >
                {ui.manualCancelBtn}
              </button>
              <button
                type="button"
                className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-meta font-medium text-white disabled:opacity-50"
                disabled={manualBusy || !manualForm.enterpriseId.trim()}
                onClick={() => void saveManual()}
              >
                {ui.manualSaveBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCopyModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[10px] border border-border-light bg-white p-5 shadow-lg">
            <h3 className="text-[16px] font-semibold text-text">{ui.copyModalTitle}</h3>
            <p className="mt-2 text-il-meta text-text-3">{ui.copyModalHint}</p>
            <div className="mt-4 space-y-3">
              <label className="block text-il-label text-text-2">
                {ui.copySourceYearLabel}
                <select
                  className={`${inputClass} mt-1`}
                  value={copySourceYear}
                  onChange={(e) => setCopySourceYear(e.target.value)}
                >
                  <option value="">—</option>
                  {yearOptions
                    .filter((y) => y !== effectiveYear)
                    .map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                </select>
              </label>
              <div className="text-il-meta text-text-3">
                {ui.copyTargetYearLabel}：{effectiveYear}
              </div>
              <label className="flex items-center gap-2 text-il-label text-text-2">
                <input
                  type="checkbox"
                  checked={copyIncludePending}
                  onChange={(e) => setCopyIncludePending(e.target.checked)}
                />
                {ui.copyIncludePending}
              </label>
              <label className="flex items-center gap-2 text-il-label text-text-2">
                <input
                  type="checkbox"
                  checked={copyOverwriteManual}
                  onChange={(e) => setCopyOverwriteManual(e.target.checked)}
                />
                {ui.copyOverwriteManual}
              </label>
              <label className="flex items-center gap-2 text-il-label text-text-2">
                <input
                  type="checkbox"
                  checked={copyFillEmptyRegistry}
                  onChange={(e) => setCopyFillEmptyRegistry(e.target.checked)}
                />
                {ui.copyFillEmptyRegistry}
              </label>
              {copyPreviewText ? (
                <div className="rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">
                  {copyPreviewText}
                </div>
              ) : null}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-sm border border-border-light px-3 py-1.5 text-il-meta text-text"
                onClick={() => setShowCopyModal(false)}
              >
                {ui.manualCancelBtn}
              </button>
              <button
                type="button"
                className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text disabled:opacity-50"
                disabled={copyBusy || !copySourceYear}
                onClick={() => void previewCopy()}
              >
                {ui.copyPreviewBtn}
              </button>
              <button
                type="button"
                className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-meta font-medium text-white disabled:opacity-50"
                disabled={copyBusy || !copySourceYear}
                onClick={() => void executeCopy()}
              >
                {ui.copyExecuteBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
