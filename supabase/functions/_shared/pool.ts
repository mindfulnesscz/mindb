/* Bounded concurrency for edge functions.
 *
 * `cdn-reconcile` awaited every R2 request one at a time — a queued document issues one probe per
 * page per level, so a batch of twenty-five assets spent twenty seconds doing nothing but waiting,
 * and the desktop run waited with it. Latency, not work.
 *
 * A SECOND COPY of `desktop/src/services/pipeline/pool.ts`, deliberately. These functions run on
 * Deno with no bundler and no access to the workspace's node_modules, so importing the desktop's
 * helper is not possible; the alternative is a shared package the edge runtime would have to mount,
 * and `project_edge_runtime_mounts` is the note about what that costs. Twenty lines is the cheaper
 * duplication. Keep them behaviourally identical.
 *
 * Unbounded `Promise.all` is what this exists to avoid: each in-flight copy of a cross-bucket move
 * holds a whole object in the function's memory, so the limit is a memory bound as much as a
 * politeness one.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, resolving to the results **in input order**
 * however they finish. Rejections propagate — callers that must not abandon their siblings catch
 * inside `fn`, exactly as the serial loop this replaces did.
 */
export async function mapPool<T, R>(
  limit: number,
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  // Each worker pulls the next index the moment it frees, so one slow item cannot idle the others —
  // the property a chunked `Promise.all` barrier does not have.
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
