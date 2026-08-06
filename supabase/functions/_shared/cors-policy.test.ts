import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, parseAllowedOrigins } from './cors-policy';

describe('edge-function CORS policy', () => {
  it('accepts only origins explicitly named in configuration', () => {
    const allowed = new Set(parseAllowedOrigins(
      'https://hub.example.com, https://known-preview.vercel.app/',
    ));

    expect(isAllowedOrigin('https://hub.example.com', allowed)).toBe(true);
    expect(isAllowedOrigin('https://known-preview.vercel.app', allowed)).toBe(true);
    expect(isAllowedOrigin('https://attacker-preview.vercel.app', allowed)).toBe(false);
    expect(isAllowedOrigin('https://hub.example.com.attacker.test', allowed)).toBe(false);
  });
});
