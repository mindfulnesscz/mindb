/* Pooled row writes must be indistinguishable from the serial ones they replaced.
 *
 * `writeParents`/`writeChildren` used to await one PostgREST round trip per row. They now dispatch
 * WRITE_CONCURRENCY at a time, so responses can land in ANY order — which makes the properties worth
 * pinning the ones that must not depend on that order: the created/updated/error tallies, the
 * key → uuid map children are wired from, and per-row error isolation.
 *
 * The stub below therefore resolves out of order ON PURPOSE, from a fixed pseudo-random tick count
 * so the shuffle is reproducible rather than flaky.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const stub = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; body: Record<string, unknown> | null }>,
  /** URLs matching this answer 400, to exercise the per-row failure path. */
  failUrlMatching: null as RegExp | null,
  /** URLs matching this throw, i.e. the transport itself died. */
  throwUrlMatching: null as RegExp | null,
  live: 0,
  peak: 0,
  seq: 0,
  ids: 0,
}));

vi.mock('./rest', () => ({
  BATCH: 500,
  sbFetch: async (
    url: string,
    options: { method?: string; headers: Record<string, string>; body?: string },
  ) => {
    const method = options.method ?? 'GET';
    stub.calls.push({
      url, method,
      body: options.body ? (JSON.parse(options.body) as Record<string, unknown>) : null,
    });
    if (stub.throwUrlMatching?.test(url)) throw new Error('transport died');

    // Deterministic out-of-order completion: 0–5 microtask ticks plus a macrotask, so later
    // dispatches routinely settle before earlier ones.
    stub.live++;
    stub.peak = Math.max(stub.peak, stub.live);
    const ticks = (stub.seq++ * 7) % 6;
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    stub.live--;

    if (stub.failUrlMatching?.test(url)) {
      return {
        ok: false, status: 400,
        text: async () => 'simulated failure',
        json: async <T>() => ({}) as T,
      };
    }
    const created = [{ id: `row-${++stub.ids}` }];
    return {
      ok: true, status: method === 'POST' ? 201 : 204,
      text: async () => JSON.stringify(created),
      json: async <T>() => created as unknown as T,
    };
  },
}));

const { writeParents, writeChildren, WRITE_CONCURRENCY } = await import('./exportWrite');
import type { ChildWrite, ParentWrite, StableRow, SupabaseExportResult } from './exportTypes';

const BASE = 'https://test.supabase.co/rest/v1';
const HEADERS = { apikey: 'anon' };

const emptyResult = (): SupabaseExportResult =>
  ({ created: 0, updated: 0, disconnected: 0, errors: 0, staleObjectKeys: [] });

const parentAt = (n: number): ParentWrite => ({
  key: `s${n}:c1`,
  record: {
    stable_id: `s${n}`, child_id: 'c1', name: `Asset ${n}`, thumbnail_url: `t${n}`,
    perm: 'client', // portal-owned once the row exists — dropped from PATCH, kept on POST
  },
});

const childAt = (n: number): ChildWrite => ({
  key: `s${n}:c2`,
  record: { stable_id: `s${n}`, child_id: 'c2', name: `Variant ${n}` },
  parentKey: `s${n}:c1`,
  relation: 'variant_of',
});

const existingParent = (n: number): [string, StableRow] => [`s${n}:c1`, {
  id: `db-${n}`, stable_id: `s${n}`, child_id: 'c1',
  thumbnail_url: null, parent_id: null, variant_of: null,
}];

beforeEach(() => {
  stub.calls = [];
  stub.failUrlMatching = null;
  stub.throwUrlMatching = null;
  stub.live = 0;
  stub.peak = 0;
  stub.seq = 0;
  stub.ids = 0;
});

