import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { LicenseGateBanner } from '../components/LicenseGateBanner'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchSettingsInstance,
  postSettingsInstance,
  type InstanceConfig,
  type InstanceSystemInfo,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { useRbac } from '../users/rbacContext'
import { useLicense } from './useLicense'

type Props = {
  onNav?: (key: NavKey) => void
}

const EMPTY_CONFIG: InstanceConfig = {
  display_name: '',
  instance_id: '',
  default_stat_year: null,
  scope_root_id: '',
  notes: '',
}

export function SettingsInstancePage({ onNav }: Props) {
  const ui = t.settingsInstanceUi
  const licUi = t.settingsLicenseUi
  const rbac = useRbac()
  const license = useLicense()
  const [config, setConfig] = useState<InstanceConfig>(EMPTY_CONFIG)
  const [draft, setDraft] = useState<InstanceConfig>(EMPTY_CONFIG)
  const [system, setSystem] = useState<InstanceSystemInfo>({})
  const [hint, setHint] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchSettingsInstance(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      const cfg = res.config ?? EMPTY_CONFIG
      setConfig(cfg)
      setDraft(cfg)
      setSystem(res.system ?? {})
      setHint(res.hint ?? null)
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
    return (
      draft.display_name !== config.display_name ||
      draft.instance_id !== config.instance_id ||
      draft.default_stat_year !== config.default_stat_year ||
      draft.scope_root_id !== config.scope_root_id ||
      draft.notes !== config.notes
    )
  }, [config, draft])

  const onSave = async () => {
    setSaving(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await postSettingsInstance({
        config: {
          display_name: draft.display_name.trim(),
          instance_id: draft.instance_id.trim(),
          default_stat_year: draft.default_stat_year,
          scope_root_id: draft.scope_root_id.trim(),
          notes: draft.notes.trim(),
        },
      })
      if (!res.ok) {
        setErr(res.error?.message ?? res.errors?.join('；') ?? ui.saveFailed)
        return
      }
      const cfg = res.config ?? draft
      setConfig(cfg)
      setDraft(cfg)
      setMsg(ui.saveSuccess)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col p-[22px]">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} note={ui.pageNote} />

      {err ? <p className="mt-3 text-il-meta text-danger">{err}</p> : null}
      {msg ? <p className="mt-3 text-il-meta text-text-2">{msg}</p> : null}
      {hint ? <p className="mt-2 text-il-meta text-text-3">{hint}</p> : null}
      <LicenseGateBanner hint={license.trialHint} className="mt-3" />

      <Card title={ui.licenseSummaryTitle} className="mt-4 max-w-3xl">
        {license.loading ? (
          <p className="text-il-meta text-text-3">{ui.loading}</p>
        ) : (
          <dl className="grid gap-2 text-il-meta sm:grid-cols-[140px_1fr]">
            <dt className="text-text-3">{licUi.colTier}</dt>
            <dd className="text-text-2">{license.license?.tier ?? '—'}</dd>
            <dt className="text-text-3">{licUi.colExport}</dt>
            <dd className="text-text-2">{license.exportAllowed ? licUi.yes : licUi.no}</dd>
            <dt className="text-text-3">{licUi.colMaxEntities}</dt>
            <dd className="text-text-2">
              {license.maxEntities != null && license.maxEntities >= 0
                ? license.maxEntities
                : ui.unlimitedLabel}
            </dd>
            <dt className="text-text-3">{licUi.colCrossGroup}</dt>
            <dd className="text-text-2">{license.crossGroupAllowed ? licUi.yes : licUi.no}</dd>
          </dl>
        )}
        {!license.exportAllowed && license.trialHint ? (
          <p className="mt-3 text-il-meta text-warn">{license.trialHint}</p>
        ) : null}
      </Card>

      <Card title={ui.relatedTitle} className="mt-4 max-w-3xl">
        <p className="mb-4 text-il-meta leading-relaxed text-text-2">{ui.relatedDesc}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-[7px] border border-accent bg-white px-3 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff]"
            onClick={() => onNav?.('settings_thresholds')}
          >
            {ui.linkThresholds}
          </button>
          <button
            type="button"
            className="rounded-[7px] border border-accent bg-white px-3 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff]"
            onClick={() => onNav?.('settings_license')}
          >
            {ui.linkLicense}
          </button>
        </div>
      </Card>

      <Card title={ui.formTitle} className="mt-4 max-w-3xl">
        {loading ? (
          <p className="text-il-meta text-text-3">{ui.loading}</p>
        ) : (
          <div className="flex max-w-xl flex-col gap-4">
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.labelDisplayName}</span>
              <input
                className="rounded border border-border px-2 py-1.5 text-sm"
                value={draft.display_name}
                onChange={(e) => setDraft((d) => ({ ...d, display_name: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.labelInstanceId}</span>
              <input
                className="rounded border border-border px-2 py-1.5 text-sm"
                value={draft.instance_id}
                onChange={(e) => setDraft((d) => ({ ...d, instance_id: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.labelDefaultStatYear}</span>
              <input
                className="rounded border border-border px-2 py-1.5 text-sm"
                type="number"
                placeholder={ui.statYearPlaceholder}
                value={draft.default_stat_year ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim()
                  setDraft((d) => ({
                    ...d,
                    default_stat_year: raw === '' ? null : Number(raw),
                  }))
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.labelScopeRootId}</span>
              <input
                className="rounded border border-border px-2 py-1.5 text-sm"
                value={draft.scope_root_id}
                onChange={(e) => setDraft((d) => ({ ...d, scope_root_id: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-il-meta">
              <span className="text-text-2">{ui.labelNotes}</span>
              <textarea
                className="min-h-[72px] rounded border border-border px-2 py-1.5 text-sm"
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              />
            </label>
            <div>
              {!rbac.canWrite ? (
                <p className="mb-2 text-il-meta text-text-3">{rbac.writeDisabledHint}</p>
              ) : null}
              <button
                type="button"
                className="rounded-[7px] border border-accent bg-accent px-4 py-1.5 text-il-btn font-medium text-white disabled:opacity-50"
                disabled={!dirty || saving || !rbac.canWrite}
                onClick={() => void onSave()}
              >
                {saving ? ui.saving : ui.saveBtn}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card title={ui.scopeTitle} className="mt-4 max-w-3xl">
        <p className="mb-4 text-il-meta leading-relaxed text-text-2">{ui.scopeDesc}</p>
        <dl className="grid gap-2 text-il-meta sm:grid-cols-[140px_1fr]">
          <dt className="text-text-3">{ui.sysAppVersion}</dt>
          <dd className="break-all text-text-2">
            {system.app_version ?? import.meta.env.VITE_APP_VERSION ?? '—'}
          </dd>
          <dt className="text-text-3">{ui.sysBuildTime}</dt>
          <dd className="break-all text-text-2">{system.build_time ?? '—'}</dd>
          <dt className="text-text-3">{ui.sysProjectRoot}</dt>
          <dd className="break-all text-text-2">{system.project_root ?? '—'}</dd>
          <dt className="text-text-3">{ui.sysDbPath}</dt>
          <dd className="break-all text-text-2">{system.db_path ?? '—'}</dd>
          <dt className="text-text-3">{ui.sysConfigDir}</dt>
          <dd className="break-all text-text-2">{system.config_dir ?? '—'}</dd>
          <dt className="text-text-3">{ui.sysFieldMapping}</dt>
          <dd className="break-all text-text-2">{system.field_mapping_path ?? '—'}</dd>
        </dl>
      </Card>
    </div>
  )
}
