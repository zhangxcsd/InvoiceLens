import type { ReactNode } from 'react'
import { useEffect } from 'react'
import type { NavKey } from '../types'
import { setActiveEmbedNavQuery } from '../utils/embedNavQuery'
import { setEmbedShellNavigateHandler } from '../utils/embedShellNav'
import { buildNavUrl, openNavInNewTab } from '../utils/navHelpers'
import { EntityProfilePage } from '../dws/EntityProfilePage'
import { FlagsTrackPage } from './FlagsTrackPage'
import { FlagDetailPanel } from './FlagDetailPanel'
import { HealthScorePage } from '../quality/HealthScorePage'
import { TaxRiskExposurePage } from '../dws/TaxRiskExposurePage'
import { RelatedPairsPage } from './RelatedPairsPage'
import { RelatedShellPage } from './RelatedShellPage'
import { TradeRelationshipsPage } from '../dws/TradeRelationshipsPage'
import { FinanceDiffPage } from '../finance/FinanceDiffPage'
import { TaxCodeAnalysisPage } from '../dim/TaxCodeAnalysisPage'
import { TaxCodeEnterpriseAnalysisPage } from '../dim/TaxCodeEnterpriseAnalysisPage'
import { DataQualityOverviewPage } from '../quality/DataQualityOverviewPage'
import { DataQualityDetailPage } from '../quality/DataQualityDetailPage'
import { DataQualityTrendPage } from '../quality/DataQualityTrendPage'
import { OverviewTaxPage } from '../dws/OverviewTaxPage'
import { SupplierNewPage } from '../dws/SupplierNewPage'
import { CounterpartyRiskPage } from '../dws/CounterpartyRiskPage'
import { GoodsCategoryPage } from '../dws/GoodsCategoryPage'
import { YearOverYearComparePage } from '../dws/YearOverYearComparePage'
import { CompareChartsPage } from '../ads/CompareChartsPage'
import { CompareRankPage } from '../ads/CompareRankPage'
import { OverviewTrendPage } from '../dws/OverviewTrendPage'
import { OverviewSummaryPage } from '../dws/OverviewSummaryPage'
import { SupplierTopPage } from '../dws/SupplierTopPage'
import { SupplierCrPage } from '../dws/SupplierCrPage'
import { RedOffsetAnalysisPage } from '../dws/RedOffsetAnalysisPage'
import { InvoiceTimingPage } from '../dws/InvoiceTimingPage'
import { TaxInOutDeviationPage } from '../dws/TaxInOutDeviationPage'
import type { FlagAnalysisHandlers } from './flagAnalysisNavigate'

type Props = {
  nav: NavKey
  params: Record<string, string>
  embedMode?: boolean
  onEmbedNavigate?: (nav: NavKey, params: Record<string, string>) => boolean
  analysisHandlers?: FlagAnalysisHandlers | null
}

function noopOnNav(_nav: NavKey) {
  /* embed 模式下由 navigateWithQuery → embedShell 拦截 */
}

function EmbedPageBody({ children }: { children: ReactNode }) {
  return <div className="min-h-full bg-white/96">{children}</div>
}

