/* Integration test for the sync path against a real Postgres — run `supabase start` and this
   exercises exportAssetsToSupabase end to end: folder identity in, rows out. Skipped when the
   local stack isn't up, so CI (which has no database) stays green.

   Covered here and nowhere else: that a package's distinct files become one primary plus
   `variant_of` siblings, that a gallery folder becomes a parent plus `parent_id` children,
   that two assets may render the same shortcode now that identity carries uniqueness, and
   that a file disappearing disconnects its row instead of deleting it.

   Each test owns its own package hash — no shared rows, so tests don't depend on order. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const API = 'http://127.0.0.1:54321';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const CLIENT_ID = '00000000-0000-0000-0000-000000000001'; // Acme Studio, from seed.sql

const up = await fetch(`${API}/rest/v1/`, { headers: { apikey: SERVICE_KEY } })
  .then(r => r.ok || r.status === 404)
  .catch(() => false);

/* ── Fakes: the filesystem, and Rust's request/auth bridges ─────────────────── */

const textFiles = new Map<string, string>();
const binFiles  = new Map<string, Uint8Array>();

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists:        async (p: string) => textFiles.has(p),
  readTextFile:  async (p: string) => textFiles.get(p) ?? '',
  writeTextFile: async (p: string, c: string) => { textFiles.set(p, c); },
  readFile:      async (p: string) => binFiles.get(p) ?? new Uint8Array([0]),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== 'supabase_request') throw new Error(`unexpected command ${cmd}`);
    const res = await fetch(args.url as string, {
      method:  args.method as string,
      headers: args.headers as Record<string, string>,
      body:    args.body as string | undefined,
    });
    return { status: res.status, ok: res.ok, body: await res.text() };
  },
}));

// Requests run as the signed-in user in the app; here the service role stands in so the test
// exercises the write path itself rather than RLS.
vi.mock('./authService', () => ({ getCurrentAccessToken: () => SERVICE_KEY }));

const { exportAssetsToSupabase } = await import('./supabaseService');
const { groupAssets } = await import('../domain/assetGrouping');

const config = { url: API, anonKey: SERVICE_KEY };
const vocab = {
  _schema_version: '4.0.0',
  _comment: 'test',
  tags: [
    { shortcode: 'PRD', slot: 'entity' as const, parentGroup: null, label: 'Product',  key: 'product',  icon: '' },
    { shortcode: 'SlD', slot: 'format' as const, parentGroup: null, label: 'Slides',   key: 'slides',   icon: '' },
    { shortcode: 'Gll', slot: 'format' as const, parentGroup: null, label: 'Gallery',  key: 'gallery',  icon: '' },
    { shortcode: 'OVR', slot: 'angle'  as const, parentGroup: null, label: 'Overview', key: 'overview', icon: '' },
  ],
};

type Row = {
  id: string; shortcode: string; name: string; tags: string[]; status: string;
  stable_id: string; child_id: string; parent_id: string | null; variant_of: string | null;
};

const auth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function rowsFor(stableId: string): Promise<Row[]> {
  const res = await fetch(
    `${API}/rest/v1/assets?stable_id=eq.${stableId}` +
    `&select=id,shortcode,name,tags,status,stable_id,child_id,parent_id,variant_of&order=child_id`,
    { headers: auth },
  );
  return res.json();
}

async function wipe(...stableIds: string[]) {
  for (const sid of stableIds) {
    await fetch(`${API}/rest/v1/assets?stable_id=eq.${sid}`, { method: 'DELETE', headers: auth });
  }
}

/** Runs the sync over a set of absolute file paths, exactly as the pipeline does. */
async function sync(paths: string[]) {
  const { singles, galleries } = groupAssets(paths, 'OUT');
  const logs: string[] = [];
  const result = await exportAssetsToSupabase(
    singles, CLIENT_ID, vocab, config, (_t, m) => logs.push(m),
    undefined, undefined, galleries, undefined,
  );
  return { result, logs };
}

/** Registers a file on the fake disk and returns its path. */
function file(path: string, byte: number): string {
  binFiles.set(path, new Uint8Array([byte]));
  return path;
}

