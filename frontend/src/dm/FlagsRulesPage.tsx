import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  fetchAuditRulesConfig,
  postAuditRun,
  saveAuditRulesConfig,
  validateAuditRulesConfig,
  type AuditRuleExecutionMode,
  type AuditRuleListItem,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { auditRiskLevelBadgeClass } from '../dim/dimDictHelpers'
import { useDimDictDomain } from '../dim/useDimDict'

function executionModeBadgeClass(mode: AuditRuleExecutionMode | undefined): string {
  switch (mode) {
    case 'sql_scan':
      return 'bg-[#e8f0fe] text-[#1a56db]'
    case 'post_scan':
      return 'bg-[#f0e8fe] text-[#6b21a8]'
    case 'sync':
      return 'bg-[#fef3c7] text-[#92400e]'
    default:
      return 'bg-[#f3f4f6] text-text-3'
  }
}

function executionModeLabel(mode: AuditRuleExecutionMode | undefined, ui: typeof t.auditRulesUi): string {
  switch (mode) {
    case 'sql_scan':
      return ui.executionModeSqlScan
    case 'post_scan':
      return ui.executionModePostScan
    case 'sync':
      return ui.executionModeSync
    default:
      return '—'
  }
}

function syncSourceHint(rule: AuditRuleListItem, ui: typeof t.auditRulesUi): string {
  const rid = rule.rule_id
  if (rid.startsWith('RULE-FIN-')) return ui.syncSourceFinance
  if (rid.startsWith('RULE-DQ-')) return ui.syncSourceQuality
  if (rid === 'RULE-TAX-DEV') return ui.syncSourceTaxDev
  if (rid.startsWith('RULE-TAX-')) return ui.syncSourceTaxCode
  return rule.trigger_hint ?? '—'
}

