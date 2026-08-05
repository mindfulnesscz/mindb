/* Domain whitelist tag input.
 *
 * A domain here grants AUTOMATIC membership to anyone with an email at it, so this is an
 * authorization control, not a preference. Narrow client domains only — never a free-mail host.
 */

import { useState, useRef } from 'react'
import {} from '@dc-hub/asset-library'

export function DomainInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function add(raw: string) {
    const domain = raw.trim().toLowerCase().replace(/^@/, '')
    if (!domain || value.includes(domain)) { setDraft(''); return }
    onChange([...value, domain])
    setDraft('')
  }

  function remove(domain: string) { onChange(value.filter(d => d !== domain)) }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(draft) }
    else if (e.key === 'Backspace' && draft === '' && value.length > 0) onChange(value.slice(0, -1))
  }

  return (
    <div
      className="min-h-[38px] flex flex-wrap gap-1.5 items-center border border-border rounded-sm px-2 py-1.5 bg-bg focus-within:border-cosmos-black transition-colors cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(d => (
        <span key={d} className="flex items-center gap-1 text-[11px] font-mono bg-gray-100 border border-border rounded-chip px-2 py-0.5">
          {d}
          <button type="button" onClick={e => { e.stopPropagation(); remove(d) }} className="text-text-muted hover:text-cosmos-black leading-none">×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length === 0 ? 'acme.com, client.io…' : ''}
        className="flex-1 min-w-[120px] text-sm font-mono bg-transparent outline-none placeholder:text-text-subtle"
      />
    </div>
  )
}

// ── Client form helpers ───────────────────────────────────────

