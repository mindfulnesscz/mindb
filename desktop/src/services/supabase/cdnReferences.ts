/** A database row that can point at bytes in either R2 tier. */
export interface CdnReferenceRow {
  stable_id: string;
  child_id: string;
  thumbnail_url?: string | null;
  download_url?: string | null;
  download_key?: string | null;
}

/** Convert a stored CDN URL or raw download key into the object key used inside R2. */
export function objectKeyFromReference(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const path = value.includes('://') ? new URL(value).pathname : value;
    return decodeURIComponent(path).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

export interface CdnKeyReferenceIndex {
  references: Map<string, Set<string>>;
  /** False when a non-empty stored reference could not be parsed, so deletion must fail closed. */
  complete: boolean;
}

/**
 * Every live row that names an R2 key, indexed by that key.
 *
 * Owners matter, rather than just membership in a Set: an asset's own old URL is expected while
 * the upload is about to repoint it, but the same key named by a different row (notably a gallery
 * parent sharing its first child's media) must be retained.
 */
export function inspectCdnKeyReferences(
  rows: Iterable<CdnReferenceRow>,
): CdnKeyReferenceIndex {
  const references = new Map<string, Set<string>>();
  let complete = true;
  for (const row of rows) {
    const owner = `${row.stable_id}:${row.child_id}`;
    for (const value of [row.thumbnail_url, row.download_url, row.download_key]) {
      const key = objectKeyFromReference(value);
      if (!key) {
        if (value) complete = false;
        continue;
      }
      const owners = references.get(key) ?? new Set<string>();
      owners.add(owner);
      references.set(key, owners);
    }
  }
  return { references, complete };
}

export function indexCdnKeyReferences(
  rows: Iterable<CdnReferenceRow>,
): Map<string, Set<string>> {
  return inspectCdnKeyReferences(rows).references;
}
