import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchReportTemplates,
  postReportTemplateDelete,
  postReportTemplateSave,
  type ReportChapter,
  type ReportTemplate,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

type EditorState = {
  template_id: string
  name: string
  title_template: string
  description: string
  chapters: Record<string, boolean>
  is_builtin: boolean
}

const EMPTY_EDITOR: EditorState = {
  template_id: '',
  name: '',
  title_template: '{year}年度发票数据审计分析报告',
  description: '',
  chapters: {},
  is_builtin: false,
}

export function ReportTemplatesPage() {
  const ui = t.reportTemplatesUi
  const [templates, setTemplates] = useState<ReportTemplate[]>([])
  const [chapterDefs, setChapterDefs] = useState<ReportChapter[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchReportTemplates(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      setTemplates(res.templates ?? [])
      setChapterDefs(res.chapter_defs ?? [])
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const openCreate = () => {
    const chapters: Record<string, boolean> = {}
    for (const c of chapterDefs) chapters[c.id] = c.default !== false
    setEditor({ ...EMPTY_EDITOR, chapters })
    setMsg(null)
  }

  const openEdit = (tpl: ReportTemplate) => {
    setEditor({
      template_id: tpl.template_id,
      name: tpl.name,
      title_template: tpl.title_template,
      description: tpl.description ?? '',
      chapters: { ...tpl.chapters },
      is_builtin: tpl.is_builtin,
    })
    setMsg(null)
  }

  const onSave = async () => {
    if (!editor) return
    if (!editor.name.trim()) {
      setMsg(ui.nameRequired)
      return
    }
    setSaveBusy(true)
    setMsg(null)
    try {
      const res = await postReportTemplateSave({
        template_id: editor.template_id || undefined,
        name: editor.name.trim(),
        title_template: editor.title_template.trim(),
        description: editor.description.trim(),
        chapters: editor.chapters,
      })
      if (!res.ok) {
        setMsg(res.error?.message ?? ui.saveFailed)
        return
      }
      setMsg(res.created ? ui.createSuccess : ui.saveSuccess)
      setEditor(null)
      await load()
    } finally {
      setSaveBusy(false)
    }
  }

  const onDelete = async (tpl: ReportTemplate) => {
    if (tpl.is_builtin) return
    if (!window.confirm(ui.deleteConfirm.replace('{name}', tpl.name))) return
    const res = await postReportTemplateDelete(tpl.template_id)
    if (!res.ok) {
      setMsg(res.error?.message ?? ui.deleteFailed)
      return
    }
    setMsg(ui.deleteSuccess)
    if (editor?.template_id === tpl.template_id) setEditor(null)
    await load()
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {err ? <p className="text-sm text-danger">{err}</p> : null}
      {msg ? <p className="text-sm text-text-2">{msg}</p> : null}

      <Card title={ui.listTitle}>
        <div className="mb-3">
          <button
            type="button"
            className="rounded bg-primary px-4 py-1.5 text-sm text-white"
            onClick={openCreate}
          >
            {ui.createBtn}
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-3 font-medium">{ui.colName}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colTitle}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colChapters}</th>
                  <th className="py-2 pr-3 font-medium">{ui.colType}</th>
                  <th className="py-2 font-medium">{ui.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl) => {
                  const enabledIds = Object.entries(tpl.chapters)
                    .filter(([, v]) => v)
                    .map(([k]) => k)
                  const enabledLabels = enabledIds
                    .map((id) => chapterDefs.find((c) => c.id === id)?.label ?? id)
                    .join('、')
                  return (
                    <tr key={tpl.template_id} className="border-b border-border/60">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{tpl.name}</div>
                        {tpl.description ? (
                          <div className="text-xs text-text-3">{tpl.description}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-text-2">{tpl.title_template}</td>
                      <td className="py-2 pr-3">
                        <div className="tabular-nums">{enabledIds.length}</div>
                        <div className="mt-0.5 max-w-[280px] text-xs leading-snug text-text-3" title={enabledLabels}>
                          {enabledLabels || '—'}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        {tpl.is_builtin ? (
                          <span className="rounded bg-surface-2 px-2 py-0.5 text-xs">{ui.builtinTag}</span>
                        ) : (
                          <span className="text-text-3">{ui.customTag}</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="text-sm text-primary"
                            onClick={() => openEdit(tpl)}
                          >
                            {tpl.is_builtin ? ui.viewBtn : ui.editBtn}
                          </button>
                          {!tpl.is_builtin ? (
                            <button
                              type="button"
                              className="text-sm text-danger"
                              onClick={() => void onDelete(tpl)}
                            >
                              {ui.deleteBtn}
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

      {editor ? (
        <Card title={editor.template_id ? ui.editTitle : ui.createTitle}>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-2">{ui.fieldName}</span>
              <input
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-60"
                value={editor.name}
                disabled={editor.is_builtin}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-2">{ui.fieldTitle}</span>
              <input
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-60"
                value={editor.title_template}
                disabled={editor.is_builtin}
                onChange={(e) => setEditor({ ...editor, title_template: e.target.value })}
              />
              <span className="text-xs text-text-3">{ui.titleHint}</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-2">{ui.fieldDesc}</span>
              <textarea
                className="min-h-[4rem] rounded border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-60"
                value={editor.description}
                disabled={editor.is_builtin}
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
            </label>
            <div>
              <p className="mb-2 text-sm text-text-2">{ui.chaptersTitle}</p>
              <div className="flex flex-col gap-2">
                {chapterDefs.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editor.chapters[c.id] !== false}
                      disabled={editor.is_builtin}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          chapters: { ...editor.chapters, [c.id]: e.target.checked },
                        })
                      }
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              {!editor.is_builtin ? (
                <button
                  type="button"
                  className="rounded bg-primary px-4 py-1.5 text-sm text-white disabled:opacity-50"
                  disabled={saveBusy}
                  onClick={() => void onSave()}
                >
                  {saveBusy ? ui.saveBusy : ui.saveBtn}
                </button>
              ) : null}
              <button
                type="button"
                className="rounded border border-border px-4 py-1.5 text-sm"
                onClick={() => setEditor(null)}
              >
                {ui.cancelBtn}
              </button>
            </div>
            {editor.is_builtin ? (
              <p className="text-xs text-text-3">{ui.builtinReadonlyHint}</p>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  )
}
