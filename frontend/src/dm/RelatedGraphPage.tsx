import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsTradeGraph, fetchSettingsThresholds, type DwsTradeGraphEdge, type DwsTradeGraphNode } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import {
  navigateToFlagsList,
  navigateToRelatedPairs,
  navigateToRelatedShell,
  navigateToReportConfig,
  navigateToTaxRiskExposure,
  navigateWithQuery,
  readNavQueryParams,
} from '../utils/navHelpers'
import { DwsFilterBar } from '../dws/DwsFilterBar'
import { formatDwsAmount, useDwsFilters } from '../dws/useDwsFilters'
import type { NavKey } from '../types'

const ROLE_COLORS: Record<string, string> = {
  subject: '#0066cc',
  供应商: '#2b6cb0',
  客户: '#2f855a',
  往来单位: '#c05621',
  未知: '#718096',
}

type Props = { onNav?: (key: NavKey) => void }

function normTaxId(v: string): string {
  return v.replace(/[\s-]+/g, '').toUpperCase()
}

function layoutNodes(
  center: DwsTradeGraphNode,
  others: DwsTradeGraphNode[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const cx = width / 2
  const cy = height / 2
  pos.set(center.id, { x: cx, y: cy })
  const r = Math.min(width, height) * 0.34
  others.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2
    pos.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  })
  return pos
}

type ViewTransform = { x: number; y: number; scale: number }

function clampScale(s: number): number {
  return Math.min(3, Math.max(0.35, s))
}

