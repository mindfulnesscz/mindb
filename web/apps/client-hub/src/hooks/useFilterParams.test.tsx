// @vitest-environment jsdom

/* `useFilterParams` — the React binding between the URL and FilterState.
 *
 * The test that matters most is "two setter calls in one handler both land". That is the regression
 * `useSearchParams`'s own setter has: it closes over the params from render, so the second call in a
 * tick overwrites the first instead of composing on it. GalleryView already uses the updater form
 * and Phase 4b adds more writers to the same handlers, so a silent last-write-wins here would show
 * up as a filter that "sometimes doesn't stick".
 *
 * History is asserted through `useNavigationType()` rather than `window.history.length` —
 * MemoryRouter never touches `window.history`, so a length check here would pass no matter what the
 * hook did.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigationType } from 'react-router-dom';
import { getDefaultFilters, type FilterState } from '@dc-hub/asset-library';
import { useFilterParams } from './useFilterParams';

/** Renders the current filters, the live location, and buttons for each way of calling the setter. */
function Probe() {
  const [filters, setFilters] = useFilterParams();
  const location = useLocation();
  const navType = useNavigationType();
  return (
    <div>
      <span data-testid="filters">{JSON.stringify(filters)}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="navtype">{navType}</span>
      <button onClick={() => setFilters(f => ({ ...f, entities: [...f.entities, 'Chair'] }))}>add chair</button>
      <button onClick={() => setFilters(f => ({ ...f, latestOnly: true }))}>latest</button>
      <button
        onClick={() => {
          // Both in ONE handler, both updater-form — the regression this hook exists to avoid.
          setFilters(f => ({ ...f, entities: [...f.entities, 'Chair'] }));
          setFilters(f => ({ ...f, latestOnly: true }));
        }}
      >
        both
      </button>
      <button onClick={() => setFilters(getDefaultFilters())}>clear</button>
    </div>
  );
}

function renderProbe(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path=":slug" element={<Probe />} />
        <Route path=":slug/a/:assetId" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const current = (): FilterState => JSON.parse(screen.getByTestId('filters').textContent!);
const search = () => screen.getByTestId('search').textContent!;

describe('reading', () => {
  it('parses the initial query string', () => {
    renderProbe('/ess?entity=Sofa');
    expect(current().entities).toEqual(['Sofa']);
  });

  it('a bare path is the default filter set', () => {
    renderProbe('/ess');
    expect(current()).toEqual(getDefaultFilters());
  });

  it('parses on the asset detail route too', () => {
    renderProbe('/ess/a/some-uuid?entity=Sofa&latest=1');
    expect(current().entities).toEqual(['Sofa']);
    expect(current().latestOnly).toBe(true);
  });

  it('a stale or hand-edited URL still yields a usable filter set', () => {
    renderProbe('/ess?status=banana&latest=yes&unknown=1');
    expect(current()).toEqual(getDefaultFilters());
  });

  it('the returned object identity is stable across unrelated re-renders', () => {
    /* `useAssets` keys its fetch off this object. A fresh one on every render refetches forever —
       which is why the parse is memoized on the search string rather than run inline. */
    const seen: FilterState[] = [];
    function Identity() {
      const [filters] = useFilterParams();
      const [, setTick] = useState(0);
      seen.push(filters);
      return <button onClick={() => setTick(t => t + 1)}>re-render</button>;
    }
    render(
      <MemoryRouter initialEntries={['/ess?entity=Sofa']}>
        <Routes><Route path=":slug" element={<Identity />} /></Routes>
      </MemoryRouter>,
    );
    const before = seen.length;

    fireEvent.click(screen.getByText('re-render'));

    expect(seen.length).toBeGreaterThan(before);
    expect(seen[seen.length - 1]).toBe(seen[0]);
  });
});

describe('writing', () => {
  it('the setter rewrites the URL', async () => {
    renderProbe('/ess');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(search()).toBe('?entity=Chair'));
  });

  it('the direct-value form works as well as the updater form', async () => {
    renderProbe('/ess?entity=Sofa&latest=1');
    fireEvent.click(screen.getByText('clear'));
    await waitFor(() => expect(search()).toBe(''));
  });

  it('clearing every filter leaves no empty params behind', async () => {
    renderProbe('/ess?entity=Sofa&q=x&latest=1&status=approved');
    fireEvent.click(screen.getByText('clear'));
    await waitFor(() => expect(search()).toBe(''));
  });

  it('two setter calls in one handler BOTH land', async () => {
    renderProbe('/ess');
    fireEvent.click(screen.getByText('both'));

    await waitFor(() => expect(current().latestOnly).toBe(true));
    expect(current().entities).toEqual(['Chair']);
    expect(search()).toBe('?latest=1&entity=Chair');
  });

  it('composes onto what is already there rather than replacing it', async () => {
    renderProbe('/ess?entity=Sofa');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(current().entities).toEqual(['Chair', 'Sofa']));
  });

  it('the written URL is canonical — sorted, whatever order the values arrived in', async () => {
    renderProbe('/ess?entity=Sofa');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(search()).toBe('?entity=Chair&entity=Sofa'));
  });
});

describe('history', () => {
  it('a filter change REPLACES — Back leaves rather than rewinding one checkbox at a time', async () => {
    renderProbe('/ess');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(search()).toBe('?entity=Chair'));
    expect(screen.getByTestId('navtype').textContent).toBe('REPLACE');

    fireEvent.click(screen.getByText('latest'));
    await waitFor(() => expect(current().latestOnly).toBe(true));
    expect(screen.getByTestId('navtype').textContent).toBe('REPLACE');
  });
});

describe('params this hook does not own', () => {
  it('an unrelated param survives a filter change', async () => {
    renderProbe('/ess?foo=1');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(search()).toBe('?entity=Chair&foo=1'));
  });

  it('focus and lb survive a filter change', async () => {
    // Phase 4 puts these on the detail route; a filter change there must not close the lightbox.
    renderProbe('/ess/a/uuid-1?focus=uuid-2&lb=1');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(search()).toBe('?entity=Chair&focus=uuid-2&lb=1'));
  });

  it('clearing filters keeps the foreign params', async () => {
    renderProbe('/ess?entity=Sofa&focus=uuid-2');
    fireEvent.click(screen.getByText('clear'));
    await waitFor(() => expect(search()).toBe('?focus=uuid-2'));
  });

  it('the pathname is untouched, including on the detail route', async () => {
    renderProbe('/ess/a/uuid-1?entity=Sofa');
    fireEvent.click(screen.getByText('add chair'));
    await waitFor(() => expect(current().entities).toEqual(['Chair', 'Sofa']));
    expect(screen.getByTestId('pathname').textContent).toBe('/ess/a/uuid-1');
  });
});
