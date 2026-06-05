import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchLevel1EnterpriseYearCandidates,
  fetchLevel1EnterpriseYearList,
  fetchLevel1EnterpriseYearMembers,
  fetchLevel1EnterpriseYearMeta,
  postLevel1EnterpriseYearCopyFromPrevious,
  postLevel1EnterpriseYearDelete,
  postLevel1EnterpriseYearImportBatch,
  postLevel1EnterpriseYearPreviewFromPrevious,
  postLevel1EnterpriseYearUpsert,
  type Level1EnterpriseYearMemberRow,
  type Level1EnterpriseYearPreviewRow,
  type Level1EnterpriseYearRow,
} from '../config/localApi'

function buildYearOptions(apiYears: string[]): string[] {
  const cy = new Date().getFullYear()
  // 统计年度：当前年 +1（预编下年）至当前年往回 11 年
  const fallback = Array.from({ length: 12 }, (_, i) => String(cy + 1 - i))
  const s = new Set<string>([...apiYears, ...fallback])
  return [...s].sort((a, b) => Number(b) - Number(a))
}

/** 实务默认年度：当前自然年（跨年自动变为新年份） */
function defaultPracticeStatYear(yearOptions: string[]): string {
  const cy = String(new Date().getFullYear())
  if (yearOptions.includes(cy)) return cy
  return yearOptions[0] ?? cy
}

function defaultSourceYear(targetYear: string): string {
  const y = Number(targetYear)
  if (Number.isFinite(y) && y > 1990) return String(y - 1)
  return String(new Date().getFullYear() - 1)
}

function buildSourceYearOptions(targetYear: string, statYears: string[], rowCounts: Record<string, number>): string[] {
  const target = Number(targetYear)
  const s = new Set<string>()
  for (const y of statYears) {
    if ((rowCounts[y] ?? 0) > 0) s.add(y)
  }
  if (Number.isFinite(target)) s.add(String(target - 1))
  return [...s].sort((a, b) => Number(b) - Number(a))
}

function parseImportLines(text: string): { level1_enterprise_id: string; level1_enterprise_name: string }[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const out: { level1_enterprise_id: string; level1_enterprise_name: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const parts = line.includes('\t') ? line.split('\t') : line.split(/[,，]/)
    if (parts.length < 2) continue
    const id = parts[0]!.trim()
    const name = parts.slice(1).join(',').trim()
    if (!id || !name) continue
    if (i === 0 && /识别|税号|统一|enterprise|level1/i.test(id) && /名称|name/i.test(name)) continue
    out.push({ level1_enterprise_id: id, level1_enterprise_name: name })
  }
  return out
}

type DeriveEditRow = Level1EnterpriseYearPreviewRow & { included: boolean }

