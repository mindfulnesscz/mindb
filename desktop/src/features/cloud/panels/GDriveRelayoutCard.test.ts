// @vitest-environment jsdom

/* The screen's job is to make the destructive path unreachable by accident, and to leave the upload
 * cache describing where the files actually are afterwards.
 *
 * The engine's own rails are tested in services/cloud/gdriveRelayout.test.ts; asserted here are the
 * order of the gates — no move without a preview, no move without a typed confirmation, the move
 * carrying the plan id the operator looked at — and the re-key that runs only for moves that
 * applied. A card that skipped the re-key would leave a correct Drive and a cache pointing at paths
 * nothing is at, which costs a full cold export on the next run. */

import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scanGDriveRelayout    = vi.fn();
const executeGDriveRelayout = vi.fn();
const planRelayoutMappings  = vi.fn();
const deliveredRemotePaths  = vi.fn();
const renameDeliveredPaths  = vi.fn();
const scanAllAssets         = vi.fn();

vi.mock('../../../services/cloud/gdriveRelayout', () => ({
  scanGDriveRelayout:    (...args: unknown[]) => scanGDriveRelayout(...args),
  executeGDriveRelayout: (...args: unknown[]) => executeGDriveRelayout(...args),
  planRelayoutMappings:  (...args: unknown[]) => planRelayoutMappings(...args),
}));
vi.mock('../../../services/pipeline/cloudExport', () => ({
  deliveredRemotePaths: (...args: unknown[]) => deliveredRemotePaths(...args),
  renameDeliveredPaths: (...args: unknown[]) => renameDeliveredPaths(...args),
}));
vi.mock('../../../services/pipeline/scan', () => ({
  scanAllAssets: (...args: unknown[]) => scanAllAssets(...args),
}));
vi.mock('../../../services/reportError', () => ({ reportError: vi.fn() }));

const { GDriveRelayoutCard } = await import('./GDriveRelayoutCard');
const { useSettingsStore } = await import('../../../store/settingsStore');

const DEST = {
  id: 'dest-1', name: 'Client Drive', role: 'client' as const, minRole: 'member' as const,
  exportLayout: 'source' as const, includePackages: false, generateLink: true,
  showInPortal: true, allowRevealLocal: false, enabled: true,
  config: {
    type: 'gdrive' as const,
    clientId: 'id', clientSecret: 'secret', sharedDriveId: '', remotePath: 'Clients/Deliverables',
    token: { accessToken: 'tok', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER, email: '', displayName: '' },
  },
};

const MAPPINGS = [{ from: 'Deck.pdf', to: '01 Works/Batch I/Deck.pdf' }];

const PLAN = {
  rootPath: 'Clients/Deliverables',
  rootId: 'deliv',
  scannedFolders: 3,
  planId: 'abc123def456abc123def456',
  warnings: [],
  skipped: [],
  inPlace: 2,
  prune: [{ folderId: 'gallery', path: '(Gll) Studio' }],
  actions: [{
    kind: 'move' as const, fileId: 'f-deck', name: 'Deck.pdf',
    from: 'Deck.pdf', to: '01 Works/Batch I/Deck.pdf',
    fromFolderId: 'deliv', toDir: '01 Works/Batch I',
  }],
  totals: { moves: 1, prune: 1, inPlace: 2, skipped: 0 },
};

const card = () => createElement(GDriveRelayoutCard, { dest: DEST });
const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

async function click(name: RegExp): Promise<void> {
  await act(async () => { button(name).click(); });
}

async function typeConfirmation(word: string): Promise<void> {
  const input = screen.getByRole('textbox') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, word);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  useSettingsStore.setState(state => ({
    settings: { ...state.settings, sourceFolder: '/src', outFolder: '[03] OUT' },
  }));
  scanAllAssets.mockReset().mockResolvedValue(['/src/A __a1111111/[03] OUT/Deck.pdf']);
  deliveredRemotePaths.mockReset().mockResolvedValue(new Set(['Deck.pdf']));
  planRelayoutMappings.mockReset().mockReturnValue({ mappings: MAPPINGS, inPlace: 2, unknown: [] });
  scanGDriveRelayout.mockReset().mockResolvedValue(PLAN);
  executeGDriveRelayout.mockReset().mockResolvedValue({
    plan: PLAN,
    executed: {
      planId: PLAN.planId, moved: 1, trashed: 1, skipped: 0, failed: 0,
      applied: MAPPINGS, audit: [], completedAt: '2026-08-07T00:00:00Z',
    },
  });
  renameDeliveredPaths.mockReset().mockResolvedValue(1);
});
afterEach(cleanup);

