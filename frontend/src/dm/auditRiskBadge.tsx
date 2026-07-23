import {
  auditRiskLevelBadgeClass,
  scorecardRiskLevelBadgeClass,
} from '../dim/dimDictHelpers'

/** 疑点风险列宽：容纳「高风险」徽章且不被挤压 */
export const AUDIT_RISK_COL_CLASS = 'shrink-0 whitespace-nowrap w-[72px] min-w-[72px]'

/** 评分卡风险列宽：容纳「重点关注」徽章 */
export const SCORECARD_RISK_COL_CLASS = 'shrink-0 whitespace-nowrap w-[80px] min-w-[80px]'

type BadgeSize = 'default' | 'dense' | 'large'

const badgeSizeClass: Record<BadgeSize, string> = {
  default: 'rounded px-1.5 py-0.5 text-il-meta',
  dense: 'rounded px-1 py-px text-[10px] leading-tight',
  large: 'rounded px-1.5 py-0.5 text-[14px] font-medium',
}

type RiskBadgeProps = {
  level: string
  label?: string
  size?: BadgeSize
  className?: string
}

export function AuditRiskLevelBadge({ level, label, size = 'default', className = '' }: RiskBadgeProps) {
  if (!level) return <span className="text-text-3">—</span>
  const text = label ?? level
  return (
    <span
      className={`inline-block whitespace-nowrap ${badgeSizeClass[size]} ${auditRiskLevelBadgeClass(level)} ${className}`}
      title={text}
    >
      {text}
    </span>
  )
}

export function ScorecardRiskLevelBadge({ level, label, size = 'default', className = '' }: RiskBadgeProps) {
  if (!level) return <span className="text-text-3">—</span>
  const text = label ?? level
  return (
    <span
      className={`inline-block whitespace-nowrap ${badgeSizeClass[size]} ${scorecardRiskLevelBadgeClass(level)} ${className}`}
      title={text}
    >
      {text}
    </span>
  )
}

/** 表格长文本单元格：截断 + hover 显示完整内容 */
export function TableCellTruncate({
  text,
  className = '',
  maxWidth = 'max-w-[160px]',
}: {
  text: string | null | undefined
  className?: string
  maxWidth?: string
}) {
  const display = text?.trim() || '—'
  if (display === '—') {
    return <span className={className}>—</span>
  }
  return (
    <span className={`block truncate ${maxWidth} ${className}`} title={display}>
      {display}
    </span>
  )
}
