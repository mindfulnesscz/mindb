/**
 * Portal-managed export destinations (structure in clients.cloud_destinations).
 * OAuth tokens stay on desktop only — never written from the web.
 */
import { supabase } from '../lib/supabase'
import type { Role } from '@dc-hub/asset-library'

export type DestType = 'local' | 'dropbox' | 'onedrive' | 'gdrive'
/** Pipeline audience: internal tools vs client-facing share links. */
export type DestPipelineRole = 'internal' | 'client'

/**
 * Required base layout (exactly one).
 * - folders — preserve OUT-relative folder tree
 * - flat — dump files into one folder (share links; no nesting)
 *
 * Packages are optional via `includePackages` and nest *inside* the folder tree
 * (they are never a standalone dump at the target root).
 */
export type DestExportLayout = 'folders' | 'flat'

export type PortalDestConfig =
  | { type: 'local'; path: string }
  | { type: 'dropbox'; clientId: string; remotePath: string; token: null }
  | { type: 'onedrive'; clientId: string; tenantId: string; remotePath: string; token: null }
  | { type: 'gdrive'; clientId: string; clientSecret: ''; sharedDriveId: string; remotePath: string; token: null }

export interface PortalDestination {
  id: string
  name: string
  role: DestPipelineRole
  minRole: Role
  /** Required: folders or flat. */
  exportLayout: DestExportLayout
  /**
   * Optional. When true (and layout is folders), also copy source package folders
   * into the target at their nested relative paths — after / alongside the OUT tree.
   */
  includePackages: boolean
  generateLink: boolean
  showInPortal: boolean
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

/** Normalize layout + packages from current or legacy fields. */
export function resolveExportShape(raw: Record<string, unknown> | Partial<PortalDestination>): {
  exportLayout: DestExportLayout
  includePackages: boolean
} {
  const layoutRaw = (raw as { exportLayout?: unknown }).exportLayout
  // Legacy exclusive "packages" mode → folders + include packages
  if (layoutRaw === 'packages' || (raw as { exportPackages?: unknown }).exportPackages) {
    return { exportLayout: 'folders', includePackages: true }
  }
  const exportLayout: DestExportLayout =
    layoutRaw === 'flat' || (raw as { flatExport?: unknown }).flatExport
      ? 'flat'
      : 'folders'
  const includePackages =
    exportLayout === 'folders' && Boolean((raw as { includePackages?: unknown }).includePackages)
  return { exportLayout, includePackages }
}

export function makePortalDestination(partial: Partial<PortalDestination> = {}): PortalDestination {
  const shape = resolveExportShape(partial as Record<string, unknown>)
  return {
    id: crypto.randomUUID(),
    name: '',
    role: 'client',
    minRole: 'member',
    exportLayout: shape.exportLayout,
    includePackages: shape.includePackages,
    generateLink: true,
    showInPortal: true,
    allowRevealLocal: true,
    enabled: true,
    config: { type: 'gdrive', clientId: '', clientSecret: '', sharedDriveId: '', remotePath: '', token: null },
    ...partial,
    exportLayout: shape.exportLayout,
    includePackages: shape.includePackages,
  }
}

function normalizeDest(raw: Record<string, unknown>): PortalDestination {
  const config = (raw.config ?? { type: 'local', path: '' }) as PortalDestConfig
  const safeConfig: PortalDestConfig =
    config.type === 'local'
      ? { type: 'local', path: '' }
      : { ...config, token: null, ...(config.type === 'gdrive' ? { clientSecret: '' as const } : {}) }

  const shape = resolveExportShape(raw)
  return {
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? ''),
    role: (raw.role === 'internal' ? 'internal' : 'client'),
    minRole: (['public', 'member', 'editor', 'admin'].includes(String(raw.minRole))
      ? (raw.minRole as Role)
      : 'member'),
    exportLayout: shape.exportLayout,
    includePackages: shape.includePackages,
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
  const sanitized = destinations.map(d => {
    const shape = resolveExportShape(d as unknown as Record<string, unknown>)
    const {
      flatExport: _f,
      exportPackages: _p,
      ...rest
    } = d as PortalDestination & { flatExport?: boolean; exportPackages?: boolean }
    return {
      ...rest,
      exportLayout: shape.exportLayout,
      includePackages: shape.includePackages,
      config:
        d.config.type === 'local'
          ? { type: 'local' as const, path: '' }
          : { ...d.config, token: null, ...(d.config.type === 'gdrive' ? { clientSecret: '' } : {}) },
    }
  })
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
