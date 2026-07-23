/** 组织层级树三 Tab 共用的筛选条件（由 AuditedEnterpriseTreePage 持有）。 */
export type OrgTreeSharedFilters = {
  selectedYear: string
  selectedStateInvestor: string
  enterpriseKeyword: string
  debouncedEnterpriseKeyword: string
  selectedRelationType: string
  selectedMatchStatus: string
  inAnalysisPoolOnly: boolean
  onYearChange: (year: string) => void
  onStateInvestorChange: (value: string) => void
  onEnterpriseKeywordChange: (keyword: string) => void
  onRelationTypeChange: (value: string) => void
  onMatchStatusChange: (value: string) => void
  onInAnalysisPoolOnlyChange: (value: boolean) => void
  onReset: () => void
  canReset: boolean
}
