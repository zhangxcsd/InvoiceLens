import { zhCN as t } from '../copy/zh-CN'

export type TaxTreeRow = {
  taxCode: string
  displayTaxCode?: string
  aggregateCount?: number
  goodsName: string
  goodsShortName: string
  description: string
  parentCode: string | null
  levelDepth: number
  isLeaf: boolean
  cleanStatus: 'ok' | 'invalid' | 'duplicate'
  auditRiskLabel: 'NORMAL' | 'HIGH'
}

export const TREE_UI_CONST = {
  INDENT_STEP_PX: 18,
  INDENT_BASE_PX: 6,
} as const

export function TaxTreeGrid(props: {
  roots: TaxTreeRow[]
  childMap: Map<string, TaxTreeRow[]>
  byCode: Map<string, TaxTreeRow>
  expanded: Set<string>
  onToggleExpand: (taxCode: string) => void
  /** 编码树：goods_name；分类树：goods_short_name（拓扑仍由 parent_code 决定） */
  nodeTitleField?: 'goodsName' | 'goodsShortName'
  hideDuplicateTitleWithParent?: boolean
  showInlineTaxCode?: boolean
  compareColumns?: Array<'goodsShortName' | 'taxCode' | 'goodsName' | 'description'>
  cleanStatusLabel: (v: 'ok' | 'invalid' | 'duplicate') => string
  rowStatusTone: (row: TaxTreeRow) => 'invalid' | 'duplicate' | 'high' | 'ok'
}) {
  const ui = t.taxCodeLibraryUi
  const nodeTitleField = props.nodeTitleField ?? 'goodsName'
  const hideDuplicateTitleWithParent = props.hideDuplicateTitleWithParent ?? false
  const showInlineTaxCode = props.showInlineTaxCode ?? true
  const compareColumns = props.compareColumns ?? ['goodsShortName', 'description']
  const columnClass: Record<'goodsShortName' | 'taxCode' | 'goodsName' | 'description', string> = {
    goodsShortName: 'min-w-[140px] w-[18%] max-w-[260px]',
    taxCode: 'min-w-[220px] w-[22%] max-w-[360px]',
    goodsName: 'min-w-[260px] w-[26%] max-w-[420px]',
    description: 'min-w-[220px] w-[30%] max-w-[560px]',
  }
  const columnValue = (row: TaxTreeRow, col: 'goodsShortName' | 'taxCode' | 'goodsName' | 'description') => {
    if (col === 'goodsShortName') return String(row.goodsShortName ?? '').trim() || '（未分类）'
    if (col === 'taxCode') return String(row.displayTaxCode ?? row.taxCode)
    if (col === 'goodsName') return row.goodsName
    return String(row.description ?? '').trim() || '无'
  }
  const aggregateText = (row: TaxTreeRow) => {
    const n = Number(row.aggregateCount ?? 0)
    return Number.isFinite(n) && n > 1 ? `${Math.trunc(n)}个编码` : ''
  }
  const nodeTitle = (row: TaxTreeRow) =>
    nodeTitleField === 'goodsShortName'
      ? (String(row.goodsShortName ?? '').trim() || row.goodsName || '（未分类）')
      : row.goodsName

  function Node({ row, depth, parentTitle }: { row: TaxTreeRow; depth: number; parentTitle?: string }) {
    const kids = props.childMap.get(row.taxCode) ?? []
    const hasKids = kids.length > 0
    const open = !hasKids || props.expanded.has(row.taxCode)
    const orphan = Boolean(row.parentCode && !props.byCode.has(row.parentCode))
    const tone = props.rowStatusTone(row)
    const titleText = nodeTitle(row)
    const duplicatedWithParent = hideDuplicateTitleWithParent && !!parentTitle && parentTitle === titleText
    const dotCls =
      tone === 'invalid'
        ? 'bg-warn'
        : tone === 'duplicate'
          ? 'bg-[#6b5cb3]'
          : tone === 'high'
            ? 'bg-danger'
            : 'bg-[#2e9b57]'
    const nameCls =
      tone === 'invalid'
        ? 'text-warn'
        : tone === 'duplicate'
          ? 'text-[#5a4aa8]'
          : tone === 'high'
            ? 'text-danger'
            : 'text-text'

    return (
      <li className="relative list-none">
        <div
          className={[
            'group relative flex min-h-[30px] items-start gap-1.5 border-b border-border-light py-1 pr-1.5 text-[13px] leading-tight text-text transition-colors',
            'hover:bg-[#f5f7fa]',
          ].join(' ')}
        >
          {depth > 0 ? (
            <span
              aria-hidden
              data-testid="tree-connector-h"
              className="absolute border-t border-border-light"
              style={{
                left: TREE_UI_CONST.INDENT_BASE_PX + depth * TREE_UI_CONST.INDENT_STEP_PX - 12,
                top: 16,
                width: 12,
              }}
            />
          ) : null}
          <div
            className="relative min-w-0 flex flex-1 items-start gap-1.5 leading-tight"
            style={{ paddingLeft: TREE_UI_CONST.INDENT_BASE_PX + depth * TREE_UI_CONST.INDENT_STEP_PX }}
          >
            {Array.from({ length: Math.max(0, depth) }).map((_, idx) => (
              <span
                key={`tree_col_line_${row.taxCode}_${idx}`}
                aria-hidden
                data-testid="tree-connector-v"
                className="pointer-events-none absolute top-[-8px] bottom-[-8px] border-l border-border-light"
                style={{ left: idx * TREE_UI_CONST.INDENT_STEP_PX + TREE_UI_CONST.INDENT_BASE_PX }}
              />
            ))}
            {hasKids ? (
              <button
                type="button"
                aria-expanded={open}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-transparent text-[9px] text-text-3 hover:border-border hover:bg-white"
                onClick={() => props.onToggleExpand(row.taxCode)}
              >
                <span className={['inline-block transition-transform', open ? 'rotate-90' : ''].join(' ')} aria-hidden>
                  ▶
                </span>
              </button>
            ) : (
              <span className="inline-block w-4 shrink-0" aria-hidden />
            )}
            <span
              className={['inline-block h-[5px] w-[5px] shrink-0 rounded-full', dotCls].join(' ')}
              title={`${props.cleanStatusLabel(row.cleanStatus as 'ok' | 'invalid' | 'duplicate')} · ${row.auditRiskLabel}`}
            />
            <div className="min-w-0 flex-1">
              {!duplicatedWithParent ? (
                <>
                  <span className={['text-[12px]', 'font-medium', nameCls].join(' ')}>{titleText}</span>
                  {showInlineTaxCode ? <span className="ml-1 font-mono text-[12px] text-text-2">{row.taxCode}</span> : null}
                  <span className="ml-1 text-[12px] text-text-3">
                    （{ui.hierarchyRowLevelPrefix} {row.levelDepth}
                    {row.isLeaf ? ` · ${ui.leafYes}` : ` · ${ui.leafNo}`}）
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-text-3/80">同上</span>
              )}
              {orphan ? (
                <span className="ml-1 rounded border border-[#c8dff7] bg-[#f0f7ff] px-0.5 py-px text-[10px] font-semibold leading-none text-accent">
                  {ui.hierarchyLegendOrphan}
                </span>
              ) : null}
              {aggregateText(row) ? (
                <span className="ml-1 rounded border border-border-light bg-[#f7f9fc] px-1 py-px text-[10px] font-semibold leading-none text-text-3">
                  {aggregateText(row)}
                </span>
              ) : null}
            </div>
          </div>
          {compareColumns.map((col) => {
            const value = columnValue(row, col)
            const textCls =
              col === 'description' && !String(row.description ?? '').trim() ? 'text-text-3/70' : 'text-text-2'
            return (
              <div
                key={`${row.taxCode}_${col}`}
                className={[columnClass[col], 'border-l border-border-light pl-3 text-[11px] leading-snug', textCls].join(' ')}
                title={value}
              >
                <span className="block truncate">{value}</span>
              </div>
            )
          })}
        </div>
        {hasKids && open ? (
          <ul className="relative">
            {kids.map((c) => (
              <Node key={c.taxCode} row={c} depth={depth + 1} parentTitle={titleText} />
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <ul className="m-0 p-0">
      {props.roots.map((r) => (
        <Node key={r.taxCode} row={r} depth={0} />
      ))}
    </ul>
  )
}

