/* Client domain — client config, cloud destinations, OAuth token types */

export type DestType = 'local' | 'dropbox' | 'onedrive' | 'gdrive';
export type DestRole = 'internal' | 'client';

export interface CloudToken {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number;   // Unix ms
  email:        string;
  displayName:  string;
}

export interface LocalDestConfig {
  type: 'local';
  path: string;
}

export interface DropboxDestConfig {
  type:       'dropbox';
  clientId:   string;
  remotePath: string;
  token:      CloudToken | null;
}

export interface OneDriveDestConfig {
  type:       'onedrive';
  clientId:   string;
  tenantId:   string;   // Azure AD tenant GUID, or 'common' for multi-tenant/personal apps
  remotePath: string;
  token:      CloudToken | null;
}

export interface GDriveDestConfig {
  type:          'gdrive';
  clientId:      string;
  clientSecret:  string;
  sharedDriveId: string;   // Shared Drive ID, or '' to use the signed-in account's own My Drive
  remotePath:    string;
  token:         CloudToken | null;
}

export type DestConfig =
  | LocalDestConfig
  | DropboxDestConfig
  | OneDriveDestConfig
  | GDriveDestConfig;

export type HubRole = 'public' | 'member' | 'editor' | 'admin';

/**
 * Required base layout.
 * - folders — preserve OUT-relative folder tree
 * - flat — dump files into one folder
 * Packages are optional via includePackages (nested inside folders — never root-only).
 */
export type DestExportLayout = 'folders' | 'flat';

export interface CloudDestination {
  id:           string;
  name:         string;
  role:         DestRole;
  minRole:      HubRole;
  exportLayout: DestExportLayout;
  /** When true with folders layout, also mirror package folders at nested source paths. */
  includePackages: boolean;
  generateLink: boolean;
  showInPortal: boolean;
  allowRevealLocal: boolean;
  enabled:      boolean;
  config:       DestConfig;
}

export function resolveExportShape(
  raw: Partial<CloudDestination> & {
    flatExport?: boolean;
    exportPackages?: boolean;
    exportLayout?: DestExportLayout | 'packages' | string;
    includePackages?: boolean;
  },
): { exportLayout: DestExportLayout; includePackages: boolean } {
  if (raw.exportLayout === 'packages' || raw.exportPackages) {
    return { exportLayout: 'folders', includePackages: true };
  }
  const exportLayout: DestExportLayout =
    raw.exportLayout === 'flat' || raw.flatExport ? 'flat' : 'folders';
  const includePackages = exportLayout === 'folders' && Boolean(raw.includePackages);
  return { exportLayout, includePackages };
}

/** @deprecated Prefer resolveExportShape — kept for call sites that only need layout. */
export function resolveExportLayout(
  raw: Partial<CloudDestination> & { flatExport?: boolean; exportPackages?: boolean; exportLayout?: string },
): DestExportLayout {
  return resolveExportShape(raw).exportLayout;
}

export interface Client {
  id:                string;
  name:              string;
  slug?:             string;
  logoUrl?:          string | null;
  brandColor:        string;
  sourceFolder:      string;
  targetFolder:      string;
  vaultFolder:       string;
  cloudDestinations: CloudDestination[];
  supabaseUrl:        string;
  supabaseAnonKey:    string;
  identityMigrated:  boolean;
  lastCreationFolder: string;
  dimensionLabels?:  { entity: string; angle: string; format: string };
}

export function makeClient(partial: Partial<Client> = {}): Client {
  return {
    id:                crypto.randomUUID(),
    name:              '',
    logoUrl:           null,
    brandColor:        '#161616',
    sourceFolder:      '',
    targetFolder:      '',
    vaultFolder:       '',
    cloudDestinations:  [],
    supabaseUrl:        '',
    supabaseAnonKey:    '',
    identityMigrated:  false,
    lastCreationFolder: '',
    dimensionLabels:   { entity: 'Entity', angle: 'Angle', format: 'Format' },
    ...partial,
  };
}

export function makeDestination(partial: Partial<CloudDestination> = {}): CloudDestination {
  const shape = resolveExportShape(partial);
  const { exportLayout: _el, includePackages: _ip, ...rest } = partial;
  return {
    id:               crypto.randomUUID(),
    name:             '',
    role:             'internal',
    minRole:          'member',
    generateLink:     false,
    showInPortal:     true,
    allowRevealLocal: true,
    enabled:          true,
    config:           { type: 'local', path: '' },
    ...rest,
    // Always resolve layout from partial (maps legacy packages/flatExport).
    exportLayout:     shape.exportLayout,
    includePackages:  shape.includePackages,
  };
}

/** Normalize portal / legacy JSON into a full CloudDestination. */
export function normalizeDestination(raw: Partial<CloudDestination> & {
  id?: string;
  flatExport?: boolean;
  exportPackages?: boolean;
}): CloudDestination {
  const shape = resolveExportShape(raw);
  const base = makeDestination(raw);
  return {
    ...base,
    minRole:          (['public', 'member', 'editor', 'admin'] as HubRole[]).includes(raw.minRole as HubRole)
      ? (raw.minRole as HubRole)
      : 'member',
    exportLayout:     shape.exportLayout,
    includePackages:  shape.includePackages,
    showInPortal:     raw.showInPortal !== false,
    allowRevealLocal: Boolean(raw.allowRevealLocal),
    enabled:          raw.enabled !== false,
  };
}

export function clientInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

export function tokenStatus(token: CloudToken | null): 'none' | 'fresh' | 'expiring' | 'expired' {
  if (!token?.accessToken) return 'none';
  const now = Date.now();
  if (token.expiresAt < now) return 'expired';
  if (token.expiresAt < now + 60 * 60 * 1000) return 'expiring';
  return 'fresh';
}

export function cloudToken(config: DestConfig): CloudToken | null {
  if (config.type === 'local') return null;
  return config.token;
}
