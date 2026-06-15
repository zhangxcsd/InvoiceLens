import { useCallback, useEffect, useState } from 'react'
import { zhCN as t } from '../copy/zh-CN'
import { fetchFieldMapping, saveFieldMapping, type FieldMappingConfig as ApiFieldMappingConfig } from '../config/localApi'
import { FieldMappingEditor } from './FieldMappingEditor'
import { cloneMapping, fromFallback } from './fieldMappingEditorModel'

function initialConfigSnapshot(): ApiFieldMappingConfig {
  return cloneMapping(fromFallback())
}

export function FieldMappingConfigPrototype(props: { onNavUpload: () => void }) {
  const [config, setConfig] = useState<ApiFieldMappingConfig>(() => initialConfigSnapshot())
  const [resetKey, setResetKey] = useState('0')
  const [sourceLabel, setSourceLabel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'idle' | 'load'>('idle')

  const bootstrap = useCallback(async () => {
    setBusy('load')
    setLoadError(null)
    const data = await fetchFieldMapping()
    setBusy('idle')
    if (data) {
      const { source, ...rest } = data
      const next = cloneMapping(rest)
      setConfig(next)
      setSourceLabel(source ?? '')
      setResetKey((k) => String(Number(k) + 1))
    } else {
      setLoadError(t.fieldMappingUi.loadFromApiFailed)
      setSourceLabel('builtin')
    }
  }, [])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const handleRefresh = useCallback(async () => {
    setBusy('load')
    setLoadError(null)
    const data = await fetchFieldMapping()
    setBusy('idle')
    if (data) {
      const { source, ...rest } = data
      const next = cloneMapping(rest)
      setConfig(next)
      setSourceLabel(source ?? '')
      setResetKey((k) => String(Number(k) + 1))
      return next
    }
    setLoadError(t.fieldMappingUi.refreshFailed)
    return null
  }, [])

  const handleSave = useCallback(async (merged: ApiFieldMappingConfig) => {
    const r = await saveFieldMapping(merged)
    if (r.ok) {
      if (r.source) setSourceLabel(r.source)
      return {
        ok: true,
        hint: r.saved_to
          ? t.fieldMappingUi.saveSuccessWithPath.replace('{path}', r.saved_to)
          : t.fieldMappingUi.saveSuccess,
      }
    }
    return { ok: false, error: r.error ?? t.fieldMappingUi.saveFailed }
  }, [])

  const sourceBadge = loadError ? t.fieldMappingUi.sourceOffline : t.fieldMappingUi.sourceLive

  return (
    <div className="flex min-h-0 flex-col p-[22px]">
      <div className="mb-5 shrink-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-il-page-title font-semibold text-text">{t.fieldMappingUi.configPageTitle}</span>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon text-accent-mid">
            {sourceBadge}
          </span>
          {sourceLabel ? (
            <span className="text-il-meta text-text-3">
              {t.fieldMappingUi.sourceLabelPrefix}
              {sourceLabel}
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-il-page-desc leading-relaxed text-text-2">
          {t.fieldMappingUi.configPageBody}
        </p>
        {loadError ? (
          <div className="mt-2 space-y-1.5 text-il-meta">
            <p className="text-danger">{loadError}</p>
            <p className="max-w-3xl leading-relaxed text-text-3">{t.fieldMappingUi.apiUnavailableHint}</p>
          </div>
        ) : null}
      </div>

      <div className="mb-4 shrink-0 rounded-[10px] border border-[#c8dff7] bg-[#f7fbff] px-4 py-3 text-il-meta leading-relaxed text-text-2">
        <p>{t.fieldMappingUi.configYamlHint}</p>
        <p className="mt-2 text-text-3">{t.fieldMappingUi.configOdsDwdHint}</p>
        <p className="mt-2 text-text-3">{t.fieldMappingUi.toolsBatchHint}</p>
      </div>

      <FieldMappingEditor
        mode="active"
        initialConfig={config}
        resetKey={resetKey}
        loadError={loadError}
        onRefresh={handleRefresh}
        onSave={handleSave}
        onNavUpload={props.onNavUpload}
      />
      {busy === 'load' ? (
        <span className="sr-only">{t.fieldMappingUi.busyLoading}</span>
      ) : null}
    </div>
  )
}
