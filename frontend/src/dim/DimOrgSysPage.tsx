import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  DIM_TABLE_BASE,
  DIM_TABLE_SCROLL_WRAPPER,
  DIM_TABLE_TD,
  DIM_TABLE_TD_ELLIPSIS,
  DIM_TABLE_TH_STICKY,
  cellOrDash,
  cellSingleLine,
  dimTableRowTone,
} from './dimDataTableShared'
import { useResizableTableColumns, type ResizableColDef } from './useResizableTableColumns'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchDimOrgSysExport,
  fetchDimOrgSysList,
  postDimOrgSysBootstrapDemo,
  postDimOrgSysDelete,
  postDimOrgSysSave,
  type DimOrgSysItemDto,
} from '../config/localApi'
import type { NavKey } from '../types'

type FormState = {
  sys_id: string
  sys_name: string
  admin_level: string
  gov_owner: string
  description: string
  sort_no: string
  is_active: boolean
}

const emptyForm = (): FormState => ({
  sys_id: '',
  sys_name: '',
  admin_level: '省',
  gov_owner: '',
  description: '',
  sort_no: '1',
  is_active: true,
})

const ORG_SYS_COL_STORAGE_KEY = 'il.dimOrgSys.colWidths.v1'

const ORG_SYS_COLUMNS: ResizableColDef[] = [
  { key: 'sys_id', defaultWidth: 108, minWidth: 72 },
  { key: 'sys_name', defaultWidth: 120, minWidth: 72 },
  { key: 'admin_level', defaultWidth: 72, minWidth: 52 },
  { key: 'gov_owner', defaultWidth: 168, minWidth: 96 },
  { key: 'description', defaultWidth: 320, minWidth: 120 },
  { key: 'sort_no', defaultWidth: 64, minWidth: 48 },
  { key: 'is_active', defaultWidth: 64, minWidth: 48 },
  { key: 'ref_count', defaultWidth: 64, minWidth: 48 },
  { key: 'actions', defaultWidth: 112, minWidth: 88 },
]

type Props = {
  onNav?: (key: NavKey) => void
}

