// @vitest-environment jsdom

/* The data cache — the one suite that runs the REAL `useAssets`.
 *
 * Everywhere else `useAssets` is stubbed, because everywhere else the question is what the component
 * does with the data. Here the question is how many times it asks for it, so the stub is one level
 * lower: `fetchAssets`, the service. Every count below is a count of round-trips that would have hit
 * PostgREST.
 *
 * The property that matters: THE CACHE KEY AND THE URL ARE THE SAME STRING. `filterCacheKey(filters)`
 * is what the address bar shows, so going back to a view you had open is a cache hit by construction
 * — not by a second memoization somewhere that has to be kept in step with the first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { applyFilters, MOCK_ASSETS, type Asset, type FilterState, type Role } from '@dc-hub/asset-library';
import { DEFAULT_DIMENSION_LABELS } from '@dc-hub/database';

const asset = (over: Partial<Asset>): Asset => ({
  id: 'a', clientId: 'c1', name: 'Untitled',
  entityType: 'product', entity: 'Sofa', formats: ['Web'], angle: 'Front',
  status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 4, count: 2, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  ...over,
});

const FIXTURES: Asset[] = [
  asset({ id: 'id-alpha', name: 'Alpha', entity: 'Sofa' }),
  asset({ id: 'id-beta',  name: 'Beta',  entity: 'Chair' }),
];

let configured = true;
vi.mock('../../lib/supabase', () => ({ isConfigured: () => configured, supabase: {} }));

/** Every `fetchAssets` call the component made — i.e. every real round-trip. */
const fetchAssets = vi.fn(async ({ filters, role, clientId }: {
  filters: FilterState; role: Role; clientId?: string
}) => ({
  assets: applyFilters(FIXTURES, filters, role, clientId),
  allAssets: FIXTURES,
}));

