import { describe, expect, it } from 'vitest';
import { classifyProbe, requireStack } from './smoke-functions.mjs';

describe('edge-function boot classification', () => {
  it('rejects a 404 from a function that was never loaded', () => {
    expect(classifyProbe('missing-function', 404, 'Function not found')).toEqual({
      name: 'missing-function',
      ok: false,
      detail: '404 — unexpected: Function not found',
    });
  });

  it('rejects boot errors even when the runtime returns an otherwise allowed 503', () => {
    expect(classifyProbe('broken-function', 503, 'worker boot error').ok).toBe(false);
  });

  it('requires a full local stack instead of reporting a skipped success', () => {
    expect(() => requireStack(null)).toThrow(/no full local Supabase stack/);
  });
});
