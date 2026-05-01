import type { ReactNode } from 'react'
import { useState } from 'react'

type PrototypePageHeaderProps = {
  title: string
  description: string
  /** 折叠说明正文；仅当 showExpandableNote 为 true 时需要 */
  note?: string
  badgeText: string
  expandLabel?: string
  collapseLabel?: string
  actions?: ReactNode
  /** 为 false 时不展示「查看更多优化提示」及折叠说明（默认 true，兼容旧页） */
  showExpandableNote?: boolean
}

export function PrototypePageHeader(props: PrototypePageHeaderProps) {
  const [showTips, setShowTips] = useState(false)
  const showNote = props.showExpandableNote !== false
  const expand = props.expandLabel ?? ''
  const collapse = props.collapseLabel ?? ''

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{props.title}</h1>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
            {props.badgeText}
          </span>
        </div>
        {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
      </div>
      <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{props.description}</p>
      {showNote ? (
        <>
          <button
            type="button"
            className="mt-2 text-il-meta text-accent hover:underline"
            onClick={() => setShowTips((v) => !v)}
            aria-expanded={showTips}
          >
            {showTips ? collapse : expand}
          </button>
          {showTips ? <p className="mt-2 text-il-meta text-text-3">{props.note}</p> : null}
        </>
      ) : null}
    </div>
  )
}
