/* How loudly to render the environment in the build badge.
 *
 * Split out from BuildBadge.tsx so the rule is testable on its own — mislabelling staging as
 * production is exactly the confusion the badge exists to prevent.
 */

export type EnvTone = 'production' | 'staging' | 'local';

/**
 * Prefer the URL over the label: the environment name is user-editable free text, the project it
 * actually talks to is not. An unrecognised name is treated as staging rather than production —
 * the badge should over-warn, never reassure wrongly.
 */
export function environmentTone(name: string, supabaseUrl: string): EnvTone {
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(supabaseUrl.trim())) return 'local';
  if (/stag|preview|test/i.test(name)) return 'staging';
  if (/prod|live/i.test(name)) return 'production';
  return 'staging';
}
