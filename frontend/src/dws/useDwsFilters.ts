import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAnalysisSubjectMeta,
  fetchAnalysisSubjectOptions,
  fetchDwsEntityOptions,
  fetchDwsMeta,
  type DwsEntityOption,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import { readNavQueryParams } from '../utils/navHelpers'

export type DwsTimeFilterParams = {
  statMonth?: string
  dateFrom?: string
  dateTo?: string
  quarter?: string
}

export function useDwsUrlDeepLinkFilter() {
  const ui = t.dwsDashboardUi
  const urlQuery = useMemo(() => readNavQueryParams(), [])
  const apiStatMonth = urlQuery.stat_month?.trim() || undefined
  const apiDateFrom = urlQuery.date_from?.trim() || undefined
  const apiDateTo = urlQuery.date_to?.trim() || undefined
  const apiQuarter = urlQuery.quarter?.trim() || undefined
  const highlightMonth = useMemo(() => {
    const raw = urlQuery.stat_month?.trim()
    if (!raw) return null
    const m = parseInt(raw, 10)
    return m >= 1 && m <= 12 ? m : null
  }, [urlQuery.stat_month])
  const highlightQuarter = useMemo(() => {
    const raw = urlQuery.quarter?.trim()
    if (!raw) return null
    const q = parseInt(raw.replace(/^Q/i, ''), 10)
    return q >= 1 && q <= 4 ? q : null
  }, [urlQuery.quarter])
  const flagContextHint = useMemo(() => {
    if (highlightMonth != null) {
      return ui.flagContextMonthHint.replace('{month}', String(highlightMonth))
    }
    if (highlightQuarter != null) {
      return ui.flagContextQuarterHint.replace('{quarter}', String(highlightQuarter))
    }
    const from = urlQuery.date_from?.trim()
    const to = urlQuery.date_to?.trim()
    if (from && to) {
      return ui.flagContextDateHint.replace('{from}', from).replace('{to}', to)
    }
    return null
  }, [highlightMonth, highlightQuarter, urlQuery.date_from, urlQuery.date_to, ui])
  const timeFilterParams: DwsTimeFilterParams = useMemo(
    () => ({
      statMonth: apiStatMonth,
      dateFrom: apiDateFrom,
      dateTo: apiDateTo,
      quarter: apiQuarter,
    }),
    [apiStatMonth, apiDateFrom, apiDateTo, apiQuarter],
  )
  return {
    urlQuery,
    apiStatMonth,
    apiDateFrom,
    apiDateTo,
    apiQuarter,
    highlightMonth,
    highlightQuarter,
    flagContextHint,
    timeFilterParams,
  }
}

export type DwsFilterPoolOptions = {
  entityPool?: 'dws_trend' | 'analysis'
  requireBuyer?: boolean
  requireBothRoles?: boolean
  /** 从 URL ?stat_year=&entity_id= 初始化筛选（深链恢复） */
  initFromUrl?: boolean
}

