import type { DwsEntityOption } from '../config/localApi'
import { SearchableCombobox } from '../components/SearchableCombobox'
import { zhCN as t } from '../copy/zh-CN'
import { DwsMemberExclusionPanel } from './DwsMemberExclusionPanel'
import type { AnalysisOrgScopeMember } from '../config/localApi'
import type { DwsScopeMode, OrgScopeFlatNode } from './useDwsAnalysisScope'

const fieldInputCls =
  'h-9 w-full rounded-sm border border-border bg-white px-2.5 text-il-page-desc text-text outline-none focus:border-accent'

function toComboboxOptions(items: { entity_id: string; entity_name: string; label?: string }[]) {
  return items.map((o) => ({
    value: o.entity_id,
    label: o.label ?? (o.entity_name ? `${o.entity_name} · ${o.entity_id}` : o.entity_id),
    searchText: `${o.entity_name} ${o.entity_id}`,
  }))
}

export function DwsOrgSubtreeFilterBar(props: {
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
  orgMembers: AnalysisOrgScopeMember[]
  orgMembersLoading?: boolean
  excludedEntityIds: string[]
  onExcludedEntityIdsChange: (ids: string[]) => void
}) {
  const ui = t.dwsDashboardUi
  const isOrgScope = props.scopeMode === 'org_mg' || props.scopeMode === 'org_eq'

  const orgNodeOptions = props.orgFlatNodes.map((n) => ({
    entity_id: n.id,
    entity_name: n.name,
    label: n.label,
  }))

  return (
    <div className="space-y-3">
      <div
        className={[
          'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2',
          isOrgScope
            ? 'lg:grid-cols-[7.5rem_10.5rem_minmax(12rem,1.2fr)_minmax(12rem,1.2fr)] xl:grid-cols-[8rem_11rem_minmax(14rem,1.2fr)_minmax(14rem,1.2fr)]'
            : 'lg:grid-cols-[7.5rem_10.5rem_minmax(0,1fr)] xl:grid-cols-[8rem_11rem_minmax(16rem,1fr)]',
        ].join(' ')}
      >
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

        {isOrgScope ? (
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <span className="text-il-label font-medium text-text-2">
              {ui.scopeOrgNodeLabel}
              <span className="text-danger"> *</span>
            </span>
            <SearchableCombobox
              options={toComboboxOptions(orgNodeOptions)}
              value={props.scopeEntityId}
              onChange={props.onScopeEntityIdChange}
              placeholder={ui.scopeOrgNodePlaceholder}
              disabled={props.orgTreeLoading}
              allowEmpty
              emptyLabel={ui.scopeOrgNodePlaceholder}
            />
          </label>
        ) : (
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <span className="text-il-label font-medium text-text-2">
              {ui.entityLabel}
              {props.requireEntity ? <span className="text-danger"> *</span> : null}
            </span>
            <SearchableCombobox
              options={toComboboxOptions(props.entityOptions)}
              value={props.entityId}
              onChange={props.onEntityChange}
              placeholder={props.requireEntity ? ui.entityPlaceholderRequired : ui.entityPlaceholderAll}
              allowEmpty={!props.requireEntity}
              emptyLabel={props.requireEntity ? ui.entityPlaceholderRequired : ui.entityPlaceholderAll}
            />
          </label>
        )}

        {isOrgScope ? (
          <label className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <span className="text-il-label font-medium text-text-2">{ui.entityLabel}</span>
            <SearchableCombobox
              options={toComboboxOptions(props.entityOptions)}
              value={props.entityId}
              onChange={props.onEntityChange}
              placeholder={ui.scopeOrgEntityOptionalHint}
              disabled={!props.scopeEntityId.trim() || props.orgTreeLoading}
              allowEmpty
              emptyLabel={ui.scopeOrgEntityOptionalHint}
            />
          </label>
        ) : null}
      </div>

      {isOrgScope && props.scopeEntityId.trim() ? (
        <DwsMemberExclusionPanel
          members={props.orgMembers}
          excludedEntityIds={props.excludedEntityIds}
          onExcludedChange={props.onExcludedEntityIdsChange}
          loading={props.orgMembersLoading}
        />
      ) : null}
    </div>
  )
}
