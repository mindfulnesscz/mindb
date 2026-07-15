/** R2 object key prefixing — environment bucket, client-scoped paths. */

export function storageKey(prefix: string, key: string): string {
  if (!prefix) return key;
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return key.startsWith(p) ? key : `${p}${key.replace(/^\//, '')}`;
}
