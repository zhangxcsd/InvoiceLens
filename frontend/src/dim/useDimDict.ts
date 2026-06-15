import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchDimDict, type DimDictDomainDto } from '../config/localApi'
import {
  buildDomainIndex,
  getDomainCodes,
  getDomainOptions,
  getLabel as getLabelFromDomains,
  type DimDictOption,
} from './dimDictHelpers'

type DimDictCache = {
  ok: boolean
  domains: DimDictDomainDto[]
  error?: string
}

let sessionCache: DimDictCache | null = null
let sessionPromise: Promise<DimDictCache> | null = null

export function loadDimDictSession(force = false): Promise<DimDictCache> {
  if (!force && sessionCache) return Promise.resolve(sessionCache)
  if (!force && sessionPromise) return sessionPromise
  sessionPromise = fetchDimDict()
    .then((res) => {
      const cached: DimDictCache = {
        ok: res.ok,
        domains: res.domains ?? [],
        error: res.error?.message,
      }
      sessionCache = cached
      return cached
    })
    .catch((e) => {
      const cached: DimDictCache = {
        ok: false,
        domains: [],
        error: e instanceof Error ? e.message : '网络错误',
      }
      sessionCache = cached
      return cached
    })
    .finally(() => {
      sessionPromise = null
    })
  return sessionPromise
}

export function clearDimDictSessionCache() {
  sessionCache = null
  sessionPromise = null
}

export function useDimDict() {
  const [state, setState] = useState<DimDictCache>(() => sessionCache ?? { ok: false, domains: [] })
  const [loading, setLoading] = useState(!sessionCache)

  useEffect(() => {
    let alive = true
    if (sessionCache) {
      setState(sessionCache)
      setLoading(false)
      return
    }
    setLoading(true)
    void loadDimDictSession().then((cached) => {
      if (!alive) return
      setState(cached)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const domainIndex = useMemo(() => buildDomainIndex(state.domains), [state.domains])

  const getOptions = useCallback(
    (domainId: string, enabledOnly = true): DimDictOption[] =>
      getDomainOptions(state.domains, domainId, enabledOnly),
    [state.domains],
  )

  const getCodes = useCallback(
    (domainId: string, enabledOnly = true): string[] => getDomainCodes(state.domains, domainId, enabledOnly),
    [state.domains],
  )

  const getLabel = useCallback(
    (domainId: string, code: string, fallbackToCode = true): string =>
      getLabelFromDomains(state.domains, domainId, code, fallbackToCode),
    [state.domains],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    const cached = await loadDimDictSession(true)
    setState(cached)
    setLoading(false)
    return cached
  }, [])

  return {
    loading,
    ok: state.ok,
    error: state.error,
    domains: state.domains,
    domainIndex,
    getOptions,
    getCodes,
    getLabel,
    refresh,
  }
}

/** 单域便捷 hook：下拉/筛选常用 */
export function useDimDictDomain(domainId: string, enabledOnly = true) {
  const dict = useDimDict()
  const options = useMemo(
    () => getDomainOptions(dict.domains, domainId, enabledOnly),
    [dict.domains, domainId, enabledOnly],
  )
  const codes = useMemo(() => options.map((o) => o.code), [options])
  const getLabel = useCallback(
    (code: string, fallbackToCode = true) => getLabelFromDomains(dict.domains, domainId, code, fallbackToCode),
    [dict.domains, domainId],
  )
  return {
    loading: dict.loading,
    ok: dict.ok,
    error: dict.error,
    options,
    codes,
    getLabel,
  }
}