describe.skipIf(!up)('exportAssetsToSupabase against a real database', () => {
  beforeEach(() => { textFiles.clear(); binFiles.clear(); });

  it('writes one primary plus variant_of siblings for distinct files in a package', async () => {
    await wipe('aa001111');
    const dir = '/src/Decks/Launch Deck __aa001111/OUT';
    const deck = file(`${dir}/(PRD)(SlD) Launch Deck.pdf`, 1);
    const pdfRendition = file(`${dir}/(PRD)(SlD) Launch Deck (PDF).pdf`, 2);

    const { result } = await sync([deck, pdfRendition]);
    expect(result.errors).toBe(0);

    const rows = await rowsFor('aa001111');
    expect(rows).toHaveLength(2);
    const primary = rows.find(r => !r.variant_of)!;
    const variant = rows.find(r => r.variant_of)!;
    expect(primary.child_id).toBe('c1');
    expect(variant.variant_of).toBe(primary.id);
    expect(primary.tags).toEqual(expect.arrayContaining(['Product', 'Slides']));
    // Identity carries uniqueness — no ` __hash:cN` suffix is glued onto the display string.
    expect(primary.shortcode).not.toMatch(/__[0-9a-f]{8}:c\d+/);
  });

  it('treats one stem with two extensions as a single asset', async () => {
    await wipe('aa002222');
    const dir = '/src/Decks/One Stem __aa002222/OUT';
    const a = file(`${dir}/(PRD)(SlD) Same Stem.pdf`, 1);
    const b = file(`${dir}/(PRD)(SlD) Same Stem.png`, 2);

    const { result } = await sync([a, b]);
    expect(result.errors).toBe(0);
    expect(await rowsFor('aa002222')).toHaveLength(1);
  });

  it('is idempotent — a second identical run updates in place and creates nothing', async () => {
    await wipe('aa003333');
    const dir = '/src/Decks/Idempotent __aa003333/OUT';
    const paths = [file(`${dir}/(PRD)(SlD) Deck.pdf`, 1), file(`${dir}/(PRD)(OVR) Onepager.pdf`, 2)];

    const first = await sync(paths);
    const before = await rowsFor('aa003333');
    const second = await sync(paths);
    const after = await rowsFor('aa003333');

    expect(first.result.created).toBe(2);
    expect(second.result.created).toBe(0);
    expect(second.result.errors).toBe(0);
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort());
  });

  it('writes a gallery folder as a parent with parent_id children', async () => {
    await wipe('aa004444');
    const dir = '/src/Shoots/Open Studios __aa004444/OUT/(PRD)(Gll) Studios';
    const kids = [1, 2, 3].map(n => file(`${dir}/(PRD)(Gll) 0${n}.jpeg`, 10 + n));

    const { result } = await sync(kids);
    expect(result.errors).toBe(0);

    const rows = await rowsFor('aa004444');
    const parent = rows.find(r => !r.parent_id)!;
    const children = rows.filter(r => r.parent_id);
    expect(children).toHaveLength(3);
    expect(new Set(children.map(r => r.parent_id))).toEqual(new Set([parent.id]));
    // The gallery folder name must not leak into a child's own name or shortcode.
    for (const c of children) {
      expect(c.name).not.toContain('/');
      expect(c.shortcode).not.toContain('Studios/');
      expect(c.tags).toEqual(expect.arrayContaining(['Product', 'Gallery']));
    }
  });

  it('lets two different assets carry the same shortcode', async () => {
    await wipe('aa005555', 'aa006666');
    const a = file('/src/Decks/First __aa005555/OUT/(PRD)(OVR) Same Name.pdf', 7);
    const b = file('/src/Decks/Second __aa006666/OUT/(PRD)(OVR) Same Name.pdf', 8);

    const { result } = await sync([a, b]);
    expect(result.errors).toBe(0);

    const [rowA] = await rowsFor('aa005555');
    const [rowB] = await rowsFor('aa006666');
    expect(rowA.shortcode).toBe('(PRD)(OVR) Same Name');
    expect(rowB.shortcode).toBe(rowA.shortcode);
    expect(rowA.id).not.toBe(rowB.id);
  });

  it('disconnects a vanished file instead of deleting its row', async () => {
    await wipe('aa007777');
    const dir = '/src/Decks/Vanishing __aa007777/OUT';
    const kept = `${dir}/(PRD)(SlD) Kept.pdf`;
    const removed = `${dir}/(PRD)(OVR) Removed.pdf`;
    file(kept, 1); file(removed, 2);

    await sync([kept, removed]);
    const removedRow = (await rowsFor('aa007777')).find(r => r.shortcode === '(PRD)(OVR) Removed')!;
    expect(removedRow.status).toBe('published');

    // Second run: the file is gone from disk, its manifest entry stays.
    binFiles.delete(removed);
    // The sweep is client-wide by design (a real run scans the whole source folder), so
    // assert on this row rather than the count.
    await sync([kept]);

    const after = await rowsFor('aa007777');
    expect(after.find(r => r.id === removedRow.id)!.status).toBe('disconnected');
    expect(after.find(r => r.shortcode === '(PRD)(SlD) Kept')!.status).toBe('published');
  });

  it('syncs both packages when two hold a file with the same stem', async () => {
    // The live shape from Mucha Family: two same-named packages, distinct hashes, each with
    // plyn.pdf. A stem-keyed lookup dropped one of them silently.
    await wipe('aa008888', 'aa009999');
    const a = file('/src/Deda Energie __aa008888/OUT/plyn.pdf', 1);
    const b = file('/src/Deda Energie __aa009999/OUT/plyn.pdf', 2);

    const { result } = await sync([a, b]);
    expect(result.errors).toBe(0);
    expect(result.created).toBe(2);

    const [rowA] = await rowsFor('aa008888');
    const [rowB] = await rowsFor('aa009999');
    expect(rowA.status).toBe('published');
    expect(rowB.status).toBe('published');
    expect(rowA.id).not.toBe(rowB.id);
  });

  it('reports an asset whose folder carries no identity hash', async () => {
    const orphan = file('/src/Loose/No Hash Here/OUT/(PRD)(SlD) Nameless.pdf', 9);

    const { result, logs } = await sync([orphan]);
    expect(result.errors).toBe(1);
    expect(logs.join('\n')).toMatch(/no " __<hash>" suffix/);
  });
});
