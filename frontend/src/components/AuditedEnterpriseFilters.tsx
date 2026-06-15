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
}

export function AuditedEnterpriseFilters(props: AuditedEnterpriseFiltersProps) {
  const gridCls = props.hideStateInvestor
    ? 'mb-3 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end'
    : 'mb-3 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end'
  return (
    <div className={gridCls}>
      <label className="text-il-label text-text-2">
        <div className="mb-1 text-text-3">{props.yearLabel}</div>
        <select
          className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text"
          value={props.selectedYear}
          onChange={(event) => props.onYearChange(event.target.value)}
        >
          <option value={props.yearAllLabel}>{props.yearAllLabel}</option>
          {props.years.map((year) => (
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
          className="h-9 w-full rounded-sm border border-border-light bg-white px-2 text-il-page-desc text-text placeholder:text-text-3"
          value={props.enterpriseKeyword}
          placeholder={props.enterprisePlaceholder}
          onChange={(event) => props.onEnterpriseKeywordChange(event.target.value)}
        />
      </label>

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
