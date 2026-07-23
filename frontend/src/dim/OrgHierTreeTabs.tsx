import type { OrgHierTreeMode } from '../utils/navHelpers'

export function OrgHierTreeTabs(props: {
  mode: OrgHierTreeMode
  onModeChange: (mode: OrgHierTreeMode) => void
  labels: { manage: string; equity: string; relation: string }
  className?: string
}) {
  const { mode, onModeChange, labels, className } = props
  const tabCls = (active: boolean) =>
    [
      'rounded-sm px-3 py-1.5 text-il-meta transition-colors',
      active ? 'bg-white text-accent shadow-sm' : 'text-text-2 hover:text-text',
    ].join(' ')

  return (
    <div
      className={['inline-flex rounded-sm border border-border-light bg-[#f5f7fa] p-0.5', className]
        .filter(Boolean)
        .join(' ')}
    >
      <button type="button" className={tabCls(mode === 'management')} onClick={() => onModeChange('management')}>
        {labels.manage}
      </button>
      <button type="button" className={tabCls(mode === 'equity')} onClick={() => onModeChange('equity')}>
        {labels.equity}
      </button>
      <button type="button" className={tabCls(mode === 'relation')} onClick={() => onModeChange('relation')}>
        {labels.relation}
      </button>
    </div>
  )
}
