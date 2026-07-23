import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
import { type DimDictOption } from '../dim/dimDictHelpers'
import { AUDIT_RISK_COL_CLASS, AuditRiskLevelBadge } from './auditRiskBadge'
import { useDimDictDomain } from '../dim/useDimDict'
import {
  type CategoryTaxMapEntry,
  inferParamEditorKind,
  parseRuleParamsFromYaml,
  patchCategoryTaxMapInYaml,
  patchRuleEnabledInYaml,
  patchRuleScalarInYaml,
} from './auditRulesYaml'

type PageTab = 'list' | 'yaml'

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
  return ''
}

type RuleGroupKey = AuditRuleExecutionMode

const RULE_GROUPS: {
  key: RuleGroupKey
  titleKey: 'groupSqlScan' | 'groupPostScan' | 'groupSync'
  descKey: 'groupSqlScanDesc' | 'groupPostScanDesc' | 'groupSyncDesc'
}[] = [
  { key: 'sql_scan', titleKey: 'groupSqlScan', descKey: 'groupSqlScanDesc' },
  { key: 'post_scan', titleKey: 'groupPostScan', descKey: 'groupPostScanDesc' },
  { key: 'sync', titleKey: 'groupSync', descKey: 'groupSyncDesc' },
]

function paramLabel(key: string): string {
  return key.replace(/_/g, ' ')
}

