/**
 * Portal-managed export destinations (structure in clients.cloud_destinations).
 * OAuth tokens stay on desktop only — never written from the web.
 */
import { supabase } from '../lib/supabase'
import type { Role } from '@dc-hub/asset-library'

export type DestType = 'local' | 'dropbox' | 'onedrive' | 'gdrive'
/** Pipeline audience: internal tools vs client-facing share links. */
export type DestPipelineRole = 'internal' | 'client'

export type PortalDestConfig =
  | { type: 'local'; path: string }
  | { type: 'dropbox'; clientId: string; remotePath: string; token: null }
  | { type: 'onedrive'; clientId: string; tenantId: string; remotePath: string; token: null }
  | { type: 'gdrive'; clientId: string; clientSecret: ''; sharedDriveId: string; remotePath: string; token: null }

export interface PortalDestination {
  id: string
  name: string
  /** Pipeline: internal export vs client share. */
  role: DestPipelineRole
  /** Minimum hub role that may see this destination's links in the portal. */
  minRole: Role
  flatExport: boolean
  generateLink: boolean
  /** Show sharing links from this dest on asset detail. */
  showInPortal: boolean
  /** Allow "Reveal in Finder" for roles ≥ minRole (desktop bridge). */
  allowRevealLocal: boolean
  enabled: boolean
  config: PortalDestConfig
}

const ROLE_RANK: Record<Role, number> = {
  public: 0,
  member: 1,
  editor: 2,
  admin: 3,
}

export function roleAtLeast(user: Role, min: Role): boolean {
  return ROLE_RANK[user] >= ROLE_RANK[min]
}

export function makePortalDestination(partial: Partial<PortalDestination> = {}): PortalDestination {
  return {
    id: crypto.randomUUID(),
    name: '',
    role: 'client',
    minRole: 'member',
    flatExport: false,
    generateLink: true,
    showInPortal: true,
    allowRevealLocal: false,
    enabled: true,
    config: { type: 'gdrive', clientId: '', clientSecret: '', sharedDriveId: '', remotePath: '', token: null },
    ...partial,
  }
}

function normalizeDest(raw: Record<string, unknown>): PortalDestination {
  const config = (raw.config ?? { type: 'local', path: '' }) as PortalDestConfig
  // Strip any leaked tokens from older pushes
  const safeConfig: PortalDestConfig =
    config.type === 'local'
      ? config
      : { ...config, token: null, ...(config.type === 'gdrive' ? { clientSecret: '' as const } : {}) }

  return {
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? ''),
    role: (raw.role === 'internal' ? 'internal' : 'client'),
    minRole: (['public', 'member', 'editor', 'admin'].includes(String(raw.minRole))
      ? (raw.minRole as Role)
      : 'member'),
    flatExport: Boolean(raw.flatExport),
    generateLink: raw.generateLink !== false,
    showInPortal: raw.showInPortal !== false,
    allowRevealLocal: Boolean(raw.allowRevealLocal),
    enabled: raw.enabled !== false,
    config: safeConfig,
  }
}

export async function fetchDestinations(clientId: string): Promise<PortalDestination[]> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase
    .from('clients')
    .select('cloud_destinations')
    .eq('id', clientId)
    .single()
  if (error) throw new Error(error.message)
  const raw = (data as { cloud_destinations?: unknown } | null)?.cloud_destinations
  if (!Array.isArray(raw)) return []
  return raw.map(d => normalizeDest(d as Record<string, unknown>))
}

export async function saveDestinations(clientId: string, destinations: PortalDestination[]): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const sanitized = destinations.map(d => ({
    ...d,
    config:
      d.config.type === 'local'
        ? d.config
        : { ...d.config, token: null, ...(d.config.type === 'gdrive' ? { clientSecret: '' } : {}) },
  }))
  const { error } = await supabase
    .from('clients')
    .update({ cloud_destinations: sanitized as never })
    .eq('id', clientId)
  if (error) throw new Error(error.message)
}

export function destinationsVisibleToRole(
  dests: PortalDestination[],
  role: Role,
): PortalDestination[] {
  return dests.filter(
    d => d.enabled && d.showInPortal && roleAtLeast(role, d.minRole),
  )
}
