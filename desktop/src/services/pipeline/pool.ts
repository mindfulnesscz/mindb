/* A bounded worker pool — the run's one way to do N things at a time.
 *
 * The pipeline's existing idiom is a chunked barrier: `for (i += 8) { await Promise.all(chunk) }`.
 * That caps concurrency, but every chunk waits for its slowest member, so one 500 MB upload holds
 * seven idle slots. This dispatches instead: `limit` workers pull from a shared cursor, and the
 * next item starts the moment a slot frees.
 *
 * Three properties the callers depend on:
 *
 *   - **Per-item error isolation.** A worker that throws marks THAT item rejected and keeps
 *     pulling. The pool itself never rejects — one bad row must not abort a phase, which is the
 *     accounting every write loop in `exportWrite.ts` already relies on.
 *   - **Outcomes are index-aligned with `items`**, so a caller can pair a result back to its input
 *     without threading an id through the worker.
 *   - **`shouldStop` is checked before every dispatch**, never mid-flight. Requests already in the
 *     air are allowed to finish (that is what the pipeline's cooperative Stop has always meant);
 *     items never dispatched come back `skipped` rather than silently looking successful.
 */

export type PoolOutcome<R> =
  | { status: 'fulfilled'; value: R }
  | { status: 'rejected'; reason: unknown }
  | { status: 'skipped' };

/**
 * Run `worker` over `items`, at most `limit` at a time.
 *
 * Resolves once every item has settled or been skipped. Returns one outcome per input item, in
 * input order — the ORDER OF COMPLETION is deliberately not reported, because nothing should
 * depend on it.
 */
export async function asyncPool<T, R>(
  limit: number,
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<Array<PoolOutcome<R>>> {
  const outcomes: Array<PoolOutcome<R>> = items.map(() => ({ status: 'skipped' }));
  if (!items.length) return outcomes;

  // Never more workers than there is work, and never fewer than one: a limit of 0 or NaN would
  // otherwise silently run nothing at all.
  const width = Math.min(Math.max(Math.floor(limit) || 1, 1), items.length);
  let next = 0;

  const drain = async (): Promise<void> => {
    while (next < items.length) {
      if (shouldStop?.()) return;
      const index = next++;
      try {
        outcomes[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => drain()));
  return outcomes;
}