vi.mock('../../services/assetService', () => ({
  fetchAssets: (args: never) => fetchAssets(args),
  fetchAsset: vi.fn(async () => null),
  assetFacetLabels: () => [],
  deleteDisconnectedAssets: vi.fn(async () => ({ deleted: 0, blocked: [] as string[] })),
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
vi.mock('./hooks/useStreamMedia', () => ({ useStreamMedia: () => () => null }));
vi.mock('../../lib/assetActions', () => ({ webAssetActions: { download: vi.fn(async () => {}) } }));
vi.mock('./MultiAssetHover', () => ({
  MultiAssetHoverGrid: () => null,
  useSiblingPreviews: () => ({ siblings: [], loading: false }),
  useDelayedHover: (active: boolean) => active,
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('motion/react');
  return { ...actual, useReducedMotion: () => false };
});
/* Exposes the one thing the drawer does to the grid's data: onStatusChange. */
vi.mock('./AssetDetail', () => ({
  default: ({ asset: a, onStatusChange }: { asset: Asset; onStatusChange?: () => void }) => (
    <div data-testid="asset-detail" data-asset-id={a.id}>
      <button onClick={onStatusChange}>change status</button>
    </div>
  ),
}));

const GalleryView = (await import('./GalleryView')).default;

function renderAt(at: string) {
  /* A fresh client per test — a module-level one would carry results between tests and the counts
     below would depend on execution order. `retry: false` so a rejection is one call, not two. */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path=":slug" element={<GalleryView />} />
          <Route path=":slug/a/:assetId" element={<GalleryView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const names = () => ['Alpha', 'Beta'].filter(n => screen.queryByRole('heading', { level: 3, name: n }));
/** The grid AND the rail's option pool are populated. `fetchAssets` having been *called* is not
 *  enough — the rail has no checkboxes to click until the pool's data has landed. */
const ready = () => waitFor(() => expect(names()).toEqual(['Alpha', 'Beta']));
function railCheckbox(text: string): HTMLInputElement {
  const label = within(screen.getByRole('complementary')).getByText(text).closest('label')!;
  return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

beforeEach(() => {
  fetchAssets.mockClear();
  configured = true;
});

describe('how many round-trips', () => {
  it('the default view is ONE fetch, though useAssets is called twice', async () => {
    /* GalleryView asks twice — once for the option pool with default filters, once for the live view.
       At the default view both produce `filterCacheKey === ''`, so the keys are IDENTICAL and Query
       dedupes them into one request. Do not "fix" this into two artificial keys. */
    renderAt('/ess');
    await waitFor(() => expect(names()).toEqual(['Alpha', 'Beta']));
    expect(fetchAssets).toHaveBeenCalledTimes(1);
  });

  it('applying a filter costs exactly one more', async () => {
    renderAt('/ess');
    await ready();
    expect(fetchAssets).toHaveBeenCalledTimes(1);

    fireEvent.click(railCheckbox('Sofa'));

    await waitFor(() => expect(names()).toEqual(['Alpha']));
    // The pool key is unchanged and still shared; only the live view is new.
    expect(fetchAssets).toHaveBeenCalledTimes(2);
  });

  it('toggling a filter off again costs NOTHING — it renders from cache', async () => {
    renderAt('/ess');
    await ready();
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(2));

    fireEvent.click(railCheckbox('Sofa'));

    await waitFor(() => expect(names()).toEqual(['Alpha', 'Beta']));
    expect(fetchAssets).toHaveBeenCalledTimes(2);
  });

  it('a filter set reached by a different route of clicks is still one key', async () => {
    // Canonicalisation earning its keep: Sofa-then-Chair and Chair-then-Sofa are the same view.
    renderAt('/ess');
    await ready();

    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(2));
    fireEvent.click(railCheckbox('Chair'));
    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(3));
    // Back to Sofa alone — a key already in cache.
    fireEvent.click(railCheckbox('Chair'));

    await waitFor(() => expect(names()).toEqual(['Alpha']));
    expect(fetchAssets).toHaveBeenCalledTimes(3);
  });

  it('opening and closing the drawer refetches nothing', async () => {
    renderAt('/ess');
    await ready();
    expect(fetchAssets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Beta' }).closest('button')!);
    await waitFor(() => expect(screen.getByTestId('asset-detail')).toBeTruthy());

    expect(fetchAssets).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation', () => {
  it('a status change in the drawer refetches the grid', async () => {
    renderAt('/ess/a/id-beta');
    await waitFor(() => expect(screen.getByTestId('asset-detail')).toBeTruthy());
    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('change status'));

    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(2));
  });

  it('invalidation reaches the option pool as well as the live view', async () => {
    /* A PREFIX match on ['assets'], deliberately. After a delete the pool is genuinely stale — the
       deleted asset's tags may no longer be in the vocabulary the rail offers — so scoping this to the
       live key would save one query and leave the rail listing a tag nothing has. */
    renderAt('/ess/a/id-alpha?entity=Sofa');
    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText('change status'));

    await waitFor(() => expect(fetchAssets).toHaveBeenCalledTimes(4));
  });
});

describe('failure and demo mode', () => {
  it('a failed fetch shows the connection error rather than an empty grid', async () => {
    fetchAssets.mockRejectedValueOnce(new Error('network down'));
    renderAt('/ess');
    await waitFor(() => expect(screen.getByText('Connection error')).toBeTruthy());
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('demo mode never touches the service', async () => {
    configured = false;
    renderAt('/ess');

    await waitFor(() => expect(screen.getByText(/of \d+ assets/)).toBeTruthy());
    expect(fetchAssets).not.toHaveBeenCalled();
    // The mock library really is what is on screen.
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
    expect(screen.getByText(`${MOCK_ASSETS.length} of ${MOCK_ASSETS.length} assets`)).toBeTruthy();
  });

  it('demo mode still filters', async () => {
    configured = false;
    renderAt('/ess');
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0));
    const before = screen.getAllByRole('heading', { level: 3 }).length;

    fireEvent.change(screen.getByPlaceholderText('Search assets…'), { target: { value: 'zzzzz' } });

    await waitFor(() => expect(screen.getByText('No matches.')).toBeTruthy());
    expect(before).toBeGreaterThan(0);
  });
});
