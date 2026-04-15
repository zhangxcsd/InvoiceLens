import React from 'react'

export function Card(props: {
  title: string
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <div
      className={['mb-4 rounded-[10px] border border-border-light bg-white px-5 py-[18px]', props.className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="mb-3 flex items-center gap-1 text-il-card-title font-semibold text-text">
        {props.title}
      </div>
      {props.bodyClassName ? <div className={props.bodyClassName}>{props.children}</div> : props.children}
    </div>
  )
}

