/* Provider and token-status presentation, shared by the list and the form. */

import { tokenStatus } from '../../domain/client';
import type { DestType, CloudToken } from '../../domain/client';
import css from './CloudDestinations.module.css';

export function typeLabel(t: DestType): string {
  return t === 'local' ? 'Local' : t === 'dropbox' ? 'Dropbox' : t === 'onedrive' ? 'OneDrive' : 'Google Drive';
}

export function typeClass(t: DestType): string {
  return t === 'local' ? css.typeLocal : t === 'dropbox' ? css.typeDropbox : t === 'onedrive' ? css.typeOnedrive : css.typeGdrive;
}

export function statusClass(s: ReturnType<typeof tokenStatus>): string {
  return s === 'fresh' ? css.statusFresh : s === 'expiring' ? css.statusExpiring : s === 'expired' ? css.statusExpired : css.statusNone;
}

export function statusTitle(s: ReturnType<typeof tokenStatus>, token: CloudToken | null): string {
  if (!token) return 'Not connected';
  if (s === 'fresh')    return `Connected — ${token.email}`;
  if (s === 'expiring') return `Expires soon — ${token.email}`;
  if (s === 'expired')  return `Expired — reconnect needed`;
  return 'Not connected';
}

/** What the operator needs to have configured on the provider's side for the connect to work. */
export function credHint(type: DestType): string {
  if (type === 'dropbox')  return 'PKCE redirect URI: http://localhost:7623/callback';
  if (type === 'onedrive') return 'Enable public client flows in Azure; use tenant id for single-tenant apps.';
  return 'Add http://localhost:7623/callback as an authorised redirect URI. Client secret stays on this machine.';
}
