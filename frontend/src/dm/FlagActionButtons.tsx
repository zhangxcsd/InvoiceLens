import type { ReactNode } from 'react'
import type { AuditFlagRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { navigateToReportConfig } from '../utils/navHelpers'
import {
  getFlagActionLinks,
  navigateFlagAction,
  reportChaptersForRule,
  type FlagActionLabels,
} from './flagActionHelpers'

type Props = {
  row: AuditFlagRow
  statYear: string
  onNav?: (key: NavKey) => void
  extraBefore?: ReactNode
  extraAfter?: ReactNode
  showReport?: boolean
  className?: string
}

const flagActionLabels: FlagActionLabels = {
  viewFinanceDiffBtn: t.auditFlagUi.viewFinanceDiffBtn,
  viewTaxCodeBtn: t.auditFlagUi.viewTaxCodeBtn,
  viewSemanticDetailBtn: t.auditFlagUi.viewSemanticDetailBtn,
  viewQualityTrendBtn: t.auditFlagUi.viewQualityTrendBtn,
  viewQualityBtn: t.auditTrackUi.viewQualityBtn,
  viewInvoiceBtn: t.auditTrackUi.exportInvoiceBtn,
  viewRelatedPairsBtn: t.auditFlagUi.viewRelatedPairsBtn,
  viewRelatedShellBtn: t.auditFlagUi.viewRelatedShellBtn,
  viewRelatedGraphBtn: t.auditFlagUi.viewRelatedGraphBtn,
  viewTradeRelationshipsBtn: t.auditFlagUi.viewTradeRelationshipsBtn,
  viewSupplierTopBtn: t.auditFlagUi.viewSupplierTopBtn,
  viewSupplierCrBtn: t.auditFlagUi.viewSupplierCrBtn,
  viewOverviewTrendBtn: t.auditFlagUi.viewOverviewTrendBtn,
  viewInvoiceTimingBtn: t.auditFlagUi.viewInvoiceTimingBtn,
  viewRedOffsetBtn: t.auditFlagUi.viewRedOffsetBtn,
  viewTaxInOutDevBtn: t.auditFlagUi.viewTaxInOutDevBtn,
  viewTaxRiskExposureBtn: t.auditFlagUi.viewTaxRiskExposureBtn,
  viewTrackBtn: t.auditFlagUi.viewTrackBtn,
  viewFlagsListBtn: t.auditTrackUi.viewFlagsListBtn,
  genReportBtn: t.auditFlagUi.genReportBtn,
}

export function FlagActionButtons({
  row,
  statYear,
  onNav,
  extraBefore,
  extraAfter,
  showReport = true,
  className = 'flex flex-wrap gap-2',
}: Props) {
  if (!onNav) return null

  const links = getFlagActionLinks(row, statYear, flagActionLabels)
  const btnClass = 'text-accent underline-offset-2 hover:underline'

  return (
    <div className={className}>
      {extraBefore}
      {links.map((link) => (
        <button
          key={link.id}
          type="button"
          className={btnClass}
          onClick={() => navigateFlagAction(onNav, link.id, row, statYear)}
        >
          {link.label}
        </button>
      ))}
      {showReport ? (
        <button
          type="button"
          className={btnClass}
          onClick={() =>
            navigateToReportConfig(onNav, {
              statYear,
              entityId: row.entity_id ?? undefined,
              chapters: reportChaptersForRule(row.rule_id),
            })
          }
        >
          {flagActionLabels.genReportBtn}
        </button>
      ) : null}
      {extraAfter}
    </div>
  )
}
