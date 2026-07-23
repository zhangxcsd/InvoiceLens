import type { AuditFlagRow } from '../config/localApi'
import type { NavKey } from '../types'
import { openNavInNewTab, navigateWithQuery } from '../utils/navHelpers'
import type { FlagActionLabels } from './flagActionHelpers'
import { navigateFlagAction } from './flagActionHelpers'
import {
  isSupportedInAnalysisShell,
  resolveFlagActionTarget,
  resolveNavTarget,
  tierForNav,
  type FlagActionTarget,
} from './flagActionTarget'

export type FlagAnalysisHandlers = {
  onNav: (key: NavKey) => void
  openShell: (target: FlagActionTarget) => void
}

/** 疑点清单页专用：A/B 档走侧栏容器，C 档新标签打开。 */
export function handleFlagAnalysisAction(
  actionId: string,
  row: AuditFlagRow,
  statYear: string,
  labels: FlagActionLabels,
  handlers: FlagAnalysisHandlers,
) {
  const target = resolveFlagActionTarget(actionId, row, statYear, labels)
  if (!target) return
  if (target.tier === 'newTab') {
    openNavInNewTab(target.nav, target.params)
    return
  }
  handlers.openShell(target)
}

/** 非疑点清单上下文仍走全页跳转。 */
export function handleFlagActionOrNavigate(
  actionId: string,
  row: AuditFlagRow,
  statYear: string,
  labels: FlagActionLabels,
  onNav: (key: NavKey) => void,
  handlers: FlagAnalysisHandlers | null,
) {
  if (handlers) {
    handleFlagAnalysisAction(actionId, row, statYear, labels, handlers)
    return
  }
  navigateFlagAction(onNav, actionId, row, statYear)
}

/** 通用 nav 跳转：有容器上下文时 A/B 档走侧栏，C 档新标签，其余全页跳转。 */
export function handleNavAnalysisAction(
  nav: NavKey,
  params: Record<string, string>,
  onNav: (key: NavKey) => void,
  handlers: FlagAnalysisHandlers | null,
  options?: { closeShell?: () => void },
) {
  if (tierForNav(nav) === 'newTab') {
    openNavInNewTab(nav, params)
    return
  }
  const target = resolveNavTarget(nav, params)
  if (handlers && target && isSupportedInAnalysisShell(nav)) {
    handlers.openShell(target)
    return
  }
  options?.closeShell?.()
  navigateWithQuery(onNav, nav, params)
}
