import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  DIM_TABLE_BASE,
  DIM_TABLE_PAGE_SIZE_OPTIONS,
  DIM_TABLE_SCROLL_WRAPPER,
  DIM_TABLE_TH_STICKY,
  cellOrDash,
} from './dimDataTableShared'
import { DimTablePagination } from './DimTablePagination'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchDimDict,
  postDimDict,
  type DimDictDomainDto,
  type DimDictEntryDto,
} from '../config/localApi'
import type { NavKey } from '../types'
import { clearDimDictSessionCache } from './useDimDict'

const LS_KEY = 'invoicelens.dimDictDraft.v1'

type EntryRow = DimDictEntryDto & { _key: string }

function entryKey(code: string): string {
  return code.trim()
}

function toEntryRows(entries: DimDictEntryDto[]): EntryRow[] {
  return entries.map((e) => ({ ...e, _key: entryKey(e.code) }))
}

function sortEntries(entries: EntryRow[]): EntryRow[] {
  return [...entries].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
}

function parseCsvImport(text: string): { rows: DimDictEntryDto[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((ln) => ln.trim().length > 0)
  const errors: string[] = []
  const rows: DimDictEntryDto[] = []
  const seen = new Set<string>()
  let start = 0
  if (lines[0]?.toLowerCase().includes('code')) start = 1
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    try {
      const parts = line.split(',').map((p) => p.trim().replace(/^"|"$/g, ''))
      const code = String(parts[0] ?? '').trim()
      if (!code) {
        errors.push(`第 ${i + 1} 行：编码为空，已跳过`)
        continue
      }
      if (seen.has(code)) {
        errors.push(`第 ${i + 1} 行：编码 ${code} 重复，已跳过`)
        continue
      }
      seen.add(code)
      const label = String(parts[1] ?? code).trim() || code
      const sortRaw = parts[2]
      let sort_order = rows.length + 1
      if (sortRaw) {
        const n = Number(sortRaw)
        if (Number.isFinite(n)) sort_order = Math.floor(n)
      }
      const enabledRaw = (parts[3] ?? 'true').toLowerCase()
      const enabled = !['0', 'false', '否', 'no'].includes(enabledRaw)
      const notes = String(parts[4] ?? '').trim()
      rows.push({ code, label, sort_order, enabled, notes })
    } catch (e) {
      errors.push(`第 ${i + 1} 行解析失败：${e instanceof Error ? e.message : '未知错误'}`)
    }
  }
  return { rows, errors }
}

