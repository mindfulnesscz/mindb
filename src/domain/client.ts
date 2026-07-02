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
  remotePath: string;
  token:      CloudToken | null;
}

export interface GDriveDestConfig {
  type:         'gdrive';
  clientId:     string;
  clientSecret: string;
  remotePath:   string;
  token:        CloudToken | null;
}

export type DestConfig =
  | LocalDestConfig
  | DropboxDestConfig
  | OneDriveDestConfig
  | GDriveDestConfig;

export interface CloudDestination {
  id:           string;
  name:         string;
  role:         DestRole;
  flatExport:   boolean;
  generateLink: boolean;
  config:       DestConfig;
}

export interface Client {
  id:                string;
  name:              string;
  logoDataUrl:       string | null;
  brandColor:        string;
  sourceFolder:      string;
  targetFolder:      string;
  vaultFolder:       string;
  cloudDestinations: CloudDestination[];
  // Supabase DAM sync
  supabaseUrl:        string;  // https://<project>.supabase.co
  supabaseServiceKey: string;  // service_role key — used by pipeline (bypasses RLS)
  supabaseAnonKey:    string;  // anon key — used by the web portal
  // Cloudflare R2 CDN
  r2Endpoint:        string;  // https://{account}.r2.cloudflarestorage.com
  r2AccessKeyId:     string;
  r2SecretKey:       string;
  r2Bucket:          string;  // bucket name, e.g. dc-hub-ess
  r2PublicDomain:    string;  // public-facing domain, e.g. https://cdn.disruptcollective.com
}

export function makeClient(partial: Partial<Client> = {}): Client {
  return {
    id:                crypto.randomUUID(),
    name:              '',
    logoDataUrl:       null,
    brandColor:        '#161616',
    sourceFolder:      '',
    targetFolder:      '',
    vaultFolder:       '',
    cloudDestinations:  [],
    supabaseUrl:        '',
    supabaseServiceKey: '',
    supabaseAnonKey:    '',
    r2Endpoint:         '',
    r2AccessKeyId:     '',
    r2SecretKey:       '',
    r2Bucket:          '',
    r2PublicDomain:    '',
    ...partial,
  };
}

export function makeDestination(partial: Partial<CloudDestination> = {}): CloudDestination {
  return {
    id:           crypto.randomUUID(),
    name:         '',
    role:         'internal',
    flatExport:   false,
    generateLink: false,
    config:       { type: 'local', path: '' },
    ...partial,
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
