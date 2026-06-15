import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useRbac } from './rbacContext'

export function useWriteGate() {
  const rbac = useRbac()
  return {
    canWrite: rbac.canWrite,
    canAuditFlags: rbac.canAuditFlags,
    writeDisabledHint: rbac.writeDisabledHint,
    auditDisabledHint: rbac.auditDisabledHint,
  }
}

type WriteGateButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  requires?: 'write' | 'audit_flags'
  children: ReactNode
}

/** 按 RBAC 禁用写操作并附带 title 提示。 */
export function WriteGateButton({
  requires = 'write',
  disabled,
  title,
  children,
  ...rest
}: WriteGateButtonProps) {
  const gate = useWriteGate()
  const allowed = requires === 'audit_flags' ? gate.canAuditFlags : gate.canWrite
  const hint = requires === 'audit_flags' ? gate.auditDisabledHint : gate.writeDisabledHint
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || !allowed}
      title={!allowed ? hint : title}
    >
      {children}
    </button>
  )
}
