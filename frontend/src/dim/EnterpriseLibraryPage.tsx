import { Fragment, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchSubjectLibraryRows,
  fetchSubjectLibrarySummary,
  postSubjectCategoryRecompute,
  postSubjectLibraryIngestFromDwd,
} from '../config/localApi'

type RoleTag = 'seller' | 'buyer' | 'both'
type SubjectType = 'enterprise' | 'person'

type EnterpriseRow = {
  enterpriseId: string
  enterpriseName: string
  taxpayerId: string
  sourceType: 'platform' | 'external'
  subjectType: SubjectType
  subjectCategoryCode: string
  snapshotYear: string
  roleTag: RoleTag
  renamedInYear: boolean
  renameHint: string
  renameTimeline: string[]
  firstSeenBatchId: string
  lastSeenBatchId: string
  firstSeenDate: string
  lastSeenDate: string
}

function roleLabel(v: RoleTag) {
  const ui = t.enterpriseLibraryUi
  if (v === 'both') return ui.roleBoth
  if (v === 'seller') return ui.roleSeller
  return ui.roleBuyer
}

function createImportedRows(fileName: string, snapshotYear: string, baseSize: number): EnterpriseRow[] {
  const stem = fileName.replace(/\.[^.]+$/, '').trim() || '外部导入'
  const seq = String(baseSize + 1).padStart(3, '0')
  const year = /^\d{4}$/.test(snapshotYear) ? snapshotYear : String(new Date().getFullYear())
  return [
    {
      enterpriseId: `EXT_ENT_${seq}`,
      enterpriseName: `${stem}-企业主体`,
      taxpayerId: `91EXT${String(baseSize + 100001).slice(-6)}${year.slice(-2)}X`,
      sourceType: 'external',
      subjectType: 'enterprise',
      subjectCategoryCode: 'SC-ENT',
      snapshotYear: year,
      roleTag: 'both',
      renamedInYear: false,
      renameHint: '-',
      renameTimeline: [],
      firstSeenBatchId: `EXT_${year}_A01`,
      lastSeenBatchId: `EXT_${year}_A01`,
      firstSeenDate: `${year}-01-01`,
      lastSeenDate: `${year}-12-31`,
    },
    {
      enterpriseId: `EXT_PSN_${seq}`,
      enterpriseName: `${stem}-个人主体`,
      taxpayerId: `37EXT${String(baseSize + 200001).slice(-6)}${year.slice(-2)}Y`,
      sourceType: 'external',
      subjectType: 'person',
      subjectCategoryCode: 'SC-TEMP',
      snapshotYear: year,
      roleTag: 'buyer',
      renamedInYear: false,
      renameHint: '-',
      renameTimeline: [],
      firstSeenBatchId: `EXT_${year}_A01`,
      lastSeenBatchId: `EXT_${year}_A01`,
      firstSeenDate: `${year}-01-01`,
      lastSeenDate: `${year}-12-31`,
    },
  ]
}

