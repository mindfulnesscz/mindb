/* When does an asset's page previews need sweeping?
 *
 * Page objects appear in no URL column, so the mover cannot ask the row where they are — it probes
 * by attempting a copy from every level except the target and expecting three of four to miss. That
 * is the correct answer to "where is this page?" and the wrong question to ask about an asset whose
 * level never moved: the pages are already where they belong, and the probe is three round trips
 * per page that cannot succeed.
 *
 * It was the dominant cost of a run. `cdn_move_queue` was seeded with EVERY asset holding an object
 * (see 20260802090000) on the reasoning that "the cost of over-queueing is one no-op pass" — but a
 * no-op pass over a twenty-page deck is sixty round trips, serially, and the queue drains twenty-five
 * assets per call.
 *
 * The queue already records `was_level`, described there as "purely diagnostic". It is enough to
 * decide this, and the decision is deliberately conservative: sweep unless we can show the level did
 * not move, and that no earlier attempt could have left the pages split across two levels. A missed
 * sweep leaves a page readable at a WIDER level than its asset, which is the failure this whole
 * mechanism exists to prevent — so every uncertain case sweeps.
 */

export interface QueueEntry {
  /** The level when the row was queued. Null on INSERT — a brand-new row has no previous level. */
  wasLevel:  string | null;
  attempts:  number;
  lastError: string | null;
}

/**
 * True when the page objects must be probed across every level.
 *
 * Sweeps when:
 *  - there is no queue entry at all — the caller named this asset directly (the portal path), so
 *    nothing recorded where its bytes were;
 *  - `wasLevel` is null — an INSERT, whose objects may have been published at any level;
 *  - the level moved since queueing — the pages have to follow it;
 *  - an earlier attempt on this row failed. A partial pass moves some pages and deletes their
 *    sources while others stay put, so the pages can be SPLIT across two levels even though
 *    `wasLevel` matches the current one. That is the one case where "the level did not change"
 *    is true and sweeping is still required.
 */
export function needsPageSweep(level: string, entry: QueueEntry | undefined): boolean {
  if (!entry) return true;
  if (entry.wasLevel === null || entry.wasLevel === undefined) return true;
  if (entry.attempts > 0 || entry.lastError) return true;
  return entry.wasLevel !== level;
}
