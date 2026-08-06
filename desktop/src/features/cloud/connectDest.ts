/* Connecting a destination — the provider branch, the device-code wait, the identity check.
 *
 * Two things here are worth keeping out of a component:
 *
 *   CANCELLATION  the OneDrive device-code flow polls in a loop for up to fifteen minutes. If the
 *                 operator navigates away or hits Cancel, the loop must stop AND the result must be
 *                 discarded — a token that arrives after cancellation would be written into a form
 *                 the user already abandoned, silently connecting a destination they backed out of.
 *
 *   IDENTITY      a token alone does not tell the operator WHICH account they just connected. The
 *                 account is fetched immediately and attached, so the destination row can say
 *                 "connected as …" — the difference between a delivery landing in the client's drive
 *                 and in a staff member's personal one.
 *
 * `null` means cancelled. A throw means failed. They are different outcomes: only the second is an
 * error the operator should see.
 */

import {
  connectDropbox, checkDropboxConnection, refreshDropboxToken,
  startOneDriveDeviceCode, pollOneDriveToken, checkOneDriveConnection, refreshOneDriveToken,
  connectGDrive, checkGDriveConnection, refreshGDriveToken,
  type DeviceCodeInfo, delay,
} from '../../services/cloudService';
import type { DestConfig, CloudToken } from '../../domain/client';

export interface CancelSignal { cancelled: boolean }

export interface ConnectOptions {
  signal: CancelSignal;
  /** Called once the device code exists, so the UI can show it while polling continues. */
  onDeviceCode?: (info: DeviceCodeInfo) => void;
}

export async function connectDestination(
  cfg: DestConfig, { signal, onDeviceCode }: ConnectOptions,
): Promise<CloudToken | null> {
  if (cfg.type === 'local') return null;

  let token: CloudToken;

  if (cfg.type === 'dropbox') {
    token = await connectDropbox(cfg.clientId);
  } else if (cfg.type === 'onedrive') {
    const info = await startOneDriveDeviceCode(cfg.clientId, cfg.tenantId);
    onDeviceCode?.(info);
    token = null!;
    // Poll one interval SLOWER than Microsoft asks for: polling too fast earns a slow_down error
    // that costs more time than the extra second.
    const deadline   = Date.now() + info.expiresIn * 1000;
    const intervalMs = (info.interval + 1) * 1000;
    while (!signal.cancelled && !token && Date.now() < deadline) {
      await delay(intervalMs);
      if (signal.cancelled) return null;
      const result = await pollOneDriveToken(cfg.clientId, cfg.tenantId, info.deviceCode, signal);
      if (result) token = result;
    }
    if (!token) throw new Error('Authorization timed out or was cancelled.');
  } else {
    token = await connectGDrive(cfg.clientId, cfg.clientSecret);
  }

  if (signal.cancelled) return null;

  const info = cfg.type === 'dropbox'
    ? await checkDropboxConnection(token.accessToken)
    : cfg.type === 'onedrive'
      ? await checkOneDriveConnection(token.accessToken)
      : await checkGDriveConnection(token.accessToken);

  token.email       = info.email;
  token.displayName = info.displayName;
  return token;
}

/** Refresh through the provider that issued the token — never through another one's endpoint. */
export async function refreshDestinationToken(cfg: DestConfig): Promise<Partial<CloudToken>> {
  if (cfg.type === 'local' || !cfg.token) throw new Error('Nothing to refresh — not connected.');
  if (cfg.type === 'dropbox')  return refreshDropboxToken(cfg.clientId, cfg.token.refreshToken);
  if (cfg.type === 'onedrive') return refreshOneDriveToken(cfg.clientId, cfg.tenantId, cfg.token.refreshToken);
  return refreshGDriveToken(cfg.clientId, cfg.clientSecret, cfg.token.refreshToken);
}
