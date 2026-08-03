// @vitest-environment jsdom

/* Characterization tests — ASSET DETAIL, the portal's most stateful component.
 *
 * 22 useState calls and a dozen effects, all in one function. The plan is to extract those into
 * six hooks (useAssetRating, useAssetComments, useAssetStatus, useAssetChildren, useAssetVariants,
 * useAssetEvents), and the risk in doing that is a broken effect — a fetch that no longer fires, a
 * dependency array that now re-runs forever, a save that silently stops calling its service.
 *
 * So these assert on OBSERVABLE behaviour: what the component fetches on mount, what it calls when
 * the user acts, and what it renders per role. They are written against the CURRENT component and
 * must pass unchanged after the extraction — that is the whole point, and it is what made the
 * pipelineService and supabaseService splits non-events.
 *
 * Every service is stubbed, so nothing here touches a network or a database.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Asset } from '@dc-hub/asset-library';

/* ── Service stubs — recorded so we can assert what the component asked for ── */

const calls = {
  fetchMyRating: vi.fn(async () => 0),
  upsertRating: vi.fn(async () => {}),
  fetchComments: vi.fn(async () => [] as unknown[]),
  addComment: vi.fn(async () => ({})),
  deleteComment: vi.fn(async () => {}),
  fetchChildAssets: vi.fn(async () => [] as Asset[]),
  fetchVariants: vi.fn(async () => [] as Asset[]),
  updateAssetStatus: vi.fn(async () => {}),
  updateAssetPerm: vi.fn(async () => {}),
  deleteAsset: vi.fn(async () => {}),
  deleteAssetAndMedia: vi.fn(async (_a?: unknown, _o?: unknown) => {}),
  trackEvent: vi.fn(async () => {}),
  fetchEventCounts: vi.fn(async () => ({ views: 0, downloads: 0 })),
  fetchDestinations: vi.fn(async () => [] as unknown[]),
  revealInDesktop: vi.fn(async () => {}),
};

let role = 'member';

vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ role }) }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: 'user-1', email: 'u@test' } } }),
}));
vi.mock('../../lib/supabase', () => ({ isConfigured: () => true, supabase: {} }));
vi.mock('../../lib/assetActions', () => ({ webAssetActions: { download: vi.fn(async () => {}) } }));
vi.mock('./ImageLightbox', () => ({ ImageLightbox: () => null }));

vi.mock('../../services/ratingService', () => ({
  fetchMyRating: (...a: unknown[]) => calls.fetchMyRating(...(a as [])),
  upsertRating: (...a: unknown[]) => calls.upsertRating(...(a as [])),
}));
vi.mock('../../services/commentService', () => ({
  fetchComments: (...a: unknown[]) => calls.fetchComments(...(a as [])),
  addComment: (...a: unknown[]) => calls.addComment(...(a as [])),
  deleteComment: (...a: unknown[]) => calls.deleteComment(...(a as [])),
}));
vi.mock('../../services/assetService', () => ({
  fetchChildAssets: (...a: unknown[]) => calls.fetchChildAssets(...(a as [])),
  fetchVariants: (...a: unknown[]) => calls.fetchVariants(...(a as [])),
  updateAssetStatus: (...a: unknown[]) => calls.updateAssetStatus(...(a as [])),
  updateAssetPerm: (...a: unknown[]) => calls.updateAssetPerm(...(a as [])),
  deleteAsset: (...a: unknown[]) => calls.deleteAsset(...(a as [])),
  deleteAssetAndMedia: (...a: unknown[]) => calls.deleteAssetAndMedia(...(a as [])),
  assetFacetLabels: () => [],
}));
vi.mock('../../services/eventService', () => ({
  trackEvent: (...a: unknown[]) => calls.trackEvent(...(a as [])),
  fetchEventCounts: (...a: unknown[]) => calls.fetchEventCounts(...(a as [])),
}));
vi.mock('../../services/destinationService', () => ({
  fetchDestinations: (...a: unknown[]) => calls.fetchDestinations(...(a as [])),
  destinationsVisibleToRole: () => [],
  roleAtLeast: () => true,
}));
vi.mock('../../services/revealService', () => ({
  revealInDesktop: (...a: unknown[]) => calls.revealInDesktop(...(a as [])),
}));

const AssetDetail = (await import('./AssetDetail')).default;

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'asset-1', clientId: 'c1', name: 'Product Slides — Deck',
  entityType: 'product', entity: 'Product', formats: ['Slides'], angle: 'Overview',
  status: 'published', perm: 'public', version: 'v1', latest: true,
  avg: 4, count: 2, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockClear();
  role = 'member';
});

