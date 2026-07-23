import type { NavKey } from '../types'

/** 与 src/local_api/users_api.py ROLES 对齐 */
export type AppRole = 'admin' | 'analyst' | 'viewer'

export type RbacPermission = 'read' | 'write' | 'export' | 'audit_flags' | 'admin'

const ROLE_PERMISSIONS: Record<AppRole, RbacPermission[] | ['*']> = {
  admin: ['*'],
  analyst: ['read', 'write', 'export', 'audit_flags'],
  viewer: ['read'],
}

/** 侧栏路由最低权限；未列出则仅需 read */
export const NAV_REQUIRED_PERMISSION: Partial<Record<NavKey, RbacPermission>> = {
  users_list: 'admin',
  users_roles: 'admin',
  users_audit: 'admin',
  settings_license: 'admin',
  import_wizard_upload: 'write',
  import_wizard_format_check: 'write',
  import_mapping_config: 'write',
  import_mapping_templates: 'write',
  ods_to_dwd_center: 'write',
  dwd_to_dim_center: 'write',
  processing_derived_dim_tasks: 'write',
  import_invoice_export: 'export',
  report_config: 'export',
  report_templates: 'export',
  report_archive: 'export',
  settings_thresholds: 'write',
  flags_rules: 'write',
  dim_org_hier_tree: 'write',
  dim_org_sys: 'write',
  /** @deprecated 兼容旧 ?nav= 链接 */
  dim_org_manage: 'write',
  dim_audited_registry: 'write',
  dim_enterprise_year_roster: 'write',
  dim_audited_contribution: 'write',
  dim_audited_invoice_link: 'write',
  dim_level1_enterprise_year: 'write',
  /** @deprecated 兼容旧 ?nav= 链接 */
  dim_org_equity: 'write',
  /** @deprecated 兼容旧 ?nav= 链接，侧栏已合并为 dim_org_hier_tree（tree_mode=relation） */
  dim_org_diff: 'write',
  dim_enterprise_library: 'write',
  dim_audit_related_library: 'write',
  dim_tax_lib: 'write',
  dim_tax_risk_define: 'write',
  dim_tax_result: 'write',
  dim_tax_quality: 'write',
  dim_subject_category: 'write',
  dim_dict: 'write',
  finance_reconcile: 'write',
  finance_diff: 'write',
}

export function normalizeRole(role: string): AppRole {
  if (role === 'admin' || role === 'analyst' || role === 'viewer') return role
  return 'viewer'
}

export function roleHasPermission(role: string, perm: RbacPermission): boolean {
  const r = normalizeRole(role)
  const perms = ROLE_PERMISSIONS[r]
  if ((perms as string[]).includes('*')) return true
  if (perm === 'admin') return r === 'admin'
  return (perms as RbacPermission[]).includes(perm)
}

export function canAccessNav(role: string, nav: NavKey): boolean {
  const required = NAV_REQUIRED_PERMISSION[nav] ?? 'read'
  return roleHasPermission(role, required)
}

export function canWrite(role: string): boolean {
  return roleHasPermission(role, 'write')
}

export function canExport(role: string): boolean {
  return roleHasPermission(role, 'export')
}

export function canAuditFlags(role: string): boolean {
  return roleHasPermission(role, 'audit_flags')
}

export function isAdmin(role: string): boolean {
  return normalizeRole(role) === 'admin'
}

export function defaultNavForRole(role: string): NavKey {
  if (canAccessNav(role, 'import_wizard_preview')) return 'import_wizard_preview'
  if (canAccessNav(role, 'overview_summary')) return 'overview_summary'
  return 'import_history'
}

export function firstAllowedNav(role: string, candidates: readonly NavKey[]): NavKey | null {
  for (const nav of candidates) {
    if (canAccessNav(role, nav)) return nav
  }
  return null
}

export type RbacState = {
  role: AppRole
  canWrite: boolean
  canExport: boolean
  canAuditFlags: boolean
  isAdmin: boolean
  writeDisabledHint: string
  auditDisabledHint: string
  forbiddenHint: string
}

export function getRbacForRole(role: string, copy: {
  writeDisabledHint: string
  auditDisabledHint: string
  forbiddenHint: string
}): RbacState {
  const r = normalizeRole(role)
  return {
    role: r,
    canWrite: canWrite(role),
    canExport: canExport(role),
    canAuditFlags: canAuditFlags(role),
    isAdmin: isAdmin(role),
    writeDisabledHint: copy.writeDisabledHint,
    auditDisabledHint: copy.auditDisabledHint,
    forbiddenHint: copy.forbiddenHint,
  }
}
