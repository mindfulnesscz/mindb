import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../authService', () => ({ getAccessToken: async () => 'token' }));

const { fetchAllForClient } = await import('./rest');

beforeEach(() => invoke.mockReset());

describe('fetchAllForClient', () => {
  it('orders every offset page by the unique row id', async () => {
    invoke.mockImplementation(async (_command: string, args?: { url: string }) => {
      if (!args?.url) return null;
      const firstPage = args.url.includes('offset=0');
      const rows = firstPage
        ? Array.from({ length: 1000 }, (_, i) => ({ id: `row-${i}` }))
        : [{ id: 'row-1000' }];
      return { status: 200, ok: true, body: JSON.stringify(rows) };
    });

    const rows = await fetchAllForClient<{ id: string }>(
      'https://test.supabase.co/rest/v1',
      'assets?status=neq.archived',
      'client-1',
      'id',
      { Authorization: 'Bearer token' },
    );

    expect(rows).toHaveLength(1001);
    const urls = invoke.mock.calls
      .map(([, args]) => (args as { url?: string } | undefined)?.url)
      .filter((url): url is string => !!url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('&order=id.asc&limit=1000&offset=0');
    expect(urls[1]).toContain('&order=id.asc&limit=1000&offset=1000');
  });
});