describe('writeParents — pooled', () => {
  it('tallies and maps 20 rows identically however the responses land', async () => {
    // Even keys already exist (PATCH → updated), odd ones do not (POST → created).
    const parents = Array.from({ length: 20 }, (_, i) => parentAt(i));
    const existing = new Map<string, StableRow>(
      Array.from({ length: 10 }, (_, i) => existingParent(i * 2)),
    );
    const result = emptyResult();
    const logs: string[] = [];

    const parentIdByKey = await writeParents(
      parents, existing, BASE, HEADERS, result, (_type, msg) => logs.push(msg),
    );

    expect(result).toMatchObject({ created: 10, updated: 10, errors: 0 });
    expect(logs).toEqual([]);

    // Every key resolved, an updated row to its own uuid and a created row to a distinct new one.
    expect([...parentIdByKey.keys()].sort()).toEqual(parents.map(p => p.key).sort());
    for (let i = 0; i < 20; i += 2) expect(parentIdByKey.get(`s${i}:c1`)).toBe(`db-${i}`);
    expect(new Set(parentIdByKey.values()).size).toBe(20);

    // Rows created this run join `existing`, so a later resolution updates rather than re-inserts.
    expect(existing.size).toBe(20);
    expect(existing.get('s1:c1')).toMatchObject({ stable_id: 's1', child_id: 'c1', thumbnail_url: 't1' });

    // Still one request per row, and still only PATCH or POST — never a bulk upsert.
    expect(stub.calls).toHaveLength(20);
    expect(stub.calls.filter(c => c.method === 'PATCH')).toHaveLength(10);
    expect(stub.calls.filter(c => c.method === 'POST')).toHaveLength(10);
    // The PATCH bodies still omit `perm` (stripPortalOwnedFields) and the POSTs still carry it.
    for (const call of stub.calls) {
      if (call.method === 'PATCH') expect(call.body).not.toHaveProperty('perm');
      else expect(call.body).toHaveProperty('perm', 'client');
    }
  });

  it('runs exactly WRITE_CONCURRENCY rows at a time', async () => {
    await writeParents(
      Array.from({ length: 20 }, (_, i) => parentAt(i)),
      new Map(), BASE, HEADERS, emptyResult(), () => {},
    );
    expect(stub.peak).toBe(WRITE_CONCURRENCY);
  });

  it('isolates one failed row — the other 19 still land, and it resolves no parent uuid', async () => {
    const existing = new Map<string, StableRow>([existingParent(3)]);
    stub.failUrlMatching = /id=eq\.db-3/;
    const result = emptyResult();
    const logs: string[] = [];

    const parentIdByKey = await writeParents(
      Array.from({ length: 20 }, (_, i) => parentAt(i)),
      existing, BASE, HEADERS, result, (_type, msg) => logs.push(msg),
    );

    expect(result).toMatchObject({ created: 19, updated: 0, errors: 1 });
    expect(parentIdByKey.has('s3:c1')).toBe(false);
    expect(parentIdByKey.size).toBe(19);
    expect(logs).toEqual(['  ✕  Stable update failed for s3:c1: simulated failure']);
  });

  it('counts a transport throw as one error per row, not as a phase abort', async () => {
    stub.throwUrlMatching = /assets$/; // every POST throws
    const result = emptyResult();
    const logs: string[] = [];

    await writeParents(
      Array.from({ length: 5 }, (_, i) => parentAt(i)),
      new Map(), BASE, HEADERS, result, (_type, msg) => logs.push(msg),
    );

    expect(result).toMatchObject({ created: 0, errors: 5 });
    expect(logs).toHaveLength(5);
    expect(logs.every(msg => msg.includes('Stable write error'))).toBe(true);
  });

  it('stops dispatching on the stop signal, leaving the rest unwritten', async () => {
    const result = emptyResult();

    await writeParents(
      Array.from({ length: 40 }, (_, i) => parentAt(i)),
      new Map(), BASE, HEADERS, result, () => {},
      () => stub.calls.length >= WRITE_CONCURRENCY,
    );

    // The first dispatches are already in the air when stop trips; nothing new starts after them.
    expect(stub.calls).toHaveLength(WRITE_CONCURRENCY);
    expect(result.created).toBe(WRITE_CONCURRENCY);
  });
});

describe('writeChildren — pooled', () => {
  it('links 20 children to their parents whatever order the writes complete in', async () => {
    const parentIdByKey = new Map(
      Array.from({ length: 20 }, (_, i) => [`s${i}:c1`, `parent-${i}`] as [string, string]),
    );
    const result = emptyResult();

    await writeChildren(
      Array.from({ length: 20 }, (_, i) => childAt(i)),
      parentIdByKey, new Map(), BASE, HEADERS, result, () => {},
    );

    expect(result).toMatchObject({ created: 20, updated: 0, errors: 0 });
    const posted = stub.calls.filter(c => c.method === 'POST').map(c => c.body!);
    expect(posted).toHaveLength(20);
    for (const row of posted) {
      expect(row.variant_of).toBe(`parent-${String(row.stable_id).slice(1)}`);
      expect(row.parent_id).toBeNull();
    }
  });

  it('reports a child whose parent never resolved, and writes nothing for it', async () => {
    const result = emptyResult();
    const logs: string[] = [];

    await writeChildren(
      [childAt(0), childAt(1)],
      new Map([['s1:c1', 'parent-1']]),
      new Map(), BASE, HEADERS, result, (_type, msg) => logs.push(msg),
    );

    expect(result).toMatchObject({ created: 1, errors: 1 });
    expect(logs).toEqual(['  ✕  No parent ID for s0:c2 — child skipped']);
    expect(stub.calls).toHaveLength(1);
  });

  it('runs exactly WRITE_CONCURRENCY children at a time', async () => {
    const parentIdByKey = new Map(
      Array.from({ length: 20 }, (_, i) => [`s${i}:c1`, `parent-${i}`] as [string, string]),
    );
    await writeChildren(
      Array.from({ length: 20 }, (_, i) => childAt(i)),
      parentIdByKey, new Map(), BASE, HEADERS, emptyResult(), () => {},
    );
    expect(stub.peak).toBe(WRITE_CONCURRENCY);
  });
});
