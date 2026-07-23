import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchDwsTradeGraph, fetchSettingsThresholds, type DwsTradeGraphEdge, type DwsTradeGraphNode } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'
import { handleNavAnalysisAction } from './flagAnalysisNavigate'
import { FlagAnalysisShell } from './FlagAnalysisShell'
import { useFlagAnalysisShell } from './useFlagAnalysisShell'
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

type Point = { x: number; y: number }

type GraphDimensions = { width: number; height: number; orbitR: number; titleH: number }

type EdgeSegmentKind = 'purchase' | 'sales'

type EdgeSegmentLabel = {
  key: string
  displayEdgeKey: string
  counterpartyId: string
  kind: EdgeSegmentKind
  line: string
  from: Point
  to: Point
  lineAngle: number
  bothDirections: boolean
  layoutIndex: number
  cpAngle: number
}

type NodePlacement = Point & { angle: number; r: number }

type LabelBox = { cx: number; cy: number; w: number; h: number }

const GRAPH_FONT_NODE = 10
const GRAPH_FONT_EDGE = 11
const CENTER_NODE_R = 9
const PERIPH_NODE_R = 6
const NODE_HIT_R = 14
const EDGE_LABEL_SIDE_OFFSET = 32
const EDGE_LABEL_MIN_LINE_CLEARANCE = 12
const BIDIR_LINE_OFFSET = 7
const LABEL_AUDIT_MAX_ROUNDS = 10

function graphDimensions(nodeCount: number): GraphDimensions {
  const peripheral = Math.max(nodeCount - 1, 0)
  if (peripheral <= 4) return { width: 760, height: 500, orbitR: 168, titleH: 36 }
  if (peripheral <= 6) return { width: 940, height: 580, orbitR: 188, titleH: 36 }
  return { width: 1080, height: 640, orbitR: 208, titleH: 40 }
}

function graphCenterY(dims: GraphDimensions): number {
  return dims.titleH + (dims.height - dims.titleH) / 2
}

function layoutNodes(
  center: DwsTradeGraphNode,
  others: DwsTradeGraphNode[],
  dims: GraphDimensions,
): Map<string, NodePlacement> {
  const pos = new Map<string, NodePlacement>()
  const cx = dims.width / 2
  const cy = graphCenterY(dims)
  pos.set(center.id, { x: cx, y: cy, angle: 0, r: CENTER_NODE_R })
  others.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2
    pos.set(n.id, {
      x: cx + dims.orbitR * Math.cos(angle),
      y: cy + dims.orbitR * Math.sin(angle),
      angle,
      r: PERIPH_NODE_R,
    })
  })
  return pos
}

function nodeDotFill(n: DwsTradeGraphNode): string {
  if (n.is_shell) return '#e53e3e'
  if (n.is_circular) return '#dd6b20'
  if (n.has_confirmed_flag) return '#805ad5'
  return ROLE_COLORS[n.is_center ? 'subject' : n.role] ?? '#718096'
}

function radialTextAnchor(angle: number): 'start' | 'middle' | 'end' {
  const c = Math.cos(angle)
  if (c > 0.35) return 'start'
  if (c < -0.35) return 'end'
  return 'middle'
}

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62
}

function boxesOverlap(a: LabelBox, b: LabelBox, pad = 5): boolean {
  const ax1 = a.cx - a.w / 2 - pad
  const ax2 = a.cx + a.w / 2 + pad
  const ay1 = a.cy - a.h / 2 - pad
  const ay2 = a.cy + a.h / 2 + pad
  const bx1 = b.cx - b.w / 2 - pad
  const bx2 = b.cx + b.w / 2 + pad
  const by1 = b.cy - b.h / 2 - pad
  const by2 = b.cy + b.h / 2 + pad
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1
}

function overlapsAny(box: LabelBox, others: LabelBox[]): boolean {
  return others.some((b) => boxesOverlap(box, b))
}

type NodeLabelLayout = {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  box: LabelBox
  text: string
}

