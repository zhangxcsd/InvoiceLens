import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDwsFilters } from '../dws/useDwsFilters'
import { readFinanceFilterParams, writeFinanceFilterParams } from './financeNav'

export function useFinanceFilters() {
  const initial = useMemo(() => readFinanceFilterParams(), [])
  const dws = useDwsFilters(false, { entityPool: 'dws_trend' })
  const [batchId, setBatchIdState] = useState(initial.batchId ?? '')
  const [diffType, setDiffTypeState] = useState(initial.diffType ?? '')

  useEffect(() => {
    if (initial.statYear && dws.yearOptions.includes(initial.statYear)) {
      dws.setStatYear(initial.statYear)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 仅挂载时从 URL 恢复

  useEffect(() => {
    if (initial.entityId) dws.setEntityId(initial.entityId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const syncUrl = useCallback(
    (next: { batchId?: string; statYear?: string; entityId?: string; diffType?: string }) => {
      writeFinanceFilterParams({
        batchId: next.batchId ?? batchId,
        statYear: next.statYear ?? dws.effectiveYear,
        entityId: next.entityId ?? dws.entityId,
        diffType: next.diffType ?? diffType,
      })
    },
    [batchId, diffType, dws.effectiveYear, dws.entityId],
  )

  const setBatchId = useCallback(
    (id: string) => {
      setBatchIdState(id)
      syncUrl({ batchId: id })
    },
    [syncUrl],
  )

  const setStatYear = useCallback(
    (y: string) => {
      dws.setStatYear(y)
      syncUrl({ statYear: y })
    },
    [dws, syncUrl],
  )

  const setEntityId = useCallback(
    (id: string) => {
      dws.setEntityId(id)
      syncUrl({ entityId: id })
    },
    [dws, syncUrl],
  )

  const setDiffType = useCallback(
    (dt: string) => {
      setDiffTypeState(dt)
      syncUrl({ diffType: dt })
    },
    [syncUrl],
  )

  const statYearNum = useMemo(() => {
    const n = Number(dws.effectiveYear)
    return Number.isFinite(n) ? n : undefined
  }, [dws.effectiveYear])

  return {
    batchId,
    setBatchId,
    diffType,
    setDiffType,
    statYear: dws.statYear,
    effectiveYear: dws.effectiveYear,
    yearOptions: dws.yearOptions,
    setStatYear,
    entityId: dws.entityId,
    setEntityId,
    entityOptions: dws.entityOptions,
    metaHint: dws.metaHint,
    loadingMeta: dws.loadingMeta,
    statYearNum,
  }
}
