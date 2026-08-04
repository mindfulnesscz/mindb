// @vitest-environment jsdom

/* The gallery's filters, as an address.
 *
 * Separate from `GalleryView.characterization.test.tsx` on purpose: that file pins behaviour that
 * must not change and is never edited, this one asserts the behaviour each phase ADDS. Same stub
 * set, different job.
 *
 * Phase 2: filters round-trip through the query string, a cold load applies them, and a filter
 * change replaces rather than pushes.
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

const FIXTURES: Asset[] = [
  asset({ id: 'id-alpha', name: 'Alpha', entity: 'Sofa',  formats: ['Web'],   angle: 'Front' }),
  asset({ id: 'id-beta',  name: 'Beta',  entity: 'Chair', formats: ['Print'], angle: 'Side', status: 'approved' }),
  asset({ id: 'id-gamma', name: 'Gamma', entity: 'Sofa',  formats: ['Print'], angle: 'Side', status: 'draft', latest: false }),
  asset({ id: 'id-delta', name: 'Delta', entity: 'Table', formats: ['Web'],   angle: 'Top' }),
];
const CARD_NAMES = FIXTURES.map(a => a.name);

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
  fetchAsset: vi.fn(async () => null),
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
vi.mock('./AssetDetail', () => ({
  default: ({ asset: a, onClose }: { asset: Asset; onClose?: () => void }) => (
    <div data-testid="asset-detail" data-asset-id={a.id}>
      <button onClick={onClose}>Close detail</button>
    </div>
  ),
}));

const GalleryView = (await import('./GalleryView')).default;

/** Every distinct URL the router has been at, in order. Reset per test. */
const visited: string[] = [];

/* The gallery plus the two things a test needs from outside it: the live URL, and a way to go Back. */
function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  const here = `${location.pathname}${location.search}`;
  if (visited[visited.length - 1] !== here) visited.push(here);
  return (
    <>
      <span data-testid="url">{here}</span>
      <button onClick={() => navigate(-1)}>go back</button>
      <GalleryView />
    </>
  );
}

/** `entries` lets a test start with somewhere to go Back TO. */
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
const cardNames = () => CARD_NAMES.filter(n => screen.queryByRole('heading', { level: 3, name: n }));
function railCheckbox(text: string): HTMLInputElement {
  const label = within(screen.getByRole('complementary')).getByText(text).closest('label')!;
  return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

beforeEach(() => { visited.length = 0; });

describe('cold load — the URL is the view', () => {
  it('applies every filter param on first render', async () => {
    renderAt(['/ess?entity=Sofa&status=approved&latest=1']);

    await waitFor(() => expect(railCheckbox('Sofa').checked).toBe(true));
    expect(railCheckbox('Approved').checked).toBe(true);
    // Alpha is published, Gamma is draft-and-superseded, so status+latest exclude everything.
    expect(cardNames()).toEqual([]);
  });

  it('a filtered link reproduces exactly the grid it was copied from', async () => {
    renderAt(['/ess?entity=Sofa']);
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma']));
  });

  it('the search param populates the search box', async () => {
    renderAt(['/ess?q=delta']);
    await waitFor(() =>
      expect(screen.getByPlaceholderText<HTMLInputElement>('Search assets…').value).toBe('delta'));
    expect(cardNames()).toEqual(['Delta']);
  });

  it('a bare portal path is the clean default view', async () => {
    renderAt(['/ess']);
    await waitFor(() => expect(cardNames()).toHaveLength(4));
    expect(url()).toBe('/ess');
  });

  it('filters apply on the detail route too', async () => {
    // The Phase 3 route, already reachable in the harness — the filter params must not be
    // interpreted differently there.
    renderAt(['/ess/a/id-alpha?entity=Sofa']);
    await waitFor(() => expect(cardNames()).toEqual(['Alpha', 'Gamma']));
  });
});

describe('interaction writes the URL', () => {
  it('a tag checkbox lands in the query string', async () => {
    renderAt(['/ess']);
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(url()).toBe('/ess?entity=Sofa'));
  });

  it('a status checkbox lands in the query string', async () => {
    renderAt(['/ess']);
    fireEvent.click(railCheckbox('Approved'));
    await waitFor(() => expect(url()).toBe('/ess?status=approved'));
  });

  it('latestOnly lands as latest=1', async () => {
    renderAt(['/ess']);
    fireEvent.click(screen.getByText('Latest version only').previousElementSibling!);
    await waitFor(() => expect(url()).toBe('/ess?latest=1'));
  });

  it('several filters accumulate, canonically ordered', async () => {
    renderAt(['/ess']);
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(url()).toContain('entity=Sofa'));
    fireEvent.click(railCheckbox('Approved'));
    await waitFor(() => expect(url()).toBe('/ess?status=approved&entity=Sofa'));
  });

  it('clearing every filter returns the URL to the bare portal path', async () => {
    renderAt(['/ess']);
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(url()).toBe('/ess?entity=Sofa'));

    fireEvent.click(railCheckbox('Sofa'));

    // No `?`, no empty param — this is the URL a client is given.
    await waitFor(() => expect(url()).toBe('/ess'));
  });
});