export function DimOrgSysPage({ onNav }: Props) {
  const ui = t.dimOrgSysUi
  const { widths: colWidths, tableWidth, activeIndex: resizeColIndex, beginResize } = useResizableTableColumns(
    ORG_SYS_COL_STORAGE_KEY,
    ORG_SYS_COLUMNS,
  )
  const [items, setItems] = useState<DimOrgSysItemDto[]>([])
  const [scopeSysId, setScopeSysId] = useState('')
  const [scopeRootId, setScopeRootId] = useState('')
  const [adminLevels, setAdminLevels] = useState<string[]>(['省', '市', '区/县', '中央', '其他'])
  const [emptyHint, setEmptyHint] = useState('')
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [banner, setBanner] = useState('')
  const [showDialog, setShowDialog] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [formError, setFormError] = useState('')
  const [selectedSysId, setSelectedSysId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const res = await fetchDimOrgSysList()
    setLoading(false)
    if (!res.ok) {
      setError(res.error?.message ?? ui.loadFailed)
      return
    }
    setItems(res.items ?? [])
    setScopeSysId(res.scope_sys_id ?? '')
    setScopeRootId(res.scope_root_id ?? '')
    if (res.admin_levels?.length) setAdminLevels(res.admin_levels)
    setEmptyHint(res.empty_hint ?? '')
    setSelectedSysId((prev) => {
      const nextItems = res.items ?? []
      if (prev && nextItems.some((row) => row.sys_id === prev)) return prev
      return null
    })
  }, [ui.loadFailed])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return items.filter((row) => {
      if (statusFilter === 'active' && !row.is_active) return false
      if (statusFilter === 'inactive' && row.is_active) return false
      if (!kw) return true
      return (
        row.sys_id.toLowerCase().includes(kw) ||
        row.sys_name.toLowerCase().includes(kw) ||
        row.admin_level.toLowerCase().includes(kw) ||
        (row.gov_owner ?? '').toLowerCase().includes(kw) ||
        (row.description ?? '').toLowerCase().includes(kw)
      )
    })
  }, [items, keyword, statusFilter])

  const openCreate = () => {
    setEditId(null)
    setForm(emptyForm())
    setFormError('')
    setShowDialog(true)
  }

  const openEdit = (row: DimOrgSysItemDto) => {
    setSelectedSysId(row.sys_id)
    setEditId(row.sys_id)
    setForm({
      sys_id: row.sys_id,
      sys_name: row.sys_name,
      admin_level: row.admin_level,
      gov_owner: row.gov_owner ?? '',
      description: row.description ?? '',
      sort_no: String(row.sort_no ?? 0),
      is_active: row.is_active,
    })
    setFormError('')
    setShowDialog(true)
  }

  const onSave = async () => {
    setFormError('')
    const sysId = form.sys_id.trim().toUpperCase()
    if (!sysId) {
      setFormError(ui.formSysIdRequired)
      return
    }
    if (!form.sys_name.trim()) {
      setFormError(ui.formSysNameRequired)
      return
    }
    setBusy(true)
    const res = await postDimOrgSysSave({
      sys_id: sysId,
      sys_name: form.sys_name.trim(),
      admin_level: form.admin_level,
      gov_owner: form.gov_owner.trim(),
      description: form.description.trim(),
      sort_no: Number(form.sort_no) || 0,
      is_active: form.is_active,
    })
    setBusy(false)
    if (!res.ok) {
      setFormError(res.error?.message ?? ui.saveFailed)
      return
    }
    setShowDialog(false)
    setBanner(res.created ? ui.bannerCreated.replace('{id}', sysId) : ui.bannerUpdated.replace('{id}', sysId))
    await load()
  }

  const onDelete = async (row: DimOrgSysItemDto) => {
    const refTotal = (row.node_count ?? 0) + (row.hier_count ?? 0)
    const msg = refTotal > 0 ? ui.confirmDeactivate.replace('{id}', row.sys_id) : ui.confirmDelete.replace('{id}', row.sys_id)
    if (!window.confirm(msg)) return
    setBusy(true)
    const res = await postDimOrgSysDelete(row.sys_id)
    setBusy(false)
    if (!res.ok) {
      setError(res.error?.message ?? ui.deleteFailed)
      return
    }
    if (selectedSysId === row.sys_id) setSelectedSysId(null)
    setBanner(res.message ?? (res.deactivated ? ui.bannerDeactivated : ui.bannerDeleted).replace('{id}', row.sys_id))
    await load()
  }

  const onExport = async () => {
    setBusy(true)
    setError('')
    const res = await fetchDimOrgSysExport()
    setBusy(false)
    if (!res.ok || !res.blob) {
      setError(res.error?.message ?? ui.exportFailed)
      return
    }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = res.fileName ?? '监管体系清单.xlsx'
    a.click()
    URL.revokeObjectURL(url)
    setBanner(ui.bannerExported)
  }

  const onBootstrapDemo = async () => {
    setBusy(true)
    setError('')
    const res = await postDimOrgSysBootstrapDemo()
    setBusy(false)
    if (!res.ok) {
      setError(res.error?.message ?? ui.bootstrapFailed)
      return
    }
    const count = res.seeded_count ?? 0
    setBanner(count > 0 ? res.message ?? ui.bannerBootstrapOk : ui.bannerBootstrapNone)
    await load()
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        description={ui.pageDesc}
        note={ui.pageNote}
        noteTone="plain"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={() => void onBootstrapDemo()}
            >
              {ui.bootstrapDemoButton}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
              onClick={openCreate}
            >
              {ui.createButton}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc] disabled:opacity-60"
              onClick={() => void onExport()}
            >
              {ui.exportButton}
            </button>
            {onNav ? (
              <button
                type="button"
                className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-accent hover:bg-[#f8fafc]"
                onClick={() => onNav('dim_org_hier_tree')}
              >
                {ui.gotoImport}
              </button>
            ) : null}
          </div>
        }
      />

      {scopeSysId ? (
        <div className="mb-4 rounded-sm border border-border-light bg-[#fafbfd] px-3 py-2 text-il-page-desc text-text-2">
          {ui.scopeHint.replace('{sysId}', scopeSysId).replace('{rootId}', scopeRootId || '—')}
        </div>
      ) : null}

      {banner ? <p className="mb-3 text-il-meta text-[#1b6b3a]">{banner}</p> : null}
      {error ? <p className="mb-3 text-il-meta text-red-600">{error}</p> : null}

      <Card title={ui.tableTitle}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-il-label text-text-2">
            <div className="mb-1 text-text-3">{ui.keywordLabel}</div>
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={ui.keywordPlaceholder}
              className="w-52 rounded-sm border border-border-light px-2 py-1.5 text-il-page-desc"
            />
          </label>
          <label className="text-il-label text-text-2">
            <div className="mb-1 text-text-3">{ui.statusFilterLabel}</div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded-sm border border-border-light px-2 py-1.5 text-il-page-desc"
            >
              <option value="all">{ui.statusAll}</option>
              <option value="active">{ui.statusActive}</option>
              <option value="inactive">{ui.statusInactive}</option>
            </select>
          </label>
        </div>

        {!loading && items.length === 0 ? (
          <div className="rounded-sm border border-dashed border-border-light bg-[#fafbfd] px-4 py-6 text-center">
            <p className="text-il-page-desc text-text-2">{emptyHint || ui.emptyHint}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc] disabled:opacity-60"
                onClick={() => void onBootstrapDemo()}
              >
                {ui.bootstrapDemoButton}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
                onClick={openCreate}
              >
                {ui.createButton}
              </button>
            </div>
          </div>
        ) : (
          <div className={DIM_TABLE_SCROLL_WRAPPER}>
            <table
              className={`${DIM_TABLE_BASE} table-fixed`}
              style={{ tableLayout: 'fixed', width: tableWidth, minWidth: '100%' }}
            >
              <colgroup>
                {colWidths.map((w, i) => (
                  <col key={ORG_SYS_COLUMNS[i]?.key ?? i} style={{ width: w }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {(
                    [
                      { label: ui.colSysId, align: 'text-center' as const },
                      { label: ui.colSysName, align: '' },
                      { label: ui.colAdminLevel, align: 'text-center' as const },
                      { label: ui.colGovOwner, align: '' },
                      { label: ui.colDescription, align: '' },
                      { label: ui.colSortNo, align: 'text-center' as const },
                      { label: ui.colActive, align: 'text-center' as const },
                      { label: ui.colRefCount, align: 'text-center' as const },
                      { label: ui.colActions, align: '' },
                    ] as const
                  ).map((col, index) => (
                    <th
                      key={ORG_SYS_COLUMNS[index]?.key ?? col.label}
                      className={[DIM_TABLE_TH_STICKY, 'il-col-resize-th', col.align].filter(Boolean).join(' ')}
                    >
                      {col.label}
                      {index < ORG_SYS_COLUMNS.length - 1 ? (
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`${col.label}列宽`}
                          className={[
                            'il-col-resize-handle',
                            resizeColIndex === index ? 'is-active' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            beginResize(index, e.clientX)
                          }}
                        />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-4 text-center text-il-page-desc text-text-3">
                      …
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-4 text-center text-il-page-desc text-text-3">
                      {ui.filterEmpty}
                    </td>
                  </tr>
                ) : (
                  filtered.map((row, idx) => {
                    const activeRow = selectedSysId === row.sys_id
                    const refTotal = (row.node_count ?? 0) + (row.hier_count ?? 0)
                    const descText = cellSingleLine(row.description)
                    const govOwnerText = cellSingleLine(row.gov_owner)
                    return (
                    <tr
                      key={row.sys_id}
                      onClick={() => setSelectedSysId(row.sys_id)}
                      className={[
                        'cursor-pointer align-middle last:[&>td]:border-b-0',
                        dimTableRowTone({ idx, active: activeRow }),
                      ].join(' ')}
                    >
                      <td className={`${DIM_TABLE_TD_ELLIPSIS} text-center font-mono text-[12px]`} title={row.sys_id}>
                        <span className="il-table-ellipsis">{cellOrDash(row.sys_id)}</span>
                      </td>
                      <td className={DIM_TABLE_TD_ELLIPSIS} title={row.sys_name}>
                        <span className="il-table-ellipsis">{cellOrDash(row.sys_name)}</span>
                      </td>
                      <td className={`${DIM_TABLE_TD_ELLIPSIS} text-center`}>
                        <span className="il-table-ellipsis">{cellOrDash(row.admin_level)}</span>
                      </td>
                      <td className={DIM_TABLE_TD_ELLIPSIS} title={govOwnerText === '—' ? undefined : govOwnerText}>
                        <span className="il-table-ellipsis text-text-2">{govOwnerText}</span>
                      </td>
                      <td className={DIM_TABLE_TD_ELLIPSIS} title={descText === '—' ? undefined : descText}>
                        <span className="il-table-ellipsis text-text-2">{descText}</span>
                      </td>
                      <td className={`${DIM_TABLE_TD} tabular-nums text-center`}>{row.sort_no ?? 0}</td>
                      <td className={`${DIM_TABLE_TD} text-center`}>{row.is_active ? ui.yes : ui.no}</td>
                      <td className={`${DIM_TABLE_TD} tabular-nums text-center`}>{(row.node_count ?? 0) + (row.hier_count ?? 0)}</td>
                      <td className={DIM_TABLE_TD}>
                        <div className="flex flex-nowrap gap-2 whitespace-nowrap">
                          <button
                            type="button"
                            disabled={busy}
                            className="text-il-meta text-accent hover:underline disabled:opacity-60"
                            onClick={(e) => {
                              e.stopPropagation()
                              openEdit(row)
                            }}
                          >
                            {ui.editAction}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            className="text-il-meta text-red-600 hover:underline disabled:opacity-60"
                            onClick={(e) => {
                              e.stopPropagation()
                              void onDelete(row)
                            }}
                          >
                            {refTotal > 0 ? ui.deactivateAction : ui.deleteAction}
                          </button>
                        </div>
                      </td>
                    </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-il-meta text-text-3">{ui.tableHint}</p>
      </Card>

      {showDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-lg rounded-sm border border-border-light bg-white p-4 shadow-lg">
            <div className="mb-3 text-il-label font-medium text-text">
              {editId ? ui.dialogEditTitle : ui.dialogCreateTitle}
            </div>
            <div className="space-y-3">
              <label className="block text-il-page-desc text-text-2">
                <span className="mb-1 block text-text-3">{ui.colSysId}</span>
                <input
                  type="text"
                  value={form.sys_id}
                  disabled={!!editId}
                  onChange={(e) => setForm((f) => ({ ...f, sys_id: e.target.value.toUpperCase() }))}
                  placeholder="PROV_SD"
                  className="w-full rounded-sm border border-border-light px-2 py-1.5 font-mono text-[12px] disabled:bg-[#f5f7fa]"
                />
              </label>
              <label className="block text-il-page-desc text-text-2">
                <span className="mb-1 block text-text-3">{ui.colSysName}</span>
                <input
                  type="text"
                  value={form.sys_name}
                  onChange={(e) => setForm((f) => ({ ...f, sys_name: e.target.value }))}
                  className="w-full rounded-sm border border-border-light px-2 py-1.5"
                />
              </label>
              <label className="block text-il-page-desc text-text-2">
                <span className="mb-1 block text-text-3">{ui.colAdminLevel}</span>
                <select
                  value={form.admin_level}
                  onChange={(e) => setForm((f) => ({ ...f, admin_level: e.target.value }))}
                  className="w-full rounded-sm border border-border-light px-2 py-1.5"
                >
                  {adminLevels.map((lv) => (
                    <option key={lv} value={lv}>
                      {lv}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-il-page-desc text-text-2">
                <span className="mb-1 block text-text-3">{ui.colGovOwner}</span>
                <input
                  type="text"
                  value={form.gov_owner}
                  onChange={(e) => setForm((f) => ({ ...f, gov_owner: e.target.value }))}
                  className="w-full rounded-sm border border-border-light px-2 py-1.5"
                />
              </label>
              <label className="block text-il-page-desc text-text-2">
                <span className="mb-1 block text-text-3">{ui.colDescription}</span>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder={ui.formDescriptionPlaceholder}
                  rows={3}
                  className="w-full rounded-sm border border-border-light px-2 py-1.5"
                />
              </label>
              <label className="block text-il-page-desc text-text-2">
                <span className="mb-1 block text-text-3">{ui.colSortNo}</span>
                <input
                  type="number"
                  value={form.sort_no}
                  onChange={(e) => setForm((f) => ({ ...f, sort_no: e.target.value }))}
                  className="w-full rounded-sm border border-border-light px-2 py-1.5"
                />
              </label>
              <label className="inline-flex items-center gap-2 text-il-page-desc text-text-2">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                />
                {ui.colActive}
              </label>
            </div>
            {formError ? <p className="mt-2 text-il-meta text-red-600">{formError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-meta text-text hover:bg-[#f8fafc]"
                onClick={() => setShowDialog(false)}
              >
                {ui.cancel}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-sm bg-accent px-3 py-1.5 text-il-meta font-medium text-white hover:bg-accent-mid disabled:opacity-60"
                onClick={() => void onSave()}
              >
                {ui.save}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
