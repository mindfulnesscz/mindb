/* The run summary, as data.
 *
 * These totals exist in the activity log as text — "CDN DONE — N uploaded · M cached · …" — buried
 * among hundreds of per-file lines. This rebuilds them from the stats so the operator can see what a
 * run did without scrolling.
 *
 * A section is listed only when it did something, so the panel says what happened rather than
 * printing nine zeroes after a thumbnails-only run.
 */

import type { RunStats, SupabaseSyncSummary } from '../../store/pipelineStore';

export interface SummaryRow { label: string; value: string }

export function buildSummaryRows(
  stats: RunStats, supabaseSync: SupabaseSyncSummary | null,
): SummaryRow[] {
  const rows: SummaryRow[] = [];

  if (stats.thumbnails > 0) {
    rows.push({ label: 'Thumbnails', value: `${stats.thumbnails} created` });
  }
  if (stats.cdnThumbUploaded || stats.cdnThumbCached || stats.cdnThumbUnchanged) {
    rows.push({
      label: 'CDN thumbnails',
      value: `${stats.cdnThumbUploaded} uploaded · ${stats.cdnThumbCached} cached · ${stats.cdnThumbUnchanged} unchanged`,
    });
  }
  if (stats.cdnOrigUploaded || stats.cdnOrigCached || stats.cdnOrigUnchanged) {
    rows.push({
      label: 'CDN originals',
      value: `${stats.cdnOrigUploaded} uploaded · ${stats.cdnOrigCached} cached · ${stats.cdnOrigUnchanged} unchanged`,
    });
  }
  if (stats.packages || stats.copied || stats.skipped) {
    rows.push({
      label: 'Distribute',
      value: `${stats.packages} packages · ${stats.copied} copied · ${stats.skipped} unchanged`,
    });
  }
  if (stats.published || stats.pubFolders) {
    rows.push({
      label: 'Publish',
      value: `${stats.published} files · ${stats.pubFolders} folders · ${stats.disconnected} disconnected`,
    });
  }
  if (supabaseSync) {
    rows.push({
      label: 'Supabase',
      value: `${supabaseSync.created} new · ${supabaseSync.updated} updated · ${supabaseSync.disconnected} disconnected`,
    });
    if (supabaseSync.errors) {
      rows.push({ label: '', value: `${supabaseSync.errors} errors` });
    }
  }
  if (stats.errors > 0) {
    rows.push({ label: 'Errors', value: `${stats.errors} total` });
  }

  return rows;
}
