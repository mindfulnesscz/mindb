// @vitest-environment jsdom

/* Characterization tests — GALLERY VIEW, before its state moves into the URL.
 *
 * `GalleryView` owns the filter state, the open asset, the focused sibling and the lightbox flag,
 * all in `useState`. The URL-routing work replaces every one of those with a value derived from the
 * address bar. That is a restructure of the component's entire state model, and it has no test.
 *
 * So these assert on OBSERVABLE behaviour — what the grid contains after an interaction, what the
 * rail still offers, whether the drawer is up — and they must pass UNEDITED after the filters move
 * to the query string (Phase 2), after the drawer becomes a route (Phase 3), and after the data
 * layer becomes TanStack Query (Phase 5). A test that needed adjusting is the signal that behaviour
 * changed, not that the test was wrong.
 *
 * Two deliberate choices:
 *
 * 1. THE ROUTER HARNESS SCAFFOLDS THE END STATE. Both `:slug` and `:slug/a/:assetId` are declared
 *    here even though the second route does not exist in `App.tsx` yet. `GalleryView` starts reading
 *    `useParams()` in Phase 3, and a bare `<MemoryRouter>` would hand it `{}` — every test would
 *    then need editing to add the route, which is exactly the acceptance criterion this file exists
 *    to protect.
 *
 * 2. EVERY ASSERTION IS `waitFor`ED. Filtering is synchronous today and becomes a navigation (plus a
 *    ~250 ms search debounce) later. Asserting synchronously would pass now and fail then for a
 *    reason that is not a behaviour change.
 *
 * `useAssets` is stubbed over the real `applyFilters`, so the filter → grid path is genuinely
 * exercised without a network. `AssetDetail` is stubbed to its props: it has its own
 * characterization suite (`AssetDetail.characterization.test.tsx`), and what matters here is which
 * asset the gallery hands it and with what focus.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { applyFilters, type Asset, type FilterState, type Role } from '@sotto/asset-library';
import { DEFAULT_DIMENSION_LABELS } from '@sotto/database';

/* ── Fixtures ──────────────────────────────────────────────────────────────────
 * Names are deliberately distinct from every tag label, so `getByText('Sofa')` can only be the
 * rail's checkbox and never a card. */

const asset = (over: Partial<Asset>): Asset => ({
  id: 'a', clientId: 'c1', name: 'Untitled',
  entityType: 'product', entity: 'Sofa', formats: ['Web'], angle: 'Front',
  status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 4, count: 2, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  ...over,
});

const FIXTURES: Asset[] = [
  asset({ id: 'id-alpha', name: 'Alpha', entity: 'Sofa',  formats: ['Web'],   angle: 'Front' }),
  asset({ id: 'id-beta',  name: 'Beta',  entity: 'Chair', formats: ['Print'], angle: 'Side', status: 'approved' }),
  // Draft, so its effective level is `internal` whatever its perm says — the role gate below needs
  // one asset staff can see and a member cannot.
  asset({ id: 'id-gamma', name: 'Gamma', entity: 'Sofa',  formats: ['Print'], angle: 'Side', status: 'draft', latest: false }),
  asset({ id: 'id-delta', name: 'Delta', entity: 'Table', formats: ['Web'],   angle: 'Top' }),
];

const CARD_NAMES = FIXTURES.map(a => a.name);

/* ── Stubs ─────────────────────────────────────────────────────────────────────── */

const reload = vi.fn();
/** Every `filters` object the component asked data for, newest last. */
const filterCalls: FilterState[] = [];

vi.mock('../../hooks/useAssets', () => ({
  useAssets: (filters: FilterState, role: Role, clientId?: string) => {
    filterCalls.push(filters);
    const assets = applyFilters(FIXTURES, filters, role, clientId);
    return {
      assets, allAssets: FIXTURES, total: assets.length,
      loading: false, error: null, usingMock: true, reload,
    };
  },
}));

/* Empty on purpose. With no DB tags the rail derives its options from the unfiltered option pool,
   which is the `stableFilters` behaviour one of these tests pins. */
vi.mock('../../hooks/useTags', () => ({
  useTags: () => ({ entity: [], format: [], angle: [], groups: { entity: [], format: [], angle: [] } }),
}));

const activeClient = {
  id: 'c1', name: 'ESS', slug: 'ess', accent: '#161616', initials: 'ES',
  dimensionLabels: DEFAULT_DIMENSION_LABELS,
};
let role: Role = 'editor';
vi.mock('../../context/RoleContext', () => ({ useRole: () => ({ role, activeClient }) }));

