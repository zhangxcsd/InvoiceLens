import type { ReactNode } from 'react'
import { useState } from 'react'

/** plain：页顶说明段落；callout：浅蓝提示条；compact：小号次色说明（原折叠区默认样式） */
export type PrototypePageHeaderBodyTone = 'plain' | 'callout' | 'compact'

const DEFAULT_EXPAND_LABEL = '查看更多说明'
const DEFAULT_COLLAPSE_LABEL = '收起说明'

type PrototypePageHeaderProps = {
  title: string
  /** 空字符串则不占位；开启折叠时与 note 合并，不再单独常驻展示 */
  description?: string
  descriptionTone?: PrototypePageHeaderBodyTone
  /** 折叠说明正文；与 description 合并为一条，默认折叠 */
  note?: string
  /** 展开后正文的展示样式；默认 compact */
  noteTone?: PrototypePageHeaderBodyTone
  /** 不传或空字符串则不展示角标（如主体库等已接后端数据的页面） */
  badgeText?: string
  expandLabel?: string
  collapseLabel?: string
  actions?: ReactNode
  /** 为 false 时不折叠，description 常驻展示（默认 true） */
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
  const collapsible = props.showExpandableNote !== false
  const expand = (props.expandLabel ?? '').trim() || DEFAULT_EXPAND_LABEL
  const collapse = (props.collapseLabel ?? '').trim() || DEFAULT_COLLAPSE_LABEL

  const desc = (props.description ?? '').trim()
  const noteRaw = (props.note ?? '').trim()
  const noteTone = props.noteTone ?? 'compact'
  const collapsibleText = collapsible ? [desc, noteRaw].filter(Boolean).join(' ') : noteRaw
  const staticDesc = collapsible ? '' : desc
  const staticTone = props.descriptionTone ?? 'plain'
  const showToggle = collapsible && collapsibleText.length > 0

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{props.title}</h1>
          {props.badgeText ? (
            <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
              {props.badgeText}
            </span>
          ) : null}
          {showToggle ? (
            <button
              type="button"
              className="text-il-meta text-accent hover:underline"
              onClick={() => setShowTips((v) => !v)}
              aria-expanded={showTips}
            >
              {showTips ? collapse : expand}
            </button>
          ) : null}
        </div>
        {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
      </div>
      {staticDesc ? renderBody(staticDesc, staticTone) : null}
      {showTips && collapsibleText ? renderBody(collapsibleText, noteTone, 'fullWidth') : null}
    </div>
  )
}