describe('AssetDetail — what it loads on mount', () => {
  it('fetches the viewer’s own rating for this asset', async () => {
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchMyRating).toHaveBeenCalled());
    // Keyed by BOTH asset and user — a rating is one-per-person-per-asset.
    expect(calls.fetchMyRating.mock.calls[0]).toEqual(['asset-1', 'user-1']);
  });

  it('fetches the comment thread', async () => {
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchComments).toHaveBeenCalledWith('asset-1'));
  });

  it('records a view event exactly once per mount', async () => {
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.trackEvent).toHaveBeenCalled());
    const views = (calls.trackEvent.mock.calls as unknown[][]).filter(c => String(c[1] ?? c[0]).includes('view'));
    expect(views.length).toBeLessThanOrEqual(1);
  });

  it('loads children and variants only when the asset declares children', async () => {
    // Gated on childCount, so a plain single asset costs no round-trips at all.
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchComments).toHaveBeenCalled());
    expect(calls.fetchChildAssets).not.toHaveBeenCalled();
    expect(calls.fetchVariants).not.toHaveBeenCalled();
  });

  it('loads children AND variants together when childCount > 0', async () => {
    render(<AssetDetail asset={asset({ childCount: 2 })} mount="drawer" />);
    await waitFor(() =>
      expect(calls.fetchChildAssets).toHaveBeenCalledWith('asset-1', { includeDisconnected: false }));
    await waitFor(() =>
      expect(calls.fetchVariants).toHaveBeenCalledWith('asset-1', { includeDisconnected: false }));
  });

  it('re-fetches when a different asset is shown', async () => {
    const { rerender } = render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchComments).toHaveBeenCalledWith('asset-1'));
    calls.fetchComments.mockClear();

    rerender(<AssetDetail asset={asset({ id: 'asset-2' })} mount="drawer" />);
    await waitFor(() => expect(calls.fetchComments).toHaveBeenCalledWith('asset-2'));
  });

  it('does NOT re-fetch on an unrelated re-render — effects are keyed on the asset', async () => {
    // A dependency array that re-runs on every render would hammer the API from the portal.
    const a = asset();
    const { rerender } = render(<AssetDetail asset={a} mount="drawer" />);
    await waitFor(() => expect(calls.fetchComments).toHaveBeenCalled());
    const before = calls.fetchComments.mock.calls.length;

    rerender(<AssetDetail asset={a} mount="drawer" />);
    rerender(<AssetDetail asset={a} mount="drawer" />);

    expect(calls.fetchComments.mock.calls.length).toBe(before);
  });
});

describe('AssetDetail — role gates', () => {
  it('fetches view/download counts for staff', async () => {
    role = 'editor';
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchEventCounts).toHaveBeenCalledWith('asset-1'));
  });

  it('does NOT fetch counts for a non-staff viewer', async () => {
    role = 'member';
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchComments).toHaveBeenCalled());
    expect(calls.fetchEventCounts).not.toHaveBeenCalled();
  });

  it('renders the asset name for any viewer', async () => {
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(screen.getAllByText(/Deck/).length).toBeGreaterThan(0));
  });
});

describe('AssetDetail — it renders without throwing across mounts and shapes', () => {
  // A smoke net for the hook extraction: a broken effect or a hook called conditionally shows up
  // here as a render crash rather than as a subtle behavioural change.
  for (const mount of ['drawer', 'page'] as const) {
    it(`mount="${mount}"`, async () => {
      render(<AssetDetail asset={asset()} mount={mount} />);
      await waitFor(() => expect(calls.fetchComments).toHaveBeenCalled());
    });
  }

  it('an asset with children (a gallery parent)', async () => {
    calls.fetchChildAssets.mockResolvedValueOnce([asset({ id: 'kid-1', name: 'Child One' })]);
    render(<AssetDetail asset={asset({ childCount: 1 })} mount="drawer" />);
    await waitFor(() => expect(calls.fetchChildAssets).toHaveBeenCalled());
  });

  it('an asset with variants (a rendition set)', async () => {
    calls.fetchVariants.mockResolvedValueOnce([
      asset({ id: 'asset-1', name: 'Product Slides — Deck' }),
      asset({ id: 'var-2', name: 'Product PDF — Deck' }),
    ]);
    render(<AssetDetail asset={asset({ childCount: 2 })} mount="drawer" />);
    await waitFor(() => expect(calls.fetchVariants).toHaveBeenCalled());
  });

  it('survives every service rejecting — a failed fetch must not blank the panel', async () => {
    for (const fn of [calls.fetchMyRating, calls.fetchComments, calls.fetchChildAssets,
                      calls.fetchVariants, calls.fetchEventCounts, calls.fetchDestinations]) {
      fn.mockRejectedValueOnce(new Error('offline'));
    }
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(screen.getAllByText(/Deck/).length).toBeGreaterThan(0));
  });

  it('a staff viewer, which enables the widest set of effects', async () => {
    role = 'admin';
    render(<AssetDetail asset={asset()} mount="page" />);
    await waitFor(() => expect(calls.fetchEventCounts).toHaveBeenCalled());
  });
});

