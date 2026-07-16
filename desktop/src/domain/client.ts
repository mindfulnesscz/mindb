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

export interface CloudDestination {
  id:           string;
  name:         string;
  role:         DestRole;
  /** Minimum hub role that may see this destination's share links in the portal. */
  minRole:      HubRole;
  flatExport:   boolean;
  generateLink: boolean;
  /** Show sharing links from this dest on asset detail in the portal. */
  showInPortal: boolean;
  /** Allow "Reveal in Finder" for roles ≥ minRole (desktop localhost bridge). */
  allowRevealLocal: boolean;
  enabled:      boolean;   // whether this destination is checked for pipeline runs; missing/legacy = enabled
  config:       DestConfig;
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
  return {
    id:               crypto.randomUUID(),
    name:             '',
    role:             'internal',
    minRole:          'member',
    flatExport:       false,
    generateLink:     false,
    showInPortal:     true,
    allowRevealLocal: true,
    enabled:          true,
    config:           { type: 'local', path: '' },
    ...partial,
  };
}

/** Normalize portal / legacy JSON into a full CloudDestination. */
export function normalizeDestination(raw: Partial<CloudDestination> & { id?: string }): CloudDestination {
  const base = makeDestination(raw);
  return {
    ...base,
    minRole:          (['public', 'member', 'editor', 'admin'] as HubRole[]).includes(raw.minRole as HubRole)
      ? (raw.minRole as HubRole)
      : 'member',
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
