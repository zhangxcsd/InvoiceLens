import type { NavKey } from '../types'
import { setActiveEmbedNavQuery } from './embedNavQuery'

export type EmbedShellNavigateHandler = (nav: NavKey, params: Record<string, string>) => boolean

let embedShellHandler: EmbedShellNavigateHandler | null = null

export function setEmbedShellNavigateHandler(handler: EmbedShellNavigateHandler | null) {
  embedShellHandler = handler
}

export function isEmbedShellActive(): boolean {
  return embedShellHandler != null
}

/** 容器内导航：由 FlagsListPage 注册 handler，navigateWithQuery 在嵌入模式下优先调用。 */
export function navigateEmbedShell(nav: NavKey, params: Record<string, string>): boolean {
  if (!embedShellHandler) return false
  setActiveEmbedNavQuery(params)
  return embedShellHandler(nav, params)
}
