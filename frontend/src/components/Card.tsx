import React from 'react'

export function Card(props: {
  title?: string
  children: React.ReactNode
  className?: string
  bodyClassName?: string
  /** 更小的卡片内边距与标题下边距，用于表单密集区 */
  compact?: boolean
}) {
  const pad = props.compact ? 'px-4 py-2.5' : 'px-5 py-[18px]'
  const titleMb = props.compact ? 'mb-1.5' : 'mb-3'
  const titleCls = props.compact
    ? 'text-[14px] font-semibold leading-tight text-text'
    : 'text-il-card-title font-semibold text-text'
  return (
    <div
      className={['mb-4 rounded-[10px] border border-border-light bg-white', pad, props.className]
        .filter(Boolean)
        .join(' ')}
    >
      {props.title ? <div className={['flex items-center gap-1', titleMb, titleCls].join(' ')}>{props.title}</div> : null}
      {props.bodyClassName ? <div className={props.bodyClassName}>{props.children}</div> : props.children}
    </div>
  )
}

