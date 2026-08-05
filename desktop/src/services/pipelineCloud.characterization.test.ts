import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadDropboxFile = vi.fn();
const uploadOneDriveFile = vi.fn();
const uploadGDriveFile = vi.fn();

vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/vfs')).vfs.fsApi());
vi.mock('@tauri-apps/api/path', async () => (await import('../test/vfs')).vfs.pathApi());
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => ({}) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }));
vi.mock('./cloudService', () => ({
  uploadDropboxFile: (...args: unknown[]) => uploadDropboxFile(...args),
  uploadOneDriveFile: (...args: unknown[]) => uploadOneDriveFile(...args),
  uploadGDriveFile: (...args: unknown[]) => uploadGDriveFile(...args),
}));

const { vfs } = await import('../test/vfs');
const { runPipeline } = await import('./pipelineService');
const { makeCtx, makeSettings, SRC } = await import('../test/pipelineHarness');

beforeEach(() => {
  vfs.reset();
  uploadDropboxFile.mockReset();
  uploadOneDriveFile.mockReset();
  uploadGDriveFile.mockReset();
});

describe('cloud export destructive safety', () => {
  it('dry-run plans cloud files without uploading or writing the local upload cache', async () => {
    vfs.tree(SRC, { 'Asset __a1b2c3d4/[03] OUT/(PRD)(SlD) Deck.pdf': 'pdf' });
    const settings = makeSettings({ doFlatExport: true, dryRun: true });
    const run = makeCtx(settings, {
      cloudDestinations: [{
        id: 'dropbox-1', name: 'Client Dropbox', role: 'client', minRole: 'member',
        exportLayout: 'folders', includePackages: false, generateLink: true,
        showInPortal: true, allowRevealLocal: false, enabled: true,
        config: {
          type: 'dropbox', clientId: 'client', remotePath: '/deliverables',
          token: {
            accessToken: 'token', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER,
            email: '', displayName: '',
          },
        },
      }],
    });

    const stats = await runPipeline(run.ctx as never);

    expect(uploadDropboxFile).not.toHaveBeenCalled();
    expect(uploadOneDriveFile).not.toHaveBeenCalled();
    expect(uploadGDriveFile).not.toHaveBeenCalled();
    expect(vfs.ops).toEqual([]);
    expect(stats.published).toBe(1);
    expect(run.logged('[DRY] would upload 1 file(s)')).toBe(true);
  });
});
