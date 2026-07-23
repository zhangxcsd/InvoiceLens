import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NavKey } from '../types'
import { openNavInNewTab, navigateWithQuery } from '../utils/navHelpers'
import { clearPanelFromUrl, writePanelStackToUrl } from '../utils/panelNavQuery'
import type { FlagAnalysisHandlers } from './flagAnalysisNavigate'
import {
  isSupportedInAnalysisShell,
  resolveNavTarget,
  type FlagActionTarget,
} from './flagActionTarget'

/** 侧栏容器内跳转到这些主工作台页时，全页切换并关闭容器。 */
const SHELL_FULL_PAGE_NAV_TARGETS = new Set<NavKey>([
  'flags_list',
  'flags_track',
  'health_score',
  'entity_profile',
])

/** 这些宿主页在容器内跳转到主工作台页时走全页（flags_list 不在此列，以便 stack 下钻）。 */
const SHELL_HOSTS_USE_FULL_PAGE_TO_TARGETS = new Set<NavKey>([
  'flags_track',
  'health_score',
  'entity_profile',
  'supplier_top',
  'tax_risk_exposure',
  'red_offset_analysis',
  'invoice_timing',
  'tax_in_out_deviation',
  'counterparty_risk',
  'goods_category',
  'year_over_year_compare',
  'overview_trend',
  'supplier_cr',
  'supplier_new',
  'trade_relationships',
  'overview_summary',
  'overview_tax',
  'compare_charts',
  'compare_rank',
  'finance_diff',
  'finance_reconcile',
  'related_pairs',
  'related_shell',
  'related_graph',
])

export type FlagAnalysisShellHost = NavKey

type Options = {
  host: FlagAnalysisShellHost
  enabled: boolean
  onNav?: (key: NavKey) => void
  breadcrumbRootLabel: string
  getInitialStack?: () => FlagActionTarget[]
  onHostReturn?: (params: Record<string, string>) => void
}

export function useFlagAnalysisShell({
  host,
  enabled,
  onNav,
  breadcrumbRootLabel,
  getInitialStack,
  onHostReturn,
}: Options) {
  const panelHistoryActive = useRef(false)
  const panelHistoryDepth = useRef(0)
  const shouldPushPanelHistory = useRef(false)
  const skipPopStateCount = useRef(0)

  const [shellStack, setShellStack] = useState<FlagActionTarget[]>(() => getInitialStack?.() ?? [])

  const closeShell = useCallback((fromPopState = false) => {
    if (!fromPopState && panelHistoryActive.current && panelHistoryDepth.current > 0) {
      window.history.go(-panelHistoryDepth.current)
      return
    }
    setShellStack([])
    clearPanelFromUrl()
    panelHistoryActive.current = false
    panelHistoryDepth.current = 0
  }, [])

  const openShell = useCallback((target: FlagActionTarget) => {
    shouldPushPanelHistory.current = true
    setShellStack([target])
  }, [])

  const popShellTo = useCallback((index: number) => {
    setShellStack((prev) => {
      const newLen = index + 1
      const stepsBack = prev.length - newLen
      if (stepsBack > 0 && panelHistoryActive.current) {
        skipPopStateCount.current = stepsBack
        panelHistoryDepth.current = Math.max(0, panelHistoryDepth.current - stepsBack)
        queueMicrotask(() => window.history.go(-stepsBack))
      }
      return prev.slice(0, newLen)
    })
  }, [])

  const pushShellTarget = useCallback((target: FlagActionTarget) => {
    shouldPushPanelHistory.current = true
    setShellStack((prev) => [...prev, target])
  }, [])

  useEffect(() => {
    const onPopState = () => {
      if (skipPopStateCount.current > 0) {
        skipPopStateCount.current -= 1
        return
      }
      setShellStack((prev) => {
        if (prev.length === 0) return prev
        if (prev.length === 1) {
          panelHistoryActive.current = false
          panelHistoryDepth.current = 0
          clearPanelFromUrl()
          return []
        }
        panelHistoryDepth.current = Math.max(0, panelHistoryDepth.current - 1)
        return prev.slice(0, -1)
      })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (shellStack.length === 0) {
      panelHistoryActive.current = false
      panelHistoryDepth.current = 0
      shouldPushPanelHistory.current = false
      return
    }
    const mode = shouldPushPanelHistory.current ? 'push' : 'replace'
    writePanelStackToUrl(shellStack, mode)
    if (mode === 'push') {
      panelHistoryActive.current = true
      panelHistoryDepth.current += 1
      shouldPushPanelHistory.current = false
    }
  }, [shellStack])

  const handleEmbedNavigate = useCallback(
    (nav: NavKey, params: Record<string, string>) => {
      if (nav === host) {
        onHostReturn?.(params)
        closeShell()
        return true
      }
      if (
        SHELL_HOSTS_USE_FULL_PAGE_TO_TARGETS.has(host) &&
        SHELL_FULL_PAGE_NAV_TARGETS.has(nav) &&
        nav !== host &&
        onNav
      ) {
        navigateWithQuery(onNav, nav, params)
        closeShell()
        return true
      }
      const target = resolveNavTarget(nav, params)
      if (!target || target.tier === 'newTab' || !isSupportedInAnalysisShell(nav)) {
        openNavInNewTab(nav, params)
        return true
      }
      pushShellTarget(target)
      return true
    },
    [host, onHostReturn, closeShell, onNav, pushShellTarget],
  )

  const analysisHandlers = useMemo<FlagAnalysisHandlers | null>(
    () =>
      enabled && onNav
        ? {
            onNav,
            openShell,
          }
        : null,
    [enabled, onNav, openShell],
  )

  const shellProps =
    shellStack.length > 0
      ? {
          stack: shellStack,
          onClose: closeShell,
          onPopTo: popShellTo,
          onEmbedNavigate: handleEmbedNavigate,
          analysisHandlers,
          breadcrumbRootLabel,
        }
      : null

  return {
    shellStack,
    closeShell,
    openShell,
    popShellTo,
    handleEmbedNavigate,
    analysisHandlers,
    shellProps,
  }
}
