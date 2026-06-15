import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchLicenseInfo,
  postLicenseImport,
  postLicenseReset,
  type LicenseInfo,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

function tierLabel(tier?: string) {
  if (tier === 'pro' || tier === 'professional') return '专业版'
  if (tier === 'enterprise') return '企业版'
  if (tier === 'trial') return '试用版'
  return tier || '—'
}

export function SettingsLicensePage() {
  const ui = t.settingsLicenseUi
  const [info, setInfo] = useState<LicenseInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [jsonDraft, setJsonDraft] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchLicenseInfo(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok || !res.license) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      setInfo(res.license)
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const licenseTag = useMemo(() => {
    if (!info) return '—'
    const exp = info.expiresAt ? ` · 有效期 ${info.expiresAt}` : ''
    return `${tierLabel(info.tier)}${exp}`
  }, [info])

  const onImportJson = async () => {
    setSaving(true)
    setMsg(null)
    setErr(null)
    try {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(jsonDraft) as Record<string, unknown>
      } catch {
        setErr(ui.invalidJson)
        return
      }
      const res = await postLicenseImport(parsed)
      if (!res.ok) {
        setErr(res.error?.message ?? res.errors?.join('；') ?? ui.saveFailed)
        return
      }
      setMsg(ui.importSuccess)
      setJsonDraft('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const onReset = async () => {
    if (!window.confirm(ui.resetConfirm)) return
    setSaving(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await postLicenseReset()
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

  return (
    <div className="flex flex-col gap-4 p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {err ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded-md border border-success/30 bg-success/5 px-4 py-2 text-sm text-success">{msg}</div>
      ) : null}

      <Card title={ui.currentTitle} className="p-4">
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : info ? (
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <span className="text-text-2">{ui.colTier}：</span>
              <span className="font-medium text-text-1">{licenseTag}</span>
            </div>
            <div>
              <span className="text-text-2">{ui.colCustomer}：</span>
              <span>{info.customer || '—'}</span>
            </div>
            <div>
              <span className="text-text-2">{ui.colExport}：</span>
              <span className={info.exportReport ? 'text-success' : 'text-warn'}>
                {info.exportReport ? ui.exportOn : ui.exportOff}
              </span>
            </div>
            <div>
              <span className="text-text-2">{ui.colCrossGroup}：</span>
              <span>{info.crossGroup ? ui.yes : ui.no}</span>
            </div>
            <div>
              <span className="text-text-2">{ui.colMaxEntities}：</span>
              <span>{info.maxEntities ?? '—'}</span>
            </div>
            <div>
              <span className="text-text-2">{ui.colSource}：</span>
              <span>
                {info.source === 'override'
                  ? '开发覆盖 (license_override.json)'
                  : info.source === 'lic'
                    ? `签名授权 (${info.licPath ?? 'license.lic'})`
                    : info.source === 'lic_invalid'
                      ? `授权无效：${info.licError ?? '验签失败'}`
                      : '默认配置 (config/settings.py)'}
              </span>
            </div>
            <div>
              <span className="text-text-2">{ui.colMaxInvoices}：</span>
              <span>{info.maxInvoices ?? '—'}</span>
            </div>
            <div>
              <span className="text-text-2">{ui.colExpired}：</span>
              <span className={info.isExpired ? 'text-danger' : 'text-text-1'}>
                {info.isExpired ? ui.yes : ui.no}
              </span>
            </div>
            {info.trialHint ? (
              <div className="md:col-span-2 rounded-sm border border-warn/40 bg-warn/5 px-3 py-2 text-text-2">
                {info.trialHint}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title={ui.importTitle} className="p-4">
        <p className="mb-3 text-sm text-text-2">{ui.importDesc}</p>
        <textarea
          className="mb-3 h-40 w-full rounded border border-border px-3 py-2 font-mono text-xs"
          placeholder={ui.importPlaceholder}
          value={jsonDraft}
          onChange={(e) => setJsonDraft(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={saving || !jsonDraft.trim()}
            onClick={() => void onImportJson()}
          >
            {saving ? ui.saveBusy : ui.importBtn}
          </button>
          {info?.isOverridden ? (
            <button
              type="button"
              className="rounded-md border border-border px-4 py-2 text-sm text-text-2 disabled:opacity-50"
              disabled={saving}
              onClick={() => void onReset()}
            >
              {ui.resetBtn}
            </button>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
