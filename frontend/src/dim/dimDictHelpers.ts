import type { DimDictDomainDto, DimDictEntryDto } from '../config/localApi'

export type DimDictOption = { code: string; label: string }

/** 内置域离线兜底（与 dim_dict_api._BUILTIN_DOMAINS 对齐） */
export const DIM_DICT_BUILTIN_DEFAULTS: Record<string, DimDictOption[]> = {
  dwd_is_balanced: [
    { code: '未校验', label: '未校验' },
    { code: '平账', label: '平账' },
    { code: '不平账', label: '不平账' },
    { code: '差异可接受', label: '差异可接受' },
    { code: '强制通过', label: '强制通过' },
  ],
  dwd_net_calc_status: [
    { code: '未计算', label: '未计算' },
    { code: '蓝票已计算', label: '蓝票已计算' },
    { code: '已全额红冲', label: '已全额红冲' },
    { code: '孤立红票', label: '孤立红票' },
    { code: '已作废', label: '已作废' },
  ],
  dwd_invoice_dir: [
    { code: '进项', label: '进项' },
    { code: '销项', label: '销项' },
  ],
  subject_no_type: [
    { code: 'uscc', label: '统一社会信用代码' },
    { code: 'id_card', label: '居民身份证' },
    { code: 'taxpayer_id', label: '纳税人识别号' },
    { code: 'other', label: '其他' },
  ],
  subject_category_domain: [
    { code: 'org', label: '组织主体' },
    { code: 'person', label: '自然人主体' },
  ],
  source_status: [
    { code: 'single', label: '单一来源' },
    { code: 'merged', label: '已归并' },
    { code: 'conflict', label: '来源冲突' },
    { code: 'pending', label: '待处理' },
  ],
  quality_status: [
    { code: 'ok', label: '正常' },
    { code: 'warning', label: '警告' },
    { code: 'error', label: '错误' },
  ],
  first_source_system: [
    { code: 'invoice', label: '发票导入' },
    { code: 'external', label: '外部清单' },
    { code: 'manual', label: '手工维护' },
  ],
  audit_risk_label: [
    { code: 'NORMAL', label: '常规' },
    { code: 'HIGH', label: '高敏感' },
  ],
  audit_risk_level: [
    { code: '高风险', label: '高风险' },
    { code: '中风险', label: '中风险' },
    { code: '低风险', label: '低风险' },
  ],
  domestic_overseas: [
    { code: '境内', label: '境内' },
    { code: '境外', label: '境外' },
  ],
  finance_import_status: [
    { code: '成功', label: '成功' },
    { code: '警告', label: '警告' },
    { code: '失败', label: '失败' },
  ],
  finance_role_type: [
    { code: '销项', label: '销项' },
    { code: '进项', label: '进项' },
  ],
  scorecard_risk_level: [
    { code: '正常', label: '正常' },
    { code: '关注', label: '关注' },
    { code: '重点关注', label: '重点关注' },
  ],
  roster_data_source: [
    { code: 'registry', label: '台账同步' },
    { code: 'manual', label: '人工维护' },
    { code: 'registry+manual', label: '台账+人工' },
  ],
  roster_quality_status: [
    { code: 'ok', label: '正常' },
    { code: 'conflict', label: '待核对' },
  ],
  quality_severity: [
    { code: 'block', label: '阻塞' },
    { code: 'warn', label: '警告' },
    { code: 'info', label: '提示' },
  ],
  dim_task_run_status: [
    { code: 'success', label: '成功' },
    { code: 'failed', label: '失败' },
    { code: 'running', label: '运行中' },
    { code: 'queued', label: '排队中' },
    { code: 'skipped', label: '已跳过' },
    { code: 'partial', label: '部分成功' },
    { code: 'pending', label: '待执行' },
  ],
}

/** 从花名册行解析 data_source 码（兼容 in_registry/in_manual 派生） */
export function rosterDataSourceCode(row: {
  data_source?: string
  in_registry?: boolean
  in_manual?: boolean
}): string {
  const ds = String(row.data_source ?? '').trim()
  if (ds) return ds
  if (row.in_registry && row.in_manual) return 'registry+manual'
  if (row.in_manual) return 'manual'
  if (row.in_registry) return 'registry'
  return ''
}

export function buildDomainIndex(domains: DimDictDomainDto[]): Map<string, DimDictDomainDto> {
  const map = new Map<string, DimDictDomainDto>()
  for (const d of domains) {
    const id = d.domain_id?.trim()
    if (id) map.set(id, d)
  }
  return map
}

function sortEntries(entries: DimDictEntryDto[]): DimDictEntryDto[] {
  return [...entries].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
}

export function getDomainOptions(
  domains: DimDictDomainDto[],
  domainId: string,
  enabledOnly = true,
): DimDictOption[] {
  const domain = buildDomainIndex(domains).get(domainId)
  const entries = domain?.entries ?? []
  const filtered = enabledOnly ? entries.filter((e) => e.enabled) : entries
  if (filtered.length > 0) {
    return sortEntries(filtered).map((e) => ({ code: e.code, label: e.label || e.code }))
  }
  const fallback = DIM_DICT_BUILTIN_DEFAULTS[domainId]
  return fallback ? [...fallback] : []
}

export function getDomainCodes(
  domains: DimDictDomainDto[],
  domainId: string,
  enabledOnly = true,
): string[] {
  return getDomainOptions(domains, domainId, enabledOnly).map((o) => o.code)
}

export function getLabel(
  domains: DimDictDomainDto[],
  domainId: string,
  code: string,
  fallbackToCode = true,
): string {
  const c = code.trim()
  if (!c) return ''
  const domain = buildDomainIndex(domains).get(domainId)
  const hit = domain?.entries?.find((e) => e.code === c)
  if (hit?.label) return hit.label
  const baked = DIM_DICT_BUILTIN_DEFAULTS[domainId]?.find((o) => o.code === c)
  if (baked?.label) return baked.label
  return fallbackToCode ? c : ''
}

/** 审计疑点风险等级徽章样式（按码表顺序：高→中→低） */
export function auditRiskLevelBadgeClass(level: string): string {
  if (level === '高风险') return 'bg-danger/10 text-danger'
  if (level === '中风险') return 'bg-warn/10 text-warn'
  return 'bg-text-3/10 text-text-2'
}

/** 评分卡综合评级徽章/条形图样式（正常→关注→重点关注） */
export function scorecardRiskLevelBadgeClass(level: string): string {
  if (level === '重点关注') return 'bg-danger/10 text-danger'
  if (level === '关注') return 'bg-warn/10 text-warn'
  return 'bg-green/10 text-green'
}

export function scorecardRiskLevelBarClass(level: string): string {
  if (level === '重点关注') return 'bg-danger'
  if (level === '关注') return 'bg-warn'
  return 'bg-green'
}

/** 花名册 data_source 徽章样式 */
export function rosterDataSourceBadgeClass(code: string): string {
  if (code === 'manual') return 'border-accent/40 bg-[#f0f7ff] text-accent-mid'
  if (code === 'registry+manual') return 'border-warn/40 bg-warn/10 text-warn'
  if (code === 'registry') return 'border-border bg-[#f8fafc] text-text-2'
  return 'border-border bg-white text-text-2'
}

/** 花名册 quality_status 徽章样式（ok / conflict 待核对） */
export function rosterQualityStatusBadgeClass(status: string): string {
  if (status === 'conflict') return 'border-warn/40 bg-warn/10 text-warn'
  if (status === 'ok') return 'border-green/40 bg-green/10 text-green'
  return 'border-border bg-white text-text-2'
}