export function formatDwsAmount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatDwsPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(2)}%`
}

export function useDwsFilters(requireEntity = false, poolOptions: DwsFilterPoolOptions = {}) {
  const entityPool = poolOptions.entityPool ?? 'dws_trend'
  const requireBuyer = Boolean(poolOptions.requireBuyer)
  const requireBothRoles = Boolean(poolOptions.requireBothRoles)
  const initFromUrl = Boolean(poolOptions.initFromUrl)
  const urlQuery = useMemo(() => (initFromUrl ? readNavQueryParams() : {}), [initFromUrl])
  const [statYears, setStatYears] = useState<string[]>([])
  const [statYear, setStatYear] = useState(() => urlQuery.stat_year ?? String(new Date().getFullYear()))
  const [entityId, setEntityId] = useState(() => urlQuery.entity_id ?? '')
  const [entityOptions, setEntityOptions] = useState<DwsEntityOption[]>([])
  const [dwsReady, setDwsReady] = useState(false)
  const [metaHint, setMetaHint] = useState<string | null>(null)
  const [poolHint, setPoolHint] = useState<string | null>(null)
  const [defaultMinInvoiceCount, setDefaultMinInvoiceCount] = useState<number | null>(null)
  const [minInvoiceCount, setMinInvoiceCount] = useState<number | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(true)

  const yearOptions = useMemo(() => {
    const cy = new Date().getFullYear()
    const fb = Array.from({ length: 12 }, (_, i) => String(cy + 1 - i))
    const s = new Set<string>([...fb, ...statYears])
    return [...s].sort((a, b) => Number(b) - Number(a))
  }, [statYears])

  const effectiveYear = useMemo(() => {
    const y = statYear.trim()
    if (y && yearOptions.includes(y)) return y
    return yearOptions[0] ?? String(new Date().getFullYear())
  }, [statYear, yearOptions])

  const reloadMeta = useCallback(async (signal?: AbortSignal) => {
    setLoadingMeta(true)
    try {
      const m = await fetchDwsMeta(signal)
      if (signal?.aborted || m.aborted) return
      if (m.ok) {
        const ys = m.stat_years ?? []
        setStatYears(ys)
        setDwsReady(Boolean(m.dws_ready))
        setMetaHint(m.hint ?? null)
        const cy = String(new Date().getFullYear())
        setStatYear((prev) => {
          const p = prev.trim()
          if (p && [...ys, cy].includes(p)) return prev
          if (ys.includes(cy)) return cy
          return ys[0] ?? cy
        })
      }
    } finally {
      setLoadingMeta(false)
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void reloadMeta(ac.signal)
    return () => ac.abort()
  }, [reloadMeta])

  useEffect(() => {
    if (entityPool !== 'analysis') return
    const ac = new AbortController()
    void fetchAnalysisSubjectMeta(undefined, ac.signal).then((res) => {
      if (ac.signal.aborted || res.aborted) return
      if (res.ok && res.min_invoice_count != null) {
        setDefaultMinInvoiceCount(res.min_invoice_count)
        setMinInvoiceCount((prev) => (prev == null ? res.min_invoice_count! : prev))
      }
    })
    return () => ac.abort()
  }, [entityPool])

  useEffect(() => {
    const ac = new AbortController()
    if (!effectiveYear) {
      setEntityOptions([])
      setPoolHint(null)
      return () => ac.abort()
    }
    if (entityPool === 'analysis') {
      if (minInvoiceCount == null) {
        setEntityOptions([])
        setPoolHint(null)
        return () => ac.abort()
      }
      void fetchAnalysisSubjectOptions(
        { statYear: effectiveYear, requireBuyer, requireBothRoles, minInvoiceCount },
        ac.signal,
      ).then((res) => {
        if (ac.signal.aborted || res.aborted) return
        if (res.ok && res.options) {
          setEntityOptions(res.options)
          setPoolHint(res.hint ?? null)
        } else {
          setEntityOptions([])
          setPoolHint(res.error?.message ?? null)
        }
      })
    } else {
      void fetchDwsEntityOptions(effectiveYear, ac.signal).then((res) => {
        if (ac.signal.aborted || res.aborted) return
        if (res.ok && res.options) setEntityOptions(res.options)
        else setEntityOptions([])
        setPoolHint(null)
      })
    }
    return () => ac.abort()
  }, [effectiveYear, entityPool, requireBuyer, requireBothRoles, minInvoiceCount])

  const entityValid = !requireEntity || Boolean(entityId.trim())

  return {
    statYear,
    setStatYear,
    effectiveYear,
    yearOptions,
    entityId,
    setEntityId,
    entityOptions,
    dwsReady,
    metaHint,
    poolHint,
    minInvoiceCount,
    setMinInvoiceCount,
    defaultMinInvoiceCount,
    loadingMeta,
    entityValid,
    reloadMeta,
  }
}
