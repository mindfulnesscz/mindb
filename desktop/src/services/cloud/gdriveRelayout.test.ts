/* The re-layout mover — the second tool in the app that MOVES a client's delivered files.
 *
 * Written against the ways it misplaces or loses one rather than the ways it succeeds:
 *
 *   · a file the client put there themselves, re-parented because its name happened to match;
 *   · a move onto an occupied path, overwriting what is already delivered;
 *   · a source folder trashed while it still holds something;
 *   · a plan confirmed in the preview and a different one executed;
 *   · the destination's own root folder trashed once it empties.
 *
 * The Drive fake answers the real endpoints, so the parent swap and the folder creation are what is
 * asserted — not that a mocked function was called.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchStub, type FetchStub } from '../../test/fetchStub';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

const {
  scanGDriveRelayout, executeGDriveRelayout, planRelayoutMappings,
} = await import('./gdriveRelayout');
const { buildCloudFileJobs } = await import('../pipeline/exportNames');
const { buildVocabMap } = await import('@sotto/domain');
const { makeSettings, SRC, VOCAB } = await import('../../test/pipelineHarness');

const FOLDER = 'application/vnd.google-apps.folder';
const LIST   = /drive\/v3\/files\?q=/;
const CREATE = /drive\/v3\/files\?supportsAllDrives/;
const PATCH  = /drive\/v3\/files\/[^?]+\?/;

interface FakeNode {
  id: string; name: string; parent: string; mimeType: string; createdTime: string;
  size?: string; md5Checksum?: string; trashed?: boolean;
}

let nodes: FakeNode[] = [];
let stub: FetchStub;
let faults: { listFailsForParent?: string; moveFailsForFile?: string } = {};
let created = 0;

const folder = (id: string, name: string, parent: string, createdTime = '2026-01-01T00:00:00Z'): FakeNode =>
  ({ id, name, parent, mimeType: FOLDER, createdTime });
const file = (id: string, name: string, parent: string): FakeNode =>
  ({ id, name, parent, mimeType: 'image/png', createdTime: '2026-01-01T00:00:00Z', size: '10', md5Checksum: 'aaa' });

function installDrive(): void {
  stub.route(LIST, call => {
    const q = new URL(call.url).searchParams.get('q') ?? '';
    const parentMatch = q.match(/'([^']+)' in parents/);
    if (parentMatch?.[1] === faults.listFailsForParent) {
      return { status: 403, text: 'insufficientPermissions' };
    }
    const nameMatch = q.match(/name='((?:[^'\\]|\\.)*)'/);
    let hits = nodes.filter(n => !n.trashed && n.parent === parentMatch?.[1]);
    if (nameMatch) {
      const wanted = nameMatch[1].replace(/\\(.)/g, '$1');
      hits = hits.filter(n => n.name === wanted && n.mimeType === FOLDER);
    }
    return { json: { files: hits.map(({ trashed: _t, parent: _p, ...rest }) => rest) } };
  });

  stub.route(CREATE, call => {
    if (call.method !== 'POST') return {};
    const body = call.json() as { name: string; parents: string[]; mimeType: string };
    created += 1;
    const id = `new-${created}`;
    nodes.push(folder(id, body.name, body.parents[0], `2026-06-0${created}T00:00:00Z`));
    return { json: { id } };
  });

  stub.route(PATCH, call => {
    const id = decodeURIComponent(new URL(call.url).pathname.split('/').pop()!);
    const node = nodes.find(n => n.id === id);
    if (!node) return { status: 404, text: 'not found' };
    // 403, not 500: a permission refusal is terminal, where a 5xx is retried with backoff by
    // `driveApiFetch` — which is the behaviour we want in production and a 15s test here.
    if (id === faults.moveFailsForFile) return { status: 403, text: 'insufficientFilePermissions' };
    const params = new URL(call.url).searchParams;
    if (params.get('addParents')) {
      if (node.parent !== params.get('removeParents')) return { status: 400, text: 'wrong parent' };
      node.parent = params.get('addParents')!;
    }
    if ((call.json() as { trashed?: boolean })?.trashed) node.trashed = true;
    return { json: { id } };
  });
}

/** A destination sitting at `Clients/Deliverables`, delivered under the OUT-only layout:
 *  one gallery folder, and two files at the root that the source layout would nest. */
function deliveredFlatish(): void {
  nodes = [
    folder('clients', 'Clients', 'root'),
    folder('deliv', 'Deliverables', 'clients'),
    folder('gallery', '(Gll) Studio', 'deliv'),
    file('f-deck', 'Product Slides — Deck.pdf', 'deliv'),
    file('f-notes', 'Notes.pdf', 'deliv'),
    file('f-01', '01.jpg', 'gallery'),
    file('f-02', '02.jpg', 'gallery'),
  ];
}

const TARGET = {
  accessToken: 'tok', remotePath: 'Clients/Deliverables', sharedDriveId: '', destId: 'dest-1',
};

