import type { NavKey } from '../types'

/** 带 query 参数导航（同步 URL，便于深链与刷新恢复）。 */
export function navigateWithQuery(
  onNav: (key: NavKey) => void,
  nav: NavKey,
  params?: Record<string, string | undefined>,
) {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('nav', nav)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') url.searchParams.set(k, v)
        else url.searchParams.delete(k)
      }
    }
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
  onNav(nav)
}

const NAV_QUERY_KEYS = [
  'stat_year',
  'stat_month',
  'rule_id',
  'entity_id',
  'seller_tax_no',
  'buyer_tax_no',
  'party_a_tax',
  'party_b_tax',
  'counterparty_tax_no',
  'counterparty_id',
  'goods_name',
  'goods_key',
  'slv_num',
  'expected_rate',
  'quarter',
  'keyword',
  'track_status',
  'track_tab',
  'batch_id',
  'domain',
  'chapters',
  'title',
  'date_from',
  'date_to',
  'fpzt',
  'source',
] as const

export function readNavQueryParams(): Record<string, string> {
  try {
    const sp = new URL(window.location.href).searchParams
    const out: Record<string, string> = {}
    for (const key of NAV_QUERY_KEYS) {
      const v = sp.get(key)
      if (v) out[key] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 同步 URL 查询参数（不切换 nav）。 */
export function writeNavQueryParams(params: Record<string, string | undefined>) {
  try {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, v)
      else url.searchParams.delete(k)
    }
    window.history.replaceState({}, '', url.toString())
  } catch {
    /* ignore */
  }
}

export function navigateToFlagsList(
  onNav: (key: NavKey) => void,
  params?: {
    statYear?: string
    ruleId?: string
    entityId?: string
    trackStatus?: string
    batchId?: string
  },
) {
  navigateWithQuery(onNav, 'flags_list', {
    stat_year: params?.statYear,
    rule_id: params?.ruleId,
    entity_id: params?.entityId,
    track_status: params?.trackStatus,
    batch_id: params?.batchId,
  })
}

export function navigateToHealthScore(
  onNav: (key: NavKey) => void,
  params?: { statYear?: string; entityId?: string },
) {
  navigateWithQuery(onNav, 'health_score', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
  })
}

export function navigateToReportConfig(
  onNav: (key: NavKey) => void,
  params?: { statYear?: string; entityId?: string; chapters?: string[]; title?: string },
) {
  navigateWithQuery(onNav, 'report_config', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
    chapters: params?.chapters?.filter(Boolean).join(','),
    title: params?.title,
  })
}

export function navigateToInvoiceExport(
  onNav: (key: NavKey) => void,
  params?: {
    statYear?: string
    entityId?: string
    dateFrom?: string
    dateTo?: string
    fpzt?: string
    sellerTaxNo?: string
  },
) {
  navigateWithQuery(onNav, 'import_invoice_export', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
    date_from: params?.dateFrom,
    date_to: params?.dateTo,
    fpzt: params?.fpzt,
    seller_tax_no: params?.sellerTaxNo,
  })
}

export function navigateToRelatedPairs(
  onNav: (key: NavKey) => void,
  params?: { statYear?: string; entityId?: string; partyATax?: string; partyBTax?: string; keyword?: string },
) {
  navigateWithQuery(onNav, 'related_pairs', {
    stat_year: params?.statYear,
    party_a_tax: params?.partyATax ?? params?.entityId,
    party_b_tax: params?.partyBTax,
    keyword: params?.keyword,
  })
}

export function navigateToTradeRelationships(
  onNav: (key: NavKey) => void,
  params?: {
    statYear?: string
    entityId?: string
    buyerTaxNo?: string
    sellerTaxNo?: string
    keyword?: string
  },
) {
  navigateWithQuery(onNav, 'trade_relationships', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
    buyer_tax_no: params?.buyerTaxNo,
    seller_tax_no: params?.sellerTaxNo,
    counterparty_id: params?.sellerTaxNo,
    keyword: params?.keyword,
  })
}

export function navigateToRelatedShell(
  onNav: (key: NavKey) => void,
  params?: { statYear?: string; entityId?: string },
) {
  navigateWithQuery(onNav, 'related_shell', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
  })
}

export function navigateToRelatedGraph(
  onNav: (key: NavKey) => void,
  params?: {
    statYear?: string
    entityId?: string
    partyATax?: string
    partyBTax?: string
    counterpartyTaxNo?: string
    source?: string
  },
) {
  navigateWithQuery(onNav, 'related_graph', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
    party_a_tax: params?.partyATax ?? params?.entityId,
    party_b_tax: params?.partyBTax,
    counterparty_tax_no: params?.counterpartyTaxNo,
    source: params?.source,
  })
}

export function navigateToTaxRiskExposure(
  onNav: (key: NavKey) => void,
  params?: { statYear?: string; entityId?: string },
) {
  navigateWithQuery(onNav, 'tax_risk_exposure', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
  })
}

export function navigateToOverviewSummary(
  onNav: (key: NavKey) => void,
  params?: { statYear?: string; entityId?: string },
) {
  navigateWithQuery(onNav, 'overview_summary', {
    stat_year: params?.statYear,
    entity_id: params?.entityId,
  })
}

export function navigateToFlagsTrack(
  onNav: (key: NavKey) => void,
  params?: {
    statYear?: string
    ruleId?: string
    entityId?: string
    trackTab?: 'pending' | 'confirmed' | 'all'
  },
) {
  navigateWithQuery(onNav, 'flags_track', {
    stat_year: params?.statYear,
    rule_id: params?.ruleId,
    entity_id: params?.entityId,
    track_tab: params?.trackTab,
    track_status: params?.trackTab,
  })
}

export function navigateToQualityDetail(
  onNav: (key: NavKey) => void,
  params?: { batchId?: string; domain?: string },
) {
  navigateWithQuery(onNav, 'import_quality_detail', {
    batch_id: params?.batchId,
    ...(params?.domain ? { domain: params.domain } : {}),
  })
}

export function readFlagsTrackTab(): 'pending' | 'confirmed' | 'all' {
  const q = readNavQueryParams()
  const raw = (q.track_tab || q.track_status || 'pending').toLowerCase()
  if (raw === 'confirmed') return 'confirmed'
  if (raw === 'all') return 'all'
  return 'pending'
}
