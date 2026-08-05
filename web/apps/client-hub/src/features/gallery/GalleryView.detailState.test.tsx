// @vitest-environment jsdom

/* `?focus=` and `?lb=` — the drawer's own state, in the URL, in both directions.
 *
 * This is the one suite that renders the REAL AssetDetail inside the REAL GalleryView, because the
 * thing being tested is the round trip between them: an interaction deep in the preview panel has to
 * reach the router, and the value that comes back has to resolve to the same carousel position,
 * variant and lightbox frame it started from.
 *
 * IDS, NOT INDICES, is the property under test. The URL never carries a carousel position — it names
 * the image, and the index is derived. A position would point at a different picture the moment a
 * sibling is added or disconnected, which is exactly what happens to a link between being sent and
 * being opened.
 *
 * Only `ImageLightbox` is stubbed, to its index and its two callbacks. Everything else is the real
 * component tree over stubbed services.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { applyFilters, type Asset, type FilterState, type Role } from '@dc-hub/asset-library';
import { DEFAULT_DIMENSION_LABELS } from '@dc-hub/database';

const asset = (over: Partial<Asset>): Asset => ({
  id: 'a', clientId: 'c1', name: 'Untitled',
  entityType: 'product', entity: 'Sofa', formats: ['Web'], angle: 'Front',
  status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 4, count: 2, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  thumbnailUrl: 'thumb.webp',
  ...over,
});

const PARENT = asset({ id: 'id-alpha', name: 'Alpha Sofa Web', childCount: 3 });
const KIDS = [
  asset({ id: 'id-kid1', name: 'Frame One',   parentId: 'id-alpha' }),
  asset({ id: 'id-kid2', name: 'Frame Two',   parentId: 'id-alpha' }),
  asset({ id: 'id-kid3', name: 'Frame Three', parentId: 'id-alpha' }),
];
const VARIANTS = [
  asset({ id: 'id-var-print', name: 'Alpha Sofa Print', variantOf: 'id-alpha', formats: ['Print'] }),
];

vi.mock('../../hooks/useAssets', () => ({
  useAssets: (filters: FilterState, role: Role, clientId?: string) => {
    const assets = applyFilters([PARENT], filters, role, clientId);
    return {
      assets, allAssets: [PARENT], total: assets.length,
      loading: false, error: null, usingMock: true, reload: vi.fn(),
    };
  },
}));
vi.mock('../../hooks/useTags', () => ({
  useTags: () => ({ entity: [], format: [], angle: [], groups: { entity: [], format: [], angle: [] } }),
}));
vi.mock('../../context/RoleContext', () => ({
  useRole: () => ({
    role: 'editor' as Role,
    activeClient: {
      id: 'c1', name: 'ESS', slug: 'ess', accent: '#161616', initials: 'ES',
      dimensionLabels: DEFAULT_DIMENSION_LABELS,
    },
  }),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: 'user-1', email: 'u@test' } } }),
}));
vi.mock('../../lib/supabase', () => ({ isConfigured: () => true, supabase: {} }));
vi.mock('../../lib/assetActions', () => ({ webAssetActions: { download: vi.fn(async () => {}) } }));

vi.mock('../../services/assetService', () => ({
  fetchAsset: vi.fn(async (id: string) => [PARENT, ...KIDS, ...VARIANTS].find(a => a.id === id) ?? null),
  fetchChildAssets: vi.fn(async () => KIDS),
  fetchVariants: vi.fn(async () => VARIANTS),
  updateAssetStatus: vi.fn(async () => {}),
  updateAssetPerm: vi.fn(async () => {}),
  deleteAsset: vi.fn(async () => {}),
  deleteAssetAndMedia: vi.fn(async () => {}),
  deleteDisconnectedAssets: vi.fn(async () => ({ deleted: 0, blocked: [] as string[] })),
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
vi.mock('./hooks/useStreamMedia', () => ({ useStreamMedia: () => () => null }));
vi.mock('./MultiAssetHover', () => ({
  MultiAssetHoverGrid: () => null,
  useSiblingPreviews: () => ({ siblings: [], loading: false }),
  useDelayedHover: (active: boolean) => active,
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('motion/react');
  return { ...actual, useReducedMotion: () => false };
});

/* The lightbox, reduced to the two things that matter here: which frame it is on, and its callbacks. */
vi.mock('./ImageLightbox', () => ({
  ImageLightbox: ({ items, index, onClose, onIndexChange }: {
    items: { title?: string }[]; index: number;
    onClose: () => void; onIndexChange: (i: number) => void;
  }) => (
    <div data-testid="lightbox" data-index={String(index)} data-title={items[index]?.title ?? ''}>
      <button onClick={onClose}>close lightbox</button>
      <button onClick={() => onIndexChange(index + 1)}>lightbox next</button>
    </div>
  ),
}));

