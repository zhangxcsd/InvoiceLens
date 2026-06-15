import { useCallback, useEffect, useState } from 'react'
import { fetchQualityImportBatches, type QualityImportBatch } from '../config/localApi'
import { readQualityBatchParams, writeQualityBatchParams } from './qualityNav'

export function useQualityBatchFilter() {
  const [batchId, setBatchIdState] = useState(() => readQualityBatchParams().batchId)
  const [sessionId] = useState(() => readQualityBatchParams().sessionId)
  const [batchOptions, setBatchOptions] = useState<QualityImportBatch[]>([])
  const [batchesLoading, setBatchesLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    void fetchQualityImportBatches({ signal: ac.signal }).then((res) => {
      if (!alive) return
      setBatchesLoading(false)
      if (res.ok) setBatchOptions(res.batches)
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [])

  const setBatchId = useCallback(
    (id: string) => {
      setBatchIdState(id)
      writeQualityBatchParams(id, sessionId)
    },
    [sessionId],
  )

  return { batchId, sessionId, setBatchId, batchOptions, batchesLoading }
}
