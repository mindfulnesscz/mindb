/** Deployment-configured browser origins. Values are exact origins, never hostname patterns. */
export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  return allowedOrigins.has(origin);
}
