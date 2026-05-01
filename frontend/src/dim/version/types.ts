export type VersionStatus = 'draft' | 'published' | 'archived'
export type DetailTab = 'definition' | 'impact' | 'diff' | 'log'

export type DimVersion = {
  id: string
  statYear: string
  versionNo: number
  status: VersionStatus
  isCurrent: boolean
  ruleVersion: string
  batchStart: string
  batchEnd: string
  includeExternalImport: boolean
  externalImportBatchCount: number
  changeNote: string
  updatedAt: string
  updatedBy: string
  publishedAt?: string
  publishedBy?: string
  kpis: {
    subjectTotal: number
    enterpriseRatio: number
    mappingCoverage: number
    unmatchedCount: number
  }
}

export type DiffRow = { metric: string; prev: number; curr: number }
