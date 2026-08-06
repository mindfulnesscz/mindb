/**
 * The tenant boundary for R2 credentials returned to an untrusted caller.
 *
 * Cloudflare applies `prefixes` as literal object-key prefixes. Public objects start with the
 * client UUID, while gated objects start with their effective access level and then the UUID.
 * Keep this aligned with `@sotto/domain`'s storageTarget() key shape.
 */

export type GrantPurpose = 'pipeline' | 'branding';
export type GrantTier = 'public' | 'gated';

const GATED_LEVELS = ['guest', 'client', 'internal'] as const;

export function grantPrefixes(
  clientId: string,
  purpose: GrantPurpose,
  tier: GrantTier,
): string[] {
  if (purpose === 'branding') {
    if (tier === 'gated') throw new Error('Branding grants have no gated tier');
    return [`branding/${clientId}/`];
  }

  if (tier === 'public') return [`${clientId}/`];
  return GATED_LEVELS.map(level => `${level}/${clientId}/`);
}

export interface TemporaryCredentialRequest {
  bucket: string;
  parentAccessKeyId: string;
  permission: 'object-read-write';
  ttlSeconds: number;
  prefixes: string[];
}

export function temporaryCredentialRequest(
  bucket: string,
  parentAccessKeyId: string,
  prefixes: string[],
  ttlSeconds: number,
): TemporaryCredentialRequest {
  if (prefixes.length === 0) throw new Error('Temporary credentials require at least one prefix');
  return {
    bucket,
    parentAccessKeyId,
    permission: 'object-read-write',
    ttlSeconds,
    prefixes,
  };
}

/** Mirrors Cloudflare's documented literal-prefix authorization for a regression-test oracle. */
export function grantAllowsKey(prefixes: readonly string[], objectKey: string): boolean {
  return prefixes.some(prefix => objectKey.startsWith(prefix));
}