describe('the search box is debounced', () => {
  it('reaches the URL after typing stops', async () => {
    renderAt(['/ess']);
    fireEvent.change(screen.getByPlaceholderText('Search assets…'), { target: { value: 'delta' } });

    await waitFor(() => expect(url()).toBe('/ess?q=delta'));
    expect(cardNames()).toEqual(['Delta']);
  });

  it('writes the URL once for a burst of keystrokes, not once per key', async () => {
    renderAt(['/ess']);
    const box = screen.getByPlaceholderText('Search assets…');

    for (const value of ['d', 'de', 'del', 'delt', 'delta']) {
      fireEvent.change(box, { target: { value } });
    }

    await waitFor(() => expect(url()).toBe('/ess?q=delta'));
    // Not one URL per keystroke: `?q=d`, `?q=de` and friends never existed. Asserted on the router's
    // own history of visited URLs, because the final value alone cannot tell the two apart.
    expect(visited).toEqual(['/ess', '/ess?q=delta']);
    // And the box itself kept every keystroke — the debounce is on the write, not on the input.
    expect(screen.getByPlaceholderText<HTMLInputElement>('Search assets…').value).toBe('delta');
  });

  it('clearing the box clears the param', async () => {
    renderAt(['/ess?q=delta']);
    await waitFor(() => expect(cardNames()).toEqual(['Delta']));

    fireEvent.change(screen.getByPlaceholderText('Search assets…'), { target: { value: '' } });

    await waitFor(() => expect(url()).toBe('/ess'));
  });

  it('a whitespace-only search writes nothing', async () => {
    renderAt(['/ess']);
    fireEvent.change(screen.getByPlaceholderText('Search assets…'), { target: { value: '   ' } });
    await waitFor(() =>
      expect(screen.getByPlaceholderText<HTMLInputElement>('Search assets…').value).toBe('   '));
    expect(url()).toBe('/ess');
  });
});

describe('history', () => {
  it('Back after several filter changes leaves the portal in ONE step', async () => {
    /* The whole point of replace-not-push. Ten checkbox clicks must not become ten history entries
       the user has to grind through to get out. */
    renderAt(['/', '/ess']);
    fireEvent.click(railCheckbox('Sofa'));
    await waitFor(() => expect(url()).toContain('entity=Sofa'));
    fireEvent.click(railCheckbox('Approved'));
    await waitFor(() => expect(url()).toContain('status=approved'));
    fireEvent.click(screen.getByText('Latest version only').previousElementSibling!);
    await waitFor(() => expect(url()).toContain('latest=1'));

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(screen.getByText('admin landing')).toBeTruthy());
  });

  it('a debounced search does not grow history either', async () => {
    renderAt(['/', '/ess']);
    const box = screen.getByPlaceholderText('Search assets…');
    for (const value of ['d', 'de', 'del']) fireEvent.change(box, { target: { value } });
    await waitFor(() => expect(url()).toBe('/ess?q=del'));

    fireEvent.click(screen.getByText('go back'));

    await waitFor(() => expect(screen.getByText('admin landing')).toBeTruthy());
  });
});