describe('GDriveRelayoutCard', () => {
  it('offers no move until a read-only preview has been run', () => {
    render(card());
    expect(screen.queryByRole('button', { name: /Move files/ })).toBeNull();
  });

  it('previews against the destination and keeps the move behind a typed confirmation', async () => {
    render(card());
    await click(/Preview the moves/);

    expect(scanGDriveRelayout).toHaveBeenCalledWith(
      { accessToken: 'tok', remotePath: 'Clients/Deliverables', sharedDriveId: '', destId: 'dest-1' },
      MAPPINGS, 2, expect.any(Function),
    );
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '1 file(s) to move'))
      .toBeTruthy();

    await click(/Move files…/);
    expect(button(/^Move files$/).disabled).toBe(true);
    expect(executeGDriveRelayout).not.toHaveBeenCalled();

    await typeConfirmation('move');
    expect(button(/^Move files$/).disabled).toBe(false);

    await click(/^Move files$/);
    // The plan the operator saw — the engine refuses anything else.
    expect(executeGDriveRelayout).toHaveBeenCalledWith(
      expect.objectContaining({ destId: 'dest-1' }), MAPPINGS, 2, PLAN.planId, expect.any(Function),
    );
    expect(screen.getByText(/Moved 1 file\(s\)/)).toBeTruthy();
  });

  it('re-keys the delivery records for exactly the moves that applied', async () => {
    // Two planned, one failed: re-keying the failed one would point the cache at an empty path and
    // the next run would upload the file a second time, at the new path, beside the old one.
    executeGDriveRelayout.mockResolvedValue({
      plan: PLAN,
      executed: {
        planId: PLAN.planId, moved: 1, trashed: 0, skipped: 0, failed: 1,
        applied: MAPPINGS, audit: [], completedAt: '2026-08-07T00:00:00Z',
      },
    });
    render(card());
    await click(/Preview the moves/);
    await click(/Move files…/);
    await typeConfirmation('move');
    await click(/^Move files$/);

    expect(renameDeliveredPaths).toHaveBeenCalledWith('dest-1', MAPPINGS);
  });

  it('re-keys nothing when the engine refused the plan', async () => {
    executeGDriveRelayout.mockResolvedValue({ plan: PLAN, refused: 'The Drive folders changed since the preview.' });
    render(card());
    await click(/Preview the moves/);
    await click(/Move files…/);
    await typeConfirmation('move');
    await click(/^Move files$/);

    expect(renameDeliveredPaths).not.toHaveBeenCalled();
    expect(screen.getByText(/changed since the preview/)).toBeTruthy();
  });

  it('says the destination is already migrated instead of scanning Drive for nothing', async () => {
    planRelayoutMappings.mockReturnValue({ mappings: [], inPlace: 7, unknown: [] });
    render(card());
    await click(/Preview the moves/);

    expect(scanGDriveRelayout).not.toHaveBeenCalled();
    expect(screen.getByText(/all 7 delivered file\(s\) are already/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Move files/ })).toBeNull();
  });

  it('says so when this machine has no delivery records to reason from', async () => {
    // No records ⇒ no evidence any remote file is ours ⇒ the mover claims nothing at all.
    planRelayoutMappings.mockReturnValue({ mappings: [], inPlace: 0, unknown: ['a', 'b'] });
    render(card());
    await click(/Preview the moves/);

    expect(screen.getByText(/No delivery records for this destination on this machine/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Move files/ })).toBeNull();
  });

  it('surfaces a failed scan and offers nothing destructive after it', async () => {
    scanGDriveRelayout.mockRejectedValue(new Error('Drive folder "Clients/Deliverables" does not exist'));
    render(card());
    await click(/Preview the moves/);

    expect(screen.getByText(/does not exist/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Move files/ })).toBeNull();
  });

  it('cannot scan without a connection or without a source folder', () => {
    const { unmount } = render(createElement(GDriveRelayoutCard, {
      dest: { ...DEST, config: { ...DEST.config, token: null } },
    }));
    expect(button(/Preview the moves/).disabled).toBe(true);
    unmount();

    useSettingsStore.setState(state => ({ settings: { ...state.settings, sourceFolder: '' } }));
    render(card());
    expect(button(/Preview the moves/).disabled).toBe(true);
  });
});