export function AnalysisPageHost({
  nav,
  params,
  embedMode = true,
  onEmbedNavigate,
  analysisHandlers = null,
}: Props) {
  setActiveEmbedNavQuery(params)

  useEffect(() => {
    if (!embedMode || !onEmbedNavigate) return
    setEmbedShellNavigateHandler(onEmbedNavigate)
    return () => setEmbedShellNavigateHandler(null)
  }, [embedMode, onEmbedNavigate])

  useEffect(() => () => setActiveEmbedNavQuery(null), [])

  const onNav = embedMode ? noopOnNav : undefined

  const page = (() => {
    switch (nav) {
      case 'flag_detail':
        return (
          <FlagDetailPanel onNav={onNav} embedMode={embedMode} analysisHandlers={analysisHandlers} />
        )
      case 'entity_profile':
        return <EntityProfilePage onNav={onNav} embedMode={embedMode} />
      case 'flags_track':
        return <FlagsTrackPage onNav={onNav} embedMode={embedMode} />
      case 'health_score':
        return <HealthScorePage onNav={onNav} embedMode={embedMode} />
      case 'tax_risk_exposure':
        return <TaxRiskExposurePage onNav={onNav} embedMode={embedMode} />
      case 'related_pairs':
        return <RelatedPairsPage onNav={onNav} embedMode={embedMode} />
      case 'related_shell':
        return <RelatedShellPage onNav={onNav} embedMode={embedMode} />
      case 'trade_relationships':
        return <TradeRelationshipsPage onNav={onNav} embedMode={embedMode} />
      case 'finance_diff':
        return <FinanceDiffPage onNav={onNav} embedMode={embedMode} />
      case 'dim_tax_quality':
        return <TaxCodeAnalysisPage embedMode={embedMode} />
      case 'tax_enterprise_structure':
        return <TaxCodeEnterpriseAnalysisPage embedMode={embedMode} />
      case 'import_quality_overview':
        return <DataQualityOverviewPage onNav={onNav} embedMode={embedMode} />
      case 'import_quality_detail':
        return <DataQualityDetailPage onNav={onNav} embedMode={embedMode} />
      case 'import_quality_trend':
        return <DataQualityTrendPage onNav={onNav} embedMode={embedMode} />
      case 'overview_trend':
        return <OverviewTrendPage onNav={onNav} embedMode={embedMode} />
      case 'overview_tax':
        return <OverviewTaxPage onNav={onNav} embedMode={embedMode} />
      case 'supplier_new':
        return <SupplierNewPage onNav={onNav} embedMode={embedMode} />
      case 'counterparty_risk':
        return <CounterpartyRiskPage onNav={onNav} embedMode={embedMode} />
      case 'goods_category':
        return <GoodsCategoryPage onNav={onNav} embedMode={embedMode} />
      case 'year_over_year_compare':
        return <YearOverYearComparePage onNav={onNav} embedMode={embedMode} />
      case 'compare_charts':
        return <CompareChartsPage onNav={onNav} embedMode={embedMode} />
      case 'compare_rank':
        return <CompareRankPage onNav={onNav} embedMode={embedMode} />
      case 'supplier_top':
        return <SupplierTopPage onNav={onNav} embedMode={embedMode} />
      case 'overview_summary':
        return <OverviewSummaryPage onNav={onNav} embedMode={embedMode} />
      case 'supplier_cr':
        return <SupplierCrPage onNav={onNav} embedMode={embedMode} />
      case 'red_offset_analysis':
        return <RedOffsetAnalysisPage onNav={onNav} embedMode={embedMode} />
      case 'invoice_timing':
        return <InvoiceTimingPage onNav={onNav} embedMode={embedMode} />
      case 'tax_in_out_deviation':
        return <TaxInOutDeviationPage onNav={onNav} embedMode={embedMode} />
      default:
        return (
          <div className="p-4 text-il-meta text-text-3">
            暂不支持在此容器中预览该页面。
            <button
              type="button"
              className="ml-2 text-accent underline-offset-2 hover:underline"
              onClick={() => openNavInNewTab(nav, params)}
            >
              在新标签打开
            </button>
          </div>
        )
    }
  })()

  return <EmbedPageBody>{page}</EmbedPageBody>
}

export function analysisPageHostKey(nav: NavKey, params: Record<string, string>) {
  return `${nav}:${JSON.stringify(params)}`
}

export function openAnalysisTargetInNewTab(nav: NavKey, params: Record<string, string>) {
  openNavInNewTab(nav, params)
}

export function analysisTargetHref(nav: NavKey, params: Record<string, string>) {
  return buildNavUrl(nav, params)
}