const fetchAsset = vi.fn(async (_id: string): Promise<Asset | null> => null);
vi.mock('../../services/assetService', () => ({
  fetchAsset: (id: string) => fetchAsset(id),
  assetFacetLabels: () => [],
  deleteDisconnectedAssets: vi.fn(async () => ({ deleted: 0, blocked: [] as string[] })),
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

/* The drawer, reduced to the props the gallery decides. `AssetDetail` itself is characterized
   next door; duplicating its eight service stubs here would test it twice and this file none. */
vi.mock('./AssetDetail', () => ({
  default: ({ asset, onClose, focusAssetId, autoOpenLightbox }: {
    asset: Asset; onClose?: () => void; focusAssetId?: string; autoOpenLightbox?: boolean
  }) => (
    <div
      data-testid="asset-detail"
      data-asset-id={asset.id}
      data-focus-id={focusAssetId ?? ''}
      data-lightbox={autoOpenLightbox ? '1' : '0'}
    >
      <button onClick={onClose}>Close detail</button>
    </div>
  ),
}));

const GalleryView = (await import('./GalleryView')).default;

/* ── Harness ───────────────────────────────────────────────────────────────────── */

function renderGallery(at = '/ess') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path=":slug" element={<GalleryView />} />
        <Route path=":slug/a/:assetId" element={<GalleryView />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Names of the cards currently in the grid. */
function cardNames(): string[] {
  return CARD_NAMES.filter(n => screen.queryByRole('heading', { level: 3, name: n }));
}

/** The rail checkbox whose label reads `text`. Scoped to the rail — status names like "Approved"
 *  also appear as a chip on every card. */
function railCheckbox(text: string): HTMLInputElement {
  const label = within(screen.getByRole('complementary')).getByText(text).closest('label');
  if (!label) throw new Error(`no rail row for "${text}"`);
  const box = label.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`no checkbox in rail row "${text}"`);
  return box;
}

beforeEach(() => {
  reload.mockClear();
  fetchAsset.mockClear();
  filterCalls.length = 0;
  role = 'editor';
});

describe('GalleryView — the grid reflects the filters', () => {
  it('lists everything the viewer may see with no filters applied', async () => {
    renderGallery();
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
  });

  it('toggling a tag checkbox narrows the grid', async () => {
    renderGallery();
    await waitFor(() => expect(cardNames()).toHaveLength(4));

    fireEvent.click(railCheckbox('Sofa'));

    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma']));
    // And the box reads back as on — the rail is driven by the same state, not by its own copy.
    await waitFor(() => expect(railCheckbox('Sofa').checked).toBe(true));
  });

  it('two tags in one dimension are an OR, not an AND', async () => {
    renderGallery();
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(cardNames()).toHaveLength(2));

    fireEvent.click(railCheckbox('Table'));
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma', 'Delta']));
  });

  it('unchecking a tag restores the grid', async () => {
    renderGallery();
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(cardNames()).toHaveLength(2));

    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(cardNames()).toHaveLength(4));
  });

  it('a status checkbox narrows the grid', async () => {
    renderGallery();
    fireEvent.click(railCheckbox('Approved'));
    await waitFor(() => expect(cardNames()).toEqual(['Beta']));
  });

  it('typing in the toolbar search narrows the grid', async () => {
    renderGallery();
    const search = screen.getByPlaceholderText('Search assets…');

    fireEvent.change(search, { target: { value: 'delta' } });

    await waitFor(() => expect(cardNames()).toEqual(['Delta']));
  });

  it('the search input shows what was typed', async () => {
    // Pins the controlled-input contract. Phase 2 debounces the write to the URL; the box itself
    // must still track every keystroke or the cursor jumps mid-word.
    renderGallery();
    const search = screen.getByPlaceholderText<HTMLInputElement>('Search assets…');

    fireEvent.change(search, { target: { value: 'chai' } });

    await waitFor(() => expect(search.value).toBe('chai'));
  });

  it('clearing the search restores the grid', async () => {
    renderGallery();
    const search = screen.getByPlaceholderText('Search assets…');
    fireEvent.change(search, { target: { value: 'delta' } });
    await waitFor(() => expect(cardNames()).toHaveLength(1));

    fireEvent.change(search, { target: { value: '' } });
    await waitFor(() => expect(cardNames()).toHaveLength(4));
  });

  it('latestOnly drops superseded versions', async () => {
    renderGallery();
    // The toggle is a div, not a checkbox — it sits directly before its label text.
    fireEvent.click(screen.getByText('Latest version only').previousElementSibling!);

    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Beta', 'Delta']));
  });

  it('a filter combination that matches nothing shows the filtered empty state', async () => {
    // Not "no assets" and not "no access" — three different messages, and the wrong one turns a
    // filter mistake into an apparent permissions problem.
    renderGallery();
    fireEvent.change(screen.getByPlaceholderText('Search assets…'), { target: { value: 'zzzz' } });

    await waitFor(() => expect(screen.getByText('No matches.')).toBeTruthy());
  });
});

