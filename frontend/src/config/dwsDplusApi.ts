import {
  apiFetch,
  isFetchAbortError,
  type DwsCustomerTopRow,
  type DwsSupplierChurnRow,
  type DwsEnterpriseBehaviorMonth,
  type DwsGoodsCatRow,
  type DwsCounterpartyRiskRow,
  type DwsInvoiceTimingOverview,
  type DwsRedOffsetOverview,
  type DwsRedOffsetRow,
  type DwsYearOverYearCompare,
} from './localApi'

export async function fetchDwsGoodsCatOverview(
  params: { statYear: string; entityId: string; statQuarter?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.statQuarter?.trim()) sp.set('stat_quarter', params.statQuarter.trim())
  try {
    const res = await apiFetch(`/api/dws/goods-cat/overview?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      totalNetJshj: Number(json.total_net_jshj ?? 0),
      quarterly: json.quarterly ?? [],
      topCategories: (json.top_categories ?? []) as DwsGoodsCatRow[],
      hint: json.hint as string | null | undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsGoodsCatList(
  params: { statYear: string; entityId: string; statQuarter?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.statQuarter?.trim()) sp.set('stat_quarter', params.statQuarter.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  try {
    const res = await apiFetch(`/api/dws/goods-cat/list?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, rows: (json.rows ?? []) as DwsGoodsCatRow[], total: Number(json.total ?? 0) }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsEnterpriseBehaviorProfile(
  params: { statYear: string; entityId: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  try {
    const res = await apiFetch(`/api/dws/enterprise-behavior/profile?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      months: (json.months ?? []) as DwsEnterpriseBehaviorMonth[],
      summary: json.summary ?? {},
      hint: json.hint as string | null | undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsCustomerCr(params: { statYear: string; entityId: string }, signal?: AbortSignal) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  try {
    const res = await apiFetch(`/api/dws/customer/cr?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      cr1: json.cr1 != null ? Number(json.cr1) : null,
      cr3: json.cr3 != null ? Number(json.cr3) : null,
      cr10: json.cr10 != null ? Number(json.cr10) : null,
      customer_cnt: Number(json.customer_cnt ?? 0),
      total_net_jshj: Number(json.total_net_jshj ?? 0),
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsCustomerTop(
  params: { statYear: string; entityId: string; limit?: number },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  try {
    const res = await apiFetch(`/api/dws/customer/top?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: DwsCustomerTopRow[] = (json.rows ?? []).map((x: any) => ({
      customer_id: String(x?.customer_id ?? ''),
      customer_name: String(x?.customer_name ?? ''),
      net_jshj: Number(x?.net_jshj ?? 0),
      invoice_cnt: Number(x?.invoice_cnt ?? 0),
      amount_rank: Number(x?.amount_rank ?? 0),
      amount_ratio: Number(x?.amount_ratio ?? 0),
      cumulative_ratio: Number(x?.cumulative_ratio ?? 0),
      is_new_customer: Boolean(x?.is_new_customer),
      last_invoice_date: String(x?.last_invoice_date ?? ''),
    }))
    return { ok: true, rows, total: Number(json.total ?? 0) }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsCustomerChurn(
  params: {
    statYear: string
    entityId: string
    kind?: 'new' | 'disappeared'
    topOnly?: boolean
    keyword?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  rows?: DwsSupplierChurnRow[]
  total?: number
  prior_year?: string
  summary?: {
    new_total: number
    new_top10: number
    disappeared_total: number
    prior_year: string
  }
  hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  sp.set('kind', params.kind ?? 'new')
  if (params.topOnly) sp.set('top_only', '1')
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  try {
    const res = await apiFetch(`/api/dws/customer/churn?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: DwsSupplierChurnRow[] = (json.rows ?? []).map((x: any) => ({
      supplier_id: String(x?.customer_id ?? x?.supplier_id ?? ''),
      supplier_name: String(x?.customer_name ?? x?.supplier_name ?? ''),
      net_jshj: Number(x?.net_jshj ?? 0),
      invoice_cnt: Number(x?.invoice_cnt ?? 0),
      amount_rank: Number(x?.amount_rank ?? 0),
      amount_ratio: Number(x?.amount_ratio ?? 0),
      cumulative_ratio: Number(x?.cumulative_ratio ?? 0),
      first_invoice_date: String(x?.first_invoice_date ?? ''),
      last_invoice_date: String(x?.last_invoice_date ?? ''),
      is_top10: Boolean(x?.is_top10),
      churn_kind: (x?.churn_kind === 'disappeared' ? 'disappeared' : 'new') as 'new' | 'disappeared',
      compare_year: x?.compare_year != null ? Number(x.compare_year) : undefined,
    }))
    return {
      ok: true,
      rows,
      total: Number(json.total ?? 0),
      prior_year: json.prior_year != null ? String(json.prior_year) : undefined,
      summary: json.summary
        ? {
            new_total: Number(json.summary.new_total ?? 0),
            new_top10: Number(json.summary.new_top10 ?? 0),
            disappeared_total: Number(json.summary.disappeared_total ?? 0),
            prior_year: String(json.summary.prior_year ?? ''),
          }
        : undefined,
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsRedOffsetOverview(
  params: { statYear: string; entityId?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  try {
    const res = await apiFetch(`/api/dws/red-offset/overview?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, data: json as DwsRedOffsetOverview }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsRedOffsetList(
  params: { statYear: string; entityId?: string; kind?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.kind?.trim()) sp.set('kind', params.kind.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  try {
    const res = await apiFetch(`/api/dws/red-offset/list?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, rows: (json.rows ?? []) as DwsRedOffsetRow[], total: Number(json.total ?? 0) }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsInvoiceTimingOverview(
  params: { statYear: string; entityId: string; roleType?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.roleType?.trim()) sp.set('role_type', params.roleType.trim())
  try {
    const res = await apiFetch(`/api/dws/invoice-timing/overview?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, data: json as DwsInvoiceTimingOverview }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsCounterpartyRiskList(
  params: { statYear: string; entityId: string; limit?: number; offset?: number },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  try {
    const res = await apiFetch(`/api/dws/counterparty-risk/list?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      rows: (json.rows ?? []) as DwsCounterpartyRiskRow[],
      total: Number(json.total ?? 0),
      hint: json.hint as string | null | undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsYearOverYearCompare(
  params: { statYear: string; entityId: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  try {
    const res = await apiFetch(`/api/dws/year-over-year/compare?${sp}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, data: json as DwsYearOverYearCompare }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}
