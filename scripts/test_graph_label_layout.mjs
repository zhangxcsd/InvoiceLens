/** 关联图谱边标签布局自检（7 节点星形，模拟双向边） */
const GRAPH_FONT_EDGE = 11
const EDGE_LABEL_SIDE_OFFSET = 32
const EDGE_LABEL_MIN_LINE_CLEARANCE = 12
const BIDIR_LINE_OFFSET = 7
const LABEL_AUDIT_MAX_ROUNDS = 10
const CENTER_NODE_R = 9
const PERIPH_NODE_R = 6

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * 0.62
}
function estimateInlineLabelSize(text, fontSize) {
  return { w: estimateTextWidth(text, fontSize) + 4, h: fontSize + 6 }
}
function perpOffset(from, to, px) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  return { ox: (-dy / len) * px, oy: (dx / len) * px }
}
function labelPosAlongEdge(from, to, t) {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}
function boxesOverlap(a, b, pad = 5) {
  return (
    a.cx - a.w / 2 - pad < b.cx + b.w / 2 + pad &&
    a.cx + a.w / 2 + pad > b.cx - b.w / 2 - pad &&
    a.cy - a.h / 2 - pad < b.cy + b.h / 2 + pad &&
    a.cy + a.h / 2 + pad > b.cy - b.h / 2 - pad
  )
}
function overlapsAny(box, others) {
  return others.some((b) => boxesOverlap(box, b))
}
function distPointToSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
function segmentLabelBox(pt, line, angleDeg = 0) {
  const { w, h } = estimateInlineLabelSize(line, GRAPH_FONT_EDGE)
  const tw = w * 0.9
  const th = h * 0.9
  if (Math.abs(angleDeg) < 0.5) return { cx: pt.x, cy: pt.y, w: tw + 6, h: th + 4 }
  const rad = (Math.abs(angleDeg) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return { cx: pt.x, cy: pt.y, w: tw * cos + th * sin + 6, h: tw * sin + th * cos + 4 }
}
function segmentLabelStrategy(kind, bothDirections, layoutIndex, cpAngle, escalation = 0, splitSibling = false) {
  const sideFlip = (Math.sin(cpAngle * 1.7) >= 0 ? 1 : -1) * (layoutIndex % 2 === 0 ? 1 : -1)
  const escAlong = escalation * 0.04
  const along = splitSibling ? 0.1 + escAlong : 0.12 + (layoutIndex % 3) * 0.012 + escAlong
  if (bothDirections) {
    if (kind === 'purchase') return { preferNear: 'from', side: -1 * sideFlip, tAnchor: along }
    if (layoutIndex % 2 === 1) return { preferNear: 'to', side: 1 * sideFlip, tAnchor: along }
    return { preferNear: 'from', side: 1 * sideFlip, tAnchor: along }
  }
  if (kind === 'purchase') return { preferNear: 'from', side: -1, tAnchor: 0.36 + escAlong }
  return { preferNear: 'to', side: 1, tAnchor: 0.64 + escAlong }
}
function segmentLineAngle(from, to) {
  let deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
  if (deg > 90) deg -= 180
  if (deg < -90) deg += 180
  return deg
}
function trimSegment(from, to, trimFrom, trimTo) {
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
function isLabelClearOfLine(pt, from, to) {
  return distPointToSegment(pt, from, to) >= EDGE_LABEL_MIN_LINE_CLEARANCE
}
function resolveSegmentLabelPos(from, to, line, avoid, base, escalation = 0, lineAngle = segmentLineAngle(from, to)) {
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
  const sideOffsets = [sideOffset, sideOffset + 8, sideOffset + 14, sideOffset - 6].filter((o) => o >= 14)
  const sideCandidates = escalation >= 2 ? [base.side, -base.side] : [base.side]
  for (const t of tValues) {
    for (const off of sideOffsets) {
      for (const side of sideCandidates) {
        const pt = labelPosAlongEdge(from, to, t)
        const placed = { x: pt.x + perp.ox * off * side, y: pt.y + perp.oy * off * side }
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
function auditEdgeLabelLayouts(segments, layouts) {
  const issues = []
  const entries = segments.map((seg) => {
    const layout = layouts.get(seg.key)
    return { seg, layout, box: segmentLabelBox(layout.pt, seg.line, layout.angle) }
  })
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]
    if (!isLabelClearOfLine(a.layout.pt, a.seg.from, a.seg.to)) {
      issues.push({ segmentKey: a.seg.key, reason: 'on-line' })
    }
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]
      if (boxesOverlap(a.box, b.box, 3)) {
        issues.push({ segmentKey: a.seg.key, reason: 'overlap', with: b.seg.key })
      }
    }
  }
  return issues
}
function layoutEdgeLabelLayouts(segments, placedBoxes) {
  const layouts = new Map()
  const segmentBoxes = new Map()
  const escalations = new Map()
  const allBoxes = () => [...placedBoxes, ...segmentBoxes.values()]
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
    for (const key of new Set(issues.map((i) => i.segmentKey))) {
      const seg = segments.find((s) => s.key === key)
      if (!seg) continue
      const nextEsc = (escalations.get(key) ?? 0) + 1
      escalations.set(key, nextEsc)
      segmentBoxes.delete(key)
      const segRef = segments.find((s) => s.key === key)
      const siblingOverlap = issues.some(
        (i) =>
          i.segmentKey === key &&
          i.reason === 'overlap' &&
          i.with != null &&
          segments.find((s) => s.key === i.with)?.displayEdgeKey === segRef?.displayEdgeKey,
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
  return { layouts, issues: auditEdgeLabelLayouts(segments, layouts) }
}

const dims = { width: 1080, height: 640, orbitR: 208, titleH: 40 }
const cx = dims.width / 2
const cy = dims.titleH + (dims.height - dims.titleH) / 2
const centerPos = { x: cx, y: cy }
const cpCount = 7
const segments = []
const placedBoxes = [
  { cx, cy, w: CENTER_NODE_R * 2 + 48, h: CENTER_NODE_R * 2 + 48 },
  { cx, cy, w: dims.orbitR * 0.42, h: dims.orbitR * 0.42 },
]

for (let i = 0; i < cpCount; i++) {
  const angle = (2 * Math.PI * i) / cpCount - Math.PI / 2
  const cpPos = { x: cx + dims.orbitR * Math.cos(angle), y: cy + dims.orbitR * Math.sin(angle) }
  const name = `公司${i}有限公司`
  const nw = estimateTextWidth(name, 10)
  placedBoxes.push({
    cx: cpPos.x + Math.cos(angle) * 20,
    cy: cpPos.y + Math.sin(angle) * 20,
    w: nw + 10,
    h: 16,
  })
  const both = true
  const offset = perpOffset(centerPos, cpPos, BIDIR_LINE_OFFSET)
  for (const kind of ['purchase', 'sales']) {
    const sign = kind === 'purchase' ? -1 : 1
    const rawFrom =
      kind === 'purchase'
        ? { x: cpPos.x + offset.ox * sign, y: cpPos.y + offset.oy * sign }
        : { x: centerPos.x + offset.ox * sign, y: centerPos.y + offset.oy * sign }
    const rawTo =
      kind === 'purchase'
        ? { x: centerPos.x + offset.ox * sign, y: centerPos.y + offset.oy * sign }
        : { x: cpPos.x + offset.ox * sign, y: cpPos.y + offset.oy * sign }
    const trimmed = trimSegment(
      rawFrom,
      rawTo,
      kind === 'purchase' ? PERIPH_NODE_R + 5 : CENTER_NODE_R + 5,
      kind === 'purchase' ? CENTER_NODE_R + 5 : PERIPH_NODE_R + 5,
    )
    const from = { x: trimmed.x1, y: trimmed.y1 }
    const to = { x: trimmed.x2, y: trimmed.y2 }
    const short = kind === 'purchase' ? '进' : '出'
    const amounts = [
      [65508, 895568],
      [0, 168328],
      [40732, 121208],
      [40028, 55808],
      [50000, 200000],
      [60000, 150000],
      [70000, 180000],
    ]
    const amt = (kind === 'purchase' ? amounts[i][0] : amounts[i][1]).toLocaleString('en-US', {
      minimumFractionDigits: 2,
    })
    segments.push({
      key: `cp${i}-${kind}`,
      displayEdgeKey: `cp${i}`,
      kind,
      bothDirections: both,
      layoutIndex: i,
      cpAngle: angle,
      line: `${short} ${amt}`,
      from,
      to,
      lineAngle: segmentLineAngle(from, to),
    })
  }
}

const { layouts, issues } = layoutEdgeLabelLayouts(segments, placedBoxes)

const angleIssues = []
for (const seg of segments) {
  const layout = layouts.get(seg.key)
  if (!layout) continue
  const diff = Math.abs(layout.angle - seg.lineAngle)
  if (diff > 0.01) {
    angleIssues.push({ key: seg.key, layoutAngle: layout.angle, lineAngle: seg.lineAngle })
  }
}

if (angleIssues.length > 0) {
  console.error('FAIL: 标签角度与线段不平行', angleIssues)
  process.exit(1)
}

if (issues.length === 0) {
  console.log('OK: 7 节点双向边标签布局自检通过（0 遮挡，角度对齐）')
  process.exit(0)
}
console.error('FAIL: 布局自检未通过', issues)
process.exit(1)