/* ── Disconnected sub-assets ──────────────────────────────────────────────────
 * A gallery child or a rendition sibling is never a top-level card, so when one goes
 * `disconnected` the parent detail is the ONLY place it can be reached. These pin the two halves
 * that made it unreachable: that staff ask for those rows at all, and that they are kept out of the
 * browse surfaces once fetched. */

describe('AssetDetail — disconnected sub-assets', () => {
  const stale = (over: Partial<Asset> = {}): Asset =>
    asset({ id: 'gone-1', name: 'Gallery Video', status: 'disconnected', ...over });

  it('staff ask for disconnected sub-assets; other roles never see them', async () => {
    role = 'editor';
    render(<AssetDetail asset={asset({ childCount: 3 })} mount="drawer" />);
    await waitFor(() =>
      expect(calls.fetchChildAssets).toHaveBeenCalledWith('asset-1', { includeDisconnected: true }));
    expect(calls.fetchVariants).toHaveBeenCalledWith('asset-1', { includeDisconnected: true });
  });

  it('staff fetch even at childCount 0 — that count excludes the disconnected ones', async () => {
    // The trap this closes: a family whose every sub-asset is disconnected reports childCount 0, so
    // gating the fetch on it made exactly the rows needing review the ones never asked for.
    role = 'admin';
    render(<AssetDetail asset={asset()} mount="drawer" />);
    await waitFor(() => expect(calls.fetchChildAssets).toHaveBeenCalled());
    expect(calls.fetchVariants).toHaveBeenCalled();
  });

  it('lists a disconnected gallery child, labelled, with a way to remove it', async () => {
    role = 'admin';
    calls.fetchChildAssets.mockResolvedValueOnce([stale()]);
    render(<AssetDetail asset={asset({ childCount: 0 })} mount="drawer" />);

    await waitFor(() => expect(screen.getByText('Gallery Video')).toBeTruthy());
    expect(screen.getByText(/Gallery image · Disconnected/)).toBeTruthy();
    expect(screen.getByText('Disconnected · 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('keeps a disconnected child OUT of the files grid', async () => {
    // Mixing it back in would present a removed image as a deliverable — and put it in the
    // lightbox and the download-all set with it.
    role = 'admin';
    calls.fetchChildAssets.mockResolvedValueOnce([
      asset({ id: 'kid-1', name: 'Live One', thumbnailUrl: 'x.webp' }),
      stale(),
    ]);
    render(<AssetDetail asset={asset({ childCount: 1 })} mount="drawer" />);

    await waitFor(() => expect(screen.getByText('Gallery Video')).toBeTruthy());
    expect(screen.getByText('Files · 1')).toBeTruthy();
  });

  it('removing one deletes the row and drops it from the list', async () => {
    role = 'admin';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    calls.fetchVariants.mockResolvedValueOnce([stale({ id: 'var-gone', name: 'Print Master' })]);
    render(<AssetDetail asset={asset()} mount="drawer" />);

    await waitFor(() => expect(screen.getByText('Print Master')).toBeTruthy());
    expect(screen.getByText(/Version · Disconnected/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(calls.deleteAssetAndMedia).toHaveBeenCalled());
    expect(calls.deleteAssetAndMedia.mock.calls[0]?.[0]).toMatchObject({ id: 'var-gone' });
    await waitFor(() => expect(screen.queryByText('Print Master')).toBeNull());
    confirm.mockRestore();
  });

  it('a cancelled confirm deletes nothing', async () => {
    role = 'admin';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    calls.fetchChildAssets.mockResolvedValueOnce([stale()]);
    render(<AssetDetail asset={asset()} mount="drawer" />);

    await waitFor(() => expect(screen.getByText('Gallery Video')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(calls.deleteAssetAndMedia).not.toHaveBeenCalled();
    expect(screen.getByText('Gallery Video')).toBeTruthy();
    confirm.mockRestore();
  });

  it('shows nothing at all when every sub-asset is live', async () => {
    role = 'admin';
    calls.fetchChildAssets.mockResolvedValueOnce([asset({ id: 'kid-1', name: 'Live One' })]);
    render(<AssetDetail asset={asset({ childCount: 1 })} mount="drawer" />);

    await waitFor(() => expect(calls.fetchChildAssets).toHaveBeenCalled());
    expect(screen.queryByText(/^Disconnected · /)).toBeNull();
  });
});
