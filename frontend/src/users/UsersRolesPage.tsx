import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchUserRoles, type AppRoleRow } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

export function UsersRolesPage() {
  const ui = t.usersRolesUi
  const [rows, setRows] = useState<AppRoleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchUserRoles(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      setRows(res.roles ?? [])
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  return (
    <div className="flex flex-col gap-4 p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {err ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">{err}</div>
      ) : null}

      <Card title={ui.listTitle} className="p-4">
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-4">{ui.colRole}</th>
                  <th className="py-2 pr-4">{ui.colLabel}</th>
                  <th className="py-2 pr-4">{ui.colPermissions}</th>
                  <th className="py-2">{ui.colDescription}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.role} className="border-b border-border/60 align-top">
                    <td className="py-3 pr-4 font-mono text-xs">{row.role}</td>
                    <td className="py-3 pr-4 font-medium">{row.label}</td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {(row.permissions ?? []).map((p) => (
                          <span
                            key={p}
                            className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent-mid"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 text-text-2">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
