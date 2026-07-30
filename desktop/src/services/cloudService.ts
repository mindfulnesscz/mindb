/* Cloud storage — the token-refresh dispatcher, and the module every consumer imports.
 *
 * One file per provider under ./cloud/, because they share almost nothing but a shape:
 *
 *   oauth     PKCE + the loopback callback (Dropbox, Drive)
 *   dropbox   PKCE auth; upload delegated to Rust, which owns the chunked-session split
 *   onedrive  DEVICE CODE auth (not PKCE); SharePoint vs personal drive; 4 MiB session threshold
 *   gdrive    PKCE auth; folders are ids not paths, so every upload resolves the path first
 *
 * `refreshCloudToken` is the one thing that must know about all three: it is called with whatever
 * destination config a client happens to hold, and dispatching to the wrong provider would try to
 * refresh with another provider's credentials.
 */

import type { CloudToken } from '../domain/client';
import { refreshDropboxToken } from './cloud/dropbox';
import { refreshOneDriveToken } from './cloud/onedrive';
import { refreshGDriveToken } from './cloud/gdrive';

export { delay } from './cloud/oauth';

export {
  connectDropbox, refreshDropboxToken, checkDropboxConnection, uploadDropboxFile,
} from './cloud/dropbox';

export {
  startOneDriveDeviceCode, pollOneDriveToken, refreshOneDriveToken, checkOneDriveConnection,
  resolveSharePointDrive, uploadOneDriveFile, graphDriveBase,
  type DeviceCodeInfo,
} from './cloud/onedrive';

export {
  connectGDrive, refreshGDriveToken, checkGDriveConnection, uploadGDriveFile,
} from './cloud/gdrive';

export async function refreshCloudToken(
  config: { type: string; clientId?: string; tenantId?: string; clientSecret?: string; token: CloudToken | null },
): Promise<Partial<CloudToken>> {
  if (!config.token?.refreshToken) throw new Error('No refresh token available.');
  const { type, clientId = '', tenantId = 'common', token } = config;
  if (type === 'dropbox')  return refreshDropboxToken(clientId, token.refreshToken);
  if (type === 'onedrive') return refreshOneDriveToken(clientId, tenantId, token.refreshToken);
  if (type === 'gdrive')   return refreshGDriveToken(clientId, (config as { clientSecret: string }).clientSecret ?? '', token.refreshToken);
  throw new Error(`Unknown provider: ${type}`);
}

