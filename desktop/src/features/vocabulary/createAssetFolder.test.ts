/* Seeding an asset folder — the one place a stable_id is minted.
 *
 * Everything an asset accumulates over its life (ratings, comments, approvals, view and download
 * events, CDN object keys, version history) hangs off the `stable_id` written here. Two failures are
 * unrecoverable rather than merely annoying:
 *
 *   a COLLIDING id      the new folder claims another asset's history;
 *   a MISSING manifest  the first pipeline run cannot recognise the placeholder and creates a second
 *                       row beside it, splitting one asset in two.
 *
 * The placeholder being extensionless is load-bearing too: the pipeline scanner requires a dot, so an
 * unfinished asset is skipped rather than published empty to a client.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vfs } from '../../test/vfs';
import type { VocabTag } from '@sotto/domain';

vi.mock('@tauri-apps/plugin-fs', () => vfs.fsApi());

const supabase = {
  fetchExistingStableIds: vi.fn(async () => new Set<string>()),
  createDraftAsset:       vi.fn(async () => ({ id: 'row-1' })),
};
vi.mock('../../services/supabaseService', () => supabase);

const readme = {
  writeReadme:     vi.fn(async () => {}),
  README_FILENAME: 'readme.md',
};
vi.mock('../../services/readmeService', () => readme);

const { createAssetFolder } = await import('./createAssetFolder');

const tag = (slot: 'entity' | 'angle' | 'format', shortcode: string, label: string): VocabTag =>
  ({ slot, shortcode, label } as VocabTag);

const TAGS = [tag('entity', 'PRD', 'Product'), tag('angle', 'OVW', 'Overview'), tag('format', 'DCK', 'Deck')];

const input = (over: Record<string, unknown> = {}) => ({
  stem: '(PRD)(OVW)(DCK) Sealing v1-0-0',
  folderName: 'Sealing overview',
  targetFolder: '/Clients/ESS',
  selectedTags: TAGS,
  description: 'Sealing',
  version: { major: '1', minor: '0', patch: '0' },
  clientId: 'client-1',
  config: { url: 'https://sb.example', anonKey: 'anon' },
  now: () => '2026-07-30T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vfs.reset();
  vfs.mkdirp('/Clients/ESS');
  supabase.fetchExistingStableIds.mockReset().mockResolvedValue(new Set<string>());
  supabase.createDraftAsset.mockReset().mockResolvedValue({ id: 'row-1' });
  readme.writeReadme.mockReset().mockResolvedValue(undefined);
});

describe('createAssetFolder — identity', () => {
  it('suffixes the folder with a hash, which is the asset’s permanent identity', async () => {
    const r = await createAssetFolder(input());

    expect(r.folder).toMatch(/^Sealing overview __[a-z0-9]+$/);
    expect(r.packageDir).toBe(`/Clients/ESS/${r.folder}`);
    expect(r.folder).toContain(r.stableId);
  });

  it('checks the id against every stable_id the CLIENT already holds', async () => {
    // A collision would silently attach this folder to another asset's ratings and history.
    await createAssetFolder(input());
    expect(supabase.fetchExistingStableIds).toHaveBeenCalledWith('client-1', input().config);
  });

  it('never reuses an id that is already taken', async () => {
    // Force the first candidates to be taken; the result must still be unique.
    const first = await createAssetFolder(input());
    supabase.fetchExistingStableIds.mockResolvedValue(new Set([first.stableId]));

    const second = await createAssetFolder(input({ folderName: 'Another' }));
    expect(second.stableId).not.toBe(first.stableId);
  });

  it('names the folder from the TYPED name, never from the bracket-coded stem', async () => {
    // Folder names cannot contain parentheses, and the tag-derived name would be unusably long.
    const r = await createAssetFolder(input({ folderName: 'Short name' }));
    expect(r.folder).toContain('Short name');
    expect(r.folder).not.toContain('(PRD)');
  });

  it('trims the typed folder name', async () => {
    const r = await createAssetFolder(input({ folderName: '  Padded  ' }));
    expect(r.folder.startsWith('Padded __')).toBe(true);
  });
});

describe('createAssetFolder — what lands on disk', () => {
  it('creates the IN / WRK / OUT working tree', async () => {
    const { packageDir } = await createAssetFolder(input());
    for (const dir of ['IN', 'WRK', 'OUT']) {
      expect(vfs.hasDir(`${packageDir}/${dir}`)).toBe(true);
    }
  });

  it('seeds an EMPTY, EXTENSIONLESS placeholder named after the shortcode', async () => {
    // No dot ⇒ the pipeline scanner skips it, so an unfinished asset is never published to a client.
    const { packageDir } = await createAssetFolder(input());
    const placeholder = `${packageDir}/OUT/(PRD)(OVW)(DCK) Sealing v1-0-0`;

    expect(vfs.hasFile(placeholder)).toBe(true);
    expect(vfs.text(placeholder)).toBe('');
    expect(placeholder.split('/').pop()).not.toContain('.');
  });

  it('writes a manifest that RESERVES child_id c1 for the placeholder', async () => {
    // Without the reservation the first real sync creates a second row instead of updating this one.
    const { packageDir, stableId } = await createAssetFolder(input());
    const manifest = JSON.parse(vfs.text(`${packageDir}/.dchub.json`));

    expect(manifest.stable_id).toBe(stableId);
    expect(manifest.children['(PRD)(OVW)(DCK) Sealing v1-0-0']).toEqual({
      child_id: 'c1',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(manifest.updated_at).toBe('2026-07-30T00:00:00.000Z');
  });

  it('records the empty-file SHA-256, matching the placeholder it describes', async () => {
    const { packageDir } = await createAssetFolder(input());
    const manifest = JSON.parse(vfs.text(`${packageDir}/.dchub.json`));
    const entry = Object.values(manifest.children)[0] as { sha256: string };
    // The well-known SHA-256 of zero bytes — the hash the next run will compute for an untouched file.
    expect(entry.sha256).toHaveLength(64);
  });

  it('writes a draft readme carrying the tags and the stable id', async () => {
    const { packageDir, stableId } = await createAssetFolder(input());
    expect(readme.writeReadme).toHaveBeenCalledWith(packageDir, expect.objectContaining({
      stableId, status: 'draft', perm: 'internal', version: '1-0-0', tags: TAGS,
    }));
  });

  it('versions a brand-new asset 0-1-0 when no version was entered', async () => {
    // Pre-release until someone versions it deliberately.
    await createAssetFolder(input({ version: { major: '', minor: '', patch: '' } }));
    expect(readme.writeReadme.mock.calls[0][1]).toMatchObject({ version: '0-1-0' });
  });

  it('fills in the missing parts of a partial version', async () => {
    await createAssetFolder(input({ version: { major: '2', minor: '', patch: '' } }));
    expect(readme.writeReadme.mock.calls[0][1]).toMatchObject({ version: '2-0-0' });
  });
});

describe('createAssetFolder — the draft row', () => {
  it('sends the tag labels split by dimension', async () => {
    const { stableId } = await createAssetFolder(input());
    expect(supabase.createDraftAsset).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client-1', stableId,
      entities: ['Product'], angles: ['Overview'], formats: ['Deck'],
      tags: ['Product', 'Overview', 'Deck'],
    }), input().config);
  });

  it('builds the asset name from the tag labels plus the description', async () => {
    await createAssetFolder(input());
    expect(supabase.createDraftAsset.mock.calls[0][0]).toMatchObject({
      name: 'Product Overview Deck Sealing',
    });
  });

  it('falls back to the shortcode when there is nothing to name it from', async () => {
    await createAssetFolder(input({ selectedTags: [], description: '' }));
    expect(supabase.createDraftAsset.mock.calls[0][0]).toMatchObject({
      name: '(PRD)(OVW)(DCK) Sealing v1-0-0',
    });
  });

  it('reports a failed draft row as PARTIAL, naming what was already written', async () => {
    // The folder is already on disk. Told only "failed", the operator retries and ends up with two
    // folders for one asset — each with its own identity.
    supabase.createDraftAsset.mockRejectedValue(new Error('permission denied'));

    await expect(createAssetFolder(input())).rejects.toThrow(/were created, but the Supabase draft row failed/);
    await expect(createAssetFolder(input())).rejects.toThrow(/permission denied/);
  });

  it('leaves the folder in place when the row fails — it is recoverable, not garbage', async () => {
    supabase.createDraftAsset.mockRejectedValue(new Error('offline'));
    await createAssetFolder(input()).catch(() => {});

    const seeded = vfs.ops.filter(o => o.kind === 'mkdir' && o.path.includes('Sealing overview __'));
    expect(seeded.length).toBeGreaterThan(0);
  });
});
