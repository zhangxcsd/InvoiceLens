import type { VersionStatus } from './types'

export function versionStatusClass(status: VersionStatus) {
  if (status === 'draft') return 'border-[#e5e7eb] bg-[#f8fafc] text-text-2'
  if (status === 'published') return 'border-[#c8e6d0] bg-[#f4fbf6] text-[#1b6b3a]'
  return 'border-[#c8dff7] bg-[#f0f7ff] text-accent'
}