export function EnterpriseLibraryPage() {
  const ui = t.enterpriseLibraryUi
  const [rows, setRows] = useState<EnterpriseRow[]>([])
  const [summary, setSummary] = useState({
    total: 0,
    enterprise_count: 0,
    person_count: 0,
    needs_review_count: 0,
  })
  const [loading, setLoading] = useState(false)
  const [loadingError, setLoadingError] = useState('')
  const [recomputeBusy, setRecomputeBusy] = useState(false)
  const [ingestBusy, setIngestBusy] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [subjectType, setSubjectType] = useState<'all' | SubjectType>('enterprise')
  const [sourceType, setSourceType] = useState<'all' | 'platform' | 'external'>('all')
  const [subjectCategory, setSubjectCategory] = useState('all')
  const [snapshotYear, setSnapshotYear] = useState('')
  const [renameStatus, setRenameStatus] = useState<'all' | 'renamed' | 'normal'>('all')
  const [role, setRole] = useState<'all' | RoleTag>('all')
  const [batchId, setBatchId] = useState('')
  const [expandedRenameId, setExpandedRenameId] = useState<string | null>(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState('')

  const roleDisabledForPerson = subjectType === 'person'
  const renameDisabledForPerson = subjectType === 'person'

  const effectiveRole = roleDisabledForPerson ? ('all' as const) : role
  const effectiveRenameStatus = renameDisabledForPerson ? ('all' as const) : renameStatus

  const snapshotYearOptions = useMemo(() => {
    const fromRows = [...new Set(rows.map((r) => r.snapshotYear).filter(Boolean))].sort(
      (a, b) => Number(b) - Number(a),
    )
    if (snapshotYear && !fromRows.includes(snapshotYear)) {
      return [snapshotYear, ...fromRows]
    }
    return fromRows
  }, [rows, snapshotYear])

  const filteredRows = useMemo(() => {
    if (effectiveRenameStatus === 'renamed') return rows.filter((r) => r.renamedInYear)
    if (effectiveRenameStatus === 'normal') return rows.filter((r) => !r.renamedInYear)
    return rows
  }, [effectiveRenameStatus, rows])

  const canReset =
    keyword.trim().length > 0 ||
    subjectType !== 'enterprise' ||
    sourceType !== 'all' ||
    subjectCategory !== 'all' ||
    snapshotYear !== '' ||
    renameStatus !== 'all' ||
    role !== 'all' ||
    batchId.trim().length > 0

  const resetFilters = () => {
    setKeyword('')
    setSubjectType('enterprise')
    setSourceType('all')
    setSubjectCategory('all')
    setSnapshotYear('')
    setRenameStatus('all')
    setRole('all')
    setBatchId('')
    setExpandedRenameId(null)
  }

  const closeImportModal = () => {
    setShowImportModal(false)
    setImportFile(null)
    setImportError('')
  }

  const confirmImport = () => {
    if (!importFile) {
      setImportError(ui.importNeedFile)
      return
    }
    const added = createImportedRows(importFile.name, snapshotYear, rows.length)
    setRows((prev) => [...added, ...prev])
    setImportSuccess(ui.importSuccessHint.replace('{count}', String(added.length)))
    closeImportModal()
  }

  const stats = useMemo(
    () => ({
      total: summary.total,
      enterpriseCount: summary.enterprise_count,
      personCount: summary.person_count,
      renamedCount: summary.needs_review_count,
    }),
    [summary],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadingError('')
      const [rowsRes, sumRes] = await Promise.all([
        fetchSubjectLibraryRows({
          snapshotYear,
          keyword,
          subjectType,
          sourceType,
          subjectCategory,
          role: effectiveRole,
          batchId,
          limit: 1000,
        }),
        fetchSubjectLibrarySummary({
          snapshotYear,
          subjectType,
          sourceType,
        }),
      ])
      if (cancelled) return
      if (!rowsRes.ok) {
        setLoadingError(rowsRes.error?.message ?? '主体库数据加载失败')
      } else {
        setRows(
          rowsRes.rows.map((r) => ({
            enterpriseId: r.enterprise_id,
            enterpriseName: r.enterprise_name,
            taxpayerId: r.taxpayer_id,
            sourceType: r.source_type,
            subjectType: r.subject_type,
            subjectCategoryCode: r.subject_category_code,
            snapshotYear: r.snapshot_year || snapshotYear,
            roleTag: r.role_tag,
            renamedInYear: r.renamed_in_year,
            renameHint: r.rename_hint,
            renameTimeline: r.rename_timeline,
            firstSeenBatchId: r.first_seen_batch_id,
            lastSeenBatchId: r.last_seen_batch_id,
            firstSeenDate: r.first_seen_date,
            lastSeenDate: r.last_seen_date,
          })),
        )
      }
      if (sumRes.ok && sumRes.summary) {
        setSummary(sumRes.summary)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [batchId, effectiveRole, keyword, snapshotYear, sourceType, subjectCategory, subjectType, reloadSeq])

  const runIngestFromDwd = async () => {
    setIngestBusy(true)
    setLoadingError('')
    const res = await postSubjectLibraryIngestFromDwd()
    if (!res.ok) {
      setLoadingError(res.error?.message ?? 'DWD 归集失败')
      setIngestBusy(false)
      return
    }
    setImportSuccess(res.message ?? 'DWD 归集完成')
    setReloadSeq((v) => v + 1)
    setIngestBusy(false)
  }

  const runRecompute = async () => {
    setRecomputeBusy(true)
    setLoadingError('')
    const res = await postSubjectCategoryRecompute({ with_relations: true })
    if (!res.ok) {
      setLoadingError(res.error?.message ?? '主体重算失败')
      setRecomputeBusy(false)
      return
    }
    setImportSuccess(res.message ?? '主体重算完成')
    setReloadSeq((v) => v + 1)
    setRecomputeBusy(false)
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.prototypeNote}
        badgeText={ui.prototypeBadge}
        expandLabel={ui.moreTipsToggle}
        collapseLabel={ui.lessTipsToggle}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc]"
              onClick={() => {
                setImportSuccess('')
                setShowImportModal(true)
              }}
            >
              {ui.importExternalBtn}
            </button>
            <button
              type="button"
              disabled={ingestBusy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={runIngestFromDwd}
            >
              {ingestBusy ? ui.ingestFromDwdBusy : ui.ingestFromDwdBtn}
            </button>
            <button
              type="button"
              disabled={recomputeBusy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text transition-colors hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={runRecompute}
            >
              {recomputeBusy ? '重算中…' : '重算（分类+关联）'}
            </button>
          </div>
        }
      />
      <div className="mb-4 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-3 py-2 text-il-meta text-accent-mid">
        {ui.caliberHint.replace('{year}', snapshotYear || ui.filterSnapshotAll)}
      </div>
      {importSuccess ? <div className="mb-4 rounded-sm border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{importSuccess}</div> : null}
      {loadingError ? <div className="mb-4 rounded-sm border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">{loadingError}</div> : null}
      {loading ? <div className="mb-4 rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2 text-il-meta text-text-3">主体库数据加载中…</div> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: ui.kpiTotal, value: stats.total, cls: 'text-text' },
          { label: ui.kpiEnterprise, value: stats.enterpriseCount, cls: 'text-accent' },
          { label: ui.kpiPerson, value: stats.personCount, cls: 'text-warn' },
          { label: ui.kpiRenamedInYear, value: stats.renamedCount, cls: 'text-[#6b5cb3]' },
        ].map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className={['mt-1 text-[20px] font-bold tabular-nums', item.cls].join(' ')}>{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.filterTitle}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-8">
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.filterYearLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={snapshotYear}
              onChange={(e) => setSnapshotYear(e.target.value)}
            >
              <option value="">{ui.filterSnapshotAll}</option>
              {snapshotYearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.subjectTypeLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={subjectType}
              onChange={(e) => setSubjectType(e.target.value as 'all' | SubjectType)}
            >
              <option value="all">{ui.subjectTypeAll}</option>
              <option value="enterprise">{ui.subjectTypeEnterprise}</option>
              <option value="person">{ui.subjectTypePerson}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.sourceTypeLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as 'all' | 'platform' | 'external')}
            >
              <option value="all">{ui.sourceTypeAll}</option>
              <option value="platform">{ui.sourceTypePlatform}</option>
              <option value="external">{ui.sourceTypeExternal}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.subjectCategoryLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent"
              value={subjectCategory}
              onChange={(e) => setSubjectCategory(e.target.value)}
            >
              <option value="all">{ui.subjectCategoryAll}</option>
              <option value="SC-ENT">{ui.subjectCategoryEnt}</option>
              <option value="SC-BRANCH">{ui.subjectCategoryBranch}</option>
              <option value="SC-TEMP">{ui.subjectCategoryTemp}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2 xl:col-span-2">
            <span className="mb-1 block font-medium">{ui.keywordLabel}</span>
            <input
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
            />
          </label>
          <label
            className={[
              'block text-il-label text-text-2',
              roleDisabledForPerson ? 'opacity-60' : '',
            ].join(' ')}
            title={roleDisabledForPerson ? ui.roleDisabledForPersonHint : undefined}
          >
            <span className="mb-1 block font-medium">{ui.roleLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-[#f6f8fb]"
              value={role}
              disabled={roleDisabledForPerson}
              onChange={(e) => setRole(e.target.value as 'all' | RoleTag)}
            >
              <option value="all">{ui.roleAll}</option>
              <option value="seller">{ui.roleSeller}</option>
              <option value="buyer">{ui.roleBuyer}</option>
              <option value="both">{ui.roleBoth}</option>
            </select>
          </label>
          <label
            className={[
              'block text-il-label text-text-2',
              renameDisabledForPerson ? 'opacity-60' : '',
            ].join(' ')}
            title={renameDisabledForPerson ? ui.renameDisabledForPersonHint : undefined}
          >
            <span className="mb-1 block font-medium">{ui.renameStatusLabel}</span>
            <select
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-[#f6f8fb]"
              value={renameStatus}
              disabled={renameDisabledForPerson}
              onChange={(e) => setRenameStatus(e.target.value as 'all' | 'renamed' | 'normal')}
            >
              <option value="all">{ui.renameStatusAll}</option>
              <option value="renamed">{ui.renameStatusRenamed}</option>
              <option value="normal">{ui.renameStatusNormal}</option>
            </select>
          </label>
          <label className="block text-il-label text-text-2">
            <span className="mb-1 block font-medium">{ui.batchLabel}</span>
            <input
              className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text outline-none placeholder:text-text-3 focus:border-accent"
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
              placeholder={ui.batchPlaceholder}
            />
          </label>
          <button
            type="button"
            className={[
              'h-9 rounded-sm border px-3 text-il-page-desc transition-colors xl:self-end',
              canReset
                ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
                : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
            ].join(' ')}
            disabled={!canReset}
            onClick={resetFilters}
          >
            {ui.filterReset}
          </button>
        </div>
      </Card>

      <Card title={ui.tableTitle}>
        <div className="mb-2 text-il-meta text-text-3">
          {ui.tableHint
            .replace('{count}', String(filteredRows.length))
            .replace('{year}', snapshotYear || ui.filterSnapshotAll)}
        </div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[1180px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colSubjectName}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectNo}</th>
                <th className="px-3 py-2 font-medium">{ui.colSourceType}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectType}</th>
                <th className="px-3 py-2 font-medium">{ui.colSubjectCategory}</th>
                <th className="px-3 py-2 font-medium">{ui.colRole}</th>
                <th className="px-3 py-2 font-medium">{ui.colSnapshotYear}</th>
                <th className="px-3 py-2 font-medium">{ui.colRenameHint}</th>
                <th className="px-3 py-2 font-medium">{ui.colRenameAction}</th>
                <th className="px-3 py-2 font-medium">{ui.colLastBatch}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {filteredRows.map((row) => {
                const isExpanded = expandedRenameId === row.enterpriseId
                return (
                  <Fragment key={row.enterpriseId}>
                    <tr key={row.enterpriseId} className="border-b border-border-light">
                      <td className="px-3 py-2.5 font-medium text-text">{row.enterpriseName}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.taxpayerId}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={[
                            'rounded-sm border px-2 py-0.5 text-il-meta',
                            row.sourceType === 'platform'
                              ? 'border-[#c8e6d0] bg-[#f4fbf6] text-[#1b6b3a]'
                              : 'border-[#d7d8ff] bg-[#f5f5ff] text-[#4747a3]',
                          ].join(' ')}
                        >
                          {row.sourceType === 'platform' ? ui.sourceTypePlatform : ui.sourceTypeExternal}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {row.subjectType === 'enterprise' ? ui.subjectTypeEnterprise : ui.subjectTypePerson}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-il-meta text-text-2">{row.subjectCategoryCode}</td>
                      <td className="px-3 py-2.5">{roleLabel(row.roleTag)}</td>
                      <td className="px-3 py-2.5">{row.snapshotYear}</td>
                      <td className="px-3 py-2.5">{row.renameHint}</td>
                      <td className="px-3 py-2.5">
                        {row.renamedInYear ? (
                          <button
                            type="button"
                            className="rounded-sm border border-border bg-white px-2 py-0.5 text-il-meta text-text-2 hover:border-accent hover:text-accent"
                            onClick={() =>
                              setExpandedRenameId((prev) =>
                                prev === row.enterpriseId ? null : row.enterpriseId,
                              )
                            }
                          >
                            {isExpanded ? ui.renameActionCollapse : ui.renameActionExpand}
                          </button>
                        ) : (
                          <span className="text-text-3">{ui.renameActionNone}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{row.lastSeenBatchId}</td>
                    </tr>
                    {isExpanded ? (
                      <tr className="border-b border-border-light bg-[#fafbfd]">
                        <td className="px-3 py-2.5" colSpan={10}>
                          <div className="text-il-label text-text-3">{ui.renameTimelineTitle}</div>
                          <ul className="mt-1 space-y-1 text-il-page-desc text-text-2">
                            {row.renameTimeline.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {showImportModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.28)] px-4">
          <div className="w-full max-w-[640px] rounded-[12px] border border-border-light bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-text">{ui.importModalTitle}</h3>
              <button type="button" className="text-il-page-desc text-text-3 hover:text-text" onClick={closeImportModal}>
                {ui.modalClose}
              </button>
            </div>
            <div className="rounded-sm border border-dashed border-[#9fc5f5] bg-[#f8fbff] px-4 py-6 text-center">
              <div className="text-il-page-desc font-medium text-text">{ui.importDropTitle}</div>
              <div className="mt-1 text-il-meta text-text-3">{ui.importDropHint}</div>
              <label className="mt-3 inline-flex cursor-pointer rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent">
                {ui.importPickFile}
                <input
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] ?? null)
                    setImportError('')
                  }}
                />
              </label>
              {importFile ? <div className="mt-2 text-il-meta text-text-2">{importFile.name}</div> : null}
              {importError ? <div className="mt-2 text-il-meta text-[#c2410c]">{importError}</div> : null}
            </div>
            <div className="mt-3 rounded-sm border border-[#fff1c7] bg-[#fffaf0] px-3 py-2 text-il-meta text-[#946200]">{ui.importModalTip}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent" onClick={closeImportModal}>
                {ui.modalCancel}
              </button>
              <button type="button" className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:opacity-90" onClick={confirmImport}>
                {ui.importConfirmBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
