import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { fetchAuditFlagsList, type AuditFlagRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { readEffectiveNavQuery } from '../utils/embedNavQuery'
import { FlagActionButtons } from './FlagActionButtons'
import type { FlagAnalysisHandlers } from './flagAnalysisNavigate'
import { readCachedFlagDetailRow } from './flagDetailHelpers'
import { useDimDictDomain } from '../dim/useDimDict'
import { AuditRiskLevelBadge } from './auditRiskBadge'

type Props = {
  onNav?: (key: NavKey) => void
  embedMode?: boolean
  analysisHandlers?: FlagAnalysisHandlers | null
}

function readParams(): { flagId: string; statYear: string } {
  const q = readEffectiveNavQuery(() => {
    try {
      const sp = new URL(window.location.href).searchParams
      const out: Record<string, string> = {}
      const flagId = sp.get('flag_id')
      const statYear = sp.get('stat_year')
      if (flagId) out.flag_id = flagId
      if (statYear) out.stat_year = statYear
      return out
    } catch {
      return {}
    }
  })
  return { flagId: q.flag_id ?? '', statYear: q.stat_year ?? '' }
}

export function FlagDetailPanel({ onNav, embedMode = true, analysisHandlers = null }: Props) {
  const ui = t.auditFlagUi
  const trackUi = t.auditTrackUi
  const riskLevelDict = useDimDictDomain('audit_risk_level')
  const { flagId, statYear } = useMemo(() => readParams(), [])
  const [row, setRow] = useState<AuditFlagRow | null>(() => readCachedFlagDetailRow(flagId))
  const [loading, setLoading] = useState(() => !readCachedFlagDetailRow(flagId))
  const [err, setErr] = useState<string | null>(null)

  const loadRow = useCallback(async (signal?: AbortSignal) => {
    if (!flagId || !statYear) {
      setErr(ui.loadFailed)
      setLoading(false)
      return
    }
    const cached = readCachedFlagDetailRow(flagId)
    if (cached) {
      setRow(cached)
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditFlagsList({ statYear, flagId, limit: 1, offset: 0 }, signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setRow(null)
        return
      }
      const found = (res.rows ?? []).find((r) => r.flag_id === flagId) ?? res.rows?.[0] ?? null
      if (!found) {
        setErr(ui.emptyList)
        setRow(null)
        return
      }
      setRow(found)
    } finally {
      setLoading(false)
    }
  }, [flagId, statYear, ui.loadFailed, ui.emptyList])

  useEffect(() => {
    const ac = new AbortController()
    void loadRow(ac.signal)
    return () => ac.abort()
  }, [loadRow])

  if (loading) {
    return <p className="text-il-meta text-text-3">{ui.loading}</p>
  }
  if (err || !row) {
    return <p className="text-il-meta text-danger">{err ?? ui.loadFailed}</p>
  }

  return (
    <div className={embedMode ? 'w-full space-y-4' : 'w-full space-y-4 px-5 py-6'}>
      <Card title={ui.flagDetailMetaTitle}>
        <dl className="grid gap-2 text-il-meta sm:grid-cols-2">
          <div>
            <dt className="text-text-3">{ui.colFlagId}</dt>
            <dd className="font-mono text-[11px] text-text">{row.flag_id}</dd>
          </div>
          <div>
            <dt className="text-text-3">{ui.colRule}</dt>
            <dd className="text-text">{row.rule_id}</dd>
          </div>
          <div>
            <dt className="text-text-3">{ui.colRisk}</dt>
            <dd>
              <AuditRiskLevelBadge level={row.risk_level} label={riskLevelDict.getLabel(row.risk_level)} />
            </dd>
          </div>
          <div>
            <dt className="text-text-3">{ui.colType}</dt>
            <dd className="text-text">{row.flag_type || '—'}</dd>
          </div>
          <div>
            <dt className="text-text-3">{ui.colEntity}</dt>
            <dd className="text-text">{row.entity_name ?? row.entity_id ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-text-3">{ui.colSeller}</dt>
            <dd className="text-text">{row.seller_name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-text-3">{ui.colAmount}</dt>
            <dd className="tabular-nums text-text">
              {row.amount != null ? row.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—'}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title={ui.descLabel}>
        <p className="whitespace-pre-wrap text-il-meta text-text-2">{row.description || '—'}</p>
      </Card>

      <Card title={ui.suggestionLabel}>
        <p className="whitespace-pre-wrap text-il-meta text-text-2">{row.suggestion || '—'}</p>
      </Card>

      {row.confirm_note ? (
        <Card title={trackUi.confirmNoteLabel}>
          <p className="whitespace-pre-wrap text-il-meta text-text-2">{row.confirm_note}</p>
        </Card>
      ) : null}

      {onNav ? (
        <Card title={ui.colAction}>
          <FlagActionButtons
            row={row}
            statYear={statYear}
            onNav={onNav}
            analysisHandlers={analysisHandlers}
            showReport
            className="flex flex-wrap gap-3"
          />
        </Card>
      ) : null}
    </div>
  )
}
