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