function exportCsv(entries: EntryRow[]): string {
  const header = 'code,label,sort_order,enabled,notes'
  const body = entries.map((e) =>
    [
      e.code,
      e.label,
      String(e.sort_order),
      e.enabled ? 'true' : 'false',
      e.notes.replace(/"/g, '""'),
    ].join(','),
  )
  return [header, ...body].join('\n')
}

type Props = {
  onNav?: (key: NavKey) => void
}

export function DimDictPage({ onNav }: Props) {
  const ui = t.dimDictUi
  const tableUi = t.dimDataTableUi
  const [domains, setDomains] = useState<DimDictDomainDto[]>([])
  const [version, setVersion] = useState(1)
  const [activeDomainId, setActiveDomainId] = useState('')
  const [domainKeyword, setDomainKeyword] = useState('')
  const [entryKeyword, setEntryKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DIM_TABLE_PAGE_SIZE_OPTIONS[0])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [showDomainDialog, setShowDomainDialog] = useState(false)
  const [domainForm, setDomainForm] = useState({
    domain_id: '',
    domain_name: '',
    description: '',
    source_table: '',
    source_column: '',
  })
  const [domainFormError, setDomainFormError] = useState('')
  const [editingEntryCode, setEditingEntryCode] = useState<string | null>(null)
  const [entryDraft, setEntryDraft] = useState<EntryRow | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const syncLocal = (list: DimDictDomainDto[], ver: number) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ version: ver, domains: list }))
    } catch {
      // ignore
    }
  }

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetchDimDict(signal)
      if (signal?.aborted) return
      if (!res.ok) {
        try {
          const raw = localStorage.getItem(LS_KEY)
          if (raw) {
            const parsed = JSON.parse(raw) as { version?: number; domains?: DimDictDomainDto[] }
            if (Array.isArray(parsed.domains) && parsed.domains.length > 0) {
              setDomains(parsed.domains)
              setVersion(parsed.version ?? 1)
              setActiveDomainId((prev) => prev || parsed.domains![0]?.domain_id || '')
              setBanner(ui.bannerOfflineMode)
              return
            }
          }
        } catch {
          // ignore
        }
        setError(res.error?.message ?? ui.loadFailed)
        return
      }
      const list = res.domains ?? []
      setDomains(list)
      setVersion(res.version ?? 1)
      setHint(res.hint ?? null)
      syncLocal(list, res.version ?? 1)
      setActiveDomainId((prev) => {
        if (prev && list.some((d) => d.domain_id === prev)) return prev
        return list[0]?.domain_id ?? ''
      })
      setDirty(false)
    } finally {
      setLoading(false)
    }
  }, [ui.bannerOfflineMode, ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const filteredDomains = useMemo(() => {
    const kw = domainKeyword.trim().toLowerCase()
    if (!kw) return domains
    return domains.filter(
      (d) =>
        d.domain_id.toLowerCase().includes(kw) ||
        d.domain_name.toLowerCase().includes(kw) ||
        d.description.toLowerCase().includes(kw) ||
        `${d.source_table}.${d.source_column}`.toLowerCase().includes(kw),
    )
  }, [domains, domainKeyword])

  const activeDomain = useMemo(
    () => domains.find((d) => d.domain_id === activeDomainId) ?? filteredDomains[0] ?? null,
    [domains, activeDomainId, filteredDomains],
  )

  const entryRows = useMemo(() => {
    if (!activeDomain) return []
    return sortEntries(toEntryRows(activeDomain.entries))
  }, [activeDomain])

  const filteredEntries = useMemo(() => {
    const kw = entryKeyword.trim().toLowerCase()
    return entryRows.filter((row) => {
      if (statusFilter === 'enabled' && !row.enabled) return false
      if (statusFilter === 'disabled' && row.enabled) return false
      if (!kw) return true
      return (
        row.code.toLowerCase().includes(kw) ||
        row.label.toLowerCase().includes(kw) ||
        row.notes.toLowerCase().includes(kw)
      )
    })
  }, [entryRows, entryKeyword, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const effectivePage = Math.min(page, totalPages)
  const pagedEntries = useMemo(() => {
    const start = (effectivePage - 1) * pageSize
    return filteredEntries.slice(start, start + pageSize)
  }, [filteredEntries, effectivePage, pageSize])

  useEffect(() => {
    setPage(1)
    setEditingEntryCode(null)
    setEntryDraft(null)
  }, [activeDomainId, entryKeyword, statusFilter])

  const updateActiveDomainEntries = (nextEntries: EntryRow[]) => {
    if (!activeDomain) return
    const sorted = sortEntries(nextEntries)
    const payload: DimDictEntryDto[] = sorted.map(({ code, label, sort_order, enabled, notes }) => ({
      code,
      label,
      sort_order,
      enabled,
      notes,
    }))
    setDomains((prev) =>
      prev.map((d) =>
        d.domain_id === activeDomain.domain_id ? { ...d, entries: payload } : d,
      ),
    )
    setDirty(true)
    setBanner('')
  }

  const onSave = async () => {
    setSaving(true)
    setError('')
    setBanner('')
    try {
      const res = await postDimDict({ version, domains })
      if (!res.ok) {
        syncLocal(domains, version)
        setError(res.error?.message ?? res.errors?.join('；') ?? ui.saveFailed)
        setBanner(ui.bannerSavedDraftAfterFail)
        return
      }
      const list = res.domains ?? domains
      setDomains(list)
      setVersion(res.version ?? version)
      syncLocal(list, res.version ?? version)
      setDirty(false)
      setBanner(res.message ?? ui.saveSuccess)
      clearDimDictSessionCache()
    } finally {
      setSaving(false)
    }
  }

  const openAddEntry = () => {
    setEditingEntryCode(null)
    setEntryDraft({
      _key: '',
      code: '',
      label: '',
      sort_order: entryRows.length + 1,
      enabled: true,
      notes: '',
    })
  }

  const openEditEntry = (row: EntryRow) => {
    setEditingEntryCode(row.code)
    setEntryDraft({ ...row })
  }

  const commitEntryDraft = () => {
    if (!entryDraft || !activeDomain) return
    const code = entryDraft.code.trim()
    const label = entryDraft.label.trim()
    if (!code || !label) {
      setError(ui.formNeedCodeLabel)
      return
    }
    const dup = entryRows.some((e) => e.code === code && e.code !== editingEntryCode)
    if (dup) {
      setError(ui.formCodeDuplicated)
      return
    }
    const next: EntryRow = {
      _key: entryKey(code),
      code,
      label,
      sort_order: Math.max(1, Math.floor(entryDraft.sort_order) || 1),
      enabled: entryDraft.enabled,
      notes: entryDraft.notes.trim(),
    }
    const others = entryRows.filter((e) => e.code !== editingEntryCode)
    updateActiveDomainEntries([...others, next])
    setEditingEntryCode(null)
    setEntryDraft(null)
    setError('')
  }

  const deleteEntry = (code: string) => {
    if (!activeDomain?.built_in && !window.confirm(ui.deleteEntryConfirm)) return
    if (activeDomain?.built_in && !window.confirm(ui.deleteBuiltinEntryConfirm)) return
    updateActiveDomainEntries(entryRows.filter((e) => e.code !== code))
  }

  const openAddDomain = () => {
    setDomainFormError('')
    setDomainForm({
      domain_id: '',
      domain_name: '',
      description: '',
      source_table: '',
      source_column: '',
    })
    setShowDomainDialog(true)
  }

  const commitDomain = () => {
    const domain_id = domainForm.domain_id.trim()
    const domain_name = domainForm.domain_name.trim()
    if (!domain_id || !domain_name) {
      setDomainFormError(ui.domainFormNeedIdName)
      return
    }
    if (!/^[a-z][a-z0-9_\-]{0,63}$/i.test(domain_id)) {
      setDomainFormError(ui.domainFormIdInvalid)
      return
    }
    if (domains.some((d) => d.domain_id === domain_id)) {
      setDomainFormError(ui.domainFormIdDuplicated)
      return
    }
    const next: DimDictDomainDto = {
      domain_id,
      domain_name,
      description: domainForm.description.trim(),
      source_table: domainForm.source_table.trim(),
      source_column: domainForm.source_column.trim(),
      built_in: false,
      entries: [],
    }
    setDomains((prev) => [...prev, next])
    setActiveDomainId(domain_id)
    setDirty(true)
    setShowDomainDialog(false)
    setDomainFormError('')
  }

  const onExportCsv = () => {
    if (!activeDomain) return
    const blob = new Blob([exportCsv(entryRows)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `dim_dict_${activeDomain.domain_id}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const onImportCsv = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '')
        const { rows, errors } = parseCsvImport(text)
        if (rows.length === 0) {
          setError(errors.join('；') || ui.importEmpty)
          return
        }
        const merged = sortEntries(toEntryRows(rows))
        updateActiveDomainEntries(merged)
        if (errors.length > 0) {
          setBanner(ui.importPartial.replace('{count}', String(rows.length)))
          setError(errors.slice(0, 5).join('；'))
        } else {
          setBanner(ui.importSuccess.replace('{count}', String(rows.length)))
          setError('')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : ui.importFailed)
      }
    }
    reader.onerror = () => setError(ui.importFailed)
    try {
      reader.readAsText(file, 'utf-8')
    } catch (e) {
      setError(e instanceof Error ? e.message : ui.importFailed)
    }
  }

  const enabledCount = entryRows.filter((e) => e.enabled).length

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        note={ui.pageDesc}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {onNav ? (
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={() => onNav('dim_subject_category')}
              >
                {ui.linkSubjectCategory}
              </button>
            ) : null}
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void onSave()}
              className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:bg-accent-mid disabled:opacity-50"
            >
              {saving ? ui.saving : ui.saveBtn}
            </button>
          </div>
        }
      />

      {hint ? (
        <div className="mb-3 rounded-[7px] border border-border-light bg-[#fafbfd] px-3 py-2 text-il-meta text-text-3">{hint}</div>
      ) : null}
      {banner ? (
        <div className="mb-3 rounded-[7px] border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{banner}</div>
      ) : null}
      {error ? (
        <div className="mb-3 rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">{error}</div>
      ) : null}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiDomainCount}</div>
          <div className="mt-1 text-il-page-title font-semibold text-text">{domains.length}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiEntryCount}</div>
          <div className="mt-1 text-il-page-title font-semibold text-text">{entryRows.length}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiEnabledCount}</div>
          <div className="mt-1 text-il-page-title font-semibold text-text">{enabledCount}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_1fr]">
        <Card title={ui.domainListTitle}>
          <div className="mb-3">
            <input
              value={domainKeyword}
              onChange={(e) => setDomainKeyword(e.target.value)}
              placeholder={ui.domainSearchPlaceholder}
              className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent"
            />
          </div>
          <button
            type="button"
            onClick={openAddDomain}
            className="mb-3 w-full rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
          >
            {ui.addDomainBtn}
          </button>
          <div className="max-h-[min(calc(100vh-20rem),520px)] overflow-y-auto rounded-[8px] border border-border-light">
            {loading ? (
              <div className="px-3 py-4 text-il-meta text-text-3">{ui.loading}</div>
            ) : filteredDomains.length === 0 ? (
              <div className="px-3 py-4 text-il-meta text-text-3">{ui.domainEmpty}</div>
            ) : (
              filteredDomains.map((d) => {
                const active = d.domain_id === activeDomain?.domain_id
                return (
                  <button
                    key={d.domain_id}
                    type="button"
                    onClick={() => setActiveDomainId(d.domain_id)}
                    className={[
                      'w-full border-b border-border-light px-3 py-2 text-left transition-colors last:border-b-0',
                      active ? 'bg-[#f0f7ff]' : 'hover:bg-[#fafcff]',
                    ].join(' ')}
                  >
                    <div className="font-medium text-text">{d.domain_name}</div>
                    <div className="font-mono text-il-pill text-text-3">{d.domain_id}</div>
                    <div className="text-il-pill text-text-3">
                      {d.entries.length} {ui.entryCountSuffix}
                      {d.built_in ? ` · ${ui.builtinTag}` : ''}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </Card>

        <Card title={activeDomain ? `${ui.entryTableTitle} · ${activeDomain.domain_name}` : ui.entryTableTitle}>
          {!activeDomain ? (
            <div className="text-il-page-desc text-text-3">{ui.selectDomainHint}</div>
          ) : (
            <>
              <div className="mb-3 rounded-[8px] border border-border-light bg-[#fafbfd] px-3 py-2 text-il-meta text-text-2">
                <div>{activeDomain.description || '—'}</div>
                <div className="mt-1 font-mono text-il-pill text-text-3">
                  {activeDomain.source_table && activeDomain.source_column
                    ? `${activeDomain.source_table}.${activeDomain.source_column}`
                    : ui.noSourceColumn}
                </div>
              </div>

              <div className="mb-3 flex flex-wrap items-end gap-2">
                <label className="min-w-[200px] flex-1">
                  <span className="mb-1 block text-il-label font-medium text-text-2">{ui.filterKeyword}</span>
                  <input
                    value={entryKeyword}
                    onChange={(e) => setEntryKeyword(e.target.value)}
                    placeholder={ui.filterKeywordPlaceholder}
                    className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent"
                  />
                </label>
                <label className="w-[140px]">
                  <span className="mb-1 block text-il-label font-medium text-text-2">{ui.filterStatus}</span>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as 'all' | 'enabled' | 'disabled')}
                    className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent"
                  >
                    <option value="all">{ui.filterStatusAll}</option>
                    <option value="enabled">{ui.filterStatusEnabled}</option>
                    <option value="disabled">{ui.filterStatusDisabled}</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={openAddEntry}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                >
                  {ui.addEntryBtn}
                </button>
                <button
                  type="button"
                  onClick={onExportCsv}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                >
                  {ui.exportCsvBtn}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                >
                  {ui.importCsvBtn}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) onImportCsv(f)
                    e.target.value = ''
                  }}
                />
              </div>

              <div className={DIM_TABLE_SCROLL_WRAPPER}>
                <table className={DIM_TABLE_BASE}>
                  <thead>
                    <tr className="text-il-meta text-text-3">
                      <th className={[DIM_TABLE_TH_STICKY, 'w-[140px]'].join(' ')}>{ui.colCode}</th>
                      <th className={[DIM_TABLE_TH_STICKY, 'w-[160px]'].join(' ')}>{ui.colLabel}</th>
                      <th className={[DIM_TABLE_TH_STICKY, 'w-[80px] text-right'].join(' ')}>{ui.colSort}</th>
                      <th className={[DIM_TABLE_TH_STICKY, 'w-[80px]'].join(' ')}>{ui.colStatus}</th>
                      <th className={[DIM_TABLE_TH_STICKY, 'min-w-[200px]'].join(' ')}>{ui.colNotes}</th>
                      <th className={[DIM_TABLE_TH_STICKY, 'w-[120px]'].join(' ')}>{ui.colAction}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedEntries.map((row) => (
                      <tr key={row.code} className="border-t border-border-light align-top hover:bg-[#fafcff]">
                        <td className="px-3 py-2 font-mono text-il-meta text-text">{cellOrDash(row.code)}</td>
                        <td className="px-3 py-2 text-text">{cellOrDash(row.label)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-text-2">{row.sort_order}</td>
                        <td className="px-3 py-2">
                          <span
                            className={[
                              'inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold',
                              row.enabled
                                ? 'border-[#c8e6d0] bg-[#f3fbf5] text-green'
                                : 'border-[#e3e7ef] bg-[#f6f8fc] text-text-3',
                            ].join(' ')}
                          >
                            {row.enabled ? ui.statusEnabled : ui.statusDisabled}
                          </span>
                        </td>
                        <td className="max-w-[280px] px-3 py-2 text-il-meta text-text-2 whitespace-pre-wrap break-words">
                          {cellOrDash(row.notes)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            <button
                              type="button"
                              className="rounded-[6px] border border-border bg-white px-2 py-[3px] text-il-btn text-text-2 hover:border-accent hover:text-accent"
                              onClick={() => openEditEntry(row)}
                            >
                              {ui.editBtn}
                            </button>
                            <button
                              type="button"
                              className="rounded-[6px] border border-border bg-white px-2 py-[3px] text-il-btn text-danger hover:border-danger/40"
                              onClick={() => deleteEntry(row.code)}
                            >
                              {ui.deleteBtn}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <DimTablePagination
                total={filteredEntries.length}
                page={effectivePage}
                pageSize={pageSize}
                loading={loading}
                ui={tableUi}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          )}
        </Card>
      </div>

      {entryDraft ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-[560px] rounded-[10px] border border-border-light bg-white p-5 shadow-[0_12px_30px_rgba(15,23,42,.18)]">
            <div className="mb-3 text-il-page-title font-semibold text-text">
              {editingEntryCode ? ui.editEntryTitle : ui.addEntryTitle}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.colCode}</span>
                <input
                  value={entryDraft.code}
                  disabled={!!editingEntryCode}
                  onChange={(e) => setEntryDraft((v) => (v ? { ...v, code: e.target.value } : v))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent disabled:opacity-60"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.colLabel}</span>
                <input
                  value={entryDraft.label}
                  onChange={(e) => setEntryDraft((v) => (v ? { ...v, label: e.target.value } : v))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.colSort}</span>
                <input
                  type="number"
                  min={1}
                  value={entryDraft.sort_order}
                  onChange={(e) =>
                    setEntryDraft((v) =>
                      v ? { ...v, sort_order: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : v,
                    )
                  }
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex items-end pb-2">
                <span className="inline-flex items-center gap-2 text-il-meta text-text-2">
                  <input
                    type="checkbox"
                    checked={entryDraft.enabled}
                    onChange={(e) => setEntryDraft((v) => (v ? { ...v, enabled: e.target.checked } : v))}
                  />
                  {ui.formEnabled}
                </span>
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.colNotes}</span>
                <textarea
                  value={entryDraft.notes}
                  onChange={(e) => setEntryDraft((v) => (v ? { ...v, notes: e.target.value } : v))}
                  rows={3}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2"
                onClick={() => {
                  setEntryDraft(null)
                  setEditingEntryCode(null)
                }}
              >
                {ui.dialogCancel}
              </button>
              <button
                type="button"
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white"
                onClick={commitEntryDraft}
              >
                {ui.dialogConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDomainDialog ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-[560px] rounded-[10px] border border-border-light bg-white p-5 shadow-[0_12px_30px_rgba(15,23,42,.18)]">
            <div className="mb-3 text-il-page-title font-semibold text-text">{ui.addDomainTitle}</div>
            <div className="grid grid-cols-1 gap-3">
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.domainIdLabel}</span>
                <input
                  value={domainForm.domain_id}
                  onChange={(e) => setDomainForm((v) => ({ ...v, domain_id: e.target.value }))}
                  placeholder={ui.domainIdPlaceholder}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 font-mono text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.domainNameLabel}</span>
                <input
                  value={domainForm.domain_name}
                  onChange={(e) => setDomainForm((v) => ({ ...v, domain_name: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.domainDescLabel}</span>
                <textarea
                  value={domainForm.description}
                  onChange={(e) => setDomainForm((v) => ({ ...v, description: e.target.value }))}
                  rows={2}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="mb-1 block text-il-label font-medium text-text-2">{ui.sourceTableLabel}</span>
                  <input
                    value={domainForm.source_table}
                    onChange={(e) => setDomainForm((v) => ({ ...v, source_table: e.target.value }))}
                    className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 font-mono text-il-input text-text outline-none focus:border-accent"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-il-label font-medium text-text-2">{ui.sourceColumnLabel}</span>
                  <input
                    value={domainForm.source_column}
                    onChange={(e) => setDomainForm((v) => ({ ...v, source_column: e.target.value }))}
                    className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 font-mono text-il-input text-text outline-none focus:border-accent"
                  />
                </label>
              </div>
            </div>
            {domainFormError ? (
              <div className="mt-3 rounded-[6px] border border-danger/30 bg-[#fff5f5] px-2.5 py-2 text-il-meta text-danger">
                {domainFormError}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2"
                onClick={() => setShowDomainDialog(false)}
              >
                {ui.dialogCancel}
              </button>
              <button
                type="button"
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white"
                onClick={commitDomain}
              >
                {ui.dialogConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
