import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { fetchAuditLog, type AuditLogEntry } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

function formatTs(ts?: string) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ts
    return d.toLocaleString('zh-CN')
  } catch {
    return ts
  }
}

export function UsersAuditPage() {
  const ui = t.usersAuditUi
  const [rows, setRows] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [actionFilter, setActionFilter] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchAuditLog({ action: actionFilter || undefined, limit: 200 }, signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      setRows(res.entries ?? [])
    } finally {
      setLoading(false)
    }
  }, [actionFilter, ui.loadFailed])

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
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="text-sm text-text-2">{ui.filterAction}</label>
          <select
            className="rounded border border-border px-2 py-1 text-sm"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">{ui.filterAll}</option>
            <option value="login">{ui.actionLogin}</option>
            <option value="license_update">{ui.actionLicense}</option>
            <option value="settings_thresholds_update">{ui.actionSettings}</option>
            <option value="user_create">{ui.actionUserCreate}</option>
            <option value="user_update">{ui.actionUserUpdate}</option>
            <option value="user_delete">{ui.actionUserDelete}</option>
          </select>
        </div>
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-2">{ui.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-4">{ui.colTime}</th>
                  <th className="py-2 pr-4">{ui.colUser}</th>
                  <th className="py-2 pr-4">{ui.colAction}</th>
                  <th className="py-2">{ui.colDetail}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.ts}-${idx}`} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-text-2">{formatTs(row.ts)}</td>
                    <td className="py-2 pr-4">{row.username}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{row.action}</td>
                    <td className="py-2 font-mono text-xs text-text-2">
                      {row.detail ? JSON.stringify(row.detail) : '—'}
                    </td>
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
