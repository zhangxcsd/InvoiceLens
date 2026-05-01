import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { fetchDimTaxCodeRiskRules, postDimTaxCodeReapplyRiskRules, saveDimTaxCodeRiskRules } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

export function TaxCodeRiskDefinePage() {
  const ui = t.taxCodeRiskDefineUi
  const [yamlText, setYamlText] = useState('')
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reapplyBusy, setReapplyBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)

  const loadRules = useCallback(async () => {
    setLoading(true)
    setFeedback(null)
    try {
      const r = await fetchDimTaxCodeRiskRules()
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.loadFailed })
        return
      }
      setYamlText(r.yamlText)
      setSource(r.source || '')
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const onSave = useCallback(async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const r = await saveDimTaxCodeRiskRules(yamlText)
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.saveFailed })
        return
      }
      if (r.source) setSource(r.source)
      setFeedback({ kind: 'ok', text: r.message || ui.saveDone })
    } finally {
      setSaving(false)
    }
  }, [ui.saveDone, ui.saveFailed, yamlText])

  const onSaveAndReapply = useCallback(async () => {
    setReapplyBusy(true)
    setFeedback(null)
    try {
      const s = await saveDimTaxCodeRiskRules(yamlText)
      if (!s.ok) {
        setFeedback({ kind: 'err', text: s.error?.message || ui.saveFailed })
        return
      }
      if (s.source) setSource(s.source)
      const r = await postDimTaxCodeReapplyRiskRules()
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.reapplyFailed })
        return
      }
      setFeedback({ kind: 'ok', text: r.message || ui.reapplyDone })
    } finally {
      setReapplyBusy(false)
    }
  }, [ui.reapplyDone, ui.reapplyFailed, ui.saveFailed, yamlText])

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
        <p className="mt-2 max-w-[980px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
      </div>

      <Card title={ui.configCardTitle}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-sm border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-text hover:border-accent hover:text-accent"
            onClick={() => void loadRules()}
            disabled={loading || saving || reapplyBusy}
          >
            {ui.loadBtn}
          </button>
          <button
            type="button"
            className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void onSave()}
            disabled={loading || saving || reapplyBusy}
          >
            {saving ? ui.saving : ui.saveBtn}
          </button>
          {source ? (
            <span className="text-[11px] text-text-3">
              {ui.sourcePathPrefix}
              <span className="font-mono">{source}</span>
            </span>
          ) : null}
        </div>
        <textarea
          className="min-h-[420px] w-full rounded-sm border border-border bg-white p-3 font-mono text-[12px] leading-relaxed text-text outline-none focus:border-accent"
          value={yamlText}
          onChange={(e) => setYamlText(e.target.value)}
          spellCheck={false}
        />
        {feedback ? (
          <div
            className={[
              'mt-2 rounded-sm border px-2.5 py-2 text-[12px]',
              feedback.kind === 'ok'
                ? 'border-[#cdeed8] bg-[#f1fbf5] text-[#1d7a43]'
                : feedback.kind === 'err'
                  ? 'border-[#ffd7d7] bg-[#fff4f4] text-danger'
                  : 'border-border-light bg-[#f7f9fc] text-text-2',
            ].join(' ')}
          >
            {feedback.text}
          </div>
        ) : null}
      </Card>

      <Card title={ui.reapplyTitle}>
        <p className="mb-2 text-il-meta text-text-3">{ui.reapplyHint}</p>
        <button
          type="button"
          className="rounded-sm border border-accent bg-white px-3 py-1.5 text-[12px] font-semibold text-accent hover:bg-[#f0f7ff] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void onSaveAndReapply()}
          disabled={loading || saving || reapplyBusy}
        >
          {reapplyBusy ? ui.reapplyBusy : ui.reapplyBtn}
        </button>
      </Card>

      <Card title={ui.helpTitle}>
        <ul className="list-inside list-disc space-y-1 text-il-page-desc text-text-2">
          {ui.helpBullets.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