export function FlagsRulesPage() {
  const ui = t.auditRulesUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const [yamlText, setYamlText] = useState('')
  const [source, setSource] = useState('')
  const [rulesList, setRulesList] = useState<AuditRuleListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rescanBusy, setRescanBusy] = useState(false)
  const [validateBusy, setValidateBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))

  const syncRules = useMemo(
    () => rulesList.filter((r) => r.execution_mode === 'sync'),
    [rulesList],
  )

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
      setRulesList(r.rulesList ?? [])
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  const onValidate = async () => {
    setValidateBusy(true)
    setFeedback(null)
    try {
      const r = await validateAuditRulesConfig(yamlText)
      if (!r.ok) {
        setFeedback({
          kind: 'err',
          text: (r.errors ?? [r.error?.message]).filter(Boolean).join('；') || ui.validateFailed,
        })
        return
      }
      if (r.rulesList) setRulesList(r.rulesList)
      setFeedback({ kind: 'ok', text: r.message || ui.validateOk })
    } finally {
      setValidateBusy(false)
    }
  }

  const onSave = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const v = await validateAuditRulesConfig(yamlText)
      if (!v.ok) {
        setFeedback({
          kind: 'err',
          text: (v.errors ?? [v.error?.message]).filter(Boolean).join('；') || ui.validateFailed,
        })
        return
      }
      const r = await saveAuditRulesConfig(yamlText)
      if (!r.ok) {
        setFeedback({ kind: 'err', text: r.error?.message || ui.saveFailed })
        return
      }
      if (r.source) setSource(r.source)
      if (v.rulesList) setRulesList(v.rulesList)
      setFeedback({ kind: 'ok', text: r.message || ui.saveDone })
    } finally {
      setSaving(false)
    }
  }

  const onSaveAndRescan = async () => {
    setRescanBusy(true)
    setFeedback(null)
    try {
      const v = await validateAuditRulesConfig(yamlText)
      if (!v.ok) {
        setFeedback({
          kind: 'err',
          text: (v.errors ?? [v.error?.message]).filter(Boolean).join('；') || ui.validateFailed,
        })
        return
      }
      const s = await saveAuditRulesConfig(yamlText)
      if (!s.ok) {
        setFeedback({ kind: 'err', text: s.error?.message || ui.saveFailed })
        return
      }
      if (v.rulesList) setRulesList(v.rulesList)
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

      <Card title={ui.rulesTableTitle}>
        {rulesList.length === 0 ? (
          <p className="text-il-meta text-text-3">{ui.rulesTableEmpty}</p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border-light">
            <table className="w-full min-w-[960px] border-collapse text-il-page-desc">
              <thead>
                <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                  <th className="px-2 py-2 font-medium">{ui.colRuleId}</th>
                  <th className="px-2 py-2 font-medium">{ui.colRuleName}</th>
                  <th className="px-2 py-2 font-medium">{ui.colExecutionMode}</th>
                  <th className="px-2 py-2 font-medium">{ui.colTriggerHint}</th>
                  <th className="px-2 py-2 font-medium">{ui.colEnabled}</th>
                  <th className="px-2 py-2 font-medium">{ui.colModules}</th>
                  <th className="px-2 py-2 font-medium">{ui.colRisk}</th>
                </tr>
              </thead>
              <tbody className="text-text-2">
                {rulesList.map((r) => (
                  <tr key={r.rule_id} className="border-b border-border-light last:border-0">
                    <td className="px-2 py-2 font-mono text-il-meta">{r.rule_id}</td>
                    <td className="px-2 py-2">{r.name}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-il-meta ${executionModeBadgeClass(r.execution_mode)}`}
                      >
                        {executionModeLabel(r.execution_mode, ui)}
                      </span>
                    </td>
                    <td className="max-w-[280px] px-2 py-2 text-il-meta" title={r.trigger_hint}>
                      <span>{r.trigger_hint || '—'}</span>
                      {r.execution_mode === 'sync' && r.rescan_included === false ? (
                        <p className="mt-0.5 text-[11px] text-[#92400e]">{ui.syncRescanNote}</p>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{r.enabled ? ui.enabledYes : ui.enabledNo}</td>
                    <td className="px-2 py-2 text-il-meta">{r.modules.join('、')}</td>
                    <td className="px-2 py-2 text-il-meta">
                      {r.risk_level ? (
                        <span className={`rounded px-1.5 py-0.5 ${auditRiskLevelBadgeClass(r.risk_level)}`}>
                          {riskLevelDict.getLabel(r.risk_level)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={ui.syncCardTitle}>
        <p className="mb-3 text-il-meta text-text-2">{ui.syncCardDesc}</p>
        {syncRules.length === 0 ? (
          <p className="text-il-meta text-text-3">{ui.syncCardEmpty}</p>
        ) : (
          <ul className="space-y-2 text-il-meta text-text-2">
            {syncRules.map((r) => (
              <li
                key={r.rule_id}
                className="rounded-sm border border-border-light bg-[#fffbeb] px-3 py-2"
              >
                <div className="font-mono text-il-label text-text">{r.rule_id}</div>
                <div>{r.name}</div>
                <div className="mt-1 text-text-3">{syncSourceHint(r, ui)}</div>
                {r.trigger_hint ? (
                  <div className="mt-0.5 text-text-3">{r.trigger_hint}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

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
            disabled={loading || saving || rescanBusy || validateBusy}
          >
            {ui.loadBtn}
          </button>
          <button
            type="button"
            className="h-9 rounded-sm border border-border bg-white px-3 text-il-meta font-semibold text-text hover:border-accent disabled:opacity-50"
            onClick={() => void onValidate()}
            disabled={loading || saving || rescanBusy || validateBusy}
          >
            {validateBusy ? ui.validateBusy : ui.validateBtn}
          </button>
          <button
            type="button"
            className="h-9 rounded-sm bg-accent px-3 text-il-meta font-semibold text-white disabled:opacity-50"
            onClick={() => void onSave()}
            disabled={loading || saving || rescanBusy || validateBusy}
          >
            {saving ? ui.saving : ui.saveBtn}
          </button>
          <button
            type="button"
            className="h-9 rounded-sm border border-accent bg-white px-3 text-il-meta font-semibold text-accent disabled:opacity-50"
            onClick={() => void onSaveAndRescan()}
            disabled={loading || saving || rescanBusy || validateBusy}
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
