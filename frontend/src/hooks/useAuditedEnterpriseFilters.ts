import { useMemo, useState } from 'react'

type FilterLabels = {
  yearAll: string
  stateInvestorAll: string
}

type FilterableEnterprise = {
  name: string
  snapshotYear: string
  stateInvestorEnterprise: string
}

export function useAuditedEnterpriseFilters<T extends FilterableEnterprise>(
  rows: T[],
  labels: FilterLabels,
) {
  const [selectedYear, setSelectedYear] = useState<string>(labels.yearAll)
  const [selectedStateInvestor, setSelectedStateInvestor] = useState<string>(labels.stateInvestorAll)
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')

  const years = useMemo(
    () => Array.from(new Set(rows.map((row) => row.snapshotYear))).sort((a, b) => Number(b) - Number(a)),
    [rows],
  )
  const stateInvestorEnterprises = useMemo(
    () =>
      Array.from(new Set(rows.map((row) => row.stateInvestorEnterprise))).sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const yearMatched = selectedYear === labels.yearAll || row.snapshotYear === selectedYear
        const investorMatched =
          selectedStateInvestor === labels.stateInvestorAll || row.stateInvestorEnterprise === selectedStateInvestor
        const enterpriseMatched =
          enterpriseKeyword.trim().length === 0 || row.name.toLowerCase().includes(enterpriseKeyword.trim().toLowerCase())
        return yearMatched && investorMatched && enterpriseMatched
      }),
    [enterpriseKeyword, labels.stateInvestorAll, labels.yearAll, rows, selectedStateInvestor, selectedYear],
  )

  const canReset =
    selectedYear !== labels.yearAll ||
    selectedStateInvestor !== labels.stateInvestorAll ||
    enterpriseKeyword.trim().length > 0

  const resetFilters = () => {
    if (!canReset) return
    setSelectedYear(labels.yearAll)
    setSelectedStateInvestor(labels.stateInvestorAll)
    setEnterpriseKeyword('')
  }

  return {
    selectedYear,
    setSelectedYear,
    selectedStateInvestor,
    setSelectedStateInvestor,
    enterpriseKeyword,
    setEnterpriseKeyword,
    years,
    stateInvestorEnterprises,
    filteredRows,
    canReset,
    resetFilters,
  }
}
