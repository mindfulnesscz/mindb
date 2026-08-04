/* One client card on the admin landing grid. */

import { Client } from '@sotto/asset-library'
import {} from './LogoField'

export function AdminClientCard({ client, onNavigate, onEdit, canEdit }: {
  client: Client
  onNavigate: () => void
  onEdit: () => void
  canEdit: boolean
}) {
  return (
    <div
      className="relative group p-5 bg-surface border border-border hover:border-cosmos-black rounded-sm transition-colors cursor-pointer"
      onClick={onNavigate}
    >
      {canEdit && (
      <button
        onClick={e => { e.stopPropagation(); onEdit() }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-[11px] font-sans text-text-muted hover:text-cosmos-black transition-all px-2 py-1 rounded-chip border border-transparent hover:border-border"
      >
        Edit
      </button>
      )}

      {client.logoUrl ? (
        <img src={client.logoUrl} alt={client.name} className="w-10 h-10 rounded-[28%_38%] object-cover mb-3" />
      ) : (
        <div className="w-10 h-10 rounded-[28%_38%] flex items-center justify-center mb-3 text-sm font-bold font-sans text-clear-white" style={{ backgroundColor: client.accent }}>
          {client.initials}
        </div>
      )}

      <h3 className="font-sans text-base font-semibold text-cosmos-black mb-0.5">{client.name}</h3>

      {client.slug && (
        <p className="text-[11px] font-mono text-text-muted mb-0.5">/{client.slug}</p>
      )}
      {client.website && (
        <p className="text-[11px] font-sans text-text-subtle truncate">{client.website.replace(/^https?:\/\//, '')}</p>
      )}
      {client.domainWhitelist && client.domainWhitelist.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {client.domainWhitelist.slice(0, 3).map(d => (
            <span key={d} className="text-[10px] font-mono bg-gray-100 border border-border rounded-chip px-1.5 py-0.5">@{d}</span>
          ))}
          {client.domainWhitelist.length > 3 && (
            <span className="text-[10px] font-sans text-text-muted px-1 py-0.5">+{client.domainWhitelist.length - 3}</span>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-1 text-[11px] font-sans text-text-muted group-hover:text-cosmos-black transition-colors">
        <span>Open portal</span>
        <span>→</span>
      </div>
    </div>
  )
}

// ── Admin sign-in (full page, DC branded) ────────────────────

