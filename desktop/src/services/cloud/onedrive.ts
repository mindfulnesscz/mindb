/* OneDrive / SharePoint: device-code auth, drive resolution, upload.
 *
 * OneDrive uses the DEVICE CODE flow, not PKCE — the others redirect to a loopback, this one shows a
 * code the user types into microsoft.com. Different shape, same outcome.
 * 
 * `graphDriveBase` decides between a SharePoint document library and the signed-in user's own drive; a
 * wrong answer uploads a client's deliverables into the wrong drive entirely.
 * 
 * Files over 4 MiB need an upload session, and its chunks must be a multiple of 320 KiB — Graph
 * rejects anything else, so ONEDRIVE_CHUNK is not an arbitrary tuning value.
 */

import { invoke } from '@tauri-apps/api/core';
import type { CloudToken } from '../../domain/client';

export interface DeviceCodeInfo {
  deviceCode:      string;
  userCode:        string;
  verificationUri: string;
  expiresIn:       number;
  interval:        number;
  message:         string;
}

// Uses Rust/reqwest commands — WKWebView fetch() to Microsoft's device-code
// endpoints fails with "TypeError: Load failed" because those endpoints don't
// send CORS headers for the tauri://localhost origin.
//
// tenantId: pass 'common' for multi-tenant/personal apps, or the Azure AD
// tenant GUID for single-tenant ("My organization only") app registrations —
// those reject `/common` with AADSTS50059.
export async function startOneDriveDeviceCode(clientId: string, tenantId: string): Promise<DeviceCodeInfo> {
  return invoke<DeviceCodeInfo>('onedrive_device_code', { clientId, tenantId });
}

export async function pollOneDriveToken(
  clientId:   string,
  tenantId:   string,
  deviceCode: string,
  _intervalSecs: number,
  signal: { cancelled: boolean },
): Promise<CloudToken | null> {
  const result = await invoke<{ accessToken: string; refreshToken: string; expiresIn: number } | null>(
    'onedrive_poll_token',
    { clientId, tenantId, deviceCode },
  );

  if (signal.cancelled) return null;
  if (!result) return null;

  return {
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt:    Date.now() + result.expiresIn * 1000,
    email:        '',
    displayName:  '',
  };
}

export async function refreshOneDriveToken(
  clientId: string,
  tenantId: string,
  refreshToken: string,
): Promise<Partial<CloudToken>> {
  const result = await invoke<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    'onedrive_refresh_token',
    { clientId, tenantId, refreshToken },
  );
  return {
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt:    Date.now() + result.expiresIn * 1000,
  };
}

export async function checkOneDriveConnection(accessToken: string): Promise<{ email: string; displayName: string }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('OneDrive connection check failed — token may be invalid.');
  const json = await res.json();
  return {
    email:       json.mail ?? json.userPrincipalName ?? '',
    displayName: json.displayName ?? '',
  };
}


export const ONEDRIVE_SIMPLE_MAX = 4 * 1024 * 1024;
// Upload-session chunks must be a multiple of 320 KiB; 10 MiB is a safe size.
export const ONEDRIVE_CHUNK = 10 * 1024 * 1024;

/** Graph item base for a drive: a SharePoint/OneDrive-for-Business drive, or the
 *  signed-in user's own drive when no driveId is configured. */
export function graphDriveBase(driveId?: string): string {
  return driveId && driveId.trim()
    ? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId.trim())}`
    : 'https://graph.microsoft.com/v1.0/me/drive';
}

/** Resolve a SharePoint site URL to its default document-library drive ID.
 *  Accepts e.g. https://contoso.sharepoint.com/sites/Clients */

export async function resolveSharePointDrive(
  accessToken: string,
  siteUrl:     string,
): Promise<{ driveId: string; driveName: string }> {
  const u = new URL(siteUrl.trim());
  const hostname = u.hostname;
  const sitePath = u.pathname.replace(/^\/+|\/+$/g, ''); // e.g. "sites/Clients"
  const siteRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}:/${sitePath}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!siteRes.ok) throw new Error(`Could not find SharePoint site (${siteRes.status}): ${await siteRes.text()}`);
  const site = await siteRes.json() as { id?: string };
  if (!site.id) throw new Error('SharePoint site lookup returned no id.');

  const drivesRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${site.id}/drives`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!drivesRes.ok) throw new Error(`Could not list document libraries (${drivesRes.status}).`);
  const drives = (await drivesRes.json() as { value?: { id: string; name: string }[] }).value ?? [];
  if (drives.length === 0) throw new Error('No document libraries found on that site.');
  // Prefer the default "Documents" library; fall back to the first.
  const doc = drives.find(d => d.name === 'Documents') ?? drives[0];
  return { driveId: doc.id, driveName: doc.name };
}

async function onedriveCreateLink(
  driveBase:   string,
  encodedPath: string,
  accessToken: string,
): Promise<string | null> {
  // Corporate tenants usually block anonymous links; fall back to organization.
  for (const scope of ['anonymous', 'organization'] as const) {
    const res = await fetch(
      `${driveBase}/root:/${encodedPath}:/createLink`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'view', scope }),
      },
    );
    if (res.ok) {
      const data = await res.json() as { link?: { webUrl?: string } };
      if (data.link?.webUrl) return data.link.webUrl;
    }
  }
  return null;
}

export async function uploadOneDriveFile(
  accessToken: string,
  bytes:        Uint8Array<ArrayBuffer>,
  remotePath:   string,   // e.g. "DC Hub/ESS/file.pdf"
  getLink:      boolean,
  driveId?:     string,   // SharePoint/OneDrive-for-Business drive; empty → /me/drive
): Promise<string | null> {
  const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
  const driveBase   = graphDriveBase(driveId);

  if (bytes.byteLength <= ONEDRIVE_SIMPLE_MAX) {
    const uploadRes = await fetch(
      `${driveBase}/root:/${encodedPath}:/content`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
        body:    bytes,
      },
    );
    if (!uploadRes.ok) throw new Error(`OneDrive upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  } else {
    // Large file → resumable upload session (chunked).
    const sessionRes = await fetch(
      `${driveBase}/root:/${encodedPath}:/createUploadSession`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      },
    );
    if (!sessionRes.ok) throw new Error(`OneDrive upload session failed (${sessionRes.status}): ${await sessionRes.text()}`);
    const { uploadUrl } = await sessionRes.json() as { uploadUrl: string };

    const total = bytes.byteLength;
    for (let start = 0; start < total; start += ONEDRIVE_CHUNK) {
      const end   = Math.min(start + ONEDRIVE_CHUNK, total);
      const chunk = bytes.subarray(start, end);
      const putRes = await fetch(uploadUrl, {
        method:  'PUT',
        headers: {
          'Content-Length': String(chunk.byteLength),
          'Content-Range':  `bytes ${start}-${end - 1}/${total}`,
        },
        body: chunk,
      });
      // 202 = chunk accepted; 200/201 = final chunk, upload complete.
      if (putRes.status !== 202 && putRes.status !== 200 && putRes.status !== 201) {
        throw new Error(`OneDrive chunk upload failed (${putRes.status}): ${await putRes.text()}`);
      }
    }
  }

  if (!getLink) return null;
  return onedriveCreateLink(driveBase, encodedPath, accessToken);
}