const live = (id: string) => nodes.find(n => n.id === id && !n.trashed);
const pathOf = (id: string): string => {
  const parts: string[] = [];
  let node = nodes.find(n => n.id === id);
  while (node && node.id !== 'deliv') {
    parts.unshift(node.name);
    node = nodes.find(n => n.id === node!.parent);
  }
  return parts.join('/');
};

beforeEach(() => {
  faults = {};
  created = 0;
  stub = installFetchStub();
  installDrive();
  deliveredFlatish();
});
afterEach(() => stub.restore());

/* ── Which files are in the wrong place ───────────────────────────────────── */

describe('planRelayoutMappings', () => {
  const settings = makeSettings();
  const vocabMap = buildVocabMap(VOCAB);
  const jobs = () => buildCloudFileJobs([
    `${SRC}/01 Works/Batch I __a1111111/[03] OUT/(PRD)(SlD) Deck.pdf`,
    `${SRC}/02 Studio/M5 __c3333333/[03] OUT/(Gll) Studio/01.jpg`,
  ], settings);

  it('maps a file from the layout that has a delivery record to the current one', () => {
    // Delivered under `folders`: the deck at the root, the gallery file under its gallery.
    const delivered = new Set(['Product Slides — Deck.pdf', '(Gll) Studio/01.jpg']);
    const result = planRelayoutMappings(jobs(), vocabMap, 'source', delivered);

    expect(result.mappings).toEqual([
      { from: 'Product Slides — Deck.pdf', to: '01 Works/Batch I/Product Slides — Deck.pdf' },
      { from: '(Gll) Studio/01.jpg',       to: '02 Studio/M5/(Gll) Studio/01.jpg' },
    ]);
    expect(result.inPlace).toBe(0);
    expect(result.unknown).toEqual([]);
  });

  it('needs no telling which layout the files are under — it reads the records', () => {
    // A half-migrated destination: one file already moved, one not. Both are planned correctly.
    const delivered = new Set([
      '01 Works/Batch I/Product Slides — Deck.pdf',   // already `source`
      '(Gll) Studio/01.jpg',                          // still `folders`
    ]);
    const result = planRelayoutMappings(jobs(), vocabMap, 'source', delivered);

    expect(result.inPlace).toBe(1);
    expect(result.mappings).toEqual([
      { from: '(Gll) Studio/01.jpg', to: '02 Studio/M5/(Gll) Studio/01.jpg' },
    ]);
  });

  it('claims nothing for a file this machine never delivered', () => {
    // No record ⇒ no evidence the remote file is ours ⇒ no move is planned for it at all.
    const result = planRelayoutMappings(jobs(), vocabMap, 'source', new Set());

    expect(result.mappings).toEqual([]);
    expect(result.unknown).toHaveLength(2);
  });

  it('plans one move per destination path when two sources would collide', () => {
    const twoWithOneName = buildCloudFileJobs([
      `${SRC}/A __a1111111/[03] OUT/01.jpg`,
      `${SRC}/B __b2222222/[03] OUT/01.jpg`,
    ], settings);
    // Both are delivered flat under one name — a collision the export already reports.
    const result = planRelayoutMappings(twoWithOneName, vocabMap, 'flat', new Set(['A/01.jpg', 'B/01.jpg']));

    expect(result.mappings).toEqual([{ from: 'A/01.jpg', to: '01.jpg' }]);
  });
});

/* ── Scan ─────────────────────────────────────────────────────────────────── */

describe('scanGDriveRelayout', () => {
  it('plans a move per delivered file and marks the folders that empty', async () => {
    const plan = await scanGDriveRelayout(TARGET, [
      { from: 'Product Slides — Deck.pdf', to: '01 Works/Batch I/Product Slides — Deck.pdf' },
      { from: '(Gll) Studio/01.jpg',       to: '02 Studio/M5/(Gll) Studio/01.jpg' },
      { from: '(Gll) Studio/02.jpg',       to: '02 Studio/M5/(Gll) Studio/02.jpg' },
    ], 0);

    expect(plan.totals.moves).toBe(3);
    expect(plan.actions.map(a => a.fileId)).toEqual(['f-deck', 'f-01', 'f-02']);
    // The gallery loses both its files, so it becomes a prune candidate. `Deliverables` does not:
    // Notes.pdf is still in it — and it is the destination root, which is never a candidate.
    expect(plan.prune.map(p => p.path)).toEqual(['(Gll) Studio']);
  });

  it('never plans a move onto an occupied path', async () => {
    const plan = await scanGDriveRelayout(TARGET, [
      { from: 'Product Slides — Deck.pdf', to: 'Notes.pdf' },
    ], 0);

    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([
      { path: 'Notes.pdf', reason: 'a file is already there — left alone, nothing overwritten' },
    ]);
  });

  it('reports a recorded file that is not where the record says', async () => {
    const plan = await scanGDriveRelayout(TARGET, [
      { from: 'Gone.pdf', to: '01 Works/Gone.pdf' },
    ], 0);

    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/not at its recorded path/);
  });

  it('refuses a destination with no remote path rather than sweeping My Drive', async () => {
    await expect(scanGDriveRelayout({ ...TARGET, remotePath: '  ' }, [], 0))
      .rejects.toThrow(/Refusing to sweep the whole of My Drive/);
  });

  it('throws when a folder listing fails — a partial view reads as "already empty"', async () => {
    faults.listFailsForParent = 'gallery';
    await expect(scanGDriveRelayout(TARGET, [], 0)).rejects.toThrow(/list failed/);
  });

  it('is read-only', async () => {
    await scanGDriveRelayout(TARGET, [
      { from: 'Product Slides — Deck.pdf', to: '01 Works/Batch I/Product Slides — Deck.pdf' },
    ], 0);

    expect(stub.calls.every(c => c.method === 'GET')).toBe(true);
    expect(live('f-deck')!.parent).toBe('deliv');
  });
});

