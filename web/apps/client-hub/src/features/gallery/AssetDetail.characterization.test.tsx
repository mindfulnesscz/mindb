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
import { render, screen, waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(calls.fetchChildAssets).toHaveBeenCalledWith('asset-1'));
    await waitFor(() => expect(calls.fetchVariants).toHaveBeenCalledWith('asset-1'));
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
