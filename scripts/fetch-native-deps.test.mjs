import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDigest,
  hasValidCache,
  sha256Tree,
  validatePins,
} from './fetch-native-deps.mjs';

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('native dependency integrity', () => {
  it('refuses an engine table with an unpinned download', () => {
    expect(() => validatePins({
      unsafe: {
        platforms: {
          'test-x64': { url: 'https://example.test/native.tgz', sha256: null },
        },
      },
    })).toThrow(/missing valid sha256.*refusing unverified native code/);
  });

  it('refuses downloaded bytes that differ from the pinned archive digest', () => {
    const spec = { url: 'https://example.test/native.tgz', sha256: 'a'.repeat(64) };
    expect(() => assertDigest('unsafe', spec, 'b'.repeat(64))).toThrow(/digest mismatch/);
  });

  it('invalidates a cache when a payload is swapped or absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-native-cache-'));
    cleanup.push(root);
    const outDir = join(root, 'pdfium');
    const binary = join(outDir, 'libpdfium.so');
    const spec = { sha256: 'a'.repeat(64) };
    await mkdir(outDir);
    await writeFile(binary, 'trusted binary');
    const tree = await sha256Tree(outDir);
    await writeFile(join(outDir, '.stamp.json'), JSON.stringify({
      platform: 'linux-x64',
      digests: { archive: spec.sha256, tree },
    }));

    expect(await hasValidCache(outDir, spec, 'linux-x64', ['libpdfium.so'])).toBe(true);

    await writeFile(binary, 'swapped binary');
    expect(await hasValidCache(outDir, spec, 'linux-x64', ['libpdfium.so'])).toBe(false);

    await rm(binary);
    expect(await hasValidCache(outDir, spec, 'linux-x64', ['libpdfium.so'])).toBe(false);
  });
});
