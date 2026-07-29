/* Covers the identity rules the Vocabulary scaffold depends on: its extensionless
   placeholder reserves child_id 'c1', and the first real file must claim that id rather
   than mint a new one (which would strand the draft DB row as a phantom primary) — while a
   set of format variants sharing one base must still get distinct ids. Exercised through
   resolveCdnIdentity, the exported entry point into resolveChildId. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const files = new Map<string, string>();   // path → text content (manifests)
const bytes = new Map<string, Uint8Array>(); // path → asset bytes

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists:       async (p: string) => files.has(p),
  readTextFile: async (p: string) => files.get(p) ?? '',
  writeTextFile: async (p: string, c: string) => { files.set(p, c); },
  readFile:     async (p: string) => bytes.get(p) ?? new Uint8Array([1, 2, 3]),
}));

const { resolveCdnIdentity } = await import('./supabaseService');

const PKG      = '/src/Assets/Launch Deck __a1b2c3d4';
const MANIFEST = `${PKG}/.dchub.json`;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function scaffoldManifest(placeholderStem: string) {
  files.set(MANIFEST, JSON.stringify({
    stable_id: 'a1b2c3d4',
    children: { [placeholderStem]: { child_id: 'c1', sha256: EMPTY_SHA } },
    updated_at: '',
  }));
}

const manifestChildren = () => JSON.parse(files.get(MANIFEST)!).children as Record<string, { child_id: string }>;

beforeEach(() => {
  files.clear();
  bytes.clear();
});

describe('scaffold placeholder adoption', () => {
  it('lets the real file claim the reserved c1 and retires the placeholder key', async () => {
    scaffoldManifest('(Brnd)(SlD) Launch Deck v1-0-0');
    bytes.set(`${PKG}/OUT/(Brnd)(SlD) Launch Deck v1-0-0.pdf`, new Uint8Array([9, 9]));

    const ids = await resolveCdnIdentity([`${PKG}/OUT/(Brnd)(SlD) Launch Deck v1-0-0.pdf`], 'OUT');

    expect(ids.get('(Brnd)(SlD) Launch Deck v1-0-0.pdf')).toEqual({ stableId: 'a1b2c3d4', childId: 'c1' });
    expect(Object.keys(manifestChildren())).toEqual(['(Brnd)(SlD) Launch Deck v1-0-0.pdf']);
  });

  it('gives format variants distinct ids — only one may claim the placeholder', async () => {
    scaffoldManifest('(Brnd)(SlD) Launch Deck v1-0-0');
    const pdf = `${PKG}/OUT/(Brnd)(SlD) Launch Deck v1-0-0.pdf`;
    const png = `${PKG}/OUT/(Brnd)(SlD) Launch Deck v1-0-0.png`;
    bytes.set(pdf, new Uint8Array([1]));
    bytes.set(png, new Uint8Array([2]));

    const ids = await resolveCdnIdentity([pdf, png], 'OUT');

    const a = ids.get('(Brnd)(SlD) Launch Deck v1-0-0.pdf')!.childId;
    const b = ids.get('(Brnd)(SlD) Launch Deck v1-0-0.png')!.childId;
    expect(a).not.toEqual(b);
    expect(new Set([a, b])).toEqual(new Set(['c1', 'c2']));
  });

  it('keeps a version bump on the same child id', async () => {
    scaffoldManifest('(Brnd)(SlD) Launch Deck v1-0-0');
    const v1 = `${PKG}/OUT/(Brnd)(SlD) Launch Deck v1-0-0.pdf`;
    bytes.set(v1, new Uint8Array([1]));
    await resolveCdnIdentity([v1], 'OUT');

    const v2 = `${PKG}/OUT/(Brnd)(SlD) Launch Deck v1-1-0.pdf`;
    bytes.set(v2, new Uint8Array([7]));
    const ids = await resolveCdnIdentity([v2], 'OUT');

    expect(ids.get('(Brnd)(SlD) Launch Deck v1-1-0.pdf')!.childId).toBe('c1');
  });

  it('does not let an unrelated file claim the placeholder', async () => {
    scaffoldManifest('(Brnd)(SlD) Launch Deck v1-0-0');
    const other = `${PKG}/OUT/(Brnd)(Img) Something Else v1-0-0.png`;
    bytes.set(other, new Uint8Array([5]));

    const ids = await resolveCdnIdentity([other], 'OUT');

    expect(ids.get('(Brnd)(Img) Something Else v1-0-0.png')!.childId).toBe('c2');
    expect(manifestChildren()['(Brnd)(SlD) Launch Deck v1-0-0'].child_id).toBe('c1');
  });
});
