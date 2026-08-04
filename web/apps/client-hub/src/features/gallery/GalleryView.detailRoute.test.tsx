// @vitest-environment jsdom

/* The detail drawer as an address — `/:slug/a/:assetId`.
 *
 * What is genuinely new here is the COLD LOAD. Clicking a card always had the row in hand; a
 * forwarded link has an id and nothing else, and the id may be a gallery child or a format variant,
 * which are never cards in the grid. So the interesting cases are the ones with no click in them:
 * a child id in the path, a parent that is not in the current list, an id this viewer cannot see,
 * and an id that is not a UUID at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { applyFilters, type Asset, type FilterState, type Role } from '@sotto/asset-library';
import { DEFAULT_DIMENSION_LABELS } from '@sotto/database';

const asset = (over: Partial<Asset>): Asset => ({
  id: 'a', clientId: 'c1', name: 'Untitled',
  entityType: 'product', entity: 'Sofa', formats: ['Web'], angle: 'Front',
  status: 'published', perm: 'client', version: 'v1', latest: true,
  avg: 4, count: 2, comments: 0, approval: 'none', updatedAt: '2026-01-01',
  ...over,
});

/** Top-level cards. */
const FIXTURES: Asset[] = [
  asset({ id: 'id-alpha', name: 'Alpha', entity: 'Sofa',  childCount: 2 }),
  asset({ id: 'id-beta',  name: 'Beta',  entity: 'Chair' }),
];

/** Rows that are NOT cards: a gallery child, a format variant, and a parent outside the list. */
const CHILD   = asset({ id: 'id-child',  name: 'Child',  parentId: 'id-alpha' });
const VARIANT = asset({ id: 'id-var',    name: 'Variant', variantOf: 'id-alpha' });
const ORPHAN  = asset({ id: 'id-orphan', name: 'Orphan', entity: 'Table' });
const ORPHAN_CHILD = asset({ id: 'id-orphan-kid', name: 'Orphan kid', parentId: 'id-orphan' });

const OFF_LIST = [CHILD, VARIANT, ORPHAN, ORPHAN_CHILD];

/* Stands in for the database, so it knows the cards too — an asset filtered OUT of the grid is still
   a row RLS returns, and resolving one is exactly what keeps its drawer open. */
const fetchAsset = vi.fn(async (id: string): Promise<Asset | null> =>
  [...FIXTURES, ...OFF_LIST].find(a => a.id === id) ?? null);

