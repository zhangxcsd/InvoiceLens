import { useEffect, useId, useMemo, useRef, useState } from 'react'

export type SearchableComboboxOption = {
  value: string
  label: string
  searchText?: string
}

const inputCls =
  'h-9 w-full rounded-sm border border-border bg-white px-2.5 text-il-page-desc text-text outline-none focus:border-accent'

export function SearchableCombobox(props: {
  options: SearchableComboboxOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  allowEmpty?: boolean
  emptyLabel?: string
  inputClassName?: string
}) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => props.options.find((o) => o.value === props.value) ?? null,
    [props.options, props.value],
  )

  useEffect(() => {
    if (!open) setQuery(selected?.label ?? '')
  }, [open, selected])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return props.options
    return props.options.filter((o) => {
      const hay = (o.searchText ?? `${o.label} ${o.value}`).toLowerCase()
      return hay.includes(q)
    })
  }, [props.options, query])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (value: string) => {
    props.onChange(value)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <input
        className={props.inputClassName ?? inputCls}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={props.disabled}
        placeholder={props.placeholder}
        value={query}
        onFocus={() => {
          if (!props.disabled) setOpen(true)
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (!e.target.value.trim() && props.allowEmpty) props.onChange('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false)
            setQuery(selected?.label ?? '')
          }
          if (e.key === 'Enter' && open && filtered.length === 1) {
            e.preventDefault()
            pick(filtered[0]!.value)
          }
        }}
      />
      {open && !props.disabled ? (
        <ul
          id={listId}
          className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-sm border border-border bg-white py-1 shadow-md"
        >
          {props.allowEmpty ? (
            <li>
              <button
                type="button"
                className="block w-full px-2.5 py-1.5 text-left text-il-page-desc text-text-3 hover:bg-[#fafbfd]"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick('')}
              >
                {props.emptyLabel ?? '—'}
              </button>
            </li>
          ) : null}
          {filtered.length === 0 ? (
            <li className="px-2.5 py-2 text-il-meta text-text-3">无匹配项</li>
          ) : (
            filtered.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  className={[
                    'block w-full px-2.5 py-1.5 text-left text-il-page-desc hover:bg-[#fafbfd]',
                    o.value === props.value ? 'bg-accent/5 font-medium text-accent' : 'text-text-2',
                  ].join(' ')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.value)}
                >
                  {o.label}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
