/* The duplicate-folder cleanup — a tool that MOVES and TRASHES a client's delivered files.
 *
 * Nothing else in the app rearranges what a client already has, so the tests are written against the
 * ways this loses a file rather than the ways it succeeds:
 *
 *   · a duplicate folder trashed while it still holds something;
 *   · two different files sharing a name, one of them quietly dropped;
 *   · a failed listing read as "that folder is empty";
 *   · a plan confirmed in the preview and a different one executed.
 *
 * The Drive fake answers the real endpoints (`files?q=…`, `PATCH files/{id}`) rather than the module's
 * functions, so the query and the parent swap are what is asserted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchStub, type FetchStub } from '../../test/fetchStub';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

const { scanGDriveDuplicates, executeGDriveDedupe, planGDriveDedupe } = await import('./gdriveDedupe');
type TreeNode = Parameters<typeof planGDriveDedupe>[0];

const FOLDER = 'application/vnd.google-apps.folder';
const LIST   = /drive\/v3\/files\?q=/;
const PATCH  = /drive\/v3\/files\/[^?]+\?/;

/* ── A fake Drive, as a mutable node table ────────────────────────────────── */

interface FakeNode {
  id: string;
  name: string;
  parent: string;
  mimeType: string;
  createdTime: string;
  size?: string;
  md5Checksum?: string;
  trashed?: boolean;
}

let nodes: FakeNode[] = [];
let stub: FetchStub;
/* Fault injection lives in the fake rather than in an overriding route, so a failing listing is the
   only thing that changes — the rest of the drive still answers normally. */
let faults: { listFailsForParent?: string; rateLimitFirstList?: boolean } = {};

const folder = (id: string, name: string, parent: string, createdTime: string): FakeNode =>
  ({ id, name, parent, mimeType: FOLDER, createdTime });
const file = (
  id: string, name: string, parent: string,
  over: Partial<FakeNode> = {},
): FakeNode => ({
  id, name, parent, mimeType: 'application/pdf', createdTime: '2026-01-01T00:00:00Z',
  size: '10', md5Checksum: 'aaa', ...over,
});

function installDrive(): void {
  stub.route(LIST, call => {
    const q = new URL(call.url).searchParams.get('q') ?? '';
    const parentMatch = q.match(/'([^']+)' in parents/);
    if (faults.rateLimitFirstList) {
      faults.rateLimitFirstList = false;
      return { status: 429, text: 'rateLimitExceeded' };
    }
    if (parentMatch?.[1] === faults.listFailsForParent) {
      return { status: 403, text: 'insufficientPermissions' };
    }
    const nameMatch   = q.match(/name='((?:[^'\\]|\\.)*)'/);
    let hits = nodes.filter(n => !n.trashed && n.parent === parentMatch?.[1]);
    if (nameMatch) {
      const wanted = nameMatch[1].replace(/\\(.)/g, '$1');
      hits = hits.filter(n => n.name === wanted && n.mimeType === FOLDER);
    }
    return { json: { files: hits.map(({ trashed: _t, parent: _p, ...rest }) => rest) } };
  });

  stub.route(PATCH, call => {
    const id = decodeURIComponent(new URL(call.url).pathname.split('/').pop()!);
    const node = nodes.find(n => n.id === id);
    if (!node) return { status: 404, text: 'not found' };
    const params = new URL(call.url).searchParams;
    if (params.get('addParents')) {
      if (node.parent !== params.get('removeParents')) return { status: 400, text: 'wrong parent' };
      node.parent = params.get('addParents')!;
    }
    if ((call.json() as { trashed?: boolean })?.trashed) node.trashed = true;
    return { json: { id } };
  });
}

const TARGET = { accessToken: 'tok', remotePath: 'Clients/Deliverables', sharedDriveId: '' };

