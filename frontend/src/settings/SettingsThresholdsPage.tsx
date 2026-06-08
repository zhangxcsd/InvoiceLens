import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchSettingsThresholds,
  postSettingsThresholds,
  postDemoSeedAnalysisData,
  type SettingsThresholdItem,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

function formatValue(item: SettingsThresholdItem, v: number): string {
  if (item.type === 'float' && item.max === 1) {
    return `${(v * 100).toFixed(0)}%`
  }
  if (item.type === 'float') {
    return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  }
  return String(v)
}

export function SettingsThresholdsPage() {
  const ui = t.settingsThresholdsUi
  const [items, setItems] = useState<SettingsThresholdItem[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [hint, setHint] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchSettingsThresholds(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      const list = res.items ?? []
      setItems(list)
      setHint(res.hint ?? null)
      const d: Record<string, string> = {}
      for (const it of list) {
        d[it.key] = String(it.effective_value ?? it.default ?? '')
      }
      setDraft(d)
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const dirty = useMemo(() => {
    return items.some((it) => {
      const cur = draft[it.key]
      if (cur == null || cur === '') return false
      const num = Number(cur)
      if (!Number.isFinite(num)) return true
      return num !== Number(it.effective_value)
    })
  }, [items, draft])

  const onSave = async () => {
    setSaving(true)
    setMsg(null)
    setErr(null)
    try {
      const payload: Record<string, number> = {}
      for (const it of items) {
        const raw = draft[it.key]
        if (raw == null || raw.trim() === '') continue
        const num = Number(raw)
        if (!Number.isFinite(num)) {
          setErr(`${it.label}：请输入有效数字`)
          return
        }
        payload[it.key] = num
      }
      const res = await postSettingsThresholds({ items: payload })
      if (!res.ok) {
        setErr(res.error?.message ?? res.errors?.join('；') ?? ui.saveFailed)
        return
      }
      setMsg(ui.saveSuccess)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const onReset = async (key: string) => {
    setSaving(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await postSettingsThresholds({ reset_keys: [key] })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.saveFailed)
        return
      }
      setMsg(ui.resetSuccess)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const onSeedDemo = async () => {
    setSeeding(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await postDemoSeedAnalysisData()
      if (!res.ok) {
        setErr(res.error?.message ?? res.warning ?? ui.seedFailed)
        return
      }
      const v = res.verification ?? {}
      setMsg(
        ui.seedSuccess
          .replace('{year}', String(res.stat_year ?? ''))
          .replace('{pool}', String(v.analysis_subject_options ?? '0'))
          .replace('{trade}', String(v.dws_trade_sum ?? '0')),
      )
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {err ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded-md border border-success/30 bg-success/5 px-4 py-2 text-sm text-success">{msg}</div>
      ) : null}

      <Card title={ui.demoSeedTitle} className="p-4">
        <p className="mb-3 text-sm text-text-2">{ui.demoSeedDesc}</p>
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={seeding}
          onClick={() => void onSeedDemo()}
        >
          {seeding ? ui.seedBusy : ui.seedBtn}
        </button>
      </Card>

      <Card title={ui.configTitle} className="p-4">
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : (
          <>
            {hint ? <p className="mb-4 text-sm text-text-2">{hint}</p> : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-text-2">
                    <th className="py-2 pr-4 font-medium">{ui.colLabel}</th>
                    <th className="py-2 pr-4 font-medium">{ui.colValue}</th>
                    <th className="py-2 pr-4 font-medium">{ui.colDefault}</th>
                    <th className="py-2 font-medium">{ui.colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.key} className="border-b border-border/60 align-top">
                      <td className="py-3 pr-4">
                        <div className="font-medium text-text-1">{it.label}</div>
                        <div className="mt-1 text-xs text-text-2">{it.description}</div>
                        {it.is_overridden ? (
                          <span className="mt-1 inline-block rounded bg-warn/10 px-1.5 py-0.5 text-xs text-warn">
                            {ui.overriddenBadge}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4">
                        <input
                          type="number"
                          className="w-32 rounded border border-border px-2 py-1"
                          min={it.min}
                          max={it.max}
                          step={it.type === 'int' ? 1 : 0.01}
                          value={draft[it.key] ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [it.key]: e.target.value }))}
                        />
                        <div className="mt-1 text-xs text-text-3">
                          {ui.rangeHint.replace('{min}', String(it.min)).replace('{max}', String(it.max))}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-text-2">
                        {formatValue(it, Number(it.default))}
                      </td>
                      <td className="py-3">
                        {it.is_overridden ? (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline"
                            disabled={saving}
                            onClick={() => void onReset(it.key)}
                          >
                            {ui.resetBtn}
                          </button>
                        ) : (
                          <span className="text-xs text-text-3">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
                disabled={saving || !dirty}
                onClick={() => void onSave()}
              >
                {saving ? ui.saveBusy : ui.saveBtn}
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