/* ── Execute ──────────────────────────────────────────────────────────────── */

describe('executeGDriveRelayout', () => {
  const mappings = [
    { from: 'Product Slides — Deck.pdf', to: '01 Works/Batch I/Product Slides — Deck.pdf' },
    { from: '(Gll) Studio/01.jpg',       to: '02 Studio/M5/(Gll) Studio/01.jpg' },
    { from: '(Gll) Studio/02.jpg',       to: '02 Studio/M5/(Gll) Studio/02.jpg' },
  ];

  it('re-parents every file, creates the tree it needs, and keeps each file id', async () => {
    const plan = await scanGDriveRelayout(TARGET, mappings, 0);
    const result = await executeGDriveRelayout(
      { ...TARGET, destId: 'exec-1' }, mappings, 0, plan.planId,
    );

    expect(result.refused).toBeUndefined();
    expect(result.executed!.moved).toBe(3);
    // Same ids, new places — which is what preserves every share link pointing at them.
    expect(pathOf('f-deck')).toBe('01 Works/Batch I/Product Slides — Deck.pdf');
    expect(pathOf('f-01')).toBe('02 Studio/M5/(Gll) Studio/01.jpg');
    expect(result.executed!.applied).toEqual(mappings);
    // Not one byte: no upload endpoint is touched.
    expect(stub.calls.some(c => c.url.includes('/upload/'))).toBe(false);
  });

  it('trashes a folder the moves emptied, and never the destination root', async () => {
    const plan = await scanGDriveRelayout(TARGET, mappings, 0);
    await executeGDriveRelayout({ ...TARGET, destId: 'exec-2' }, mappings, 0, plan.planId);

    expect(live('gallery')).toBeUndefined();   // trashed, recoverable
    expect(live('deliv')).toBeDefined();       // the destination itself stays, always
  });

  it('leaves a source folder alone when a move into it failed', async () => {
    // 02.jpg cannot move, so `(Gll) Studio` still holds a file — the fresh listing catches it even
    // though the PLAN said the folder would be empty.
    faults.moveFailsForFile = 'f-02';
    const plan = await scanGDriveRelayout(TARGET, mappings, 0);
    const result = await executeGDriveRelayout({ ...TARGET, destId: 'exec-3' }, mappings, 0, plan.planId);

    expect(result.executed!.failed).toBe(1);
    expect(live('gallery')).toBeDefined();
    expect(live('f-02')!.parent).toBe('gallery');
    expect(result.executed!.audit.some(e =>
      e.outcome === 'skipped' && e.reason?.includes('still holds 1 item(s)'))).toBe(true);
  });

  it('reports only the moves that applied, so the caller re-keys nothing it should not', async () => {
    faults.moveFailsForFile = 'f-01';
    const plan = await scanGDriveRelayout(TARGET, mappings, 0);
    const result = await executeGDriveRelayout({ ...TARGET, destId: 'exec-4' }, mappings, 0, plan.planId);

    expect(result.executed!.applied.map(m => m.from))
      .toEqual(['Product Slides — Deck.pdf', '(Gll) Studio/02.jpg']);
  });

  it('refuses a plan the operator did not see', async () => {
    const plan = await scanGDriveRelayout(TARGET, mappings, 0);
    // Another machine's export lands a file between the preview and the click.
    nodes.push(file('f-late', 'Late.pdf', 'gallery'));

    const result = await executeGDriveRelayout({ ...TARGET, destId: 'exec-5' }, mappings, 0, plan.planId);

    expect(result.executed).toBeUndefined();
    expect(result.refused).toMatch(/changed since the preview/);
    expect(live('f-deck')!.parent).toBe('deliv');   // nothing moved
  });

  it('refuses an empty plan instead of reporting a successful no-op', async () => {
    const plan = await scanGDriveRelayout(TARGET, [], 4);
    const result = await executeGDriveRelayout({ ...TARGET, destId: 'exec-6' }, [], 4, plan.planId);

    expect(result.refused).toMatch(/already in its new place/);
  });
});