type SegmentLabelLayout = { pt: Point; angle: number }

type SegmentLabelStrategy = {
  preferNear: 'from' | 'to'
  side: 1 | -1
  tAnchor: number
  sideOffset: number
  escalation: number
}

function distPointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function segmentLabelBox(pt: Point, line: string, angleDeg = 0): LabelBox {
  const { w, h } = estimateInlineLabelSize(line, GRAPH_FONT_EDGE)
  const tw = w * 0.9
  const th = h * 0.9
  if (Math.abs(angleDeg) < 0.5) return { cx: pt.x, cy: pt.y, w: tw + 6, h: th + 4 }
  const rad = (Math.abs(angleDeg) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return { cx: pt.x, cy: pt.y, w: tw * cos + th * sin + 6, h: tw * sin + th * cos + 4 }
}

/** 与箭头同向、可读（不倒置）的线段标签旋转角（度） */
function segmentLineAngle(from: Point, to: Point): number {
  let deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
  if (deg > 90) deg -= 180
  if (deg < -90) deg += 180
  return deg
}

function isLabelClearOfLine(pt: Point, from: Point, to: Point): boolean {
  return distPointToSegment(pt, from, to) >= EDGE_LABEL_MIN_LINE_CLEARANCE
}

function segmentLabelStrategy(
  kind: EdgeSegmentKind,
  bothDirections: boolean,
  layoutIndex: number,
  cpAngle: number,
  escalation = 0,
  splitSibling = false,
): Omit<SegmentLabelStrategy, 'escalation' | 'sideOffset'> {
  const sideFlip = (((Math.sin(cpAngle * 1.7) >= 0 ? 1 : -1) * (layoutIndex % 2 === 0 ? 1 : -1)) as 1 | -1)
  const escAlong = escalation * 0.04
  const along = splitSibling
    ? 0.1 + escAlong
    : 0.12 + (layoutIndex % 3) * 0.012 + escAlong
  if (bothDirections) {
    if (kind === 'purchase') {
      return { preferNear: 'from', side: (-1 * sideFlip) as 1 | -1, tAnchor: along }
    }
    // 出标奇偶错开：偶数索引靠中心侧，奇数索引靠对方节点侧，避免多根出边堆叠
    if (layoutIndex % 2 === 1) {
      return { preferNear: 'to', side: (1 * sideFlip) as 1 | -1, tAnchor: along }
    }
    return { preferNear: 'from', side: (1 * sideFlip) as 1 | -1, tAnchor: along }
  }
  if (kind === 'purchase') return { preferNear: 'from', side: -1, tAnchor: 0.36 + escAlong }
  return { preferNear: 'to', side: 1, tAnchor: 0.64 + escAlong }
}

function resolveSegmentLabelPos(
  from: Point,
  to: Point,
  line: string,
  avoid: LabelBox[],
  base: Omit<SegmentLabelStrategy, 'escalation' | 'sideOffset'>,
  escalation = 0,
  lineAngle = segmentLineAngle(from, to),
): SegmentLabelLayout {
  const angle = lineAngle
  const sideOffset = EDGE_LABEL_SIDE_OFFSET + escalation * 6
  const perp = perpOffset(from, to, 1)
  const spread = 0.05 + escalation * 0.04
  const tValues = [
    base.tAnchor,
    base.tAnchor + spread,
    base.tAnchor - spread,
    base.tAnchor + spread * 2,
    base.tAnchor - spread * 2,
    base.preferNear === 'from' ? 0.2 : 0.8,
    0.5,
  ].filter((t, i, arr) => t > 0.1 && t < 0.9 && arr.indexOf(t) === i)

  const sideOffsets = [
    sideOffset,
    sideOffset + 8,
    sideOffset + 14,
    sideOffset - 6,
  ].filter((o) => o >= 14)

  const sideCandidates: Array<1 | -1> =
    escalation >= 2 ? [base.side, (-base.side as 1 | -1)] : [base.side]

  for (const t of tValues) {
    for (const off of sideOffsets) {
      for (const side of sideCandidates) {
        const pt = labelPosAlongEdge(from, to, t)
        const placed = {
          x: pt.x + perp.ox * off * side,
          y: pt.y + perp.oy * off * side,
        }
        const box = segmentLabelBox(placed, line, angle)
        if (!isLabelClearOfLine(placed, from, to)) continue
        if (!overlapsAny(box, avoid)) return { pt: placed, angle }
      }
    }
  }

  const fallback = labelPosAlongEdge(from, to, base.tAnchor)
  const pt = {
    x: fallback.x + perp.ox * sideOffset * base.side,
    y: fallback.y + perp.oy * sideOffset * base.side,
  }
  return { pt, angle }
}

type LabelAuditIssue = { segmentKey: string; reason: 'on-line' | 'overlap'; with?: string }

function auditEdgeLabelLayouts(
  segments: EdgeSegmentLabel[],
  layouts: Map<string, SegmentLabelLayout>,
): LabelAuditIssue[] {
  const issues: LabelAuditIssue[] = []
  const entries = segments.map((seg) => {
    const layout = layouts.get(seg.key)!
    return { seg, layout, box: segmentLabelBox(layout.pt, seg.line, layout.angle) }
  })
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!
    if (!isLabelClearOfLine(a.layout.pt, a.seg.from, a.seg.to)) {
      issues.push({ segmentKey: a.seg.key, reason: 'on-line' })
    }
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]!
      if (boxesOverlap(a.box, b.box, 3)) {
        issues.push({ segmentKey: a.seg.key, reason: 'overlap', with: b.seg.key })
        issues.push({ segmentKey: b.seg.key, reason: 'overlap', with: a.seg.key })
      }
    }
  }
  return issues
}

