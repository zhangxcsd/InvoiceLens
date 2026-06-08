import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchAuditRulesConfig, postAuditRun, saveAuditRulesConfig } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

export function FlagsRulesPage() {
  const ui = t.auditRulesUi
  const [yamlText, setYamlText] = useState('')
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rescanBusy, setRescanBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))

  const loadRules = useCallback(async () => {
    setLoading(true)
    setFeedback(null)
    try {
      const r = await fetchAuditRulesConfig()
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.loadFailed })
        return
      }
      setYamlText(r.yamlText ?? '')
      setSource(r.source ?? '')
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const onSave = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const r = await saveAuditRulesConfig(yamlText)
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.saveFailed })
        return
      }
      if (r.source) setSource(r.source)
      setFeedback({ kind: 'ok', text: r.message || ui.saveDone })
    } finally {
      setSaving(false)
    }
  }

  const onSaveAndRescan = async () => {
    setRescanBusy(true)
    setFeedback(null)
    try {
      const s = await saveAuditRulesConfig(yamlText)
      if (!s.ok) {
        setFeedback({ kind: 'err', text: s.error?.message || ui.saveFailed })
        return
      }
      const r = await postAuditRun({ statYear })
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.rescanFailed })
        return
      }
      setFeedback({
        kind: 'ok',
        text: ui.rescanDone.replace('{count}', String(r.total_flag_count ?? 0)),
      })
    } finally {
      setRescanBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />

      <Card title={ui.configCardTitle}>
        <div className="mb-2 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-il-meta text-text-2">
            <span>{ui.rescanYearLabel}</span>
            <input
              className="h-9 w-[120px] rounded-sm border border-border-light bg-white px-2 text-il-body text-text"
              value={statYear}
              onChange={(e) => setStatYear(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="h-9 rounded-sm border border-border bg-white px-3 text-il-meta font-semibold text-text hover:border-accent"
            onClick={() => void loadRules()}
            disabled={loading || saving || rescanBusy}
          >
            {ui.loadBtn}
          </button>
          <button
            type="button"
            className="h-9 rounded-sm bg-accent px-3 text-il-meta font-semibold text-white disabled:opacity-50"
            onClick={() => void onSave()}
            disabled={loading || saving || rescanBusy}
          >
            {saving ? ui.saving : ui.saveBtn}
          </button>
          <button
            type="button"
            className="h-9 rounded-sm border border-accent bg-white px-3 text-il-meta font-semibold text-accent disabled:opacity-50"
            onClick={() => void onSaveAndRescan()}
            disabled={loading || saving || rescanBusy}
          >
            {rescanBusy ? ui.rescanBusy : ui.saveRescanBtn}
          </button>
          {source ? (
            <span className="text-il-meta text-text-3">
              {ui.sourcePrefix}
              <span className="font-mono">{source}</span>
            </span>
          ) : null}
        </div>
        <textarea
          className="min-h-[480px] w-full rounded-sm border border-border-light bg-white p-3 font-mono text-[12px] leading-relaxed text-text outline-none focus:border-accent"
          value={yamlText}
          onChange={(e) => setYamlText(e.target.value)}
          spellCheck={false}
        />
        {feedback ? (
          <div
            className={[
              'mt-2 rounded-sm border px-2.5 py-2 text-il-meta',
              feedback.kind === 'ok' ? 'border-[#cdeed8] bg-[#f1fbf5] text-[#1d7a43]' : 'border-[#ffd7d7] bg-[#fff4f4] text-danger',
            ].join(' ')}
          >
            {feedback.text}
          </div>
        ) : null}
      </Card>

      <Card title={ui.helpTitle}>
        <ul className="list-inside list-disc space-y-1 text-il-meta text-text-2">
          {ui.helpBullets.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