export function RelatedGraphPage({ onNav }: Props) {
  const ui = t.relatedGraphUi
  const dash = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const f = useDwsFilters(true, { entityPool: 'analysis', initFromUrl: true })
  const [nodes, setNodes] = useState<DwsTradeGraphNode[]>([])
  const [edges, setEdges] = useState<DwsTradeGraphEdge[]>([])
  const [minAmount, setMinAmount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [truncatedMessage, setTruncatedMessage] = useState<string | null>(null)
  const [graphStats, setGraphStats] = useState<{ nodes: number; edges: number } | null>(null)
  const [maxGraphNodes, setMaxGraphNodes] = useState<number | null>(null)
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 })
  const panRef = useRef<{ dragging: boolean; sx: number; sy: number; ox: number; oy: number } | null>(null)
  const svgWrapRef = useRef<HTMLDivElement>(null)

  const effectiveN = f.minInvoiceCount ?? f.defaultMinInvoiceCount ?? 10
  const caliberHint = dash.analysisSubjectCaliberHint.replace('{n}', String(effectiveN))
  const highlightCounterparty = useMemo(() => {
    const raw = urlQuery.counterparty_tax_no?.trim() || urlQuery.party_b_tax?.trim() || ''
    return raw ? normTaxId(raw) : ''
  }, [urlQuery.counterparty_tax_no, urlQuery.party_b_tax])
  const flagContextHint = useMemo(() => {
    if (!urlQuery.party_a_tax?.trim() && !highlightCounterparty) return null
    return dash.flagContextPartyHint
      .replace('{partyA}', urlQuery.party_a_tax?.trim() || f.entityId.trim() || '—')
      .replace('{partyB}', urlQuery.party_b_tax?.trim() || urlQuery.counterparty_tax_no?.trim() || '—')
  }, [dash, f.entityId, highlightCounterparty, urlQuery.counterparty_tax_no, urlQuery.party_a_tax, urlQuery.party_b_tax])
  const taxRiskContextHint = useMemo(() => {
    if (urlQuery.source !== 'tax_risk') return null
    return ui.taxRiskContextHint.replace('{entity}', f.entityId.trim() || urlQuery.entity_id?.trim() || '—')
  }, [f.entityId, ui.taxRiskContextHint, urlQuery.entity_id, urlQuery.source])

  const graphLinkParams = useMemo(
    () => ({
      statYear: f.effectiveYear,
      entityId: f.entityId.trim(),
      partyATax: f.entityId.trim() || urlQuery.party_a_tax?.trim(),
      partyBTax: highlightCounterparty || urlQuery.party_b_tax?.trim(),
    }),
    [f.effectiveYear, f.entityId, highlightCounterparty, urlQuery.party_a_tax, urlQuery.party_b_tax],
  )

  useEffect(() => {
    const ac = new AbortController()
    void fetchSettingsThresholds(ac.signal).then((res) => {
      if (ac.signal.aborted || !res.ok) return
      const item = (res.items ?? []).find((x) => x.key === 'max_graph_nodes')
      if (item?.effective_value != null) setMaxGraphNodes(Number(item.effective_value))
    })
    return () => ac.abort()
  }, [])

  useEffect(() => {
    setView({ x: 0, y: 0, scale: 1 })
  }, [f.effectiveYear, f.entityId, minAmount, highlightCounterparty])

  const isHighlightedNode = (node: DwsTradeGraphNode) =>
    highlightCounterparty !== '' && normTaxId(node.id) === highlightCounterparty

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!f.effectiveYear || !f.entityId.trim()) {
      setNodes([])
      setEdges([])
      setTruncated(false)
      setTruncatedMessage(null)
      setGraphStats(null)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchDwsTradeGraph(
        {
          statYear: f.effectiveYear,
          entityId: f.entityId.trim(),
          minAmount: minAmount ?? undefined,
          counterpartyId: highlightCounterparty || undefined,
          partyATax: urlQuery.party_a_tax?.trim() || undefined,
          partyBTax: urlQuery.party_b_tax?.trim() || urlQuery.counterparty_tax_no?.trim() || undefined,
        },
        signal,
      )
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        setNodes([])
        setEdges([])
        return
      }
      setNodes(res.nodes ?? [])
      setEdges(res.edges ?? [])
      setTruncated(Boolean(res.truncated))
      setTruncatedMessage(res.truncatedMessage ?? null)
      if (res.nodeCount != null) {
        setGraphStats({ nodes: res.nodeCount, edges: res.edgeCount ?? 0 })
      } else {
        setGraphStats(null)
      }
    } finally {
      setLoading(false)
    }
  }, [f.effectiveYear, f.entityId, highlightCounterparty, minAmount, ui.loadFailed, urlQuery.counterparty_tax_no, urlQuery.party_a_tax, urlQuery.party_b_tax])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const center = useMemo(() => nodes.find((n) => n.is_center) ?? nodes[0], [nodes])
  const others = useMemo(() => nodes.filter((n) => !n.is_center), [nodes])
  const positions = useMemo(
    () => (center ? layoutNodes(center, others, 720, 420) : new Map()),
    [center, others],
  )

  const onNodeClick = (node: DwsTradeGraphNode) => {
    if (!onNav) return
    if (node.is_center) {
      navigateWithQuery(onNav, 'trade_relationships', {
        stat_year: f.effectiveYear,
        entity_id: f.entityId.trim(),
      })
      return
    }
    if (node.is_shell) {
      navigateToFlagsList(onNav, { statYear: f.effectiveYear, ruleId: 'RULE-SHELL', entityId: node.id })
      return
    }
    if (node.is_circular) {
      navigateToFlagsList(onNav, { statYear: f.effectiveYear, ruleId: 'RULE-09', entityId: node.id })
      return
    }
    if (node.has_confirmed_flag) {
      navigateToFlagsList(onNav, { statYear: f.effectiveYear, entityId: node.id })
      return
    }
    navigateWithQuery(onNav, 'trade_relationships', {
      stat_year: f.effectiveYear,
      entity_id: f.entityId.trim(),
    })
  }

  const showSvg = nodes.length > 1

  const onWheelZoom = (ev: WheelEvent) => {
    ev.preventDefault()
    const delta = ev.deltaY > 0 ? 0.9 : 1.1
    setView((prev) => ({ ...prev, scale: clampScale(prev.scale * delta) }))
  }

  const onPanStart = (ev: PointerEvent) => {
    if (ev.button !== 0) return
    panRef.current = { dragging: true, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y }
    ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  }

  const onPanMove = (ev: PointerEvent) => {
    const p = panRef.current
    if (!p?.dragging) return
    setView((prev) => ({
      ...prev,
      x: p.ox + (ev.clientX - p.sx),
      y: p.oy + (ev.clientY - p.sy),
    }))
  }

  const onPanEnd = (ev: PointerEvent) => {
    if (panRef.current) panRef.current.dragging = false
    try {
      ;(ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
  }

  const resetView = () => setView({ x: 0, y: 0, scale: 1 })

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader title={ui.pageTitle} note={ui.pageDesc} noteTone="plain" />
      {flagContextHint ? <p className="mb-2 text-il-meta text-amber-800">{flagContextHint}</p> : null}
      {taxRiskContextHint ? <p className="mb-2 text-il-meta text-amber-800">{taxRiskContextHint}</p> : null}
      {err ? <p className="mb-2 text-il-meta text-red-600">{err}</p> : null}

      <Card title={ui.filterTitle}>
        <DwsFilterBar
          effectiveYear={f.effectiveYear}
          yearOptions={f.yearOptions}
          onYearChange={f.setStatYear}
          entityId={f.entityId}
          onEntityChange={f.setEntityId}
          entityOptions={f.entityOptions}
          requireEntity
          showMinInvoiceCount
          minInvoiceCount={effectiveN}
          onMinInvoiceCountChange={f.setMinInvoiceCount}
        />
        <label className="mt-2 flex items-center gap-2 text-il-meta text-text-2">
          <span>{ui.minAmountLabel}</span>
          <input
            type="number"
            className="h-8 w-32 rounded-sm border border-border-light px-2"
            value={minAmount ?? ''}
            placeholder={ui.minAmountPlaceholder}
            onChange={(e) => {
              const v = e.target.value.trim()
              setMinAmount(v ? Number(v) : null)
            }}
          />
        </label>
        <p className="mt-2 text-il-meta text-text-3">{caliberHint}</p>
        {maxGraphNodes != null ? (
          <p className="mt-1 text-il-meta text-text-3">
            {ui.maxNodesHint.replace('{n}', String(maxGraphNodes))}
          </p>
        ) : null}
        {onNav ? (
          <div className="mt-3 flex flex-wrap gap-2 text-il-meta">
            {urlQuery.source === 'tax_risk' ? (
              <button
                type="button"
                className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
                onClick={() =>
                  navigateToTaxRiskExposure(onNav, {
                    statYear: f.effectiveYear,
                    entityId: f.entityId.trim(),
                  })
                }
              >
                {ui.taxRiskLink}
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() => navigateWithQuery(onNav, 'flags_rules', { stat_year: f.effectiveYear })}
            >
              {ui.rescanLink}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() => navigateToRelatedPairs(onNav, graphLinkParams)}
            >
              {ui.pairsLink}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() => navigateToRelatedShell(onNav, graphLinkParams)}
            >
              {ui.shellLink}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() =>
                navigateToReportConfig(onNav, {
                  statYear: f.effectiveYear,
                  entityId: f.entityId.trim(),
                  chapters: ['related', 'flags_track', 'tax_in_out_deviation'],
                })
              }
            >
              {ui.reportLink}
            </button>
          </div>
        ) : null}
      </Card>

      <Card title={ui.graphTitle}>
        {loading ? <p className="text-il-meta text-text-3">{ui.loading}</p> : null}
        {!loading && !f.entityId.trim() ? (
          <p className="text-il-meta text-text-3">{ui.pickEntityHint}</p>
        ) : !loading && nodes.length <= 1 ? (
          <p className="text-il-meta text-text-3">{ui.emptyHint}</p>
        ) : (
          <>
            {truncated ? (
              <div className="mb-3 rounded-sm border border-warn/40 bg-warn/5 px-3 py-2 text-il-meta text-text-2">
                <p className="font-medium text-warn">{ui.truncatedTitle}</p>
                <p className="mt-1">{truncatedMessage ?? ui.truncatedDefault}</p>
                {graphStats ? (
                  <p className="mt-1 text-text-3">
                    {ui.truncatedStats
                      .replace('{nodes}', String(graphStats.nodes))
                      .replace('{edges}', String(graphStats.edges))}
                  </p>
                ) : null}
                {onNav ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() => navigateToRelatedPairs(onNav, graphLinkParams)}
                    >
                      {ui.pairsLink}
                    </button>
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() => navigateToRelatedShell(onNav, graphLinkParams)}
                    >
                      {ui.shellLink}
                    </button>
                    {urlQuery.source === 'tax_risk' ? (
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() =>
                          navigateToTaxRiskExposure(onNav, {
                            statYear: f.effectiveYear,
                            entityId: f.entityId.trim(),
                          })
                        }
                      >
                        {ui.taxRiskLink}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {showSvg ? (
              <>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-il-meta text-text-3">
                  <span>{ui.panZoomHint}</span>
                  <button type="button" className="text-accent hover:underline" onClick={resetView}>
                    {ui.resetViewBtn}
                  </button>
                </div>
                <div
                  ref={svgWrapRef}
                  className="mx-auto max-w-[720px] overflow-hidden rounded-sm border border-border-light bg-[#fafbfd] touch-none"
                  onWheel={onWheelZoom}
                  onPointerDown={onPanStart}
                  onPointerMove={onPanMove}
                  onPointerUp={onPanEnd}
                  onPointerLeave={onPanEnd}
                >
                  <svg viewBox="0 0 720 420" className="w-full select-none">
                    <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                  {edges.map((e, idx) => {
                    const s = positions.get(e.source)
                    const tpos = positions.get(e.target)
                    if (!s || !tpos) return null
                    const color = ROLE_COLORS[e.role] ?? '#718096'
                    return (
                      <g key={`${e.source}-${e.target}-${idx}`}>
                        <line
                          x1={s.x}
                          y1={s.y}
                          x2={tpos.x}
                          y2={tpos.y}
                          stroke={color}
                          strokeWidth={1.5}
                          strokeOpacity={0.55}
                        />
                        <text
                          x={(s.x + tpos.x) / 2}
                          y={(s.y + tpos.y) / 2 - 4}
                          textAnchor="middle"
                          className="fill-text-3 text-[10px]"
                        >
                          {formatDwsAmount(e.amount)}
                        </text>
                      </g>
                    )
                  })}
                  {nodes.map((n) => {
                    const p = positions.get(n.id)
                    if (!p) return null
                    const fill = n.is_shell
                      ? '#fed7d7'
                      : n.is_circular
                        ? '#feebc8'
                        : n.has_confirmed_flag
                          ? '#e9d8fd'
                          : '#ebf8ff'
                    const stroke = isHighlightedNode(n)
                      ? '#d97706'
                      : ROLE_COLORS[n.is_center ? 'subject' : n.role] ?? '#718096'
                    const r = n.is_center ? 28 : 22
                    const strokeWidth = isHighlightedNode(n) ? 3.5 : 2
                    return (
                      <g
                        key={n.id}
                        className="cursor-pointer"
                        onClick={() => onNodeClick(n)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') onNodeClick(n)
                        }}
                      >
                        <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                        <text
                          x={p.x}
                          y={p.y + r + 12}
                          textAnchor="middle"
                          className="fill-text text-[10px]"
                        >
                          {(n.label || n.id).slice(0, 8)}
                        </text>
                      </g>
                    )
                  })}
                    </g>
                  </svg>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-il-soon text-text-3">
                  <span>{ui.legendCenter}</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#fed7d7]" /> {ui.legendShell}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#feebc8]" /> {ui.legendCircular}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#e9d8fd]" /> {ui.legendConfirmed}
                  </span>
                </div>
              </>
            ) : null}
          </>
        )}
      </Card>
    </div>
  )
}