export function Level1EnterpriseYearPage() {
  const ui = t.level1EnterpriseYearUi
  const [statYears, setStatYears] = useState<string[]>([])
  const [rowCountsByYear, setRowCountsByYear] = useState<Record<string, number>>({})
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))
  const [keyword, setKeyword] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [rows, setRows] = useState<Level1EnterpriseYearRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  const [showEdit, setShowEdit] = useState(false)
  const [editId, setEditId] = useState('')
  const [editName, setEditName] = useState('')
  const [editOrder, setEditOrder] = useState('0')
  const [editActive, setEditActive] = useState(true)
  const [editRemark, setEditRemark] = useState('')
  const [editIsNew, setEditIsNew] = useState(true)
  const [saveBusy, setSaveBusy] = useState(false)

  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReplace, setImportReplace] = useState(false)
  const [importBusy, setImportBusy] = useState(false)

  const [showCandidates, setShowCandidates] = useState(false)
  const [candidates, setCandidates] = useState<Level1EnterpriseYearRow[]>([])
  const [pickedCand, setPickedCand] = useState<Set<string>>(() => new Set())
  const [candBusy, setCandBusy] = useState(false)

  const [showCopy, setShowCopy] = useState(false)
  const [copySourceYear, setCopySourceYear] = useState('')
  const [copyOnlyActive, setCopyOnlyActive] = useState(true)
  const [copyReplace, setCopyReplace] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)

  const [showDerive, setShowDerive] = useState(false)
  const [deriveSourceYear, setDeriveSourceYear] = useState('')
  const [deriveOnlyActive, setDeriveOnlyActive] = useState(true)
  const [deriveReplace, setDeriveReplace] = useState(false)
  const [deriveRows, setDeriveRows] = useState<DeriveEditRow[]>([])
  const [derivePreviewBusy, setDerivePreviewBusy] = useState(false)
  const [deriveSaveBusy, setDeriveSaveBusy] = useState(false)
  const [deriveResolvedSource, setDeriveResolvedSource] = useState('')

  const [showMembers, setShowMembers] = useState(false)
  const [membersRow, setMembersRow] = useState<Level1EnterpriseYearRow | null>(null)
  const [members, setMembers] = useState<Level1EnterpriseYearMemberRow[]>([])
  const [membersKeyword, setMembersKeyword] = useState('')
  const [membersBusy, setMembersBusy] = useState(false)
  const [membersSummary, setMembersSummary] = useState({ total: 0, active: 0 })

  const yearOptions = useMemo(() => buildYearOptions(statYears), [statYears])
  const effectiveYear = useMemo(() => {
    const y = statYear.trim()
    if (y && yearOptions.includes(y)) return y
    return defaultPracticeStatYear(yearOptions)
  }, [statYear, yearOptions])

  const displayRows = useMemo(
    () => (activeOnly ? rows.filter((r) => r.is_active !== false) : rows),
    [activeOnly, rows],
  )

  const memberTotalSum = useMemo(
    () => displayRows.reduce((s, r) => s + (r.group_member_count ?? 0), 0),
    [displayRows],
  )

  const sourceYearOptions = useMemo(
    () => buildSourceYearOptions(effectiveYear, statYears, rowCountsByYear),
    [effectiveYear, rowCountsByYear, statYears],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const meta = await fetchLevel1EnterpriseYearMeta()
      if (meta.ok) {
        if (meta.stat_years?.length) setStatYears(meta.stat_years)
        if (meta.row_counts_by_year) setRowCountsByYear(meta.row_counts_by_year)
      }
      const res = await fetchLevel1EnterpriseYearList({
        statYear: effectiveYear,
        keyword,
      })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRows([])
        return
      }
      if (res.stat_years?.length) setStatYears(res.stat_years)
      setStatYear((prev) => {
        const merged = buildYearOptions(res.stat_years ?? [])
        const p = prev.trim()
        if (p && merged.includes(p)) return prev
        return defaultPracticeStatYear(merged)
      })
      setRows(res.rows ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : ui.loadFailed)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [effectiveYear, keyword, ui.loadFailed])

  useEffect(() => {
    void load()
  }, [load])

  const openCopyModal = () => {
    const def = defaultSourceYear(effectiveYear)
    const pick = sourceYearOptions.includes(def) ? def : (sourceYearOptions[0] ?? def)
    setCopySourceYear(pick)
    setCopyOnlyActive(true)
    setCopyReplace(false)
    setShowCopy(true)
  }

  const openDeriveModal = () => {
    const def = defaultSourceYear(effectiveYear)
    const pick = sourceYearOptions.includes(def) ? def : (sourceYearOptions[0] ?? def)
    setDeriveSourceYear(pick)
    setDeriveOnlyActive(true)
    setDeriveReplace(false)
    setDeriveRows([])
    setDeriveResolvedSource('')
    setShowDerive(true)
  }

  useEffect(() => {
    if (!showDerive) return
    void loadDerivePreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 打开弹窗时自动预览
  }, [showDerive])

  const openCreate = () => {
    setEditIsNew(true)
    setEditId('')
    setEditName('')
    setEditOrder('0')
    setEditActive(true)
    setEditRemark('')
    setShowEdit(true)
  }

  const openEdit = (row: Level1EnterpriseYearRow) => {
    setEditIsNew(false)
    setEditId(row.level1_enterprise_id)
    setEditName(row.level1_enterprise_name)
    setEditOrder(String(row.display_order ?? 0))
    setEditActive(row.is_active !== false)
    setEditRemark(row.remark ?? '')
    setShowEdit(true)
  }

  const saveRow = async () => {
    setSaveBusy(true)
    setErr(null)
    try {
      const r = await postLevel1EnterpriseYearUpsert({
        stat_year: effectiveYear,
        level1_enterprise_id: editId,
        level1_enterprise_name: editName,
        display_order: Number(editOrder) || 0,
        is_active: editActive,
        remark: editRemark,
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.saveFailed)
        return
      }
      setShowEdit(false)
      setBanner(ui.saveSuccess)
      await load()
    } finally {
      setSaveBusy(false)
    }
  }

  const deleteRow = async (row: Level1EnterpriseYearRow) => {
    if (!window.confirm(ui.deleteConfirm.replace('{name}', row.level1_enterprise_name))) return
    const r = await postLevel1EnterpriseYearDelete({
      stat_year: effectiveYear,
      level1_enterprise_id: row.level1_enterprise_id,
    })
    if (!r.ok) {
      setErr(r.error?.message ?? ui.deleteFailed)
      return
    }
    setBanner(ui.deleteSuccess)
    await load()
  }

  const runImport = async () => {
    const parsed = parseImportLines(importText)
    if (!parsed.length) {
      setErr(ui.importEmpty)
      return
    }
    setImportBusy(true)
    setErr(null)
    try {
      const r = await postLevel1EnterpriseYearImportBatch({
        stat_year: effectiveYear,
        rows: parsed,
        replace_year: importReplace,
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.importFailed)
        return
      }
      setShowImport(false)
      setImportText('')
      setBanner(
        ui.importSuccess
          .replace('{inserted}', String(r.inserted ?? 0))
          .replace('{updated}', String(r.updated ?? 0))
          .replace('{rejected}', String(r.rejected_count ?? 0)),
      )
      await load()
    } finally {
      setImportBusy(false)
    }
  }

  const runCopy = async () => {
    if (copyReplace && !window.confirm(ui.importReplaceLabel)) return
    setCopyBusy(true)
    setErr(null)
    try {
      const r = await postLevel1EnterpriseYearCopyFromPrevious({
        target_stat_year: effectiveYear,
        source_stat_year: copySourceYear || undefined,
        replace_year: copyReplace,
        only_active: copyOnlyActive,
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.copyFailed)
        return
      }
      if (r.skipped) {
        setBanner(r.message ?? ui.copySkipped)
      } else {
        setShowCopy(false)
        setBanner(
          ui.copySuccess
            .replace('{inserted}', String(r.inserted ?? 0))
            .replace('{updated}', String(r.updated ?? 0)),
        )
        await load()
      }
    } finally {
      setCopyBusy(false)
    }
  }

  const loadDerivePreview = async () => {
    setDerivePreviewBusy(true)
    setErr(null)
    try {
      const r = await postLevel1EnterpriseYearPreviewFromPrevious({
        target_stat_year: effectiveYear,
        source_stat_year: deriveSourceYear || undefined,
        mode: 'derive',
        only_active: deriveOnlyActive,
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.derivePreviewFailed)
        setDeriveRows([])
        return
      }
      setDeriveResolvedSource(r.source_stat_year ?? deriveSourceYear)
      const list = (r.rows ?? []).map((row) => ({
        ...row,
        included: true,
      }))
      setDeriveRows(list)
    } finally {
      setDerivePreviewBusy(false)
    }
  }

  const saveDerive = async () => {
    const picked = deriveRows.filter((r) => r.included)
    if (!picked.length) {
      setErr(ui.derivePreviewEmpty)
      return
    }
    if (deriveReplace && !window.confirm(ui.importReplaceLabel)) return
    setDeriveSaveBusy(true)
    setErr(null)
    try {
      const r = await postLevel1EnterpriseYearImportBatch({
        stat_year: effectiveYear,
        rows: picked.map((row) => ({
          level1_enterprise_id: row.level1_enterprise_id,
          level1_enterprise_name: row.level1_enterprise_name,
          display_order: row.display_order,
          is_active: row.is_active,
          remark: row.remark,
        })),
        replace_year: deriveReplace,
        data_source: `derive_from_${deriveResolvedSource || deriveSourceYear}`,
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.saveFailed)
        return
      }
      setShowDerive(false)
      setBanner(
        ui.deriveSaveSuccess
          .replace('{inserted}', String(r.inserted ?? 0))
          .replace('{updated}', String(r.updated ?? 0)),
      )
      await load()
    } finally {
      setDeriveSaveBusy(false)
    }
  }

  const updateDeriveRow = (id: string, patch: Partial<DeriveEditRow>) => {
    setDeriveRows((prev) => prev.map((r) => (r.level1_enterprise_id === id ? { ...r, ...patch } : r)))
  }

  const openMembers = async (row: Level1EnterpriseYearRow, keywordOverride?: string) => {
    setMembersRow(row)
    setShowMembers(true)
    setMembersKeyword(keywordOverride ?? '')
    setMembersBusy(true)
    setErr(null)
    try {
      const r = await fetchLevel1EnterpriseYearMembers({
        statYear: effectiveYear,
        level1EnterpriseId: row.level1_enterprise_id,
        keyword: keywordOverride ?? membersKeyword,
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.membersLoadFailed)
        setMembers([])
        setMembersSummary({ total: 0, active: 0 })
        return
      }
      setMembers(r.members ?? [])
      setMembersSummary({ total: r.total ?? 0, active: r.active_member_count ?? 0 })
    } finally {
      setMembersBusy(false)
    }
  }

  const reloadMembers = async () => {
    if (!membersRow) return
    await openMembers(membersRow, membersKeyword)
  }

  const loadCandidates = async () => {
    setCandBusy(true)
    setErr(null)
    try {
      const r = await fetchLevel1EnterpriseYearCandidates({ statYear: effectiveYear })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.candidatesFailed)
        return
      }
      const list = (r.candidates ?? []).map((c) => ({
        stat_year: effectiveYear,
        level1_enterprise_id: c.level1_enterprise_id,
        level1_enterprise_name: c.level1_enterprise_name,
        display_order: 0,
        is_active: true,
        remark: '',
        data_source: '',
        updated_at: '',
      }))
      setCandidates(list)
      setPickedCand(new Set(list.map((x) => x.level1_enterprise_id)))
      setShowCandidates(true)
    } finally {
      setCandBusy(false)
    }
  }

  const addCandidates = async () => {
    const picked = candidates.filter((c) => pickedCand.has(c.level1_enterprise_id))
    if (!picked.length) {
      setErr(ui.candidatesNonePicked)
      return
    }
    setCandBusy(true)
    try {
      const r = await postLevel1EnterpriseYearImportBatch({
        stat_year: effectiveYear,
        rows: picked.map((c) => ({
          level1_enterprise_id: c.level1_enterprise_id,
          level1_enterprise_name: c.level1_enterprise_name,
        })),
      })
      if (!r.ok) {
        setErr(r.error?.message ?? ui.importFailed)
        return
      }
      setShowCandidates(false)
      setBanner(ui.candidatesAdded.replace('{n}', String(picked.length)))
      await load()
    } finally {
      setCandBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.groupRosterViewHint}
        noteTone="compact"
      />

      {err ? (
        <div className="rounded-md border border-danger/30 bg-[#fff5f5] px-3 py-2 text-sm text-danger">{err}</div>
      ) : null}
      {banner ? (
        <div className="rounded-md border border-[#b7e4c8] bg-[#f0fdf4] px-3 py-2 text-sm text-[#0d5c2e]">{banner}</div>
      ) : null}

      <Card title={ui.filterCardTitle}>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-3">{ui.statYearLabel}</label>
            <select
              className="rounded border border-line bg-white px-2 py-1.5 text-sm"
              value={effectiveYear}
              onChange={(e) => setStatYear(e.target.value)}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-xs font-medium text-text-3">{ui.keywordLabel}</label>
            <input
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
            />
          </div>
          <label className="flex items-center gap-2 pb-1 text-sm text-text-2">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            {ui.activeOnlyLabel}
          </label>
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={() => void load()}
            disabled={loading}
          >
            {ui.refreshBtn}
          </button>
        </div>
      </Card>

      <Card
        title={`${ui.listCardTitle.replace('{year}', effectiveYear).replace('{count}', String(displayRows.length))}${memberTotalSum > 0 ? ` · 成员单位合计 ${memberTotalSum}` : ''}`}
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            onClick={openCreate}
          >
            {ui.createBtn}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={() => setShowImport(true)}
          >
            {ui.importBtn}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={openCopyModal}
          >
            {ui.copyFromPrevBtn}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={openDeriveModal}
          >
            {ui.deriveFromPrevBtn}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
            onClick={() => void loadCandidates()}
            disabled={candBusy}
          >
            {candBusy ? ui.candidatesBusy : ui.candidatesBtn}
          </button>
        </div>
        {loading ? (
          <div className="text-sm text-text-2">{ui.loading}</div>
        ) : displayRows.length === 0 ? (
          <div className="text-sm text-text-2">{ui.emptyList}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-text-3">
                  <th className="py-2 pr-3 font-medium">{ui.colOrder}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colName}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colId}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colMemberCount}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colStateInvestor}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colActive}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colRemark}</th>
                  <th className="py-2 font-medium">{ui.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => {
                  const memberTotal = row.group_member_count ?? 0
                  const memberActive = row.group_active_member_count ?? 0
                  const memberLabel =
                    memberTotal > 0
                      ? ui.memberCountHint
                          .replace('{active}', String(memberActive))
                          .replace('{total}', String(memberTotal))
                      : ui.memberCountEmpty
                  const stateInvestor =
                    row.state_investor?.trim() || row.soe_anchor_name?.trim() || ui.memberCountEmpty
                  return (
                  <tr key={row.level1_enterprise_id} className="border-b border-line/70">
                    <td className="py-2 pr-3 tabular-nums">{row.display_order}</td>
                    <td className="py-2 pr-3 font-medium text-text">{row.level1_enterprise_name}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-2">{row.level1_enterprise_id}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {memberTotal > 0 ? (
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          title={ui.viewMembersBtn}
                          onClick={() => void openMembers(row)}
                        >
                          {memberLabel}
                        </button>
                      ) : (
                        ui.memberCountEmpty
                      )}
                    </td>
                    <td className="py-2 pr-3 max-w-[160px] truncate text-text-2" title={stateInvestor}>
                      {stateInvestor}
                    </td>
                    <td className="py-2 pr-3">{row.is_active ? ui.yes : ui.no}</td>
                    <td className="py-2 pr-3 max-w-[200px] truncate text-text-2" title={row.remark}>
                      {row.remark || '—'}
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      <button type="button" className="mr-2 text-accent hover:underline" onClick={() => openEdit(row)}>
                        {ui.editBtn}
                      </button>
                      <button
                        type="button"
                        className="mr-2 text-accent hover:underline"
                        onClick={() => void openMembers(row)}
                      >
                        {ui.viewMembersBtn}
                      </button>
                      <button type="button" className="text-danger hover:underline" onClick={() => void deleteRow(row)}>
                        {ui.deleteBtn}
                      </button>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showEdit ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-text">{editIsNew ? ui.createModalTitle : ui.editModalTitle}</h2>
            <p className="mt-1 text-xs text-text-3">{ui.modalHint.replace('{year}', effectiveYear)}</p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-3">{ui.colId}</label>
                <input
                  className="w-full rounded border border-line px-2 py-1.5 text-sm disabled:bg-[#f5f5f5]"
                  value={editId}
                  onChange={(e) => setEditId(e.target.value)}
                  disabled={!editIsNew}
                  placeholder={ui.idPlaceholder}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-3">{ui.colName}</label>
                <input
                  className="w-full rounded border border-line px-2 py-1.5 text-sm"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={ui.namePlaceholder}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-text-3">{ui.colOrder}</label>
                  <input
                    type="number"
                    className="w-full rounded border border-line px-2 py-1.5 text-sm"
                    value={editOrder}
                    onChange={(e) => setEditOrder(e.target.value)}
                  />
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
                  {ui.colActive}
                </label>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-3">{ui.colRemark}</label>
                <input
                  className="w-full rounded border border-line px-2 py-1.5 text-sm"
                  value={editRemark}
                  onChange={(e) => setEditRemark(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-line px-3 py-1.5 text-sm"
                onClick={() => setShowEdit(false)}
                disabled={saveBusy}
              >
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void saveRow()}
                disabled={saveBusy}
              >
                {saveBusy ? ui.modalSaving : ui.modalSave}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showImport ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-text">{ui.importModalTitle}</h2>
            <p className="mt-1 text-xs text-text-3">{ui.importHint}</p>
            <textarea
              className="mt-3 h-40 w-full rounded border border-line p-2 font-mono text-xs"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={ui.importPlaceholder}
            />
            <label className="mt-2 flex items-center gap-2 text-sm text-text-2">
              <input type="checkbox" checked={importReplace} onChange={(e) => setImportReplace(e.target.checked)} />
              {ui.importReplaceLabel}
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border border-line px-3 py-1.5 text-sm" onClick={() => setShowImport(false)}>
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void runImport()}
                disabled={importBusy}
              >
                {importBusy ? ui.importBusy : ui.importConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCopy ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-text">{ui.copyModalTitle}</h2>
            <p className="mt-1 text-xs text-text-3">{ui.copyModalHint}</p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-3">{ui.sourceYearLabel}</label>
                <select
                  className="w-full rounded border border-line px-2 py-1.5 text-sm"
                  value={copySourceYear}
                  onChange={(e) => setCopySourceYear(e.target.value)}
                >
                  {sourceYearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}
                      {(rowCountsByYear[y] ?? 0) > 0 ? `（${rowCountsByYear[y]} 家）` : ''}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-text-3">
                  {ui.prevYearDefaultHint} · 目标年度 {effectiveYear}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-text-2">
                <input type="checkbox" checked={copyOnlyActive} onChange={(e) => setCopyOnlyActive(e.target.checked)} />
                {ui.onlyActiveSourceLabel}
              </label>
              <label className="flex items-center gap-2 text-sm text-text-2">
                <input type="checkbox" checked={copyReplace} onChange={(e) => setCopyReplace(e.target.checked)} />
                {ui.replaceTargetLabel}
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded border border-line px-3 py-1.5 text-sm" onClick={() => setShowCopy(false)}>
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void runCopy()}
                disabled={copyBusy}
              >
                {copyBusy ? ui.copyBusy : ui.copyConfirmBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDerive ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-text">{ui.deriveModalTitle}</h2>
            <p className="mt-1 text-xs text-text-3">{ui.deriveModalHint}</p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-3">{ui.sourceYearLabel}</label>
                <select
                  className="rounded border border-line px-2 py-1.5 text-sm"
                  value={deriveSourceYear}
                  onChange={(e) => setDeriveSourceYear(e.target.value)}
                >
                  {sourceYearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}
                      {(rowCountsByYear[y] ?? 0) > 0 ? `（${rowCountsByYear[y]} 家）` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 pb-1 text-sm text-text-2">
                <input type="checkbox" checked={deriveOnlyActive} onChange={(e) => setDeriveOnlyActive(e.target.checked)} />
                {ui.onlyActiveSourceLabel}
              </label>
              <button
                type="button"
                className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
                onClick={() => void loadDerivePreview()}
                disabled={derivePreviewBusy}
              >
                {derivePreviewBusy ? ui.derivePreviewBusy : ui.derivePreviewBtn}
              </button>
            </div>
            {deriveResolvedSource ? (
              <p className="mt-2 text-xs text-text-3">
                来源 {deriveResolvedSource} → 目标 {effectiveYear}，预览 {deriveRows.length} 条
              </p>
            ) : null}
            {derivePreviewBusy ? (
              <p className="mt-4 text-sm text-text-2">{ui.derivePreviewBusy}</p>
            ) : deriveRows.length === 0 ? (
              <p className="mt-4 text-sm text-text-2">{ui.derivePreviewEmpty}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-text-3">
                      <th className="py-2 pr-2 font-medium">{ui.colInclude}</th>
                      <th className="py-2 pr-2 font-medium">{ui.colOrder}</th>
                      <th className="py-2 pr-2 font-medium">{ui.colName}</th>
                      <th className="py-2 pr-2 font-medium">{ui.colId}</th>
                      <th className="py-2 pr-2 font-medium">{ui.colActive}</th>
                      <th className="py-2 pr-2 font-medium">{ui.colRemark}</th>
                      <th className="py-2 font-medium">{ui.colDeriveHint}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deriveRows.map((row) => (
                      <tr
                        key={row.level1_enterprise_id}
                        className={`border-b border-line/70 ${row.from_group_extra ? 'bg-[#fffbeb]' : ''}`}
                      >
                        <td className="py-1.5 pr-2">
                          <input
                            type="checkbox"
                            checked={row.included}
                            onChange={(e) => updateDeriveRow(row.level1_enterprise_id, { included: e.target.checked })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            type="number"
                            className="w-16 rounded border border-line px-1 py-0.5 text-xs"
                            value={row.display_order}
                            onChange={(e) =>
                              updateDeriveRow(row.level1_enterprise_id, { display_order: Number(e.target.value) || 0 })
                            }
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            className="min-w-[140px] rounded border border-line px-1 py-0.5 text-xs"
                            value={row.level1_enterprise_name}
                            onChange={(e) => updateDeriveRow(row.level1_enterprise_id, { level1_enterprise_name: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2 font-mono text-xs text-text-2">{row.level1_enterprise_id}</td>
                        <td className="py-1.5 pr-2">
                          <input
                            type="checkbox"
                            checked={row.is_active !== false}
                            onChange={(e) => updateDeriveRow(row.level1_enterprise_id, { is_active: e.target.checked })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            className="min-w-[100px] rounded border border-line px-1 py-0.5 text-xs"
                            value={row.remark ?? ''}
                            onChange={(e) => updateDeriveRow(row.level1_enterprise_id, { remark: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 text-xs text-text-3">
                          {row.from_group_extra ? ui.deriveRowExtra : null}
                          {row.already_in_target ? (
                            <span className={row.from_group_extra ? ' ml-1' : ''}>{ui.deriveRowExists}</span>
                          ) : null}
                          {row.derive_hint ? <div className="text-text-2">{row.derive_hint}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <label className="mt-3 flex items-center gap-2 text-sm text-text-2">
              <input type="checkbox" checked={deriveReplace} onChange={(e) => setDeriveReplace(e.target.checked)} />
              {ui.replaceTargetLabel}
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border border-line px-3 py-1.5 text-sm" onClick={() => setShowDerive(false)}>
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void saveDerive()}
                disabled={deriveSaveBusy || derivePreviewBusy || deriveRows.length === 0}
              >
                {deriveSaveBusy ? ui.deriveSaveBusy : ui.deriveSaveBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showMembers && membersRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-text">
              {ui.membersModalTitle
                .replace('{year}', effectiveYear)
                .replace('{name}', membersRow.level1_enterprise_name)}
            </h2>
            <p className="mt-1 text-xs text-text-3">{ui.membersModalHint}</p>
            <p className="mt-1 font-mono text-xs text-text-3">{membersRow.level1_enterprise_id}</p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <input
                  className="w-full rounded border border-line px-2 py-1.5 text-sm"
                  value={membersKeyword}
                  onChange={(e) => setMembersKeyword(e.target.value)}
                  placeholder={ui.membersFilterPlaceholder}
                />
              </div>
              <button
                type="button"
                className="rounded border border-line bg-white px-3 py-1.5 text-sm hover:bg-[#f8fafc]"
                onClick={() => void reloadMembers()}
                disabled={membersBusy}
              >
                {membersBusy ? ui.membersLoading : ui.refreshBtn}
              </button>
            </div>
            <p className="mt-2 text-sm text-text-2">
              {ui.memberCountHint
                .replace('{active}', String(membersSummary.active))
                .replace('{total}', String(membersSummary.total))}
            </p>
            {membersBusy ? (
              <p className="mt-4 text-sm text-text-2">{ui.membersLoading}</p>
            ) : members.length === 0 ? (
              <p className="mt-4 text-sm text-text-2">{ui.membersEmpty}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[880px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-text-3">
                      <th className="py-2 pr-2 font-medium">{ui.membersColName}</th>
                      <th className="py-2 pr-2 font-medium">{ui.membersColId}</th>
                      <th className="py-2 pr-2 font-medium">{ui.membersColActive}</th>
                      <th className="py-2 pr-2 font-medium">{ui.membersColStateInvestor}</th>
                      <th className="py-2 font-medium">{ui.membersColQuality}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.enterprise_id} className="border-b border-line/70">
                        <td className="py-1.5 pr-2 font-medium text-text">{m.enterprise_name || '—'}</td>
                        <td className="py-1.5 pr-2 font-mono text-xs text-text-2">{m.enterprise_id}</td>
                        <td className="py-1.5 pr-2">{m.is_member ? ui.yes : ui.no}</td>
                        <td className="py-1.5 pr-2 max-w-[160px] truncate text-text-2" title={m.state_investor}>
                          {m.state_investor || '—'}
                        </td>
                        <td className="py-1.5 max-w-[200px] truncate text-text-3" title={m.quality_issue}>
                          {m.quality_issue || (m.quality_status === 'conflict' ? '待核对' : '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" className="rounded border border-line px-3 py-1.5 text-sm" onClick={() => setShowMembers(false)}>
                {ui.modalCancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showCandidates ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-text">{ui.candidatesModalTitle}</h2>
            <p className="mt-1 text-xs text-text-3">{ui.candidatesModalHint}</p>
            {candidates.length === 0 ? (
              <p className="mt-4 text-sm text-text-2">{ui.candidatesEmpty}</p>
            ) : (
              <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                {candidates.map((c) => (
                  <li key={c.level1_enterprise_id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded border border-line/60 px-2 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={pickedCand.has(c.level1_enterprise_id)}
                        onChange={() => {
                          setPickedCand((prev) => {
                            const n = new Set(prev)
                            if (n.has(c.level1_enterprise_id)) n.delete(c.level1_enterprise_id)
                            else n.add(c.level1_enterprise_id)
                            return n
                          })
                        }}
                      />
                      <span>
                        <span className="font-medium text-text">{c.level1_enterprise_name}</span>
                        <span className="ml-2 font-mono text-xs text-text-3">{c.level1_enterprise_id}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border border-line px-3 py-1.5 text-sm" onClick={() => setShowCandidates(false)}>
                {ui.modalCancel}
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void addCandidates()}
                disabled={candBusy || candidates.length === 0}
              >
                {ui.candidatesAddBtn}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
