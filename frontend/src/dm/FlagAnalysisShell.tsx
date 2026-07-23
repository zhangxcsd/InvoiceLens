import { useEffect, useState } from 'react'
import { zhCN as t } from '../copy/zh-CN'
import type { FlagActionTarget } from './flagActionTarget'
import { AnalysisPageHost, analysisPageHostKey, openAnalysisTargetInNewTab } from './AnalysisPageHost'
import type { FlagAnalysisHandlers } from './flagAnalysisNavigate'
import type { NavKey } from '../types'

type Props = {
  stack: FlagActionTarget[]
  onClose: () => void
  onPopTo: (index: number) => void
  onEmbedNavigate: (nav: NavKey, params: Record<string, string>) => boolean
  analysisHandlers?: FlagAnalysisHandlers | null
  breadcrumbRootLabel?: string
}

export function FlagAnalysisShell({
  stack,
  onClose,
  onPopTo,
  onEmbedNavigate,
  analysisHandlers = null,
  breadcrumbRootLabel,
}: Props) {
  const ui = t.auditFlagUi.analysisShell
  const rootLabel = breadcrumbRootLabel ?? ui.breadcrumbList
  const target = stack[stack.length - 1]
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(false)
  }, [target?.nav, target?.title])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (collapsed) setCollapsed(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, collapsed])

  useEffect(() => {
    const prev = document.body.style.overflow
    if (!collapsed) document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [collapsed])

  if (!target) return null

  const wide = target.tier === 'wide'
  const panelWidth = wide
    ? 'w-full max-w-none sm:w-[min(720px,92vw)] xl:w-[min(960px,58vw)]'
    : 'w-full max-w-none'

  const openInNewTabAndClose = () => {
    openAnalysisTargetInNewTab(target.nav, target.params)
    onClose()
  }

  if (collapsed) {
    return (
      <div className="fixed inset-y-0 right-0 z-40 flex" role="complementary" aria-label={target.title}>
        <aside className="flex h-full w-11 flex-col border-l border-border-light bg-white/96 shadow-lg backdrop-blur-sm">
          <button
            type="button"
            className="shrink-0 border-b border-border-light px-1 py-2 text-il-meta text-text-3 hover:bg-bg hover:text-accent"
            title={ui.expandFromEdgeBtn}
            aria-label={ui.expandFromEdgeBtn}
            onClick={() => setCollapsed(false)}
          >
            ‹
          </button>
          <button
            type="button"
            className="min-h-0 flex-1 px-1 py-3 text-il-meta text-text-2 hover:text-accent"
            title={target.title}
            onClick={() => setCollapsed(false)}
          >
            <span className="mx-auto block max-h-[min(320px,50vh)] truncate [writing-mode:vertical-rl]">
              {target.title}
            </span>
          </button>
          <button
            type="button"
            className="shrink-0 border-t border-border-light px-1 py-2 text-il-meta text-text-3 hover:bg-bg hover:text-danger"
            title={ui.closeBtn}
            aria-label={ui.closeBtn}
            onClick={onClose}
          >
            ×
          </button>
        </aside>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={target.title}>
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        aria-label={ui.closeBtn}
        onClick={onClose}
      />
      <aside
        className={[
          'relative flex h-full flex-col border-l border-border-light bg-white/96 shadow-xl backdrop-blur-sm',
          panelWidth,
        ].join(' ')}
      >
        <header className="flex shrink-0 flex-col gap-2 border-b border-border-light bg-white/96 px-4 py-3 backdrop-blur-sm">
          <nav className="flex min-w-0 flex-wrap items-center gap-1 text-il-meta text-text-3" aria-label={ui.breadcrumbLabel}>
            <button type="button" className="hover:text-accent" onClick={onClose}>
              {rootLabel}
            </button>
            {stack.map((item, index) => (
              <span key={`${item.nav}:${index}`} className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true">/</span>
                {index < stack.length - 1 ? (
                  <button
                    type="button"
                    className="max-w-[12rem] truncate hover:text-accent"
                    onClick={() => onPopTo(index)}
                  >
                    {item.title}
                  </button>
                ) : (
                  <span className="max-w-[14rem] truncate font-medium text-text-2">{item.title}</span>
                )}
              </span>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-il-card-title font-semibold text-text">{target.title}</h2>
            <button
              type="button"
              className="shrink-0 rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text-2 hover:border-accent hover:text-accent"
              onClick={() => setCollapsed(true)}
            >
              {ui.collapseToEdgeBtn}
            </button>
            <button
              type="button"
              className="shrink-0 rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text-2 hover:border-accent hover:text-accent"
              onClick={() => openAnalysisTargetInNewTab(target.nav, target.params)}
            >
              {ui.openNewTabBtn}
            </button>
            <button
              type="button"
              className="shrink-0 rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text-2 hover:border-accent hover:text-accent"
              onClick={openInNewTabAndClose}
            >
              {ui.openNewTabAndCloseBtn}
            </button>
            <button
              type="button"
              className="shrink-0 rounded-sm border border-border-light bg-white px-2.5 py-1 text-il-meta text-text-2 hover:border-accent hover:text-accent"
              onClick={onClose}
            >
              {ui.closeBtn}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-white/96 p-4">
          <AnalysisPageHost
            key={analysisPageHostKey(target.nav, target.params)}
            nav={target.nav}
            params={target.params}
            onEmbedNavigate={onEmbedNavigate}
            analysisHandlers={analysisHandlers}
          />
        </div>
      </aside>
    </div>
  )
}
