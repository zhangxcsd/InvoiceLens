import { useEffect, useState } from 'react'
import { fetchLicenseInfo, type LicenseInfo } from '../config/localApi'

export type UseLicenseResult = {
  loading: boolean
  license: LicenseInfo | null
  exportAllowed: boolean
  crossGroupAllowed: boolean
  /** 未开通 cross_group 或授权过期时的提示；与 compare 页文案一致时可作兜底。 */
  crossGroupHint: string | null
  trialHint: string | null
  maxEntities: number | undefined
  maxInvoices: number | undefined
  maxYears: number | undefined
  isExpired: boolean
}

export function useLicense(): UseLicenseResult {
  const [loading, setLoading] = useState(true)
  const [license, setLicense] = useState<LicenseInfo | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    void fetchLicenseInfo(ac.signal).then((res) => {
      if (ac.signal.aborted) return
      if (res.ok && res.license) setLicense(res.license)
      setLoading(false)
    })
    return () => ac.abort()
  }, [])

  const exportAllowed = Boolean(license?.exportReport)
  const isExpired = Boolean(license?.isExpired)
  const crossGroupAllowed = Boolean(license?.gates?.cross_group ?? license?.crossGroup)
  const trialHint = license?.trialHint ?? null
  const crossGroupHint = license
    ? crossGroupAllowed
      ? null
      : isExpired
        ? '授权已过期，子公司对比功能不可用，请导入新授权文件。'
        : '当前授权未开通子公司对比，请升级授权或在「授权管理」导入正式授权。'
    : null

  return {
    loading,
    license,
    exportAllowed,
    crossGroupAllowed,
    crossGroupHint,
    trialHint,
    maxEntities: license?.maxEntities,
    maxInvoices: license?.maxInvoices,
    maxYears: license?.maxYears,
    isExpired,
  }
}
