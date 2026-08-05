// @vitest-environment jsdom

/* `/share/:id` — the four states.
 *
 * This route shipped documented-as-working while being a stub over MOCK_ASSETS, which in production
 * meant "Asset not found" every time. These tests exist mostly so that cannot recur silently: each one
 * pins a state against what the DATABASE returned, not against a fixture list compiled into the bundle.
 *
 * The two states worth reading carefully are the last two. RLS answers "no such asset" and "not yours"
 * identically, so the only thing this component may branch on is whether there is a session — and
 * neither message may confirm the asset exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Asset } from '@sotto/asset-library';

const ASSET: Asset = {
  id: 'id-shared', clientId: 'c1', name: 'Shared Deck',
  entityType: 'product', entity: 'Sofa', formats: ['Slides'], angle: 'Overview',
  status: 'published', perm: 'public', version: 'v1', latest: true,
  avg: 4, count: 2, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  thumbnailUrl: 'https://cdn.example/thumb.webp',
};

let session: { user: { id: string; email: string } } | null = null;
let slug: string | undefined = 'ess';

const fetchAsset = vi.fn(async (id: string): Promise<Asset | null> => (id === ASSET.id ? ASSET : null));

vi.mock('../../lib/supabase', () => ({ isConfigured: () => true, supabase: {} }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ session }) }));
vi.mock('../../context/RoleContext', () => ({
  useRole: () => ({
    role: 'member',
    activeClient: slug ? { id: 'c1', name: 'ESS', slug, accent: '#161616', initials: 'ES' } : null,
  }),
}));
vi.mock('../../services/assetService', () => ({
  fetchAsset: (id: string) => fetchAsset(id),
  fetchChildAssets: vi.fn(async () => []),
  fetchVariants: vi.fn(async () => []),
  updateAssetStatus: vi.fn(async () => {}),
  updateAssetPerm: vi.fn(async () => {}),
  deleteAsset: vi.fn(async () => {}),
  deleteAssetAndMedia: vi.fn(async () => {}),
  assetFacetLabels: () => [],
}));
vi.mock('../../services/ratingService', () => ({
  fetchMyRating: vi.fn(async () => 0), upsertRating: vi.fn(async () => {}),
}));
vi.mock('../../services/commentService', () => ({
  fetchComments: vi.fn(async () => []), addComment: vi.fn(async () => ({})), deleteComment: vi.fn(async () => {}),
}));
vi.mock('../../services/eventService', () => ({
  trackEvent: vi.fn(async () => {}), fetchEventCounts: vi.fn(async () => ({ views: 0, downloads: 0 })),
}));
vi.mock('../../services/destinationService', () => ({
  fetchDestinations: vi.fn(async () => []), destinationsVisibleToRole: () => [], roleAtLeast: () => true,
}));
vi.mock('../../services/revealService', () => ({ revealInDesktop: vi.fn(async () => {}) }));
vi.mock('../../lib/assetActions', () => ({ webAssetActions: { download: vi.fn(async () => {}) } }));
vi.mock('./hooks/useStreamMedia', () => ({ useStreamMedia: () => () => null }));
vi.mock('./ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../auth/SignInModal', () => ({ default: () => <div data-testid="sign-in-modal" /> }));

const AssetDetailPage = (await import('./AssetDetailPage')).default;

function renderAt(at: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="share/:id" element={<AssetDetailPage />} />
          <Route path=":slug" element={<div>the ess portal</div>} />
          <Route index element={<div>admin landing</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchAsset.mockClear();
  session = null;
  slug = 'ess';
});

describe('the asset resolves', () => {
  it('reads the DATABASE, not MOCK_ASSETS', async () => {
    renderAt('/share/id-shared');
    await waitFor(() => expect(fetchAsset).toHaveBeenCalledWith('id-shared'));
    await waitFor(() => expect(screen.getAllByText(/Shared Deck/).length).toBeGreaterThan(0));
  });

  it('a mock-library id is NOT found — the bundle is not a source of assets', async () => {
    // The exact bug this route shipped with: MOCK_ASSETS ids resolved locally and real ones never did.
    renderAt('/share/a1');
    await waitFor(() => expect(screen.getByText(/don't have access|Sign in to view/)).toBeTruthy());
  });

  it('renders a skeleton while the row is in flight', () => {
    renderAt('/share/id-shared');
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});

describe('the asset does not resolve', () => {
  it('with no session, it asks the viewer to sign in', async () => {
    renderAt('/share/00000000-0000-0000-0000-000000000000');
    await waitFor(() => expect(screen.getByText('Sign in to view this asset.')).toBeTruthy());
  });

  it('with a session, it says access rather than sign in', async () => {
    session = { user: { id: 'u1', email: 'u@test' } };
    renderAt('/share/00000000-0000-0000-0000-000000000000');
    await waitFor(() => expect(screen.getByText("You don't have access to this asset.")).toBeTruthy());
    expect(screen.queryByText('Sign in to view this asset.')).toBeNull();
  });

  it('neither message confirms the asset exists', async () => {
    // RLS returns nothing for "no such row" and for "not yours" alike, so nothing here may imply which.
    for (const withSession of [false, true]) {
      session = withSession ? { user: { id: 'u1', email: 'u@test' } } : null;
      const view = renderAt('/share/00000000-0000-0000-0000-000000000000');
      await waitFor(() => expect(screen.getByText(/access to this asset|Sign in to view/)).toBeTruthy());
      expect(screen.queryByText(/exists|deleted|no such/i)).toBeNull();
      view.unmount();
    }
  });

  it('the sign-in CTA opens the modal', async () => {
    renderAt('/share/00000000-0000-0000-0000-000000000000');
    await waitFor(() => expect(screen.getByText('Sign in to view this asset.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Sign in / Request access' }));

    expect(screen.getByTestId('sign-in-modal')).toBeTruthy();
  });

  it('a malformed id is a handled state, not a crash', async () => {
    renderAt('/share/not-a-uuid');
    await waitFor(() => expect(screen.getByText('Sign in to view this asset.')).toBeTruthy());
  });
});

describe('the back link', () => {
  it('points at the viewer\'s own portal, never the staff landing', async () => {
    /* It used to be an unconditional `Link to="/"` in both branches, which sends a client to the DC
       admin page. */
    session = { user: { id: 'u1', email: 'u@test' } };
    renderAt('/share/id-shared');
    await waitFor(() => expect(screen.getByText('Back to gallery')).toBeTruthy());

    fireEvent.click(screen.getByText('Back to gallery'));

    await waitFor(() => expect(screen.getByText('the ess portal')).toBeTruthy());
  });

  it('is absent for a viewer with no portal of their own', async () => {
    // An anonymous visitor. Resolving a slug from the asset's client would need a new RPC, and this
    // route must not widen an unauthenticated surface to decorate a header.
    slug = undefined;
    renderAt('/share/id-shared');
    await waitFor(() => expect(screen.getAllByText(/Shared Deck/).length).toBeGreaterThan(0));
    expect(screen.queryByText('Back to gallery')).toBeNull();
  });
});
