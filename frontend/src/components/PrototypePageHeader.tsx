import type { ReactNode } from 'react'
import { useState } from 'react'

/** plain：页顶说明段落；callout：浅蓝提示条；compact：小号次色说明（原折叠区默认样式） */
export type PrototypePageHeaderBodyTone = 'plain' | 'callout' | 'compact'

type PrototypePageHeaderProps = {
  title: string
  /** 空字符串则不占位（用于页内另有独立说明时） */
  description?: string
  descriptionTone?: PrototypePageHeaderBodyTone
  /** 折叠说明正文；仅当 showExpandableNote 为 true 时需要 */
  note?: string
  /** 展开后正文的展示样式；默认 compact */
  noteTone?: PrototypePageHeaderBodyTone
  /** 不传或空字符串则不展示角标（如主体库等已接后端数据的页面） */
  badgeText?: string
  expandLabel?: string
  collapseLabel?: string
  actions?: ReactNode
  /** 为 false 时不展示「查看更多操作提示」及折叠说明（默认 true，兼容旧页） */
  showExpandableNote?: boolean
}

type BodyLayout = 'default' | 'fullWidth'

function renderBody(text: string, t: PrototypePageHeaderBodyTone, layout: BodyLayout = 'default'): ReactNode {
  const widthCls = layout === 'fullWidth' ? 'w-full max-w-none' : 'max-w-[920px]'

  if (t === 'callout') {
    return (
      <div
        className={[
          'mt-2 rounded-sm border border-[#c8dff7] bg-[#f0f7ff] px-2.5 py-1.5 text-il-meta leading-snug text-accent-mid',
          widthCls,
        ].join(' ')}
      >
        {text}
      </div>
    )
  }
  if (t === 'compact') {
    return (
      <p className={['mt-2 text-il-meta leading-relaxed text-text-3', widthCls].join(' ')}>
        {text}
      </p>
    )
  }
  return (
    <p className={['mt-2 text-il-page-desc leading-relaxed text-text-2', widthCls].join(' ')}>
      {text}
    </p>
  )
}

export function PrototypePageHeader(props: PrototypePageHeaderProps) {
  const [showTips, setShowTips] = useState(false)
  const showNote = props.showExpandableNote !== false
  const expand = props.expandLabel ?? ''
  const collapse = props.collapseLabel ?? ''

  const desc = (props.description ?? '').trim()
  const tone = props.descriptionTone ?? 'plain'
  const noteText = (props.note ?? '').trim()
  const noteTone = props.noteTone ?? 'compact'

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{props.title}</h1>
          {props.badgeText ? (
            <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
              {props.badgeText}
            </span>
          ) : null}
        </div>
        {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
      </div>
      {desc ? renderBody(desc, tone) : null}
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
          {showTips && noteText ? renderBody(noteText, noteTone, 'fullWidth') : null}
        </>
      ) : null}
    </div>
  )
}
