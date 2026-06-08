import type { DwsEntityOption } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

const fieldInputCls =
  'h-9 w-full rounded-sm border border-border bg-white px-2.5 text-il-page-desc text-text outline-none focus:border-accent'

export function DwsFilterBar(props: {
  effectiveYear: string
  yearOptions: string[]
  onYearChange: (y: string) => void
  entityId: string
  onEntityChange: (id: string) => void
  entityOptions: DwsEntityOption[]
  requireEntity?: boolean
  showEntity?: boolean
  showMinInvoiceCount?: boolean
  minInvoiceCount?: number | null
  onMinInvoiceCountChange?: (n: number) => void
}) {
  const ui = t.dwsDashboardUi
  const showEntity = props.showEntity !== false
  const colCount = (props.showMinInvoiceCount ? 1 : 0) + (showEntity ? 1 : 0) + 1
  const gridCols =
    colCount >= 3
      ? 'sm:grid-cols-[7.5rem_9rem_minmax(0,1fr)] lg:grid-cols-[8rem_10rem_minmax(16rem,1fr)]'
      : showEntity
        ? 'sm:grid-cols-[7.5rem_minmax(0,1fr)] lg:grid-cols-[8rem_minmax(16rem,1fr)]'
        : 'sm:grid-cols-[7.5rem]'

  return (
    <div className="space-y-2">
      <div className={['grid grid-cols-1 gap-x-4 gap-y-3', gridCols].join(' ')}>
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
        {props.showMinInvoiceCount ? (
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
        {showEntity ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-il-label font-medium text-text-2">
              {ui.entityLabel}
              {props.requireEntity ? <span className="text-danger"> *</span> : null}
            </span>
            <select
              className={fieldInputCls}
              value={props.entityId}
              onChange={(e) => props.onEntityChange(e.target.value)}
            >
              <option value="">{props.requireEntity ? ui.entityPlaceholderRequired : ui.entityPlaceholderAll}</option>
              {props.entityOptions.map((o) => (
                <option key={o.entity_id} value={o.entity_id}>
                  {o.entity_name || o.entity_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {props.showMinInvoiceCount ? (
        <p className="text-il-meta leading-relaxed text-text-3">{ui.minInvoiceCountSettingsHint}</p>
      ) : null}
    </div>
  )
}
