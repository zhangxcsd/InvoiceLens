import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '../components/Card'
import {
  fetchFieldMappingTemplate,
  fetchFieldMappingTemplateExportZip,
  fetchFieldMappingTemplateSampleDownload,
  fetchFieldMappingTemplates,
  postFieldMappingTemplateActivate,
  postFieldMappingTemplateCreate,
  postFieldMappingTemplateDelete,
  postFieldMappingTemplateImportZip,
  postFieldMappingTemplatePreviewZip,
  postFieldMappingTemplateSave,
  type FieldMappingConfig,
  type FieldMappingTemplateDetail,
  type FieldMappingTemplateSummary,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { FieldMappingEditor } from './FieldMappingEditor'
import { cloneMapping } from './fieldMappingEditorModel'

type Props = {
  onNavMapping?: () => void
}

type CreateForm = {
  name: string
  description: string
  source_template_id: string
}

const EMPTY_CREATE: CreateForm = { name: '', description: '', source_template_id: 'builtin_default' }

export function MappingTemplatesPrototype({ onNavMapping }: Props) {
  const ui = t.fieldMappingUi
  const [templates, setTemplates] = useState<FieldMappingTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE)
  const [createBusy, setCreateBusy] = useState(false)
  const [detail, setDetail] = useState<FieldMappingTemplateDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editorResetKey, setEditorResetKey] = useState('0')
  const [importBusy, setImportBusy] = useState(false)
  const [importActivateAfter, setImportActivateAfter] = useState(true)
  const [importedTemplateId, setImportedTemplateId] = useState<string | null>(null)
  const zipInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setLoadErr(null)
    try {
      const res = await fetchFieldMappingTemplates(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setLoadErr(res.error?.message ?? ui.templatesLoadFailed)
        setTemplates([])
        return
      }
      setTemplates(res.templates ?? [])
    } finally {
      setLoading(false)
    }
  }, [ui.templatesLoadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const applyDetail = (tpl: FieldMappingTemplateDetail) => {
    setDetail(tpl)
    setEditName(tpl.name)
    setEditDesc(tpl.description ?? '')
    setEditorResetKey(`${tpl.template_id}-${Date.now()}`)
  }

  const openDetail = async (tpl: FieldMappingTemplateSummary) => {
    setDetailBusy(true)
    setMsg(null)
    try {
      const res = await fetchFieldMappingTemplate(tpl.template_id)
      if (!res.ok || !res.template) {
        setMsg(res.error?.message ?? ui.templatesLoadFailed)
        return
      }
      applyDetail(res.template)
    } finally {
      setDetailBusy(false)
    }
  }

  const refreshDetail = async (): Promise<FieldMappingConfig | null> => {
    if (!detail) return null
    const res = await fetchFieldMappingTemplate(detail.template_id)
    if (!res.ok || !res.template) return null
    applyDetail(res.template)
    return {
      default_fields: res.template.default_fields,
      sheets: res.template.sheets,
    }
  }

  const onCreate = async () => {
    if (!createForm.name.trim()) {
      setMsg(ui.templatesNameRequired)
      return
    }
    setCreateBusy(true)
    setMsg(null)
    try {
      const res = await postFieldMappingTemplateCreate({
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        source_template_id: createForm.source_template_id || 'builtin_default',
      })
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.saveFailed)
        return
      }
      setMsg(ui.templatesCreateSuccess)
      setCreateOpen(false)
      setCreateForm(EMPTY_CREATE)
      await load()
    } finally {
      setCreateBusy(false)
    }
  }

  const onDuplicate = async (tpl: FieldMappingTemplateSummary) => {
    setActionBusy(tpl.template_id)
    setMsg(null)
    try {
      const res = await postFieldMappingTemplateCreate({
        name: `${tpl.name}（副本）`,
        description: tpl.description,
        source_template_id: tpl.template_id,
      })
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.saveFailed)
        return
      }
      setMsg(ui.templatesCreateSuccess)
      await load()
      if (detail?.template_id === tpl.template_id) {
        await refreshDetail()
      }
    } finally {
      setActionBusy(null)
    }
  }

  const onDelete = async (tpl: FieldMappingTemplateSummary) => {
    if (tpl.is_builtin) return
    if (!window.confirm(ui.templatesDeleteConfirm.replace('{name}', tpl.name))) return
    setActionBusy(tpl.template_id)
    setMsg(null)
    try {
      const res = await postFieldMappingTemplateDelete(tpl.template_id)
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.templatesDeleteFailed)
        return
      }
      setMsg(ui.templatesDeleteSuccess)
      if (detail?.template_id === tpl.template_id) setDetail(null)
      await load()
    } finally {
      setActionBusy(null)
    }
  }

  const onActivate = async (tpl: FieldMappingTemplateSummary) => {
    setActionBusy(tpl.template_id)
    setMsg(null)
    try {
      const res = await postFieldMappingTemplateActivate(tpl.template_id)
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.templatesActivateFailed)
        return
      }
      setMsg(ui.templatesActivateSuccess)
      await load()
      if (detail?.template_id === tpl.template_id) await refreshDetail()
    } finally {
      setActionBusy(null)
    }
  }

  const onSaveTemplate = async (config: FieldMappingConfig) => {
    if (!detail || detail.is_builtin) {
      return { ok: false, error: ui.templatesBuiltinReadOnlyBanner }
    }
    const name = editName.trim()
    if (!name) {
      return { ok: false, error: ui.templatesNameRequired }
    }
    const res = await postFieldMappingTemplateSave({
      template_id: detail.template_id,
      name,
      description: editDesc.trim() || undefined,
      default_fields: config.default_fields,
      sheets: config.sheets ?? {},
    })
    if (!res.ok) {
      return { ok: false, error: res.error?.message ?? ui.saveFailed }
    }
    setMsg(ui.templatesSaveSuccess)
    await load()
    await refreshDetail()
    return { ok: true }
  }

  const onImportZip = async (file: File) => {
    setImportBusy(true)
    setMsg(null)
    setImportedTemplateId(null)
    try {
      const preview = await postFieldMappingTemplatePreviewZip({ file })
      if (!preview.ok) {
        setMsg(preview.error?.message ?? ui.templatesImportZipFailed)
        return
      }
      let overwrite = false
      if (preview.preview?.has_conflict && preview.preview.conflict) {
        const c = preview.preview.conflict
        const ok = window.confirm(
          ui.templatesImportZipOverwriteConfirm
            .replace('{id}', c.template_id ?? '')
            .replace('{existing}', c.existing_name ?? '')
            .replace('{incoming}', c.import_name ?? preview.preview.name ?? file.name),
        )
        if (!ok) {
          setMsg(ui.templatesImportZipOverwriteCancelled)
          return
        }
        overwrite = true
      }

      const res = await postFieldMappingTemplateImportZip({
        file,
        overwrite,
        activate: importActivateAfter,
      })
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.templatesImportZipFailed)
        return
      }
      const tid = res.template_id ?? res.summary?.template_id
      const name = res.summary?.name ?? file.name
      const sampleNote =
        res.import_meta?.sample_persisted_count && res.import_meta.sample_persisted_count > 0
          ? `（已保存 ${res.import_meta.sample_persisted_count} 个样例 Excel）`
          : res.import_meta?.sample_excel_count && res.import_meta.sample_excel_count > 0
            ? `（ZIP 含 ${res.import_meta.sample_excel_count} 个样例 Excel，仅供参考）`
            : ''
      const actionNote = res.overwritten
        ? ui.templatesImportZipOverwritten
        : res.activated
          ? ui.templatesImportZipActivated
          : ''
      setMsg(`${ui.templatesImportZipSuccess.replace('{name}', name)}${sampleNote}${actionNote}`)
      if (tid) setImportedTemplateId(tid)
      await load()
    } finally {
      setImportBusy(false)
      if (zipInputRef.current) zipInputRef.current.value = ''
    }
  }

  const onOpenImported = async () => {
    if (!importedTemplateId) return
    const tpl = templates.find((t) => t.template_id === importedTemplateId)
    if (tpl) {
      await openDetail(tpl)
      return
    }
    setDetailBusy(true)
    try {
      const res = await fetchFieldMappingTemplate(importedTemplateId)
      if (res.ok && res.template) applyDetail(res.template)
    } finally {
      setDetailBusy(false)
    }
  }

  const onExportZip = async (tpl: FieldMappingTemplateSummary) => {
    setActionBusy(tpl.template_id)
    setMsg(null)
    try {
      const res = await fetchFieldMappingTemplateExportZip(tpl.template_id)
      if (!res.ok || !res.blob) {
        setMsg(res.error?.message ?? ui.templatesExportZipFailed)
        return
      }
      const url = URL.createObjectURL(res.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.fileName ?? `${tpl.name}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setActionBusy(null)
    }
  }

  const onDownloadSample = async (templateId: string, filename: string) => {
    setActionBusy(`${templateId}:${filename}`)
    setMsg(null)
    try {
      const res = await fetchFieldMappingTemplateSampleDownload(templateId, filename)
      if (!res.ok || !res.blob) {
        setMsg(res.error?.message ?? ui.templatesSampleDownloadFailed)
        return
      }
      const url = URL.createObjectURL(res.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.fileName ?? filename
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setActionBusy(null)
    }
  }

  const formatSampleSize = (bytes?: number) => {
    const n = Number(bytes ?? 0)
    if (n <= 0) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  const detailConfig: FieldMappingConfig | null = detail
    ? { default_fields: detail.default_fields, sheets: detail.sheets }
    : null

  return (
    <div className="flex min-h-0 flex-col p-[22px]">
      <div className="mb-5 shrink-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-il-page-title font-semibold text-text">{ui.templatesPageTitle}</span>
          <span
            className={[
              'rounded border px-2 py-0.5 text-il-soon',
              loadErr ? 'border-danger/30 bg-[#fff5f5] text-danger' : 'border-[#c8dff7] bg-[#f0f7ff] text-accent-mid',
            ].join(' ')}
          >
            {loadErr ? ui.sourceOffline : ui.sourceLive}
          </span>
        </div>
        <p className="max-w-3xl text-il-page-desc leading-relaxed text-text-2">{ui.templatesPageBody}</p>
      </div>

      <div className="mb-4 shrink-0 rounded-[10px] border border-border-light bg-[#fafbfc] px-4 py-3 text-il-meta leading-relaxed text-text-2">
        {ui.templatesInfoBanner}
      </div>

      {msg ? (
        <p className="mb-3 text-il-meta text-text-2">
          {msg}
          {importedTemplateId ? (
            <button
              type="button"
              className="ml-2 text-il-btn text-accent underline"
              onClick={() => void onOpenImported()}
            >
              {ui.templatesImportZipOpen}
            </button>
          ) : null}
        </p>
      ) : null}
      {loadErr ? <p className="mb-3 text-il-meta text-danger">{loadErr}</p> : null}

      <Card title={ui.templatesListTitle}>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-[7px] border border-accent bg-accent px-3 py-1.5 text-il-btn font-medium text-white hover:opacity-90"
            onClick={() => {
              setCreateOpen(true)
              setCreateForm({ ...EMPTY_CREATE, source_template_id: 'builtin_default' })
              setMsg(null)
            }}
          >
            {ui.templatesCreateBtn}
          </button>
          <button
            type="button"
            className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn font-medium text-text-2 hover:bg-[#f7f7f7] disabled:opacity-50"
            disabled={importBusy}
            onClick={() => zipInputRef.current?.click()}
          >
            {importBusy ? ui.templatesImportZipBusy : ui.templatesImportZipBtn}
          </button>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onImportZip(f)
            }}
          />
          <label className="flex items-center gap-2 text-il-meta text-text-2">
            <input
              type="checkbox"
              checked={importActivateAfter}
              onChange={(e) => setImportActivateAfter(e.target.checked)}
            />
            {ui.templatesImportZipActivateAfter}
          </label>
          <span className="text-xs text-text-3">{ui.templatesImportZipHint}</span>
          {onNavMapping ? (
            <button
              type="button"
              className="rounded-[7px] border border-accent bg-white px-3 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff]"
              onClick={onNavMapping}
            >
              {ui.templatesOpenMappingConfig}
            </button>
          ) : null}
        </div>

        {loading ? (
          <p className="text-il-meta text-text-3">{ui.templatesLoading}</p>
        ) : templates.length === 0 ? (
          <p className="text-il-meta text-text-3">{ui.templatesEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-3 font-medium">{ui.templatesColName}</th>
                  <th className="py-2 pr-3 font-medium">{ui.templatesColFields}</th>
                  <th className="py-2 pr-3 font-medium">{ui.templatesColType}</th>
                  <th className="py-2 pr-3 font-medium">{ui.templatesColStatus}</th>
                  <th className="py-2 font-medium">{ui.templatesColActions}</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl) => {
                  const busy = actionBusy === tpl.template_id
                  const isOpen = detail?.template_id === tpl.template_id
                  return (
                    <tr
                      key={tpl.template_id}
                      className={['border-b border-border/60', isOpen ? 'bg-[#f7fbff]' : ''].join(' ')}
                    >
                      <td className="py-2 pr-3">
                        <div className="font-medium text-text">{tpl.name}</div>
                        {tpl.description ? (
                          <div className="mt-0.5 text-xs text-text-3">{tpl.description}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-text-2 tabular-nums">
                        {ui.templatesFieldCountHint
                          .replace('{defaultCount}', String(tpl.default_field_count ?? 0))
                          .replace('{sheetCount}', String(tpl.sheet_count ?? 0))}
                        {(tpl.sample_excel_count ?? 0) > 0 ? (
                          <div className="mt-0.5 text-xs text-text-3">
                            {ui.templatesSampleCountHint.replace('{count}', String(tpl.sample_excel_count ?? 0))}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        {tpl.is_builtin ? (
                          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-xs text-accent-mid">
                            {ui.templatesBuiltinTag}
                          </span>
                        ) : (
                          <span className="text-xs text-text-3">{ui.templatesCustomTag}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {tpl.is_active ? (
                          <span className="rounded bg-[#e8f5e9] px-2 py-0.5 text-xs text-[#2e7d32]">
                            {ui.templatesActiveTag}
                          </span>
                        ) : (
                          <span className="text-xs text-text-3">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="text-il-btn text-accent"
                            disabled={detailBusy}
                            onClick={() => void openDetail(tpl)}
                          >
                            {tpl.is_builtin ? ui.templatesViewBtn : ui.templatesEditBtn}
                          </button>
                          <button
                            type="button"
                            className="text-il-btn text-accent"
                            disabled={busy}
                            onClick={() => void onDuplicate(tpl)}
                          >
                            {ui.templatesDuplicateBtn}
                          </button>
                          <button
                            type="button"
                            className="text-il-btn text-accent"
                            disabled={busy}
                            onClick={() => void onExportZip(tpl)}
                          >
                            {ui.templatesExportZipBtn}
                          </button>
                          {!tpl.is_active ? (
                            <button
                              type="button"
                              className="text-il-btn text-accent"
                              disabled={busy}
                              onClick={() => void onActivate(tpl)}
                            >
                              {ui.templatesActivateBtn}
                            </button>
                          ) : null}
                          {!tpl.is_builtin ? (
                            <button
                              type="button"
                              className="text-il-btn text-danger"
                              disabled={busy}
                              onClick={() => void onDelete(tpl)}
                            >
                              {ui.templatesDeleteBtn}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {createOpen ? (
        <Card title={ui.templatesCreateDialogTitle} className="mt-4 max-w-lg">
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.templatesNameLabel}</span>
              <input
                className="rounded border border-border px-2 py-1.5 text-sm"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.templatesDescLabel}</span>
              <input
                className="rounded border border-border px-2 py-1.5 text-sm"
                value={createForm.description}
                onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.templatesSourceLabel}</span>
              <select
                className="rounded border border-border px-2 py-1.5 text-sm"
                value={createForm.source_template_id}
                onChange={(e) => setCreateForm((f) => ({ ...f, source_template_id: e.target.value }))}
              >
                {templates.map((tpl) => (
                  <option key={tpl.template_id} value={tpl.template_id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="rounded-[7px] border border-accent bg-accent px-3 py-1.5 text-il-btn text-white disabled:opacity-50"
                disabled={createBusy}
                onClick={() => void onCreate()}
              >
                {ui.templatesCreateSubmit}
              </button>
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2"
                onClick={() => setCreateOpen(false)}
              >
                {ui.templatesCreateCancel}
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {detail && detailConfig ? (
        <Card title={ui.templatesDetailTitle} className="mt-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              {detail.is_builtin ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text">{detail.name}</span>
                    <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-xs text-accent-mid">
                      {ui.templatesEditorReadOnlyTag}
                    </span>
                  </div>
                  {detail.description ? (
                    <div className="text-il-meta text-text-3">{detail.description}</div>
                  ) : null}
                </>
              ) : (
                <>
                  <label className="block max-w-md">
                    <span className="mb-1 block text-il-meta text-text-2">{ui.templatesNameLabel}</span>
                    <input
                      className="box-border w-full rounded border border-border px-2 py-1.5 text-sm"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </label>
                  <label className="block max-w-md">
                    <span className="mb-1 block text-il-meta text-text-2">{ui.templatesDescLabel}</span>
                    <input
                      className="box-border w-full rounded border border-border px-2 py-1.5 text-sm"
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                    />
                  </label>
                </>
              )}
              <div className="text-il-meta text-text-3">
                {ui.templatesFieldCountHint
                  .replace('{defaultCount}', String(Object.keys(detail.default_fields).length))
                  .replace('{sheetCount}', String(Object.keys(detail.sheets ?? {}).length))}
                {(detail.sample_excel_count ?? detail.samples?.length ?? 0) > 0
                  ? ` · ${ui.templatesSampleCountHint.replace(
                      '{count}',
                      String(detail.sample_excel_count ?? detail.samples?.length ?? 0),
                    )}`
                  : ''}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-[7px] border border-border bg-white px-3 py-1 text-il-btn text-text-2"
              onClick={() => setDetail(null)}
            >
              {ui.templatesCloseBtn}
            </button>
          </div>

          {!detail.is_builtin ? (
            <div className="mb-4 rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
              <div className="text-[12px] font-medium text-text-2">{ui.templatesSamplesTitle}</div>
              {(detail.samples?.length ?? 0) > 0 ? (
                <ul className="mt-2 space-y-1.5 text-il-meta text-text-2">
                  {detail.samples!.map((s) => {
                    const busyKey = `${detail.template_id}:${s.filename}`
                    return (
                      <li key={s.filename} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-text">{s.filename}</span>
                        <span className="text-text-3">{formatSampleSize(s.size_bytes)}</span>
                        <button
                          type="button"
                          className="text-il-btn text-accent hover:underline disabled:opacity-50"
                          disabled={actionBusy === busyKey}
                          onClick={() => void onDownloadSample(detail.template_id, s.filename)}
                        >
                          {ui.templatesSampleDownloadBtn}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-1.5 text-il-meta text-text-3">{ui.templatesSamplesEmpty}</p>
              )}
            </div>
          ) : null}

          <FieldMappingEditor
            mode="template"
            readOnly={detail.is_builtin}
            initialConfig={cloneMapping(detailConfig)}
            resetKey={editorResetKey}
            saveMeta={{ name: editName, description: editDesc }}
            onSave={onSaveTemplate}
            onSaveAsCopy={detail.is_builtin ? () => void onDuplicate(detail) : undefined}
            onRefresh={refreshDetail}
          />
        </Card>
      ) : null}
    </div>
  )
}
