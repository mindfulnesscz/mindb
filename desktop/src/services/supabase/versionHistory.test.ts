import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VocabularyData } from '@sotto/domain';
import type { AssetVersions } from '../pipeline/types';

const fetchAllForClient = vi.fn();
const fetchVHForAssets = vi.fn();
const sbFetch = vi.fn();

vi.mock('./rest', () => ({
  BATCH: 200,
  fetchAllForClient: (...args: unknown[]) => fetchAllForClient(...args),
  makeHeaders: async () => ({}),
  sbFetch: (...args: unknown[]) => sbFetch(...args),
}));
vi.mock('./assetQueries', () => ({
  fetchVHForAssets: (...args: unknown[]) => fetchVHForAssets(...args),
}));

const { syncVersionHistory } = await import('./versionHistory');

const config = { url: 'https://test.supabase.co', anonKey: 'anon' };
const vocab: VocabularyData = { _schema_version: '4.0.0', _comment: '', tags: [] };

beforeEach(() => {
  fetchAllForClient.mockReset();
  fetchVHForAssets.mockReset();
  sbFetch.mockReset();
  fetchAllForClient.mockResolvedValue([{
    id: 'asset-row-id',
    shortcode: 'ABC',
    stable_id: '12345678',
  }]);
  fetchVHForAssets.mockResolvedValue([]);
  sbFetch.mockResolvedValue({ ok: true, text: async () => '' });
});

describe('syncVersionHistory', () => {
  it('never persists a machine-local file URL', async () => {
    const versions: AssetVersions = {
      shortcode: 'ABC',
      current: {
        file: '/Users/operator/client/ABC__v2.pdf',
        stem: 'ABC__v2',
        version: 'v2',
        shortcode: 'ABC',
      },
      history: [],
    };

    await syncVersionHistory(
      new Map([['12345678:ABC', versions]]),
      'client-id',
      vocab,
      config,
      () => {},
    );

    const upsert = sbFetch.mock.calls.find(call => call[1]?.method === 'POST');
    expect(upsert).toBeDefined();
    const body = JSON.parse(upsert![1].body as string) as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty('file_url');
    expect(JSON.stringify(body)).not.toContain('/Users/operator');
  });
});
