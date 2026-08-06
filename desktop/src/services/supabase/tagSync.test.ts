import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VocabularyData } from '@sotto/domain';

const fetchAllForClient = vi.fn();
const sbFetch = vi.fn();

vi.mock('./rest', () => ({
  fetchAllForClient: (...args: unknown[]) => fetchAllForClient(...args),
  makeHeaders: async () => ({}),
  sbFetch: (...args: unknown[]) => sbFetch(...args),
}));

const { syncTagsFromVocabulary } = await import('./tagSync');

const config = { url: 'https://test.supabase.co', anonKey: 'anon' };
const emptyVocab: VocabularyData = { _schema_version: '4.0.0', _comment: '', tags: [] };
const row = (id: string) => ({
  id,
  name: `Portal ${id}`,
  key: `entity.${id}`,
  dimension: 'entity',
  parent_id: null,
  shortcode: id.toUpperCase(),
  sort_order: 0,
});

beforeEach(() => {
  fetchAllForClient.mockReset();
  sbFetch.mockReset();
  sbFetch.mockResolvedValue({ ok: true, text: async () => '', json: async () => [] });
});

describe('tag-sync deletion safety', () => {
  it('refuses to delete a portal-added tag from a stale/dirty local vocabulary', async () => {
    fetchAllForClient.mockResolvedValue([row('portal-only')]);
    const logs: string[] = [];

    const result = await syncTagsFromVocabulary(
      emptyVocab, 'client-1', config, (_type, message) => logs.push(message),
      { sourceFresh: false },
    );

    expect(sbFetch).not.toHaveBeenCalled();
    expect(result.deletionRefused).toBe(true);
    expect(logs.join('\n')).toContain('not freshly synchronized');
  });

  it('still applies the blast-radius ratio when the vocabulary is fresh', async () => {
    fetchAllForClient.mockResolvedValue(Array.from({ length: 11 }, (_, i) => row(`tag-${i}`)));

    const result = await syncTagsFromVocabulary(
      emptyVocab, 'client-1', config, () => {}, { sourceFresh: true },
    );

    expect(sbFetch).not.toHaveBeenCalled();
    expect(result.deletionRefused).toBe(true);
  });

  it('allows a small deletion only when the vocabulary is explicitly fresh', async () => {
    fetchAllForClient.mockResolvedValue([row('old')]);

    const result = await syncTagsFromVocabulary(
      emptyVocab, 'client-1', config, () => {}, { sourceFresh: true },
    );

    const deletes = sbFetch.mock.calls.filter(call => call[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(sbFetch.mock.calls.some(call => String(call[0]).includes('rename_tasks'))).toBe(false);
    expect(result).toMatchObject({ deleted: 1, deletionRefused: false });
  });

  it('updates a shortcode without creating a filesystem rename task', async () => {
    fetchAllForClient.mockResolvedValue([{
      ...row('leaf'),
      key: 'entity.leaf',
      shortcode: 'OLD',
      name: 'Leaf',
    }]);
    const vocab: VocabularyData = {
      ...emptyVocab,
      tags: [{
        shortcode: 'NEW', slot: 'entity', parentGroup: null,
        label: 'Leaf', key: 'entity.leaf', icon: '',
      }],
    };

    const result = await syncTagsFromVocabulary(
      vocab, 'client-1', config, () => {}, { sourceFresh: true },
    );

    expect(result.updated).toBe(1);
    expect(sbFetch.mock.calls.some(call => String(call[0]).includes('rename_tasks'))).toBe(false);
  });

  it('previews inserts and deletes in dry-run without issuing any mutation', async () => {
    fetchAllForClient.mockResolvedValue([row('old')]);
    const vocab: VocabularyData = {
      ...emptyVocab,
      tags: [{
        shortcode: 'NEW', slot: 'entity', parentGroup: null,
        label: 'New', key: 'entity.new', icon: '',
      }],
    };

    const result = await syncTagsFromVocabulary(
      vocab, 'client-1', config, () => {}, { sourceFresh: true, dryRun: true },
    );

    expect(sbFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 1, deletionRefused: false });
  });
});

/* A tag must never be written as its own parent.
 *
 * Reported from a real import: an exported taxonomy carried
 *   { "key": "format.document", "parent_key": "format.document" }
 * for three nodes, and the portal validator refused the file with "cannot parent itself" plus a
 * cascade of "cycle detected" for their children. The export was faithful — the ROWS were
 * self-referencing.
 *
 * Pass 1 resolves a parent group by NAME (`dimension::name`); pass 2 finds the row to update by key
 * or shortcode. Nothing connected the two, so when both landed on the SAME row — a keyed,
 * shortcode-less group whose name is also the leaf's parentGroup — the sync patched that row to be
 * its own parent. Self-parenting carries no information and is unrepresentable in the import format,
 * so it is now refused at the point of writing rather than discovered on the way back in.
 */
describe('tag-sync parent resolution', () => {
  /* A FACTORY, not a shared object. The sync does `Object.assign(existingLeaf, patch)` on the rows
     it was handed, so a shared fixture is mutated by the first test and a later one then asserts
     against an already-rewritten row — passing for the wrong reason. */
  const groupRow = () => ({
    id: 'group-document',
    name: 'Document',
    key: 'format.document',
    dimension: 'format',
    parent_id: null,
    shortcode: '',          // no shortcode + no parent ⇒ a portal-managed GROUP
    sort_order: 0,
  });
  const GROUP_ID = 'group-document';

  /** A leaf whose key is the group's key, and whose parentGroup is that same group's name. */
  const collidingLeaf: VocabularyData = {
    _schema_version: '4.0.0',
    _comment: '',
    tags: [{
      slot: 'format',
      key: 'format.document',
      label: 'Document',
      shortcode: 'Doc',
      parentGroup: 'Document',
      icon: '',
    }],
  } as unknown as VocabularyData;

  const patchedBodies = () => sbFetch.mock.calls
    .filter(([, init]) => (init as { method?: string })?.method === 'PATCH')
    .map(([, init]) => JSON.parse((init as { body: string }).body));

  it('never writes a tag as its own parent', async () => {
    fetchAllForClient.mockResolvedValue([groupRow()]);

    await syncTagsFromVocabulary(
      collidingLeaf, 'client-1', config, () => {}, { sourceFresh: true },
    );

    for (const body of patchedBodies()) {
      expect(body.parent_id).not.toBe(GROUP_ID);
    }
  });

  it('records the tag as ungrouped, and says so, rather than silently dropping the grouping', async () => {
    fetchAllForClient.mockResolvedValue([groupRow()]);
    const logs: string[] = [];

    await syncTagsFromVocabulary(
      collidingLeaf, 'client-1', config, (_t, m) => logs.push(m), { sourceFresh: true },
    );

    const withParent = patchedBodies().filter(b => 'parent_id' in b);
    for (const body of withParent) expect(body.parent_id).toBeNull();
    expect(logs.join('\n')).toContain('cannot be its own parent');
  });

  it('still groups a leaf under a DIFFERENT row normally', async () => {
    // The guard must be narrow: ordinary grouping is the common case and must be untouched.
    fetchAllForClient.mockResolvedValue([
      groupRow(),
      { id: 'leaf-1', name: 'Deck', key: 'format.deck', dimension: 'format',
        parent_id: null, shortcode: 'Dck', sort_order: 0 },
    ]);

    await syncTagsFromVocabulary(
      { _schema_version: '4.0.0', _comment: '', tags: [{
        slot: 'format', key: 'format.deck', label: 'Deck', shortcode: 'Dck',
        parentGroup: 'Document', icon: '',
      }] } as unknown as VocabularyData,
      'client-1', config, () => {}, { sourceFresh: true },
    );

    const parented = patchedBodies().filter(b => 'parent_id' in b);
    expect(parented).toHaveLength(1);
    expect(parented[0].parent_id).toBe(GROUP_ID);
  });
});