function layoutEdgeLabelLayouts(
  segments: EdgeSegmentLabel[],
  placedBoxes: LabelBox[],
): Map<string, SegmentLabelLayout> {
  const layouts = new Map<string, SegmentLabelLayout>()
  const segmentBoxes = new Map<string, LabelBox>()
  const escalations = new Map<string, number>()

  const allBoxes = (): LabelBox[] => [...placedBoxes, ...segmentBoxes.values()]

  for (const seg of segments) {
    const base = segmentLabelStrategy(seg.kind, seg.bothDirections, seg.layoutIndex, seg.cpAngle, 0)
    const layout = resolveSegmentLabelPos(seg.from, seg.to, seg.line, allBoxes(), base, 0, seg.lineAngle)
    layouts.set(seg.key, layout)
    segmentBoxes.set(seg.key, segmentLabelBox(layout.pt, seg.line, layout.angle))
    escalations.set(seg.key, 0)
  }

  for (let round = 0; round < LABEL_AUDIT_MAX_ROUNDS; round++) {
    const issues = auditEdgeLabelLayouts(segments, layouts)
    if (issues.length === 0) break

    const retryKeys = new Set(issues.map((i) => i.segmentKey))
    for (const key of retryKeys) {
      const seg = segments.find((s) => s.key === key)
      if (!seg) continue
      const nextEsc = (escalations.get(key) ?? 0) + 1
      escalations.set(key, nextEsc)
      segmentBoxes.delete(key)

      const siblingOverlap = issues.some(
        (i) =>
          i.segmentKey === key &&
          i.reason === 'overlap' &&
          i.with != null &&
          segments.find((s) => s.key === i.with)?.displayEdgeKey === seg.displayEdgeKey,
      )
      const base = segmentLabelStrategy(
        seg.kind,
        seg.bothDirections,
        seg.layoutIndex,
        seg.cpAngle,
        nextEsc,
        siblingOverlap,
      )
      const layout = resolveSegmentLabelPos(seg.from, seg.to, seg.line, allBoxes(), base, nextEsc, seg.lineAngle)
      layouts.set(key, layout)
      segmentBoxes.set(key, segmentLabelBox(layout.pt, seg.line, layout.angle))
    }
  }

  if (import.meta.env.DEV) {
    const remaining = auditEdgeLabelLayouts(segments, layouts)
    if (remaining.length > 0) {
      console.warn('[RelatedGraph] 边标签布局自检未通过:', remaining)
    }
  }

  return layouts
}

