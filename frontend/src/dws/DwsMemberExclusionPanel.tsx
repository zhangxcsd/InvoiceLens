import { useMemo, useState } from 'react'
import type { AnalysisOrgScopeMember } from '../config/localApi'
import { zhCN as t } from '../copy/zh-CN'

export function DwsMemberExclusionPanel(props: {
  members: AnalysisOrgScopeMember[]
  excludedEntityIds: string[]
  onExcludedChange: (ids: string[]) => void
  loading?: boolean
  disabled?: boolean
}) {
  const ui = t.dwsDashboardUi
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const excludedSet = useMemo(() => new Set(props.excludedEntityIds), [props.excludedEntityIds])

  const filteredMembers = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return props.members
    return props.members.filter(
      (m) =>
        m.entity_name.toLowerCase().includes(q) ||
        m.entity_id.toLowerCase().includes(q),
    )
  }, [props.members, filter])

  const toggle = (entityId: string) => {
    const next = new Set(excludedSet)
    if (next.has(entityId)) next.delete(entityId)
    else next.add(entityId)
    props.onExcludedChange([...next])
  }

  const excludedCount = props.excludedEntityIds.length

  return (
    <div className="rounded-sm border border-border-light">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-il-page-desc text-text-2 hover:bg-[#fafbfd]"
        onClick={() => setOpen((v) => !v)}
        disabled={props.disabled}
      >
        <span className="font-medium">{ui.scopeMemberExclusionTitle}</span>
        <span className="text-il-meta text-text-3">
          {ui.scopeMemberExclusionSummary
            .replace('{total}', String(props.members.length))
            .replace('{excluded}', String(excludedCount))}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border-light px-3 py-3">
          <p className="mb-2 text-il-meta leading-relaxed text-text-3">{ui.scopeMemberExclusionHint}</p>
          <input
            className="mb-2 h-8 w-full rounded-sm border border-border bg-white px-2.5 text-il-page-desc text-text outline-none focus:border-accent"
            placeholder={ui.scopeMemberExclusionFilterPlaceholder}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={props.loading || props.disabled}
          />
          {props.loading ? (
            <p className="text-il-meta text-text-3">{ui.loading}</p>
          ) : props.members.length === 0 ? (
            <p className="text-il-meta text-text-3">{ui.scopeMemberExclusionEmpty}</p>
          ) : (
            <ul className="max-h-52 space-y-1 overflow-auto">
              {filteredMembers.map((m) => {
                const checked = excludedSet.has(m.entity_id)
                return (
                  <li key={m.entity_id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-sm px-1 py-1 hover:bg-[#fafbfd]">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        onChange={() => toggle(m.entity_id)}
                        disabled={props.disabled}
                      />
                      <span className="min-w-0 flex-1 text-il-page-desc text-text-2">
                        <span className="block truncate">{m.entity_name || m.entity_id}</span>
                        <span className="font-mono text-il-meta text-text-3">{m.entity_id}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
