/* The pure path helpers that replaced `@tauri-apps/api/path` in the per-file walks.
 *
 * The point of these tests is not that string concatenation works — it is that these produce
 * EXACTLY what the platform call produced, because an R2 object key, a package mirror purge and a
 * disconnect-rename are all decided from paths built this way. `vfs.pathApi()` is the shape the
 * characterization suites have always compared against, so its normal form is what is pinned here.
 */

import { describe, it, expect } from 'vitest';
import { joinPath, parentPath, baseName } from './paths';

describe('joinPath', () => {
  it('joins absolute segments', () => {
    expect(joinPath('/src/Asset __a1', 'OUT', 'Deck.pdf')).toBe('/src/Asset __a1/OUT/Deck.pdf');
  });

  it('collapses doubled slashes and trailing slashes rather than repeating them', () => {
    expect(joinPath('/src/', 'OUT/')).toBe('/src/OUT');
    expect(joinPath('/src//a', '/b')).toBe('/src/a/b');
  });

  it('drops empty segments instead of producing a doubled slash', () => {
    expect(joinPath('/src', '', 'Deck.pdf')).toBe('/src/Deck.pdf');
    expect(joinPath('/src', undefined, null, 'Deck.pdf')).toBe('/src/Deck.pdf');
  });

  it('normalises Windows separators — settings files have carried them', () => {
    expect(joinPath('C:\\Users\\me\\src', 'OUT')).toBe('C:/Users/me/src/OUT');
  });

  it('leaves a relative first segment relative, as the platform call does', () => {
    expect(joinPath('OUT', 'Deck.pdf')).toBe('OUT/Deck.pdf');
  });

  it('does not resolve . or .. — resolution belongs in Rust, behind the scope check', () => {
    expect(joinPath('/src/a', '..', 'b')).toBe('/src/a/../b');
  });

  it('returns an empty string for no usable segments', () => {
    expect(joinPath()).toBe('');
    expect(joinPath('', undefined)).toBe('');
  });

  it('keeps the root as the root', () => {
    expect(joinPath('/', 'src')).toBe('/src');
  });
});

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('/src/Asset __a1/OUT/Deck.pdf')).toBe('/src/Asset __a1/OUT');
  });

  it('ignores a trailing slash', () => {
    expect(parentPath('/src/OUT/')).toBe('/src');
  });

  it('bottoms out at the root rather than at an empty string', () => {
    expect(parentPath('/src')).toBe('/');
    expect(parentPath('/')).toBe('/');
  });
});

describe('baseName', () => {
  it('returns the last segment', () => {
    expect(baseName('/src/OUT/(PRD)(SlD) Deck.pdf')).toBe('(PRD)(SlD) Deck.pdf');
  });

  it('ignores a trailing slash, so a directory reports its own name', () => {
    expect(baseName('/src/📦 Package/')).toBe('📦 Package');
  });

  it('reports nothing for the root', () => {
    expect(baseName('/')).toBe('');
  });
});

/* The helpers must agree with the mock the characterization suites have always used, or those
   suites would be asserting one normal form while production produced another. */
describe('agreement with the virtual filesystem path API', () => {
  const cases: Array<[string, string]> = [
    ['/src', 'Asset __a1000001'],
    ['/src/', 'OUT'],
    ['/src//nested', 'thumbnails'],
    ['/src/OUT', '(PRD)(SlD) Deck.pdf'],
  ];

  it('joins identically', async () => {
    const { vfs } = await import('../../test/vfs');
    const pathApi = vfs.pathApi();
    for (const [dir, name] of cases) {
      expect(joinPath(dir, name)).toBe(await pathApi.join(dir, name));
    }
  });

  it('takes the same parent and basename', async () => {
    const { vfs } = await import('../../test/vfs');
    const pathApi = vfs.pathApi();
    for (const [dir, name] of cases) {
      const full = joinPath(dir, name);
      expect(parentPath(full)).toBe(await pathApi.dirname(full));
      expect(baseName(full)).toBe(await pathApi.basename(full));
    }
  });
});