function estimateInlineLabelSize(text: string, fontSize: number): { w: number; h: number } {
  return { w: estimateTextWidth(text, fontSize) + 4, h: fontSize + 6 }
}

function nodeLabelBox(
  x: number,
  y: number,
  text: string,
  fontSize: number,
  anchor: 'start' | 'middle' | 'end',
): LabelBox {
  const w = estimateTextWidth(text, fontSize)
  const h = fontSize + 3
  let cx = x
  if (anchor === 'start') cx = x + w / 2
  else if (anchor === 'end') cx = x - w / 2
  return { cx, cy: y, w, h }
}

function layoutNodeLabel(
  n: DwsTradeGraphNode,
  placement: NodePlacement,
): NodeLabelLayout | null {
  if (n.is_center) return null
  const text = (n.label || n.id).trim()
  const gap = 10
  const x = placement.x + Math.cos(placement.angle) * (placement.r + gap)
  const y = placement.y + Math.sin(placement.angle) * (placement.r + gap)
  const anchor = radialTextAnchor(placement.angle)
  return {
    x,
    y,
    anchor,
    text,
    box: nodeLabelBox(x, y, text, GRAPH_FONT_NODE, anchor),
  }
}

const EDGE_TRIM_MARGIN = 5

function buildEdgeSegments(
  de: DisplayEdge,
  centerPlacement: NodePlacement,
  cpPlacement: NodePlacement,
  purchaseShort: string,
  salesShort: string,
  layoutIndex: number,
): EdgeSegmentLabel[] {
  const centerPos = { x: centerPlacement.x, y: centerPlacement.y }
  const cpPos = { x: cpPlacement.x, y: cpPlacement.y }
  const both = Boolean(de.purchase && de.sales)
  const offset = both ? perpOffset(centerPos, cpPos, BIDIR_LINE_OFFSET) : { ox: 0, oy: 0 }
  const segments: EdgeSegmentLabel[] = []

  const pushSegment = (
    key: string,
    kind: EdgeSegmentKind,
    rawFrom: Point,
    rawTo: Point,
    line: string,
  ) => {
    const trimmed = trimSegment(
      rawFrom,
      rawTo,
      kind === 'purchase' ? cpPlacement.r + EDGE_TRIM_MARGIN : centerPlacement.r + EDGE_TRIM_MARGIN,
      kind === 'purchase' ? centerPlacement.r + EDGE_TRIM_MARGIN : cpPlacement.r + EDGE_TRIM_MARGIN,
    )
    const from = { x: trimmed.x1, y: trimmed.y1 }
    const to = { x: trimmed.x2, y: trimmed.y2 }
    segments.push({
      key,
      displayEdgeKey: de.key,
      counterpartyId: de.counterpartyId,
      kind,
      bothDirections: both,
      layoutIndex,
      cpAngle: cpPlacement.angle,
      line,
      from,
      to,
      lineAngle: segmentLineAngle(from, to),
    })
  }

  if (de.purchase) {
    const sign = both ? -1 : 0
    pushSegment(
      `${de.key}-purchase`,
      'purchase',
      { x: cpPos.x + offset.ox * sign, y: cpPos.y + offset.oy * sign },
      { x: centerPos.x + offset.ox * sign, y: centerPos.y + offset.oy * sign },
      `${purchaseShort} ${formatDwsAmount(de.purchase!.amount)}`,
    )
  }
  if (de.sales) {
    const sign = both ? 1 : 0
    pushSegment(
      `${de.key}-sales`,
      'sales',
      { x: centerPos.x + offset.ox * sign, y: centerPos.y + offset.oy * sign },
      { x: cpPos.x + offset.ox * sign, y: cpPos.y + offset.oy * sign },
      `${salesShort} ${formatDwsAmount(de.sales!.amount)}`,
    )
  }
  return segments
}

