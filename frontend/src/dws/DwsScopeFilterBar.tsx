import type { DwsEntityOption } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { DwsScopeMode, OrgScopeFlatNode } from './useDwsAnalysisScope'

const fieldInputCls =
  'h-9 w-full rounded-sm border border-border bg-white px-2.5 text-il-page-desc text-text outline-none focus:border-accent'

function scopeFilterGridCols(showMin: boolean, isOrgScope: boolean): string {
  if (isOrgScope) {
    return showMin
      ? 'lg:grid-cols-[7.5rem_10.5rem_9rem_minmax(10rem,1fr)_minmax(0,1.5fr)] xl:grid-cols-[8rem_11rem_10rem_minmax(12rem,1.2fr)_minmax(0,2fr)]'
      : 'lg:grid-cols-[7.5rem_10.5rem_minmax(10rem,1fr)_minmax(0,1.5fr)] xl:grid-cols-[8rem_11rem_minmax(12rem,1.2fr)_minmax(0,2fr)]'
  }
  return showMin
    ? 'lg:grid-cols-[7.5rem_10.5rem_9rem_minmax(0,1fr)] xl:grid-cols-[8rem_11rem_10rem_minmax(16rem,1fr)]'
    : 'lg:grid-cols-[7.5rem_10.5rem_minmax(0,1fr)] xl:grid-cols-[8rem_11rem_minmax(16rem,1fr)]'
}

export function DwsScopeFilterBar(props: {
  effectiveYear: string
  yearOptions: string[]
  onYearChange: (y: string) => void
  scopeMode: DwsScopeMode
  onScopeModeChange: (mode: DwsScopeMode) => void
  scopeEntityId: string
  onScopeEntityIdChange: (id: string) => void
  orgFlatNodes: OrgScopeFlatNode[]
  orgTreeLoading?: boolean
  entityId: string
  onEntityChange: (id: string) => void
  entityOptions: DwsEntityOption[]
  requireEntity?: boolean
  showMinInvoiceCount?: boolean
  minInvoiceCount?: number | null
  onMinInvoiceCountChange?: (n: number) => void
}) {
  const ui = t.dwsDashboardUi
  const isOrgScope = props.scopeMode === 'org_mg' || props.scopeMode === 'org_eq'
  const showMin = props.showMinInvoiceCount === true
  const gridCls = ['grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2', scopeFilterGridCols(showMin, isOrgScope)].join(' ')

  return (
    <div className="space-y-2">
      <div className={gridCls}>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-il-label font-medium text-text-2">{ui.statYearLabel}</span>
          <select
            className={fieldInputCls}
            value={props.effectiveYear}
            onChange={(e) => props.onYearChange(e.target.value)}
          >
            {props.yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-il-label font-medium text-text-2">{ui.scopeModeLabel}</span>
          <select
            className={fieldInputCls}
            value={props.scopeMode}
            onChange={(e) => props.onScopeModeChange(e.target.value as DwsScopeMode)}
          >
            <option value="entity">{ui.scopeModeEntity}</option>
            <option value="org_mg">{ui.scopeModeOrgMg}</option>
            <option value="org_eq">{ui.scopeModeOrgEq}</option>
          </select>
        </label>

        {showMin ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-il-label font-medium text-text-2">{ui.minInvoiceCountLabel}</span>
            <input
              type="number"
              min={1}
              max={10000}
              className={fieldInputCls}
              value={props.minInvoiceCount ?? ''}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                if (Number.isFinite(n) && n >= 1 && n <= 10000) {
                  props.onMinInvoiceCountChange?.(n)
                }
              }}
            />
          </label>
        ) : null}

        {isOrgScope ? (
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <span className="text-il-label font-medium text-text-2">
              {ui.scopeOrgNodeLabel}
              <span className="text-danger"> *</span>
            </span>
            <select
              className={fieldInputCls}
              value={props.scopeEntityId}
              onChange={(e) => props.onScopeEntityIdChange(e.target.value)}
              disabled={props.orgTreeLoading}
            >
              <option value="">{ui.scopeOrgNodePlaceholder}</option>
              {props.orgFlatNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <span className="text-il-label font-medium text-text-2">
              {ui.entityLabel}
              {props.requireEntity ? <span className="text-danger"> *</span> : null}
            </span>
            <select
              className={fieldInputCls}
              value={props.entityId}
              onChange={(e) => props.onEntityChange(e.target.value)}
            >
              <option value="">
                {props.requireEntity ? ui.entityPlaceholderRequired : ui.entityPlaceholderAll}
              </option>
              {props.entityOptions.map((o) => (
                <option key={o.entity_id} value={o.entity_id}>
                  {o.entity_name || o.entity_id}
                </option>
              ))}
            </select>
          </label>
        )}

        {isOrgScope ? (
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <span className="text-il-label font-medium text-text-2">{ui.entityLabel}</span>
            <select
              className={fieldInputCls}
              value={props.entityId}
              onChange={(e) => props.onEntityChange(e.target.value)}
              disabled={!props.scopeEntityId.trim() || props.orgTreeLoading}
            >
              <option value="">{ui.scopeOrgEntityOptionalHint}</option>
              {props.entityOptions.map((o) => (
                <option key={o.entity_id} value={o.entity_id}>
                  {o.entity_name || o.entity_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {showMin ? (
        <p className="text-il-meta leading-relaxed text-text-3">{ui.minInvoiceCountSettingsHint}</p>
      ) : null}
    </div>
  )
}