/** Two copies of `Deliverables`, each with a copy of `Set A`, plus a name collision inside it. */
function duplicatedTree(): void {
  nodes = [
    folder('clients', 'Clients', 'root', '2026-01-01T00:00:00Z'),
    folder('deliv-old', 'Deliverables', 'clients', '2026-02-01T00:00:00Z'),
    folder('deliv-new', 'Deliverables', 'clients', '2026-02-01T00:00:05Z'),
    folder('setA-old', 'Set A', 'deliv-old', '2026-02-01T00:00:01Z'),
    folder('setA-new', 'Set A', 'deliv-new', '2026-02-01T00:00:06Z'),
    file('deck-old', 'deck.pdf', 'setA-old', { md5Checksum: 'same' }),
    file('deck-new', 'deck.pdf', 'setA-new', { md5Checksum: 'same' }),      // identical copy
    file('brief-old', 'brief.pdf', 'setA-old', { md5Checksum: 'v1', size: '20' }),
    file('brief-new', 'brief.pdf', 'setA-new', { md5Checksum: 'v2', size: '21' }),  // DIFFERENT
    file('extra', 'extra.pdf', 'setA-new', { md5Checksum: 'x' }),
    file('loose', 'loose.pdf', 'deliv-new', { md5Checksum: 'l' }),
    file('outside', 'not-ours.pdf', 'clients', { md5Checksum: 'o' }),
  ];
}

const live = (id: string) => nodes.find(n => n.id === id && !n.trashed);
const childrenOf = (id: string) => nodes.filter(n => !n.trashed && n.parent === id).map(n => n.id).sort();

beforeEach(() => {
  faults = {};
  stub = installFetchStub();
  installDrive();
});
afterEach(() => stub.restore());

/* ════════════════════════════════════════════════════════════════════════════
   planGDriveDedupe — pure, and the part that decides what disappears
   ════════════════════════════════════════════════════════════════════════════ */

const node = (id: string, name: string, createdTime: string, over: Partial<TreeNode> = {}): TreeNode =>
  ({ id, name, createdTime, folders: [], files: [], ...over });