vi.mock('../../hooks/useAssets', () => ({
  useAssets: (filters: FilterState, role: Role, clientId?: string) => {
    const assets = applyFilters(FIXTURES, filters, role, clientId);
    return {
      assets, allAssets: FIXTURES, total: assets.length,
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
vi.mock('../../services/assetService', () => ({
  fetchAsset: (id: string) => fetchAsset(id),
  assetFacetLabels: () => [],
  deleteDisconnectedAssets: vi.fn(async () => ({ deleted: 0, blocked: [] as string[] })),
}));
vi.mock('./hooks/useStreamMedia', () => ({ useStreamMedia: () => () => null }));
vi.mock('../../lib/assetActions', () => ({ webAssetActions: { download: vi.fn(async () => {}) } }));

/* The hover grid, always rendered rather than gated on hover, so a sibling tile is clickable in a
   test without simulating a pointer dwell. `isGalleryChild` drives the lightbox flag, so both kinds
   of sibling are offered. */
vi.mock('./MultiAssetHover', () => ({
  MultiAssetHoverGrid: ({ onSelect }: { onSelect: (s: { id: string; isGalleryChild?: boolean }) => void }) => (
    <>
      <button onClick={e => { e.stopPropagation(); onSelect({ id: 'id-child', isGalleryChild: true }); }}>
        pick child
      </button>
      <button onClick={e => { e.stopPropagation(); onSelect({ id: 'id-var' }); }}>pick variant</button>
    </>
  ),
  useSiblingPreviews: () => ({ siblings: [], loading: false }),
  useDelayedHover: (active: boolean) => active,
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('motion/react');
  return { ...actual, useReducedMotion: () => false };
});
vi.mock('./AssetDetail', () => ({
  default: ({ asset: a, onClose, focusAssetId, autoOpenLightbox }: {
    asset: Asset; onClose?: () => void; focusAssetId?: string; autoOpenLightbox?: boolean
  }) => (
    <div
      data-testid="asset-detail"
      data-asset-id={a.id}
      data-focus-id={focusAssetId ?? ''}
      data-lightbox={autoOpenLightbox ? '1' : '0'}
    >
      <button onClick={onClose}>Close detail</button>
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
const detail = () => screen.getByTestId('asset-detail');
const card = (name: string) => screen.getByRole('heading', { level: 3, name }).closest('button')!;
function railCheckbox(text: string): HTMLInputElement {
  const label = within(screen.getByRole('complementary')).getByText(text).closest('label')!;
  return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

beforeEach(() => { fetchAsset.mockClear(); });

describe('clicking a card', () => {
  it('puts the asset in the path', async () => {
    renderAt(['/ess']);
    fireEvent.click(card('Beta'));
    await waitFor(() => expect(url()).toBe('/ess/a/id-beta'));
    expect(detail()).toHaveAttribute('data-asset-id', 'id-beta');
  });

  it('keeps the filter params', async () => {
    /* Without this, Back from the drawer would land on an unfiltered grid — the filters would be
       silently discarded by the act of looking at something. */
    renderAt(['/ess?entity=Chair&latest=1']);
    await waitFor(() => expect(railCheckbox('Chair').checked).toBe(true));

    fireEvent.click(card('Beta'));

    // Byte-for-byte as they arrived. Opening an asset does not re-canonicalise the filter params —
    // that only happens when the rail writes them, so a link is never quietly rewritten under a
    // viewer who is only looking around.
    await waitFor(() => expect(url()).toBe('/ess/a/id-beta?entity=Chair&latest=1'));
  });

  it('needs no round-trip — the id is already in hand', async () => {
    renderAt(['/ess']);
    fireEvent.click(card('Beta'));
    await waitFor(() => expect(detail()).toBeTruthy());
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('a sibling tile opens the parent with the sibling in `focus`', async () => {
    renderAt(['/ess']);
    fireEvent.click(screen.getAllByText('pick variant')[0]);

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-var'));
    expect(detail()).toHaveAttribute('data-asset-id', 'id-alpha');
    expect(detail()).toHaveAttribute('data-focus-id', 'id-var');
    expect(detail()).toHaveAttribute('data-lightbox', '0');
  });

  it('a gallery-child tile also asks for the lightbox', async () => {
    renderAt(['/ess']);
    fireEvent.click(screen.getAllByText('pick child')[0]);

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-child&lb=1'));
    expect(detail()).toHaveAttribute('data-lightbox', '1');
  });
});

describe('cold load', () => {
  it('opens the grid AND the drawer', async () => {
    renderAt(['/ess/a/id-beta']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-beta'));
    // The grid behind it is still a grid.
    expect(screen.getByRole('heading', { level: 3, name: 'Alpha' })).toBeTruthy();
  });

  it('a child id in the path opens its PARENT with the child focused', async () => {
    // A gallery child is never a card, so this link can only work by resolving upwards.
    renderAt(['/ess/a/id-child']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-alpha'));
    expect(detail()).toHaveAttribute('data-focus-id', 'id-child');
  });

  it('a variant id in the path resolves the same way', async () => {
    renderAt(['/ess/a/id-var']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-alpha'));
    expect(detail()).toHaveAttribute('data-focus-id', 'id-var');
  });

  it('an asset outside the current grid is fetched and shown', async () => {
    renderAt(['/ess/a/id-orphan']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-orphan'));
    expect(fetchAsset).toHaveBeenCalledWith('id-orphan');
  });

  it('a child whose parent is also outside the grid takes two hops', async () => {
    renderAt(['/ess/a/id-orphan-kid']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-orphan'));
    expect(detail()).toHaveAttribute('data-focus-id', 'id-orphan-kid');
    expect(fetchAsset).toHaveBeenCalledWith('id-orphan-kid');
    expect(fetchAsset).toHaveBeenCalledWith('id-orphan');
  });

  it('an explicit `focus` param is honoured', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-child&lb=1']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-focus-id', 'id-child'));
    expect(detail()).toHaveAttribute('data-lightbox', '1');
  });

  it('filters in the same URL still apply to the grid', async () => {
    renderAt(['/ess/a/id-beta?entity=Chair']);
    await waitFor(() => expect(detail()).toBeTruthy());
    expect(screen.queryByRole('heading', { level: 3, name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Beta' })).toBeTruthy();
  });
});

describe('cold load that cannot resolve', () => {
  it('an id this viewer cannot see renders "Not available" over the grid', async () => {
    // RLS returns nothing for both "no such row" and "not yours", and this component must not try to
    // tell them apart — so there is one message, not two.
    renderAt(['/ess/a/00000000-0000-0000-0000-000000000000']);

    await waitFor(() => expect(screen.getByText('Not available.')).toBeTruthy());
    expect(screen.queryByTestId('asset-detail')).toBeNull();
    // The grid is untouched — a stale link must not cost the viewer a working page.
    expect(screen.getByRole('heading', { level: 3, name: 'Alpha' })).toBeTruthy();
  });

  it('a malformed id renders the same state, with no unhandled rejection', async () => {
    renderAt(['/ess/a/not-a-uuid']);
    await waitFor(() => expect(screen.getByText('Not available.')).toBeTruthy());
  });

  it('a transport failure renders the same state', async () => {
    fetchAsset.mockRejectedValueOnce(new Error('offline'));
    renderAt(['/ess/a/id-orphan']);
    await waitFor(() => expect(screen.getByText('Not available.')).toBeTruthy());
  });

  it('its close button returns to the grid', async () => {
    renderAt(['/ess/a/not-a-uuid?entity=Chair']);
    await waitFor(() => expect(screen.getByText('Not available.')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(url()).toBe('/ess?entity=Chair'));
  });
});

describe('closing and history', () => {
  it('the close button returns to the grid with the filters intact', async () => {
    renderAt(['/ess?entity=Chair']);
    fireEvent.click(card('Beta'));
    await waitFor(() => expect(url()).toContain('/a/id-beta'));

    fireEvent.click(screen.getByText('Close detail'));

    await waitFor(() => expect(url()).toBe('/ess?entity=Chair'));
    expect(screen.queryByTestId('asset-detail')).toBeNull();
    expect(railCheckbox('Chair').checked).toBe(true);
  });

  it('Back closes the drawer rather than leaving the portal', async () => {
    // Opening PUSHES — this is the behaviour that buys.
    renderAt(['/', '/ess?entity=Chair']);
    fireEvent.click(card('Beta'));
    await waitFor(() => expect(url()).toContain('/a/id-beta'));

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(screen.queryByTestId('asset-detail')).toBeNull());
    expect(url()).toBe('/ess?entity=Chair');
    expect(railCheckbox('Chair').checked).toBe(true);
  });

  it('a filter change while the drawer is open keeps it open', async () => {
    /* BEHAVIOUR CHANGE from before the drawer was a route, and a deliberate one. The open asset used
       to be looked up in the current list, so filtering it out of the grid closed the drawer
       underneath the viewer. It is an address now: the grid narrows and what you were looking at
       stays on screen. */
    renderAt(['/ess']);
    fireEvent.click(card('Beta'));
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-beta'));

    fireEvent.click(railCheckbox('Sofa'));

    await waitFor(() => expect(url()).toContain('entity=Sofa'));
    expect(screen.queryByRole('heading', { level: 3, name: 'Beta' })).toBeNull();
    await waitFor(() => expect(detail()).toHaveAttribute('data-asset-id', 'id-beta'));
  });

  it('a filter change does not clear focus or the lightbox', async () => {
    renderAt(['/ess/a/id-alpha?focus=id-child&lb=1']);
    await waitFor(() => expect(detail()).toHaveAttribute('data-lightbox', '1'));

    fireEvent.click(railCheckbox('Sofa'));

    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?entity=Sofa&focus=id-child&lb=1'));
    expect(detail()).toHaveAttribute('data-focus-id', 'id-child');
    expect(detail()).toHaveAttribute('data-lightbox', '1');
  });

  it('opening a second asset does not stack `focus` from the first', async () => {
    renderAt(['/ess']);
    fireEvent.click(screen.getAllByText('pick variant')[0]);
    await waitFor(() => expect(url()).toBe('/ess/a/id-alpha?focus=id-var'));

    fireEvent.click(card('Beta'));

    await waitFor(() => expect(url()).toBe('/ess/a/id-beta'));
    expect(detail()).toHaveAttribute('data-focus-id', '');
  });
});
