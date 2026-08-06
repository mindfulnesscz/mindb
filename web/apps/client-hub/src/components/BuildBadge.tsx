/* Version + backend, pinned to the corner on every route.
 *
 * Shown to staff always, and to everyone whenever the backend is NOT production. The asymmetry is
 * the point: the portal is client-facing, so a build stamp is noise on a real client's gallery —
 * but a client looking at a staging deploy is a problem worth making loud for whoever is nearby.
 */

import { useRole } from '../context/RoleContext'
import { getConfig } from '../lib/supabase'
import { buildInfo } from '../lib/buildInfo'

const STAFF_ROLES = new Set(['editor', 'admin', 'super_admin'])

const TONE_CLASS = {
  production: 'bg-cosmos-black/70 text-clear-white/70 border-clear-white/15',
  staging: 'bg-[#B5871A] text-black border-black/20',
  local: 'bg-[#2B5BD7] text-white border-white/20',
} as const

export function BuildBadge() {
  const { role } = useRole()
  const { version, label, tone, backend } = buildInfo(getConfig().url)

  const isProduction = tone === 'production'
  if (isProduction && !STAFF_ROLES.has(role)) return null

  return (
    <div
      // pointer-events-none so it can never sit over a control; aria-hidden because it is a
      // developer affordance, not page content a screen reader should announce on every route.
      aria-hidden
      className={`pointer-events-none fixed bottom-2 left-2 z-50 select-none rounded border px-1.5 py-0.5
        font-sans text-[10px] font-semibold uppercase leading-none tracking-[0.08em]
        ${TONE_CLASS[tone]} ${isProduction ? 'opacity-50' : 'opacity-95'}`}
      title={`Sotto ${version} — ${label}\n${backend}`}
    >
      {label} · v{version}
    </div>
  )
}