const GalleryView = (await import('./GalleryView')).default;

function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="url">{location.pathname}{location.search}</span>
      <button onClick={() => navigate(-1)}>go back</button>
      <GalleryView />
    </>
  );
}

function renderAt(entries: string[], index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route index element={<div>admin landing</div>} />
        <Route path=":slug" element={<Harness />} />
        <Route path=":slug/a/:assetId" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
}

const url = () => screen.getByTestId('url').textContent!;
const lightbox = () => screen.queryByTestId('lightbox');

beforeEach(() => { vi.clearAllMocks(); });

describe('cold load', () => {
  it('focus + lb opens the lightbox on that child', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-kid2&lb=1']);

    await waitFor(() => expect(lightbox()).toBeTruthy());
    // Index 1 of three children — derived from the id, not carried in the URL.
    expect(lightbox()).toHaveAttribute('data-index', '1');
    expect(lightbox()).toHaveAttribute('data-title', 'Frame Two');
  });

  it('lb without focus opens on the first frame', async () => {
    renderAt(['/ess/a/id-alpha?lb=1']);
    await waitFor(() => expect(lightbox()).toBeTruthy());
    expect(lightbox()).toHaveAttribute('data-index', '0');
  });

  it('focus without lb selects the frame but leaves the lightbox shut', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-kid3']);
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeTruthy());
    expect(lightbox()).toBeNull();
  });

  it('a focus on a gallery child switches the preview to the carousel', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-kid2']);
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy());
  });

  it('a focus on a variant selects that variant', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-var-print']);
    // The variant picker marks the selection with the black chip; assert on the panel bound to it —
    // the lifecycle panel acts on the SELECTED variant, so its presence is the observable.
    await waitFor(() => expect(screen.getByTitle('Alpha Sofa Print')).toBeTruthy());
    expect(screen.getByTitle('Alpha Sofa Print').className).toContain('bg-cosmos-black');
  });

  it('a focus that is neither a child nor a variant is ignored, and the parent opens normally', async () => {
    // A stale link, or one hand-edited. It must degrade to the plain asset, not to an empty drawer.
    renderAt(['/ess/a/id-alpha?focus=00000000-0000-0000-0000-000000000000']);

    await waitFor(() => expect(screen.getByText('Files · 3')).toBeTruthy());
    expect(lightbox()).toBeNull();
    // Not a variant either: the primary chip is the selected one.
    expect(screen.getByTitle('Alpha Sofa Web').className).toContain('bg-cosmos-black');
  });
});

