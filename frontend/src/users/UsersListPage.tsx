import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import {
  deleteUser,
  fetchUsers,
  postUserCreate,
  postUserUpdate,
  type AppUserRow,
} from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'
import type { User } from '../types'

type Props = { currentUser: User }

export function UsersListPage(props: Props) {
  const ui = t.usersListUi
  const [rows, setRows] = useState<AppUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ username: '', displayName: '', role: 'analyst', password: '' })

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchUsers(signal)
      if (signal?.aborted || res.aborted) return
      if (!res.ok) {
        setErr(res.error?.message ?? ui.loadFailed)
        return
      }
      setRows(res.users ?? [])
    } finally {
      setLoading(false)
    }
  }, [ui.loadFailed])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const onCreate = async () => {
    setSaving(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await postUserCreate({
        ...form,
        actor: props.currentUser.username,
      })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.saveFailed)
        return
      }
      setMsg(ui.createSuccess)
      setForm({ username: '', displayName: '', role: 'analyst', password: '' })
      await load()
    } finally {
      setSaving(false)
    }
  }

  const onToggleEnabled = async (row: AppUserRow) => {
    setSaving(true)
    setErr(null)
    try {
      const res = await postUserUpdate({
        username: row.username,
        enabled: !row.enabled,
        actor: props.currentUser.username,
      })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.saveFailed)
        return
      }
      await load()
    } finally {
      setSaving(false)
    }
  }

  const onChangeRole = async (row: AppUserRow, role: string) => {
    if (row.role === role) return
    setSaving(true)
    setErr(null)
    try {
      const res = await postUserUpdate({
        username: row.username,
        role,
        actor: props.currentUser.username,
      })
      if (!res.ok) {
        setErr(res.error?.message ?? ui.saveFailed)
        return
      }
      await load()
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (username: string) => {
    if (!window.confirm(ui.deleteConfirm.replace('{name}', username))) return
    setSaving(true)
    setErr(null)
    try {
      const res = await deleteUser(username, props.currentUser.username)
      if (!res.ok) {
        setErr(res.error?.message ?? ui.saveFailed)
        return
      }
      setMsg(ui.deleteSuccess)
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <PrototypePageHeader title={ui.pageTitle} description={ui.pageDesc} />
      {err ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded-md border border-success/30 bg-success/5 px-4 py-2 text-sm text-success">{msg}</div>
      ) : null}

      <Card title={ui.createTitle} className="p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <input
            className="rounded border border-border px-2 py-1 text-sm"
            placeholder={ui.colUsername}
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          />
          <input
            className="rounded border border-border px-2 py-1 text-sm"
            placeholder={ui.colDisplayName}
            value={form.displayName}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          />
          <select
            className="rounded border border-border px-2 py-1 text-sm"
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
          >
            <option value="admin">{ui.roleAdmin}</option>
            <option value="analyst">{ui.roleAnalyst}</option>
            <option value="viewer">{ui.roleViewer}</option>
          </select>
          <input
            type="password"
            className="rounded border border-border px-2 py-1 text-sm"
            placeholder={ui.colPassword}
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
        </div>
        <button
          type="button"
          className="mt-3 rounded-md bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={saving}
          onClick={() => void onCreate()}
        >
          {saving ? ui.saveBusy : ui.createBtn}
        </button>
      </Card>

      <Card title={ui.listTitle} className="p-4">
        {loading ? (
          <p className="text-sm text-text-2">{ui.loading}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-2">
                  <th className="py-2 pr-4">{ui.colUsername}</th>
                  <th className="py-2 pr-4">{ui.colDisplayName}</th>
                  <th className="py-2 pr-4">{ui.colRole}</th>
                  <th className="py-2 pr-4">{ui.colEnabled}</th>
                  <th className="py-2">{ui.colActions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.username} className="border-b border-border/60">
                    <td className="py-2 pr-4 font-mono text-xs">{row.username}</td>
                    <td className="py-2 pr-4">{row.displayName}</td>
                    <td className="py-2 pr-4">
                      <select
                        className="rounded border border-border px-1 py-0.5 text-xs"
                        value={row.role}
                        disabled={saving || row.username === 'admin'}
                        onChange={(e) => void onChangeRole(row, e.target.value)}
                      >
                        <option value="admin">{ui.roleAdmin}</option>
                        <option value="analyst">{ui.roleAnalyst}</option>
                        <option value="viewer">{ui.roleViewer}</option>
                      </select>
                    </td>
                    <td className="py-2 pr-4">{row.enabled ? ui.yes : ui.no}</td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="mr-3 text-xs text-primary hover:underline disabled:opacity-50"
                        disabled={saving || row.username === 'admin'}
                        onClick={() => void onToggleEnabled(row)}
                      >
                        {row.enabled ? ui.disableBtn : ui.enableBtn}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-danger hover:underline disabled:opacity-50"
                        disabled={saving || row.username === 'admin'}
                        onClick={() => void onDelete(row.username)}
                      >
                        {ui.deleteBtn}
                      </button>
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
