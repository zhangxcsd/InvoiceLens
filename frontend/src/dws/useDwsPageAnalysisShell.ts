import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { NavKey } from '../types'
import { readPanelTargetFromUrl } from '../utils/panelNavQuery'
import { handleNavAnalysisAction } from '../dm/flagAnalysisNavigate'
import { titleForNav, type AnalysisShellTier, type FlagActionTarget } from '../dm/flagActionTarget'
import { useFlagAnalysisShell } from '../dm/useFlagAnalysisShell'
import { writeDwsPageUiSnapshot, type DwsPageUiSnapshot } from './dwsPageUiState'

type PersistUiOptions = {
  statYear: string
  entityId: string
  minInvoiceCount?: number | null
  loading: boolean
  extra?: Record<string, unknown>
}

type Options = {
  host: NavKey
  onNav?: (key: NavKey) => void
  embedMode?: boolean
  onHostReturn?: (params: Record<string, string>) => void
  savedUi?: DwsPageUiSnapshot | null
  persistUi?: PersistUiOptions
}

function snapshotToShellStack(
  items: Array<{ nav: string; params: Record<string, string>; title: string; tier: string }>,
): FlagActionTarget[] {
  return items
    .filter((item) => item.nav)
    .map((item) => ({
      nav: item.nav as NavKey,
      params: item.params,
      title: item.title,
      tier: item.tier as AnalysisShellTier,
    }))
}

export function useDwsPageAnalysisShell({
  host,
  onNav,
  embedMode,
  onHostReturn,
  savedUi,
  persistUi,
}: Options) {
  const panelFromUrl = useMemo(() => readPanelTargetFromUrl(), [])
  const enabled = Boolean(onNav) && !embedMode
  const scrollRestored = useRef(false)

  const { analysisHandlers, closeShell, shellProps, shellStack } = useFlagAnalysisShell({
    host,
    enabled,
    onNav,
    breadcrumbRootLabel: titleForNav(host),
    getInitialStack: () => {
      if (panelFromUrl) return [panelFromUrl]
      if (savedUi?.shellStack?.length) return snapshotToShellStack(savedUi.shellStack)
      return []
    },
    onHostReturn,
  })

  useEffect(() => {
    if (embedMode || !persistUi) return
    writeDwsPageUiSnapshot(host, {
      statYear: persistUi.statYear,
      entityId: persistUi.entityId,
      minInvoiceCount: persistUi.minInvoiceCount ?? null,
      scrollY: window.scrollY,
      shellStack: shellStack.map((item) => ({
        nav: item.nav,
        params: item.params,
        title: item.title,
        tier: item.tier,
      })),
      extra: persistUi.extra,
    })
  }, [embedMode, host, persistUi, shellStack])

  useEffect(() => {
    if (embedMode || !persistUi || scrollRestored.current || !savedUi?.scrollY) return
    if (persistUi.loading) return
    scrollRestored.current = true
    requestAnimationFrame(() => window.scrollTo(0, savedUi.scrollY))
  }, [embedMode, persistUi, savedUi?.scrollY])

  const goAnalysis = useCallback(
    (nav: NavKey, params: Record<string, string | undefined>) => {
      if (!onNav) return
      const compact: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') compact[k] = v
      }
      handleNavAnalysisAction(nav, compact, onNav, embedMode ? null : analysisHandlers, {
        closeShell: shellProps ? closeShell : undefined,
      })
    },
    [onNav, embedMode, analysisHandlers, shellProps, closeShell],
  )

  return { goAnalysis, shellProps, embedMode }
}