describe('interaction writes the URL', () => {
  it('clicking a frame in the files grid focuses it and opens the lightbox', async () => {
    renderAt(['/ess/a/id-alpha']);
    await waitFor(() => expect(screen.getByText('Files · 3')).toBeTruthy());

    fireEvent.click(screen.getByAltText('Frame Two').closest('button')!);

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-kid2&lb=1'));
    expect(lightbox()).toHaveAttribute('data-index', '1');
  });

  it('stepping the carousel rewrites focus to the new frame', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-kid1']);
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '→' }));

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-kid2'));
    expect(screen.getByText('2 / 3')).toBeTruthy();
  });

  it('selecting a variant rewrites focus', async () => {
    renderAt(['/ess/a/id-alpha']);
    await waitFor(() => expect(screen.getByTitle('Alpha Sofa Print')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Alpha Sofa Print'));

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-var-print'));
  });

  it('selecting the primary back clears focus rather than naming it', async () => {
    // `?focus=<the asset itself>` is redundant; the clean URL for "nothing special" is no param.
    renderAt(['/ess/a/id-alpha?focus=id-var-print']);
    await waitFor(() => expect(screen.getByTitle('Alpha Sofa Print')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Alpha Sofa Web'));

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha'));
  });

  it('stepping inside the lightbox moves focus with it', async () => {
    // So the address always names the frame on screen: copy it mid-scrub and the recipient sees the
    // same picture.
    renderAt(['/ess/a/id-alpha?focus=id-kid1&lb=1']);
    await waitFor(() => expect(lightbox()).toHaveAttribute('data-index', '0'));

    fireEvent.click(screen.getByText('lightbox next'));

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-kid2&lb=1'));
    expect(lightbox()).toHaveAttribute('data-index', '1');
  });

  it('closing the lightbox drops lb and keeps the frame focused', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-kid2&lb=1']);
    await waitFor(() => expect(lightbox()).toBeTruthy());

    fireEvent.click(screen.getByText('close lightbox'));

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-kid2'));
    expect(lightbox()).toBeNull();
  });

  it('the filters ride along untouched', async () => {
    renderAt(['/ess/a/id-alpha?entity=Sofa']);
    await waitFor(() => expect(screen.getByText('Files · 3')).toBeTruthy());

    fireEvent.click(screen.getByAltText('Frame Two').closest('button')!);

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?entity=Sofa&focus=id-kid2&lb=1'));
  });
});

describe('history', () => {
  it('opening the lightbox PUSHES — Back closes it and leaves the drawer up', async () => {
    renderAt(['/ess/a/id-alpha']);
    await waitFor(() => expect(screen.getByText('Files · 3')).toBeTruthy());
    fireEvent.click(screen.getByAltText('Frame Two').closest('button')!);
    await waitFor(() => expect(lightbox()).toBeTruthy());

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(lightbox()).toBeNull());
    expect(url()).toBe('/ess/a/id-alpha');
    // The drawer is still there — Back closed the lightbox, not the asset.
    expect(screen.getByText('Files · 3')).toBeTruthy();
  });

  it('stepping the carousel does not grow history', async () => {
    /* A 40-frame scrub that pushed would bury the grid 40 entries deep. One Back must still leave. */
    renderAt(['/', '/ess/a/id-alpha?focus=id-kid1']);
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '→' }));
    await waitFor(() => expect(url()).toContain('id-kid2'));
    fireEvent.click(screen.getByRole('button', { name: '→' }));
    await waitFor(() => expect(url()).toContain('id-kid3'));

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(screen.getByText('admin landing')).toBeTruthy());
  });

  it('selecting variants does not grow history', async () => {
    renderAt(['/', '/ess/a/id-alpha']);
    await waitFor(() => expect(screen.getByTitle('Alpha Sofa Print')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Alpha Sofa Print'));
    await waitFor(() => expect(url()).toContain('focus=id-var-print'));
    fireEvent.click(screen.getByTitle('Alpha Sofa Web'));
    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha'));

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(screen.getByText('admin landing')).toBeTruthy());
  });

  it('scrubbing inside the lightbox does not grow history either', async () => {
    renderAt(['/', '/ess/a/id-alpha?focus=id-kid1&lb=1']);
    await waitFor(() => expect(lightbox()).toBeTruthy());

    fireEvent.click(screen.getByText('lightbox next'));
    await waitFor(() => expect(url()).toContain('id-kid2'));
    fireEvent.click(screen.getByText('lightbox next'));
    await waitFor(() => expect(url()).toContain('id-kid3'));

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(screen.getByText('admin landing')).toBeTruthy());
  });
});
