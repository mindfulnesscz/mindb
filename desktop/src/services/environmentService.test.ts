import { describe, expect, it } from 'vitest';
import { makeEnvironment, portalUrlForEnvironment } from './environmentService';

describe('portalUrlForEnvironment', () => {
  it('opens local Vite for local Supabase', () => {
    const env = makeEnvironment({ supabaseUrl: 'http://127.0.0.1:54321' });
    expect(portalUrlForEnvironment(env)).toBe('http://localhost:5173');
  });

  it('opens staging hub for the staging Supabase project', () => {
    const env = makeEnvironment({
      name: 'Staging',
      supabaseUrl: 'https://tvrxnwbhzborkkkdeyuk.supabase.co',
    });
    expect(portalUrlForEnvironment(env)).toBe('https://staging.hub.disruptcollective.com');
  });

  it('opens production hub for the production Supabase project', () => {
    const env = makeEnvironment({
      name: 'Production',
      supabaseUrl: 'https://knbxyaplaoenrxrpgwcg.supabase.co',
    });
    expect(portalUrlForEnvironment(env)).toBe('https://hub.disruptcollective.com');
  });

  it('ignores legacy "Production (…)" names when the URL is staging', () => {
    const env = makeEnvironment({
      name: 'Production (tvrxnwbh)',
      supabaseUrl: 'https://tvrxnwbhzborkkkdeyuk.supabase.co/',
    });
    expect(portalUrlForEnvironment(env)).toBe('https://staging.hub.disruptcollective.com');
  });

  it('still resolves staging when the URL has no scheme', () => {
    const env = makeEnvironment({
      name: 'Production (tvrxnwbh)',
      supabaseUrl: 'tvrxnwbhzborkkkdeyuk.supabase.co',
    });
    expect(portalUrlForEnvironment(env)).toBe('https://staging.hub.disruptcollective.com');
  });
});