function RuleParamsPanel({
  rule,
  params,
  riskOptions,
  ui,
  onScalarChange,
  onCategoryTaxMapChange,
}: {
  rule: AuditRuleListItem
  params: Record<string, unknown>
  riskOptions: DimDictOption[]
  ui: typeof t.auditRulesUi
  onScalarChange: (key: string, value: string | number | boolean) => void
  onCategoryTaxMapChange: (entries: CategoryTaxMapEntry[]) => void
}) {
  const keys = (rule.param_keys ?? []).filter((k) => k !== 'category_tax_map')
  const categoryMap = params.category_tax_map as CategoryTaxMapEntry[] | undefined

  if (keys.length === 0 && !categoryMap) return null

  return (
    <div className="mt-4 border-t border-border-light pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-text">{ui.ruleParamsLabel}</div>
        <span className="text-[11px] text-text-3">{ui.ruleParamsHint}</span>
      </div>
      {keys.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {keys.map((key) => {
            const raw = params[key]
            const kind = inferParamEditorKind(key, raw)
            const id = `${rule.rule_id}-${key}`

            if (kind === 'risk') {
              const value = String(raw ?? '')
              return (
                <label key={key} className="flex flex-col gap-1 text-il-meta">
                  <span className="text-text-2">{paramLabel(key)}</span>
                  <select
                    id={id}
                    className="h-9 rounded-sm border border-border-light bg-white px-2 text-il-body text-text"
                    value={value}
                    onChange={(e) => onScalarChange(key, e.target.value)}
                  >
                    <option value="">—</option>
                    {riskOptions.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )
            }

            if (kind === 'bool') {
              const checked = raw === true || raw === 'true'
              return (
                <label key={key} className="flex h-9 items-center gap-2 text-il-meta">
                  <input
                    id={id}
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={checked}
                    onChange={(e) => onScalarChange(key, e.target.checked)}
                  />
                  <span className="text-text-2">{paramLabel(key)}</span>
                </label>
              )
            }

            if (kind === 'number') {
              const num = typeof raw === 'number' ? raw : Number(raw ?? 0)
              return (
                <label key={key} className="flex flex-col gap-1 text-il-meta">
                  <span className="text-text-2">{paramLabel(key)}</span>
                  <input
                    id={id}
                    type="number"
                    step="any"
                    className="h-9 rounded-sm border border-border-light bg-white px-2 font-mono text-il-body text-text"
                    value={Number.isFinite(num) ? num : ''}
                    onChange={(e) => {
                      const v = e.target.value
                      onScalarChange(key, v === '' ? 0 : Number(v))
                    }}
                  />
                </label>
              )
            }

            return (
              <label key={key} className="flex flex-col gap-1 text-il-meta">
                <span className="text-text-2">{paramLabel(key)}</span>
                <input
                  id={id}
                  type="text"
                  className="h-9 rounded-sm border border-border-light bg-white px-2 text-il-body text-text"
                  value={String(raw ?? '')}
                  onChange={(e) => onScalarChange(key, e.target.value)}
                />
              </label>
            )
          })}
        </div>
      ) : null}

      {Array.isArray(categoryMap) ? (
        <div className="mt-4 space-y-2">
          <div className="text-il-meta font-medium text-text-2">category_tax_map</div>
          <div className="overflow-x-auto rounded-sm border border-border-light">
            <table className="w-full min-w-[520px] border-collapse text-il-meta">
              <thead>
                <tr className="border-b border-border-light bg-white text-left text-il-label text-text-3">
                  <th className="px-2 py-2 font-medium">{ui.paramKeywordsLabel}</th>
                  <th className="w-[140px] px-2 py-2 font-medium">{ui.paramExpectedRateLabel}</th>
                  <th className="w-[72px] px-2 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {categoryMap.map((row, idx) => (
                  <tr key={idx} className="border-b border-border-light last:border-0">
                    <td className="px-2 py-2">
                      <input
                        className="w-full rounded-sm border border-border-light bg-white px-2 py-1.5 text-il-body text-text"
                        value={row.keywords.join('，')}
                        onChange={(e) => {
                          const keywords = e.target.value
                            .split(/[,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                          const next = categoryMap.map((item, i) =>
                            i === idx ? { ...item, keywords } : item,
                          )
                          onCategoryTaxMapChange(next)
                        }}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number"
                        step="0.01"
                        className="w-full rounded-sm border border-border-light bg-white px-2 py-1.5 font-mono text-il-body text-text"
                        value={row.expected_rate}
                        onChange={(e) => {
                          const next = categoryMap.map((item, i) =>
                            i === idx ? { ...item, expected_rate: Number(e.target.value) } : item,
                          )
                          onCategoryTaxMapChange(next)
                        }}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        className="text-il-meta text-danger hover:underline"
                        onClick={() => onCategoryTaxMapChange(categoryMap.filter((_, i) => i !== idx))}
                      >
                        {ui.paramRemoveCategoryRow}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="rounded-sm border border-border-light px-2 py-1 text-il-meta text-text-2 hover:border-accent"
            onClick={() =>
              onCategoryTaxMapChange([...categoryMap, { keywords: [], expected_rate: 0.13 }])
            }
          >
            {ui.paramAddCategoryRow}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function FlagsRulesPage() {
  const ui = t.auditRulesUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const [pageTab, setPageTab] = useState<PageTab>('list')
  const [yamlText, setYamlText] = useState('')
  const [source, setSource] = useState('')
  const [rulesList, setRulesList] = useState<AuditRuleListItem[]>([])
  const [expandedRuleIds, setExpandedRuleIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rescanBusy, setRescanBusy] = useState(false)
  const [validateBusy, setValidateBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [statYear, setStatYear] = useState(() => String(new Date().getFullYear()))

  const groupedRules = useMemo(() => {
    const buckets: Record<RuleGroupKey, AuditRuleListItem[]> = {
      sql_scan: [],
      post_scan: [],
      sync: [],
    }
    for (const rule of rulesList) {
      const mode = rule.execution_mode ?? 'sql_scan'
      if (mode in buckets) buckets[mode].push(rule)
    }
    return buckets
  }, [rulesList])

  const ruleParamsById = useMemo(() => {
    const map: Record<string, Record<string, unknown>> = {}
    for (const rule of rulesList) {
      map[rule.rule_id] = parseRuleParamsFromYaml(yamlText, rule.rule_id)
    }
    return map
  }, [yamlText, rulesList])

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

  const toggleExpanded = (ruleId: string) => {
    setExpandedRuleIds((prev) => {
      const next = new Set(prev)
      if (next.has(ruleId)) next.delete(ruleId)
      else next.add(ruleId)
      return next
    })
  }

  const showParamFeedback = () => {
    setFeedback({ kind: 'ok', text: ui.ruleParamsHint })
  }

  const onToggleEnabled = (rule: AuditRuleListItem, nextEnabled: boolean) => {
    const nextYaml = patchRuleEnabledInYaml(yamlText, rule.rule_id, nextEnabled)
    setYamlText(nextYaml)
    setRulesList((prev) =>
      prev.map((r) => (r.rule_id === rule.rule_id ? { ...r, enabled: nextEnabled } : r)),
    )
    setFeedback({ kind: 'ok', text: ui.enabledToggleHint })
  }

  const onScalarParamChange = (rule: AuditRuleListItem, key: string, value: string | number | boolean) => {
    setYamlText(patchRuleScalarInYaml(yamlText, rule.rule_id, key, value))
    if (key === 'risk_level') {
      setRulesList((prev) =>
        prev.map((r) => (r.rule_id === rule.rule_id ? { ...r, risk_level: String(value) } : r)),
      )
    }
    showParamFeedback()
  }

  const onCategoryTaxMapChange = (ruleId: string, entries: CategoryTaxMapEntry[]) => {
    setYamlText(patchCategoryTaxMapInYaml(yamlText, ruleId, entries))
    showParamFeedback()
  }

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

  const renderToolbar = () => (
    <div className="mb-3 flex flex-wrap items-end gap-3">
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
  )

  const renderFeedback = () =>
    feedback ? (
      <div
        className={[
          'rounded-sm border px-2.5 py-2 text-il-meta',
          feedback.kind === 'ok'
            ? 'border-[#cdeed8] bg-[#f1fbf5] text-[#1d7a43]'
            : 'border-[#ffd7d7] bg-[#fff4f4] text-danger',
        ].join(' ')}
      >
        {feedback.text}
      </div>
    ) : null

  const renderRuleRow = (r: AuditRuleListItem) => {
    const expanded = expandedRuleIds.has(r.rule_id)
    const syncHint = r.execution_mode === 'sync' ? syncSourceHint(r, ui) : ''
    const hasDetail = Boolean(r.description?.trim() || r.logic?.trim())
    const hasParams = (r.param_keys?.length ?? 0) > 0
    const canExpand = hasDetail || hasParams
    const params = ruleParamsById[r.rule_id] ?? {}

    return (
      <Fragment key={r.rule_id}>
        <tr className="border-b border-border-light last:border-0">
          <td className="truncate px-1.5 py-1 font-mono text-[10px] leading-tight text-text-2">
            {r.rule_id}
          </td>
          <td className="truncate px-1.5 py-1 leading-tight">{r.name}</td>
          <td className="whitespace-nowrap px-1.5 py-1 text-center">
            <span
              className={`inline-block rounded px-1 py-px text-[10px] leading-tight ${executionModeBadgeClass(r.execution_mode)}`}
            >
              {executionModeLabel(r.execution_mode, ui)}
            </span>
          </td>
          <td
            className="px-1.5 py-1 text-[10px] leading-snug text-text-3"
            title={[r.trigger_hint, syncHint, r.execution_mode === 'sync' && r.rescan_included === false ? ui.syncRescanNote : '']
              .filter(Boolean)
              .join('\n')}
          >
            <div className="line-clamp-2 text-text-2">{r.trigger_hint || '—'}</div>
            {r.execution_mode === 'sync' && (syncHint || r.rescan_included === false) ? (
              <div className="line-clamp-2 text-[#92400e]">
                {[syncHint, r.rescan_included === false ? ui.syncRescanNote : ''].filter(Boolean).join(' · ')}
              </div>
            ) : null}
          </td>
          <td className="px-1.5 py-1 text-center">
            <label className="inline-flex cursor-pointer" title={ui.enabledToggleHint}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                checked={r.enabled}
                aria-label={`${r.name} ${r.enabled ? ui.enabledYes : ui.enabledNo}`}
                onChange={(e) => onToggleEnabled(r, e.target.checked)}
              />
            </label>
          </td>
          <td className="max-w-[120px] px-1.5 py-1 text-[10px] leading-snug text-text-3">{r.modules.join('、')}</td>
          <td className={`px-1.5 py-1 ${AUDIT_RISK_COL_CLASS}`}>
            <AuditRiskLevelBadge
              level={r.risk_level}
              label={riskLevelDict.getLabel(r.risk_level)}
              size="dense"
            />
          </td>
          <td className="px-1.5 py-1 text-center">
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded-sm border border-border-light text-[11px] leading-none text-text-2 hover:border-accent disabled:opacity-40"
              onClick={() => toggleExpanded(r.rule_id)}
              disabled={!canExpand}
              aria-expanded={expanded}
              title={expanded ? ui.collapseRule : ui.expandRule}
            >
              {expanded ? '−' : '+'}
            </button>
          </td>
        </tr>
        {expanded ? (
          <tr className="border-b border-border-light bg-[#fafbfd]">
            <td colSpan={8} className="px-3 py-2 text-il-meta text-text-2">
              {hasDetail ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 font-semibold text-text">{ui.ruleDescriptionLabel}</div>
                    <p className="whitespace-pre-wrap leading-relaxed">{r.description?.trim() || '—'}</p>
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-text">{ui.ruleLogicLabel}</div>
                    <p className="whitespace-pre-wrap leading-relaxed font-mono text-[12px]">
                      {r.logic?.trim() || '—'}
                    </p>
                  </div>
                </div>
              ) : null}
              {hasParams ? (
                <RuleParamsPanel
                  rule={r}
                  params={params}
                  riskOptions={riskLevelDict.options}
                  ui={ui}
                  onScalarChange={(key, value) => onScalarParamChange(r, key, value)}
                  onCategoryTaxMapChange={(entries) => onCategoryTaxMapChange(r.rule_id, entries)}
                />
              ) : null}
              {!hasDetail && !hasParams ? <p className="text-text-3">{ui.ruleDetailEmpty}</p> : null}
            </td>
          </tr>
        ) : null}
      </Fragment>
    )
  }

  return (
    <div className="space-y-4">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />

      <Card>
        {renderToolbar()}
        <div className="mb-3 flex border-b border-border-light" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === 'list'}
            className={[
              'px-4 py-2 text-il-meta font-semibold transition-colors',
              pageTab === 'list'
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-3 hover:text-text-2',
            ].join(' ')}
            onClick={() => setPageTab('list')}
          >
            {ui.tabRulesList}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pageTab === 'yaml'}
            className={[
              'px-4 py-2 text-il-meta font-semibold transition-colors',
              pageTab === 'yaml'
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-3 hover:text-text-2',
            ].join(' ')}
            onClick={() => setPageTab('yaml')}
          >
            {ui.tabRulesYaml}
          </button>
        </div>
        {renderFeedback()}
      </Card>

      {pageTab === 'list' ? (
        <>
          <Card title={ui.rulesTableTitle} compact>
            <p className="mb-2 text-[11px] leading-snug text-text-3">{ui.rulesTableDesc}</p>
            {rulesList.length === 0 ? (
              <p className="text-il-meta text-text-3">{ui.rulesTableEmpty}</p>
            ) : (
              <div className="space-y-3">
                {RULE_GROUPS.map((group) => {
                  const rows = groupedRules[group.key]
                  if (rows.length === 0) return null
                  return (
                    <section key={group.key}>
                      <div className="mb-1">
                        <h3 className="text-[11px] font-semibold leading-tight text-text">{ui[group.titleKey]}</h3>
                        <p className="text-[10px] leading-snug text-text-3">{ui[group.descKey]}</p>
                      </div>
                      <div className="overflow-x-auto rounded-sm border border-border-light">
                        <table className="w-full min-w-[880px] table-fixed border-collapse text-il-meta">
                          <thead>
                            <tr className="border-b border-border-light bg-[#fafbfd] text-left text-[10px] leading-tight text-text-3">
                              <th className="w-[118px] px-1.5 py-1 font-medium">{ui.colRuleId}</th>
                              <th className="w-[88px] px-1.5 py-1 font-medium">{ui.colRuleName}</th>
                              <th className="w-[52px] px-1.5 py-1 text-center font-medium">{ui.colExecutionMode}</th>
                              <th className="px-1.5 py-1 font-medium">{ui.colTriggerHint}</th>
                              <th className="w-10 px-1.5 py-1 text-center font-medium">{ui.colEnabled}</th>
                              <th className="w-[96px] px-1.5 py-1 font-medium">{ui.colModules}</th>
                              <th className={`px-1.5 py-1 font-medium ${AUDIT_RISK_COL_CLASS}`}>{ui.colRisk}</th>
                              <th className="w-10 px-1.5 py-1 text-center font-medium">{ui.colExpand}</th>
                            </tr>
                          </thead>
                          <tbody className="text-text-2">{rows.map((r) => renderRuleRow(r))}</tbody>
                        </table>
                      </div>
                    </section>
                  )
                })}
              </div>
            )}
            <div className="mt-3">
              <button
                type="button"
                className="text-il-meta text-accent hover:underline"
                onClick={() => setPageTab('yaml')}
              >
                {ui.openYamlTab}
              </button>
            </div>
          </Card>

          <Card title={ui.helpTitle}>
            <ul className="list-inside list-disc space-y-1 text-il-meta text-text-2">
              {ui.helpBullets.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>
        </>
      ) : (
        <Card title={ui.configCardTitle}>
          <p className="mb-3 text-il-meta text-text-3">{ui.tabRulesYamlHint}</p>
          <textarea
            className="min-h-[560px] w-full rounded-sm border border-border-light bg-white p-3 font-mono text-[12px] leading-relaxed text-text outline-none focus:border-accent"
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            spellCheck={false}
          />
        </Card>
      )}
    </div>
  )
}