function trimSegment(from: Point, to: Point, trimFrom: number, trimTo: number) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  return {
    x1: from.x + ux * trimFrom,
    y1: from.y + uy * trimFrom,
    x2: to.x - ux * trimTo,
    y2: to.y - uy * trimTo,
  }
}

type ViewTransform = { x: number; y: number; scale: number }

function clampScale(s: number): number {
  return Math.min(3, Math.max(0.35, s))
}

type DisplayEdge = {
  key: string
  counterpartyId: string
  purchase?: DwsTradeGraphEdge
  sales?: DwsTradeGraphEdge
}

function mergeGraphEdges(edges: DwsTradeGraphEdge[]): DisplayEdge[] {
  const byCp = new Map<string, DisplayEdge>()
  for (const e of edges) {
    const cpId = e.role === '供应商' ? e.source : e.target
    if (!byCp.has(cpId)) byCp.set(cpId, { key: cpId, counterpartyId: cpId })
    const item = byCp.get(cpId)!
    if (e.role === '供应商') item.purchase = e
    else item.sales = e
  }
  return [...byCp.values()]
}

function perpOffset(
  from: { x: number; y: number },
  to: { x: number; y: number },
  px: number,
): { ox: number; oy: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  return { ox: (-dy / len) * px, oy: (dx / len) * px }
}

function labelPosAlongEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}

type GraphHover =
  | { kind: 'node'; node: DwsTradeGraphNode }
  | { kind: 'edge'; edge: DisplayEdge; counterpartyLabel: string }
  | null

function segmentEdgeColor(kind: EdgeSegmentKind): string {
  return kind === 'purchase' ? ROLE_COLORS['供应商']! : ROLE_COLORS['客户']!
}

