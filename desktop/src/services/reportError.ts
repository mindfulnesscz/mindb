/**
 * Single chokepoint for reporting caught errors, and the only place a raw `console.error` may live
 * (`no-console` is disabled for this file in eslint.config.js, which is what makes a bare one
 * anywhere else fail CI instead of quietly swallowing a failure).
 *
 * WHAT IT DOES, in order of how much it helps when a run fails on someone else's machine:
 *
 *   1. logs to the console, as before;
 *   2. attaches BREADCRUMBS — the stage headings the run emitted before this. "Storage grant refused"
 *      is not diagnosable; "after: COLLECTING → THUMBNAILS → CDN UPLOAD" is. A run touches the
 *      filesystem, three cloud providers, R2 and Postgres, so the useful question is almost always
 *      *where in the run*;
 *   3. appends to a rolling log file in the app data directory, because the console does not exist
 *      once this is a packaged binary — the operator has no devtools and no scrollback.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never throws and never returns a promise. Nearly every caller is a `.catch()` on a
 * fire-and-forget write, so a reporting failure must not become the error being reported. The file
 * sink is best effort and swallows its own failures — outside Tauri (tests, a browser preview) the
 * plugin calls simply reject, which is caught, and the console line has already gone out.
 */

import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

const BREADCRUMB_LIMIT = 12;
const LOG_FILE = 'errors.log';

/** Keeps the log bounded on a machine that runs the pipeline daily. */
const MAX_LOG_BYTES = 256 * 1024;

const breadcrumbs: string[] = [];

/**
 * Record where the run currently is. Fed by stage headings only — a trail of individual file copies
 * would push out the stage that actually matters.
 */
export function addBreadcrumb(note: string): void {
  const cleaned = note.replace(/[━]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  breadcrumbs.push(cleaned);
  if (breadcrumbs.length > BREADCRUMB_LIMIT) breadcrumbs.shift();
}

/** Oldest first. Exposed for the log line and for tests. */
export function recentBreadcrumbs(): string[] {
  return [...breadcrumbs];
}

export function clearBreadcrumbs(): void {
  breadcrumbs.length = 0;
}

export function reportError(context: string, err: unknown): void {
  const message = toMessage(err);
  console.error(`[${context}] ${message}`, err);
  void appendToLogFile(formatEntry(context, message));
}

/** One line per error: sortable, greppable, and carrying the trail that explains it. */
export function formatEntry(context: string, message: string, at = new Date()): string {
  const trail = breadcrumbs.length ? ` | after: ${breadcrumbs.join(' → ')}` : '';
  return `${at.toISOString()} [${context}] ${message}${trail}\n`;
}

async function appendToLogFile(entry: string): Promise<void> {
  try {
    const path = await join(await appDataDir(), LOG_FILE);

    // Truncate rather than rotate: this is a diagnostic tail, not an audit trail, and a second file to
    // reason about buys nothing. The errors being investigated are the recent ones.
    let existing = '';
    if (await exists(path)) {
      existing = await readTextFile(path);
      if (existing.length + entry.length > MAX_LOG_BYTES) {
        existing = existing.slice(-Math.floor(MAX_LOG_BYTES / 2));
        // Drop the partial first line, so the file always starts at a whole entry.
        existing = existing.slice(existing.indexOf('\n') + 1);
      }
    }
    await writeTextFile(path, existing + entry);
  } catch {
    // No Tauri (tests, a browser preview), or an unwritable directory. The console line already went
    // out; failing to also file it is not worth surfacing to the user.
  }
}

/**
 * Convenience for the common `catch (e) { ... String(e) }` pattern.
 *
 * Handles a real Error, a plain object carrying a string `message` (Supabase REST errors — `String()`
 * on those yields "[object Object]"), and anything else.
 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}
