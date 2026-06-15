import { createContext, useContext } from 'react'
import { getRbacForRole, type RbacState } from './rbacNav'
import { zhCN as t } from '../copy/zh-CN'

const RbacContext = createContext<RbacState | null>(null)

export function RbacProvider(props: { role: string; children: React.ReactNode }) {
  const value = getRbacForRole(props.role, t.rbac)
  return <RbacContext.Provider value={value}>{props.children}</RbacContext.Provider>
}

export function useRbac(): RbacState {
  const ctx = useContext(RbacContext)
  if (!ctx) {
    return getRbacForRole('viewer', t.rbac)
  }
  return ctx
}
