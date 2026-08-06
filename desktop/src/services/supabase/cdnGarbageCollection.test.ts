import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeHeaders: vi.fn(),
  sbFetch: vi.fn(),
}));

vi.mock('./rest', () => ({
  makeHeaders: mocks.makeHeaders,
  sbFetch: mocks.sbFetch,
}));

const { analyzeCdnGarbage, executeCdnGarbage } = await import('./cdnGarbageCollection');
const config = { url: 'https://test.supabase.co/', anonKey: 'anon' };

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async <T>() => body as T,
  };
}

beforeEach(() => {
  mocks.makeHeaders.mockReset().mockResolvedValue({ Authorization: 'Bearer user', apikey: 'anon' });
  mocks.sbFetch.mockReset();
});

describe('desktop CDN garbage-collection service', () => {
  it('analyzes through the active environment with the current user session', async () => {
    const analysis = { planId: 'plan', report: {}, executable: true };
    mocks.sbFetch.mockResolvedValue(response(200, { ok: true, action: 'analyze', analysis }));

    await expect(analyzeCdnGarbage(config)).resolves.toBe(analysis);
    expect(mocks.makeHeaders).toHaveBeenCalledWith('anon');
    expect(mocks.sbFetch).toHaveBeenCalledWith(
      'https://test.supabase.co/functions/v1/cdn-gc',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'analyze' }) }),
    );
  });

  it('binds execution to the reviewed plan and typed confirmations', async () => {
    mocks.sbFetch.mockResolvedValue(response(200, { ok: true, action: 'execute' }));

    await executeCdnGarbage(config, {
      expectedPlanId: 'plan-1',
      confirmation: 'DELETE 2 OBJECTS',
      productionConfirmation: 'production',
    });

    const body = JSON.parse(mocks.sbFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      action: 'execute',
      expected_plan_id: 'plan-1',
      confirmation: 'DELETE 2 OBJECTS',
      production_confirmation: 'production',
    });
  });

  it('uses the shared edge-function diagnosis for a missing local function', async () => {
    mocks.sbFetch.mockResolvedValue(response(404, { message: 'Requested function was not found' }));
    await expect(analyzeCdnGarbage(config)).rejects.toThrow(/cdn-gc is not deployed/);
  });
});
