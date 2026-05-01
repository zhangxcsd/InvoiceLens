import type { VersionStatus } from './types'
import { versionStatusClass } from './versionStatus'

export function VersionStatusTag(props: { status: VersionStatus; label: string }) {
  return (
    <span className={['rounded-sm border px-2 py-0.5 text-il-meta', versionStatusClass(props.status)].join(' ')}>
      {props.label}
    </span>
  )
}