function GraphEdgeLabel({
  x,
  y,
  text,
  fontSize = 11,
  color,
  angle = 0,
}: {
  x: number
  y: number
  text: string
  fontSize?: number
  color: string
  angle?: number
}) {
  if (!text) return null
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle})`} className="pointer-events-none">
      <text
        x={0}
        y={0}
        textAnchor="middle"
        dominantBaseline="middle"
        className="tabular-nums"
        style={{
          fontSize,
          fontWeight: 500,
          fill: color,
          paintOrder: 'stroke',
          stroke: '#fafbfd',
          strokeWidth: 3.5,
          strokeLinejoin: 'round',
        }}
      >
        {text}
      </text>
    </g>
  )
}

export function RelatedGraphPage({ onNav }: Props) {
  const ui = t.relatedGraphUi
  const dash = t.dwsDashboardUi
  const { analysisHandlers, closeShell, shellProps } = useFlagAnalysisShell({
    host: 'related_graph',
    enabled: Boolean(onNav),
    onNav,
    breadcrumbRootLabel: ui.pageTitle,
  })
  const goAnalysis = useCallback(
    (nav: NavKey, params: Record<string, string | undefined>) => {
      if (!onNav) return
      const compact: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') compact[k] = v
      }
      handleNavAnalysisAction(nav, compact, onNav, analysisHandlers, {
        closeShell: shellProps ? closeShell : undefined,
      })
    },
    [onNav, analysisHandlers, shellProps, closeShell],
  )
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
  const [hover, setHover] = useState<GraphHover>(null)
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
  const graphShellParams = useMemo(
    () => ({
      stat_year: graphLinkParams.statYear,
      party_a_tax: graphLinkParams.partyATax,
      party_b_tax: graphLinkParams.partyBTax,
      entity_id: graphLinkParams.entityId || undefined,
    }),
    [graphLinkParams],
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
    setHover(null)
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
  const displayEdges = useMemo(() => mergeGraphEdges(edges), [edges])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const graphLayout = useMemo(() => {
    if (!center) return null
    const dims = graphDimensions(nodes.length)
    const positions = layoutNodes(center, others, dims)
    const centerPlacement = positions.get(center.id)!
    const centerTitle = center.label || center.id
    const centerTitleW = estimateTextWidth(centerTitle, 13)
    const centerTitleY = dims.titleH / 2 + 6

    const nodeLabels = new Map<string, NodeLabelLayout>()
    for (const n of nodes) {
      const p = positions.get(n.id)
      if (!p) continue
      const layout = layoutNodeLabel(n, p)
      if (layout) nodeLabels.set(n.id, layout)
    }

    const placedBoxes: LabelBox[] = [
      {
        cx: centerPlacement.x,
        cy: centerPlacement.y,
        w: CENTER_NODE_R * 2 + 48,
        h: CENTER_NODE_R * 2 + 48,
      },
      {
        cx: centerPlacement.x,
        cy: centerPlacement.y,
        w: dims.orbitR * 0.42,
        h: dims.orbitR * 0.42,
      },
      {
        cx: centerPlacement.x,
        cy: centerTitleY,
        w: centerTitleW + 32,
        h: 28,
      },
    ]
    for (const n of nodes) {
      if (n.is_center) continue
      const label = nodeLabels.get(n.id)
      if (!label) continue
      placedBoxes.push({
        ...label.box,
        w: label.box.w + 10,
        h: label.box.h + 8,
      })
    }

    const sortedEdges = [...displayEdges].sort((a, b) => {
      const angA = positions.get(a.counterpartyId)?.angle ?? 0
      const angB = positions.get(b.counterpartyId)?.angle ?? 0
      return angA - angB
    })

    const edgeSegments: EdgeSegmentLabel[] = []
    sortedEdges.forEach((de, layoutIndex) => {
      const cpPlacement = positions.get(de.counterpartyId)
      if (!cpPlacement) return
      edgeSegments.push(
        ...buildEdgeSegments(
          de,
          centerPlacement,
          cpPlacement,
          ui.edgePurchaseShort,
          ui.edgeSalesShort,
          layoutIndex,
        ),
      )
    })

    const edgeLabelLayout = layoutEdgeLabelLayouts(edgeSegments, placedBoxes)

    return { dims, positions, nodeLabels, edgeSegments, edgeLabelLayout, centerTitle, centerTitleY }
  }, [center, others, nodes, displayEdges, ui.edgePurchaseShort, ui.edgeSalesShort])

  const onNodeClick = (node: DwsTradeGraphNode) => {
    if (!onNav) return
    if (node.is_center) {
      goAnalysis('trade_relationships', {
        stat_year: f.effectiveYear,
        entity_id: f.entityId.trim(),
      })
      return
    }
    if (node.is_shell) {
      goAnalysis('flags_list', {
        stat_year: f.effectiveYear,
        rule_id: 'RULE-SHELL',
        entity_id: node.id,
      })
      return
    }
    if (node.is_circular) {
      goAnalysis('flags_list', {
        stat_year: f.effectiveYear,
        rule_id: 'RULE-09',
        entity_id: node.id,
      })
      return
    }
    if (node.has_confirmed_flag) {
      goAnalysis('flags_list', {
        stat_year: f.effectiveYear,
        entity_id: node.id,
      })
      return
    }
    goAnalysis('trade_relationships', {
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

  const hoverDetail = useMemo(() => {
    if (!hover) return ui.hoverEmpty
    if (hover.kind === 'node') {
      const n = hover.node
      const flags: string[] = []
      if (n.is_center) flags.push(ui.legendCenter.replace('中心=', ''))
      if (n.is_shell) flags.push(ui.legendShell)
      if (n.is_circular) flags.push(ui.legendCircular)
      if (n.has_confirmed_flag) flags.push(ui.legendConfirmed)
      const roleLine = ui.nodeHoverRole.replace('{role}', n.role || '—')
      const flagLine = flags.length ? ui.nodeHoverFlags.replace('{flags}', flags.join('、')) : ''
      return [n.label || n.id, roleLine, flagLine].filter(Boolean).join(' · ')
    }
    const de = hover.edge
    const parts: string[] = [hover.counterpartyLabel]
    if (de.purchase) {
      parts.push(
        ui.edgeHoverPurchase
          .replace('{amount}', formatDwsAmount(de.purchase.amount))
          .replace('{cnt}', String(de.purchase.invoice_cnt)),
      )
    }
    if (de.sales) {
      parts.push(
        ui.edgeHoverSales
          .replace('{amount}', formatDwsAmount(de.sales.amount))
          .replace('{cnt}', String(de.sales.invoice_cnt)),
      )
    }
    return parts.join(' · ')
  }, [hover, ui])

  return (
    <Fragment>
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
                  goAnalysis('tax_risk_exposure', {
                    stat_year: f.effectiveYear,
                    entity_id: f.entityId.trim(),
                  })
                }
              >
                {ui.taxRiskLink}
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() => goAnalysis('flags_rules', { stat_year: f.effectiveYear })}
            >
              {ui.rescanLink}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() => goAnalysis('related_pairs', graphShellParams)}
            >
              {ui.pairsLink}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() =>
                goAnalysis('related_shell', {
                  stat_year: graphLinkParams.statYear,
                  entity_id: graphLinkParams.entityId || undefined,
                })
              }
            >
              {ui.shellLink}
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-light px-3 py-1 text-accent hover:underline"
              onClick={() =>
                goAnalysis('report_config', {
                  stat_year: f.effectiveYear,
                  entity_id: f.entityId.trim(),
                  chapters: 'related,flags_track,tax_in_out_deviation',
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
                      onClick={() => goAnalysis('related_pairs', graphShellParams)}
                    >
                      {ui.pairsLink}
                    </button>
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() =>
                goAnalysis('related_shell', {
                  stat_year: graphLinkParams.statYear,
                  entity_id: graphLinkParams.entityId || undefined,
                })
              }
                    >
                      {ui.shellLink}
                    </button>
                    {urlQuery.source === 'tax_risk' ? (
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() =>
                          goAnalysis('tax_risk_exposure', {
                            stat_year: f.effectiveYear,
                            entity_id: f.entityId.trim(),
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
                  className="mx-auto overflow-hidden rounded-sm border border-border-light bg-[#fafbfd] touch-none"
                  style={{ maxWidth: graphLayout ? graphLayout.dims.width : 720 }}
                  onWheel={onWheelZoom}
                  onPointerDown={onPanStart}
                  onPointerMove={onPanMove}
                  onPointerUp={onPanEnd}
                  onPointerLeave={onPanEnd}
                >
                  <svg
                    viewBox={`0 0 ${graphLayout?.dims.width ?? 720} ${graphLayout?.dims.height ?? 440}`}
                    className="w-full select-none"
                  >
                    <defs>
                      <marker
                        id="graph-arrow-supplier"
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="#2b6cb0" fillOpacity={0.75} />
                      </marker>
                      <marker
                        id="graph-arrow-customer"
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path d="M0,0 L8,4 L0,8 Z" fill="#2f855a" fillOpacity={0.75} />
                      </marker>
                    </defs>
                    <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                  {center && graphLayout ? (
                    <text
                      x={graphLayout.dims.width / 2}
                      y={graphLayout.centerTitleY}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-text font-medium pointer-events-none"
                      style={{ fontSize: 13 }}
                    >
                      {graphLayout.centerTitle}
                    </text>
                  ) : null}
                  {center && graphLayout
                    ? displayEdges.map((de) => {
                        const cpNode = nodeById.get(de.counterpartyId)
                        const segs = graphLayout.edgeSegments.filter((s) => s.displayEdgeKey === de.key)
                        if (segs.length === 0) return null
                        return (
                          <g
                            key={de.key}
                            onMouseEnter={() =>
                              setHover({
                                kind: 'edge',
                                edge: de,
                                counterpartyLabel: cpNode?.label || de.counterpartyId,
                              })
                            }
                            onMouseLeave={() => setHover(null)}
                          >
                            {segs.map((seg) => {
                              const labelLayout = graphLayout.edgeLabelLayout.get(seg.key)
                              const color = segmentEdgeColor(seg.kind)
                              const marker =
                                seg.kind === 'purchase'
                                  ? 'url(#graph-arrow-supplier)'
                                  : 'url(#graph-arrow-customer)'
                              return (
                                <g key={seg.key}>
                                  <line
                                    x1={seg.from.x}
                                    y1={seg.from.y}
                                    x2={seg.to.x}
                                    y2={seg.to.y}
                                    stroke={color}
                                    strokeWidth={seg.bothDirections ? 1.5 : 1.75}
                                    strokeOpacity={0.65}
                                    markerEnd={marker}
                                  />
                                  <line
                                    x1={seg.from.x}
                                    y1={seg.from.y}
                                    x2={seg.to.x}
                                    y2={seg.to.y}
                                    stroke="transparent"
                                    strokeWidth={14}
                                    pointerEvents="stroke"
                                  />
                                  {labelLayout ? (
                                    <GraphEdgeLabel
                                      x={labelLayout.pt.x}
                                      y={labelLayout.pt.y}
                                      text={seg.line}
                                      fontSize={GRAPH_FONT_EDGE}
                                      color={color}
                                      angle={seg.lineAngle}
                                    />
                                  ) : null}
                                </g>
                              )
                            })}
                          </g>
                        )
                      })
                    : null}
                  {nodes.map((n) => {
                    const placement = graphLayout?.positions.get(n.id)
                    if (!placement) return null
                    const fill = nodeDotFill(n)
                    const highlighted = isHighlightedNode(n)
                    const labelLayout = graphLayout?.nodeLabels.get(n.id)
                    return (
                      <g key={n.id}>
                        <g
                          className="cursor-pointer outline-none focus-visible:outline-none"
                          onClick={() => onNodeClick(n)}
                          onMouseEnter={() => setHover({ kind: 'node', node: n })}
                          onMouseLeave={() => setHover(null)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') onNodeClick(n)
                          }}
                        >
                          <title>{n.label || n.id}</title>
                          <circle
                            cx={placement.x}
                            cy={placement.y}
                            r={NODE_HIT_R}
                            fill="transparent"
                            className="focus-visible:outline-none"
                          />
                          <circle
                            cx={placement.x}
                            cy={placement.y}
                            r={placement.r}
                            fill={fill}
                            stroke="#ffffff"
                            strokeWidth={1.5}
                            className="focus-visible:outline-none"
                          />
                          {highlighted ? (
                            <circle
                              cx={placement.x}
                              cy={placement.y}
                              r={placement.r + 5}
                              fill="none"
                              stroke="#d97706"
                              strokeWidth={1.5}
                              strokeOpacity={0.7}
                              pointerEvents="none"
                            />
                          ) : null}
                        </g>
                        {labelLayout ? (
                          <text
                            x={labelLayout.x}
                            y={labelLayout.y}
                            textAnchor={labelLayout.anchor}
                            dominantBaseline="middle"
                            className="fill-text pointer-events-none"
                            style={{ fontSize: GRAPH_FONT_NODE }}
                          >
                            {labelLayout.text}
                          </text>
                        ) : null}
                      </g>
                    )
                  })}
                    </g>
                  </svg>
                </div>
                <p className="mt-2 min-h-[1.25rem] text-il-meta text-text-2" aria-live="polite">
                  {hoverDetail}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-il-soon text-text-3">
                  <span>{ui.legendCenter}</span>
                  <span>{ui.legendEdgePurchase}</span>
                  <span>{ui.legendEdgeSales}</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#e53e3e]" /> {ui.legendShell}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#dd6b20]" /> {ui.legendCircular}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-[#805ad5]" /> {ui.legendConfirmed}
                  </span>
                </div>
              </>
            ) : null}
          </>
        )}
      </Card>
    </div>
    {shellProps ? <FlagAnalysisShell {...shellProps} /> : null}
    </Fragment>
  )
}
