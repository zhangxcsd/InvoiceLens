import type { NavKey } from '../types'
import type { FlagActionTarget } from '../dm/flagActionTarget'
import { resolveNavTarget, tierForNav } from '../dm/flagActionTarget'

const PANEL_NAV_KEY = 'panel'
const PANEL_PARAM_PREFIX = 'panel_'

const PANEL_QUERY_KEYS = [
  'stat_year',
  'stat_month',
  'rule_id',
  'entity_id',
  'seller_tax_no',
  'buyer_tax_no',
  'party_a_tax',
  'party_b_tax',
  'counterparty_tax_no',
  'counterparty_id',
  'role_mode',
  'goods_name',
  'goods_key',
  'slv_num',
  'expected_rate',
  'quarter',
  'keyword',
  'track_status',
  'track_tab',
  'batch_id',
  'flag_id',
  'domain',
  'chapters',
  'title',
  'date_from',
  'date_to',
  'fpzt',
  'source',
  'diff_type',
  'tax_bucket',
  'session_id',
] as const

function readPanelParamsFromUrl(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PANEL_QUERY_KEYS) {
    const v = sp.get(`${PANEL_PARAM_PREFIX}${key}`)
    if (v) out[key] = v
  }
  return out
}

/** 从 URL 读取分析侧栏深链（?nav=flags_list&panel=entity_profile&panel_entity_id=...）。 */
export function readPanelTargetFromUrl(): FlagActionTarget | null {
  try {
    const sp = new URL(window.location.href).searchParams
    const panelNav = (sp.get(PANEL_NAV_KEY) ?? '').trim()
    if (!panelNav) return null
    const nav = panelNav as NavKey
    const params = readPanelParamsFromUrl(sp)
    const target = resolveNavTarget(nav, params)
    if (target) return target
    return {
      nav,
      params,
      tier: tierForNav(nav),
      title: nav,
    }
  } catch {
    return null
  }
}

function applyPanelStackToSearchParams(url: URL, stack: FlagActionTarget[]) {
  for (const key of PANEL_QUERY_KEYS) {
    url.searchParams.delete(`${PANEL_PARAM_PREFIX}${key}`)
  }
  url.searchParams.delete(PANEL_NAV_KEY)
  const current = stack[stack.length - 1]
  if (current) {
    url.searchParams.set(PANEL_NAV_KEY, current.nav)
    for (const [k, v] of Object.entries(current.params)) {
      if (v) url.searchParams.set(`${PANEL_PARAM_PREFIX}${k}`, v)
    }
  }
}

/** 同步侧栏状态到 URL（不切换 nav=flags_list）。首次打开可 push 以支持浏览器后退。 */
export function writePanelStackToUrl(stack: FlagActionTarget[], mode: 'replace' | 'push' = 'replace') {
  try {
    const url = new URL(window.location.href)
    applyPanelStackToSearchParams(url, stack)
    if (mode === 'push' && stack.length > 0) {
      window.history.pushState({ ilAnalysisShell: true }, '', url.toString())
    } else {
      window.history.replaceState({}, '', url.toString())
    }
  } catch {
    /* ignore */
  }
}

export function clearPanelFromUrl() {
  writePanelStackToUrl([])
}

/** 从 URL 移除分析侧栏深链参数（新窗口独立打开时不应继承父页 panel 状态）。 */
export function stripPanelParamsFromUrl(url: URL) {
  for (const key of PANEL_QUERY_KEYS) {
    url.searchParams.delete(`${PANEL_PARAM_PREFIX}${key}`)
  }
  url.searchParams.delete(PANEL_NAV_KEY)
}
