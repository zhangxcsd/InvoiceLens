import { useMemo, type RefObject } from 'react'
import { buildStatYearOptions } from '../utils/statYearOptions'

type AuditedEnterpriseFiltersProps = {
  yearLabel: string
  yearAllLabel: string
  years: string[]
  selectedYear: string
  onYearChange: (value: string) => void
  stateInvestorLabel: string
  stateInvestorAllLabel: string
  stateInvestorOptions: string[]
  selectedStateInvestor: string
  onStateInvestorChange: (value: string) => void
  enterpriseLabel: string
  enterprisePlaceholder: string
  enterpriseKeyword: string
  onEnterpriseKeywordChange: (value: string) => void
  resetLabel: string
  canReset: boolean
  onReset: () => void
  hideStateInvestor?: boolean
  relationTypeLabel?: string
  relationTypeAllLabel?: string
  relationTypeOptions?: string[]
  selectedRelationType?: string
  onRelationTypeChange?: (value: string) => void
  matchStatusLabel?: string
  matchStatusAllLabel?: string
  matchStatusOptions?: string[]
  selectedMatchStatus?: string
  onMatchStatusChange?: (value: string) => void
  inAnalysisPoolLabel?: string
  inAnalysisPoolOnly?: boolean
  onInAnalysisPoolOnlyChange?: (value: boolean) => void
  enterpriseInputRef?: RefObject<HTMLInputElement | null>
}

export function AuditedEnterpriseFilters(props: AuditedEnterpriseFiltersProps) {
  const yearOptions = useMemo(() => buildStatYearOptions(props.years), [props.years])
  const showRelationType = Boolean(props.relationTypeLabel && props.onRelationTypeChange)
  const showMatchStatus = Boolean(props.matchStatusLabel && props.onMatchStatusChange)
  const showInAnalysisPool = Boolean(props.inAnalysisPoolLabel && props.onInAnalysisPoolOnlyChange)

  return (
    <div className="mb-3 grid gap-3 md:grid-cols-[repeat(auto-fit,minmax(160px,1fr))] md:items-end">
      <label className="text-il-label text-text-2">
        <div className="mb-1 text-text-3">{props.yearLabel}</div>
        <select
          className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text"
          value={props.selectedYear}
          onChange={(event) => props.onYearChange(event.target.value)}
        >
          <option value={props.yearAllLabel}>{props.yearAllLabel}</option>
          {yearOptions.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </label>

      {props.hideStateInvestor ? null : (
        <label className="text-il-label text-text-2">
          <div className="mb-1 text-text-3">{props.stateInvestorLabel}</div>
          <select
            className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text"
            value={props.selectedStateInvestor}
            onChange={(event) => props.onStateInvestorChange(event.target.value)}
          >
            <option value={props.stateInvestorAllLabel}>{props.stateInvestorAllLabel}</option>
            {props.stateInvestorOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="text-il-label text-text-2">
        <div className="mb-1 text-text-3">{props.enterpriseLabel}</div>
        <input
          ref={props.enterpriseInputRef}
          data-testid={props.enterpriseInputRef ? 'org-tree-enterprise-filter' : undefined}
          className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text placeholder:text-text-3"
          value={props.enterpriseKeyword}
          placeholder={props.enterprisePlaceholder}
          onChange={(event) => props.onEnterpriseKeywordChange(event.target.value)}
        />
      </label>

      {showRelationType ? (
        <label className="text-il-label text-text-2">
          <div className="mb-1 text-text-3">{props.relationTypeLabel}</div>
          <select
            className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text"
            value={props.selectedRelationType ?? props.relationTypeAllLabel}
            onChange={(event) => props.onRelationTypeChange?.(event.target.value)}
          >
            <option value={props.relationTypeAllLabel}>{props.relationTypeAllLabel}</option>
            {(props.relationTypeOptions ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {showMatchStatus ? (
        <label className="text-il-label text-text-2">
          <div className="mb-1 text-text-3">{props.matchStatusLabel}</div>
          <select
            className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text"
            value={props.selectedMatchStatus ?? props.matchStatusAllLabel}
            onChange={(event) => props.onMatchStatusChange?.(event.target.value)}
          >
            <option value={props.matchStatusAllLabel}>{props.matchStatusAllLabel}</option>
            {(props.matchStatusOptions ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {showInAnalysisPool ? (
        <label className="flex h-9 items-center gap-2 self-end text-il-label text-text-2">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border-light text-accent focus:ring-accent"
            checked={props.inAnalysisPoolOnly ?? false}
            onChange={(event) => props.onInAnalysisPoolOnlyChange?.(event.target.checked)}
          />
          {props.inAnalysisPoolLabel}
        </label>
      ) : null}

      <button
        type="button"
        className={[
          'h-9 rounded-sm border px-3 text-il-page-desc transition-colors',
          props.canReset
            ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]'
            : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
        ].join(' ')}
        disabled={!props.canReset}
        onClick={props.onReset}
      >
        {props.resetLabel}
      </button>
    </div>
  )
}