describe('planGDriveDedupe', () => {
  it('plans nothing for a tree with no repeated names', () => {
    const plan = planGDriveDedupe(node('root', 'root', 'T', {
      folders: [node('a', 'A', 'T'), node('b', 'B', 'T')],
    }), '');
    expect(plan.actions).toEqual([]);
    expect(plan.totals.duplicateSets).toBe(0);
  });

  it('keeps the OLDEST copy and empties the rest into it', () => {
    const plan = planGDriveDedupe(node('root', 'root', 'T', {
      folders: [
        node('newer', 'Set A', '2026-05-01T00:00:00Z', { files: [{ id: 'f1', name: '1.pdf', mimeType: 'application/pdf', md5Checksum: 'a' }] }),
        node('older', 'Set A', '2026-03-01T00:00:00Z'),
      ],
    }), '');

    expect(plan.sets).toHaveLength(1);
    expect(plan.sets[0].canonicalId).toBe('older');
    expect(plan.actions).toEqual([
      { kind: 'move', childId: 'f1', childName: '1.pdf', isFolder: false, fromId: 'newer', toId: 'older', path: 'Set A' },
      { kind: 'trash-folder', folderId: 'newer', name: 'Set A', path: 'Set A' },
    ]);
  });

  it('merges nested duplicates depth-first, so no parent is trashed before its children move', () => {
    const withSub = (id: string, subId: string, fileId: string, created: string) =>
      node(id, 'Set A', created, {
        folders: [node(subId, 'Pages', created, {
          files: [{ id: fileId, name: `${fileId}.pdf`, mimeType: 'application/pdf', md5Checksum: fileId }],
        })],
      });
    const plan = planGDriveDedupe(node('root', 'root', 'T', {
      folders: [withSub('a', 'a-pages', 'p1', '2026-01-01T00:00:00Z'), withSub('b', 'b-pages', 'p2', '2026-02-01T00:00:00Z')],
    }), '');

    expect(plan.actions.map(a => `${a.kind}:${'childId' in a ? a.childId : a.kind === 'trash-folder' ? a.folderId : a.fileId}`))
      .toEqual(['move:p2', 'trash-folder:b-pages', 'trash-folder:b']);
    // The nested folder is emptied and trashed before the folder that contained it.
    expect(plan.actions.findIndex(a => a.kind === 'trash-folder' && a.folderId === 'b-pages'))
      .toBeLessThan(plan.actions.findIndex(a => a.kind === 'trash-folder' && a.folderId === 'b'));
  });

  it('never plans a trash for a file whose twin has different bytes', () => {
    const withFile = (id: string, md5: string, created: string) => node(id, 'Set A', created, {
      files: [{ id: `${id}-f`, name: 'deck.pdf', mimeType: 'application/pdf', md5Checksum: md5, size: '10' }],
    });
    const plan = planGDriveDedupe(node('root', 'root', 'T', {
      folders: [withFile('old', 'v1', '2026-01-01T00:00:00Z'), withFile('new', 'v2', '2026-02-01T00:00:00Z')],
    }), '');

    expect(plan.actions.some(a => a.kind === 'trash-file')).toBe(false);
    expect(plan.collisions).toEqual([
      { path: 'Set A', name: 'deck.pdf', keptId: 'old-f', otherId: 'new-f', resolution: 'kept-both' },
    ]);
  });

  it('treats a Google-native doc (no md5, no size) as its own file rather than a copy', () => {
    const doc = (id: string) => ({ id, name: 'Notes', mimeType: 'application/vnd.google-apps.document' });
    const plan = planGDriveDedupe(node('root', 'root', 'T', {
      folders: [
        node('old', 'Set A', '2026-01-01T00:00:00Z', { files: [doc('doc-old')] }),
        node('new', 'Set A', '2026-02-01T00:00:00Z', { files: [doc('doc-new')] }),
      ],
    }), '');
    expect(plan.collisions[0].resolution).toBe('kept-both');
  });

  it('reports paths from the destination path, not from the folder name alone', () => {
    const plan = planGDriveDedupe(node('parent', 'Clients', 'T', {
      folders: [node('a', 'Deliverables', '2026-01-01T00:00:00Z'), node('b', 'Deliverables', '2026-02-01T00:00:00Z')],
    }), 'Clients');
    expect(plan.sets[0].path).toBe('Clients/Deliverables');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   scanGDriveDuplicates — read-only
   ════════════════════════════════════════════════════════════════════════════ */

describe('scanGDriveDuplicates', () => {
  beforeEach(duplicatedTree);

  it('previews the whole merge without touching anything', async () => {
    const before = JSON.stringify(nodes);
    const plan = await scanGDriveDuplicates(TARGET);

    expect(JSON.stringify(nodes)).toBe(before);
    expect(stub.calls.every(c => c.method === 'GET')).toBe(true);

    expect(plan.rootPath).toBe('Clients/Deliverables');
    expect(plan.sets.map(s => [s.path, s.canonicalId, s.duplicates.map(d => d.id)])).toEqual([
      ['Clients/Deliverables', 'deliv-old', ['deliv-new']],
    ]);
    // Two levels merge in one pass: `Set A` exists under both copies of `Deliverables`.
    expect(plan.totals).toEqual({
      duplicateSets: 1, duplicateFolders: 1,
      filesMoved: 3,        // loose.pdf, brief.pdf (differs — both kept), extra.pdf
      foldersMoved: 0,      // Set A merged in place, not re-parented
      filesTrashed: 1,      // the byte-identical deck.pdf
      foldersTrashed: 2,    // Set A (the copy) and Deliverables (the copy)
      collisions: 2,
    });
    expect(plan.collisions).toEqual([
      { path: 'Clients/Deliverables/Set A', name: 'deck.pdf', keptId: 'deck-old', otherId: 'deck-new', resolution: 'trashed-identical-copy' },
      { path: 'Clients/Deliverables/Set A', name: 'brief.pdf', keptId: 'brief-old', otherId: 'brief-new', resolution: 'kept-both' },
    ]);
  });

  it('leaves everything outside the destination folder out of the plan', async () => {
    const plan = await scanGDriveDuplicates(TARGET);
    const touched = plan.actions.map(a => ('childId' in a ? a.childId : a.kind === 'trash-file' ? a.fileId : a.folderId));
    expect(touched).not.toContain('outside');   // a file sitting beside the destination folder
    expect(touched).not.toContain('clients');
  });

  it('refuses a destination with no remote path instead of sweeping My Drive', async () => {
    await expect(scanGDriveDuplicates({ ...TARGET, remotePath: '  ' }))
      .rejects.toThrow(/Refusing to sweep the whole of My Drive/);
    expect(stub.calls).toHaveLength(0);
  });

  it('fails loudly when the destination path does not resolve', async () => {
    await expect(scanGDriveDuplicates({ ...TARGET, remotePath: 'Clients/Nope' }))
      .rejects.toThrow(/does not exist/);
  });

  it('aborts the scan when a listing fails — a partial tree is not evidence of anything', async () => {
    faults.listFailsForParent = 'setA-new';
    await expect(scanGDriveDuplicates(TARGET)).rejects.toThrow(/list failed \(403\)/);
  });

  it('retries a rate-limited listing instead of giving up on the sweep', async () => {
    // A tree of any size is thousands of requests; one 429 must not end the run.
    vi.useFakeTimers();
    try {
      faults.rateLimitFirstList = true;
      const pending = scanGDriveDuplicates(TARGET);
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toMatchObject({ rootPath: 'Clients/Deliverables' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is stable: the same tree fingerprints to the same plan', async () => {
    const first  = await scanGDriveDuplicates(TARGET);
    const second = await scanGDriveDuplicates(TARGET);
    expect(second.planId).toBe(first.planId);
    expect(first.planId).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   executeGDriveDedupe — the only code in the app that moves a delivered file
   ════════════════════════════════════════════════════════════════════════════ */

describe('executeGDriveDedupe', () => {
  beforeEach(duplicatedTree);

  it('leaves one folder per name with every file consolidated', async () => {
    const plan   = await scanGDriveDuplicates(TARGET);
    const result = await executeGDriveDedupe(TARGET, plan.planId);

    expect(result.refused).toBeUndefined();
    expect(result.executed!.failed).toBe(0);
    expect(result.executed!.skipped).toBe(0);

    expect(live('deliv-new')).toBeUndefined();
    expect(live('setA-new')).toBeUndefined();
    expect(childrenOf('clients')).toEqual(['deliv-old', 'outside']);
    expect(childrenOf('deliv-old')).toEqual(['loose', 'setA-old']);
    // brief-new survives beside brief-old: same name, different bytes, nothing dropped.
    expect(childrenOf('setA-old')).toEqual(['brief-new', 'brief-old', 'deck-old', 'extra']);
    expect(live('deck-new')).toBeUndefined();   // byte-identical copy, trashed
  });

  it('trashes rather than deletes, so a wrong merge is recoverable', async () => {
    const plan = await scanGDriveDuplicates(TARGET);
    await executeGDriveDedupe(TARGET, plan.planId);
    expect(stub.calls.some(c => c.method === 'DELETE')).toBe(false);
    expect(nodes.find(n => n.id === 'deliv-new')?.trashed).toBe(true);
  });

  it('re-checks each duplicate folder against Drive and leaves a non-empty one alone', async () => {
    const plan = await scanGDriveDuplicates(TARGET);
    // One move fails, so a folder the plan wants to trash still holds a file. Without the fresh
    // emptiness check that file goes to the trash inside its folder and the client never gets it.
    stub.route(/drive\/v3\/files\/extra\?/, { status: 403, text: 'insufficientFilePermissions' });

    const result = await executeGDriveDedupe(TARGET, plan.planId);

    expect(result.executed!.failed).toBe(1);
    expect(live('extra')).toBeDefined();
    expect(live('setA-new')).toBeDefined();     // still holds `extra`, so it stays
    // And the refusal cascades: `Deliverables (1)` still holds `Set A (1)`, so it stays too.
    expect(live('deliv-new')).toBeDefined();
    expect(result.executed!.skipped).toBe(2);
    expect(result.executed!.audit.find(e => e.outcome === 'skipped')?.reason).toMatch(/still holds 1 item/);
  });

  it('refuses a plan the operator did not confirm', async () => {
    const plan = await scanGDriveDuplicates(TARGET);
    nodes.push(file('late', 'late.pdf', 'setA-new', { md5Checksum: 'late' }));

    const result = await executeGDriveDedupe(TARGET, plan.planId);

    expect(result.executed).toBeUndefined();
    expect(result.refused).toMatch(/changed since the preview/);
    expect(live('deliv-new')).toBeDefined();
    expect(stub.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('performs no moves or deletes when the walk fails', async () => {
    const plan = await scanGDriveDuplicates(TARGET);
    faults.listFailsForParent = 'root';

    await expect(executeGDriveDedupe(TARGET, plan.planId)).rejects.toThrow(/failed \(403\)/);
    expect(stub.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('records an audit entry for every action, in the order they were applied', async () => {
    const plan   = await scanGDriveDuplicates(TARGET);
    const result = await executeGDriveDedupe(TARGET, plan.planId);
    expect(result.executed!.audit.map(e => e.action.kind)).toEqual(plan.actions.map(a => a.kind));
    expect(result.executed!.audit.every(e => Date.parse(e.at) > 0)).toBe(true);
  });
});
