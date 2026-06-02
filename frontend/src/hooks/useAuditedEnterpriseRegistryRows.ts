import { useCallback, useEffect, useState } from 'react'
import { fetchAuditedEnterpriseRegistry, type AuditedEnterpriseRegistryRow } from '../config/localApi'
import { fetchAllAuditedEnterpriseRegistryRows } from '../dim/auditedEnterpriseRegistryHelpers'

export function useAuditedEnterpriseRegistryRows(loadFailedLabel: string) {
  const [rows, setRows] = useState<AuditedEnterpriseRegistryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const res = await fetchAllAuditedEnterpriseRegistryRows(fetchAuditedEnterpriseRegistry)
    if (!res.ok) {
      setLoadError(res.error?.message ?? loadFailedLabel)
      setRows([])
      setLoading(false)
      return
    }
    setRows(res.rows)
    setLoading(false)
  }, [loadFailedLabel])

  useEffect(() => {
    void load()
  }, [load])

  return { rows, loading, loadError, reload: load }
}
