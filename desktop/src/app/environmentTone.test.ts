import { describe, expect, it } from 'vitest';
import { environmentTone } from './environmentTone';

const PROD_URL = 'https://knbxyaplaoenrxrpgwcg.supabase.co';

describe('environmentTone', () => {
  it('reads production from the name when the backend is remote', () => {
    expect(environmentTone('Production', PROD_URL)).toBe('production');
    expect(environmentTone('DC Live', PROD_URL)).toBe('production');
  });

  it('flags staging', () => {
    expect(environmentTone('Staging', 'https://tvrxnwbhzborkkkdeyuk.supabase.co')).toBe('staging');
  });

  it('lets the URL win over a misleading name', () => {
    // A local stack named "Production" is the single most dangerous mislabel: it would render
    // quietly and read as the real backend.
    expect(environmentTone('Production', 'http://localhost:54321')).toBe('local');
    expect(environmentTone('Production', 'http://127.0.0.1:54321')).toBe('local');
  });

  it('treats an unrecognised name as staging rather than production', () => {
    expect(environmentTone('', PROD_URL)).toBe('staging');
    expect(environmentTone('Client sandbox', PROD_URL)).toBe('staging');
  });
});