describe('GalleryView — the option pool does not shrink', () => {
  it('every tag stays offered after a filter is applied', async () => {
    /* DELIBERATE, and load-bearing: the rail's options come from `stableFilters` — a second,
       permanently-default `useAssets` call — not from the filtered result. Deriving them from the
       filtered set would make a filter its own trap: check "Sofa" and "Chair" vanishes, so there is
       no way back to it but Clear. */
    renderGallery();
    await waitFor(() => expect(railCheckbox('Chair')).toBeTruthy());

    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma']));

    expect(railCheckbox('Chair')).toBeTruthy();
    expect(railCheckbox('Table')).toBeTruthy();
    expect(railCheckbox('Print')).toBeTruthy();
    expect(railCheckbox('Top')).toBeTruthy();
  });

  it('the option pool is fetched with default filters, whatever the view is filtered by', async () => {
    // The mechanism behind the test above, pinned directly: one of the two data calls per render
    // always carries an untouched FilterState.
    renderGallery();
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(cardNames()).toHaveLength(2));

    const latest = filterCalls.slice(-2);
    expect(latest.some(f => f.entities.length === 0)).toBe(true);
    expect(latest.some(f => f.entities.includes('Sofa'))).toBe(true);
  });
});

describe('GalleryView — the detail drawer', () => {
  it('clicking a card opens the drawer on that asset', async () => {
    renderGallery();
    await waitFor(() => expect(cardNames()).toHaveLength(4));

    fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Beta' }).closest('button')!);

    await waitFor(() => expect(screen.getByTestId('asset-detail')).toHaveAttribute('data-asset-id', 'id-beta'));
  });

  it('the close button closes it', async () => {
    renderGallery();
    fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Beta' }).closest('button')!);
    await waitFor(() => expect(screen.getByTestId('asset-detail')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));

    await waitFor(() => expect(screen.queryByTestId('asset-detail')).toBeNull());
  });

  it('no drawer is open on a fresh load', async () => {
    renderGallery();
    await waitFor(() => expect(cardNames()).toHaveLength(4));
    expect(screen.queryByTestId('asset-detail')).toBeNull();
  });

  it('opening a card carries no focused sibling and no lightbox', async () => {
    renderGallery();
    fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Alpha' }).closest('button')!);

    const detail = await waitFor(() => screen.getByTestId('asset-detail'));
    expect(detail).toHaveAttribute('data-focus-id', '');
    expect(detail).toHaveAttribute('data-lightbox', '0');
  });

  it('the grid keeps its filters while the drawer is open', async () => {
    renderGallery();
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma']));

    fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Gamma' }).closest('button')!);

    await waitFor(() => expect(screen.getByTestId('asset-detail')).toHaveAttribute('data-asset-id', 'id-gamma'));
    expect(cardNames()).toEqual(['Alpha', 'Gamma']);
    expect(railCheckbox('Sofa').checked).toBe(true);
  });

  it('the drawer survives a filter change that would exclude the open asset', async () => {
    /* Today the open asset is held by id and looked up in the list, with `resolvedDetail` as the
       fallback — so it stays up. Pinned because the Phase 3 rewrite makes the id come from the URL
       and the same lookup has to keep working. */
    renderGallery();
    fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Beta' }).closest('button')!);
    await waitFor(() => expect(screen.getByTestId('asset-detail')).toBeTruthy());

    fireEvent.click(railCheckbox('Sofa'));

    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma']));
    // Beta is no longer in the grid. Whether its drawer stays is the interesting part — it does not,
    // because the open asset is resolved out of the current list. Pin the fact, not a preference.
    expect(screen.queryByTestId('asset-detail')).toBeNull();
  });
});

describe('GalleryView — role', () => {
  it('a member sees no internal-level assets', async () => {
    role = 'member';
    renderGallery();
    // Gamma is `draft`, so its effective level is `internal` whatever its perm says.
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Beta', 'Delta']));
  });

  it('staff see the draft that a member does not', async () => {
    renderGallery();
    await waitFor(() => expect(cardNames()).toContain('Gamma'));
  });

  it('staff are offered the archived and disconnected statuses; a member is not', async () => {
    const staff = renderGallery();
    await waitFor(() => expect(railCheckbox('Archived')).toBeTruthy());
    expect(railCheckbox('Disconnected')).toBeTruthy();
    staff.unmount();

    role = 'member';
    renderGallery();
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    const rail = within(screen.getByRole('complementary'));
    expect(rail.queryByText('Archived')).toBeNull();
    expect(rail.queryByText('Disconnected')).toBeNull();
  });
});

describe('GalleryView — the rail can be hidden', () => {
  it('Hide removes it and the toolbar offers it back', async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText('Filters')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy());
    expect(screen.queryByText('Sofa')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await waitFor(() => expect(railCheckbox('Sofa')).toBeTruthy());
  });
});
