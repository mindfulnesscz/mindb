/* Folder-based stable identity — the permanent match key for an asset, independent of
   filename/taxonomy renders. Suffix format: space + double underscore + 8 lowercase hex
   chars, e.g. "Product Launch __a1b2c3d4". Never inline this pattern elsewhere. */

export const ID_SUFFIX_PATTERN = / __([0-9a-f]{8})$/;

export function hasStableId(name: string): boolean {
  return ID_SUFFIX_PATTERN.test(name);
}

export function extractStableId(name: string): string | null {
  return name.match(ID_SUFFIX_PATTERN)?.[1] ?? null;
}

export function stripStableId(name: string): string {
  return name.replace(ID_SUFFIX_PATTERN, '');
}

export function appendStableId(name: string, hash: string): string {
  return `${stripStableId(name)} __${hash}`;
}

export function generateStableId(taken: Set<string>): string {
  let hash: string;
  do {
    hash = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  } while (taken.has(hash));
  taken.add(hash);
  return hash;
}
