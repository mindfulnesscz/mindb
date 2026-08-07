// @vitest-environment jsdom

/* The screen's job is to make the destructive path unreachable by accident.
 *
 * The engine's own rails are tested in services/cloud/gdriveDedupe.test.ts; what is asserted here is
 * the order of the gates: no merge without a preview, no merge without a typed confirmation, and the
 * merge that does run carries the plan id the operator actually looked at. */

import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scanGDriveDuplicates = vi.fn();
const executeGDriveDedupe = vi.fn();

vi.mock('../../../services/cloud/gdriveDedupe', () => ({
  scanGDriveDuplicates: (...args: unknown[]) => scanGDriveDuplicates(...args),
  executeGDriveDedupe: (...args: unknown[]) => executeGDriveDedupe(...args),
}));
vi.mock('../../../services/reportError', () => ({ reportError: vi.fn() }));

const { GDriveDedupeCard } = await import('./GDriveDedupeCard');

const CFG = {
  type: 'gdrive' as const,
  clientId: 'id', clientSecret: 'secret', sharedDriveId: '', remotePath: 'Clients/Deliverables',
  token: { accessToken: 'tok', refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER, email: '', displayName: '' },
};

const PLAN = {
  rootPath: 'Clients/Deliverables',
  rootId: 'deliv-old',
  scannedFolders: 4,
  planId: 'abc123def456abc123def456',
  warnings: [],
  collisions: [],
  actions: [{ kind: 'trash-folder' as const, folderId: 'deliv-new', name: 'Deliverables', path: 'Clients/Deliverables' }],
  sets: [{
    path: 'Clients/Deliverables', name: 'Deliverables',
    canonicalId: 'deliv-old', canonicalCreatedTime: '2026-02-01T00:00:00Z',
    duplicates: [{ id: 'deliv-new', createdTime: '2026-02-01T00:00:05Z' }],
    filesMoved: 2, foldersMoved: 0, filesTrashed: 1, foldersTrashed: 1, collisions: 1,
  }],
  totals: {
    duplicateSets: 1, duplicateFolders: 1, filesMoved: 2, foldersMoved: 0,
    filesTrashed: 1, foldersTrashed: 1, collisions: 1,
  },
};

const card = () => createElement(GDriveDedupeCard, { cfg: CFG, destName: 'Client Drive' });
const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

async function click(name: RegExp): Promise<void> {
  await act(async () => { button(name).click(); });
}

beforeEach(() => {
  scanGDriveDuplicates.mockReset().mockResolvedValue(PLAN);
  executeGDriveDedupe.mockReset().mockResolvedValue({
    plan: PLAN,
    executed: { planId: PLAN.planId, applied: 4, skipped: 0, failed: 0, audit: [], completedAt: '2026-08-07T00:00:00Z' },
  });
});
afterEach(cleanup);

describe('GDriveDedupeCard', () => {
  it('offers no merge until a read-only preview has been run', () => {
    render(card());
    expect(screen.queryByRole('button', { name: /Merge duplicates/ })).toBeNull();
  });

  it('shows what the merge would do, and keeps it behind a typed confirmation', async () => {
    render(card());
    await click(/Preview duplicate folders/);

    expect(scanGDriveDuplicates).toHaveBeenCalledWith(
      { accessToken: 'tok', remotePath: 'Clients/Deliverables', sharedDriveId: '' },
      expect.any(Function),
    );
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '1 duplicate set(s)'))
      .toBeTruthy();

    await click(/Merge duplicates…/);
    expect(button(/^Merge duplicates$/).disabled).toBe(true);
    expect(executeGDriveDedupe).not.toHaveBeenCalled();

    const input = screen.getByRole('textbox') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'merge');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(/^Merge duplicates$/).disabled).toBe(false);

    await click(/^Merge duplicates$/);
    // The plan the operator saw — the engine refuses anything else.
    expect(executeGDriveDedupe).toHaveBeenCalledWith(
      expect.objectContaining({ remotePath: 'Clients/Deliverables' }),
      PLAN.planId,
      expect.any(Function),
    );
    expect(screen.getByText(/4 action\(s\) applied/)).toBeTruthy();
  });

  it('reports a clean destination instead of an empty table', async () => {
    scanGDriveDuplicates.mockResolvedValue({
      ...PLAN, sets: [], actions: [], totals: { ...PLAN.totals, duplicateSets: 0, duplicateFolders: 0 },
    });
    render(card());
    await click(/Preview duplicate folders/);

    expect(screen.getByText(/No duplicate folders/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Merge duplicates/ })).toBeNull();
  });

  it('surfaces a failed scan and offers nothing destructive after it', async () => {
    scanGDriveDuplicates.mockRejectedValue(new Error('Drive folder "Clients/Deliverables" does not exist'));
    render(card());
    await click(/Preview duplicate folders/);

    expect(screen.getByText(/does not exist/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Merge duplicates/ })).toBeNull();
  });

  it('cannot scan a destination that is not connected', () => {
    render(createElement(GDriveDedupeCard, { cfg: { ...CFG, token: null }, destName: 'Client Drive' }));
    expect(button(/Preview duplicate folders/).disabled).toBe(true);
  });
});
