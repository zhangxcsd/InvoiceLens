import React from 'react'

export function MetricCard(props: {
  label: string
  value: React.ReactNode
  sub?: string
  tone?: 'ok' | 'up' | 'warn' | 'neutral'
}) {
  const toneClass =
    props.tone === 'ok'
      ? 'text-green'
      : props.tone === 'up'
        ? 'text-danger'
        : props.tone === 'warn'
          ? 'text-warn'
          : 'text-text'
  return (
    <div className="rounded-[10px] border border-border-light bg-white px-4 py-[14px]">
      <div className="mb-1 text-il-meta font-medium text-text-3">{props.label}</div>
      <div className={['text-[22px] font-bold leading-none', toneClass].join(' ')}>
        {props.value}
      </div>
      {props.sub ? (
        <div className="mt-1 text-il-meta text-text-3">{props.sub}</div>
      ) : null}
    </div>
  )
}

