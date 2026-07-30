// @vitest-environment jsdom

/* The shared error boundary.
 *
 * A render error unmounts the whole tree by default — the user gets a blank page and the error lives
 * only in a console they cannot open. So three things are pinned:
 *
 *   it CATCHES and reports, with the component stack (the part that makes a minified error locatable);
 *   it RECOVERS on retry and on navigation, because a boundary with no way out is a dead end that
 *     forces a reload and loses the session;
 *   it does NOT interfere when nothing is wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '@dc-hub/asset-library'

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('render exploded')
  return <p>content</p>
}

const fallback = ({ error, retry }: { error: Error; retry: () => void }) => (
  <div>
    <span>caught: {error.message}</span>
    <button onClick={retry}>Try again</button>
  </div>
)

beforeEach(() => {
  // React logs caught render errors itself; that noise is not the test's concern.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', () => {
    render(<ErrorBoundary fallback={fallback}><Boom shouldThrow={false} /></ErrorBoundary>)
    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('renders the fallback instead of unmounting the tree', () => {
    render(<ErrorBoundary fallback={fallback}><Boom shouldThrow /></ErrorBoundary>)
    expect(screen.getByText('caught: render exploded')).toBeInTheDocument()
  })

  it('reports the error WITH the component stack', () => {
    // Without the stack, a minified production error names no component at all.
    const onError = vi.fn()
    render(<ErrorBoundary fallback={fallback} onError={onError}><Boom shouldThrow /></ErrorBoundary>)

    expect(onError).toHaveBeenCalledTimes(1)
    const [error, componentStack] = onError.mock.calls[0]
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('render exploded')
    expect(componentStack).toContain('Boom')
  })

  it('recovers on retry once the cause is gone', () => {
    // The transient case: a fetch that failed mid-render. Retrying must be able to succeed.
    const { rerender } = render(
      <ErrorBoundary fallback={fallback}><Boom shouldThrow /></ErrorBoundary>,
    )
    expect(screen.getByText(/caught:/)).toBeInTheDocument()

    rerender(<ErrorBoundary fallback={fallback}><Boom shouldThrow={false} /></ErrorBoundary>)
    // fireEvent, not a raw DOM click: the state update has to be flushed inside act().
    fireEvent.click(screen.getByText('Try again'))

    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('clears itself when resetKey changes — navigating away must not stay broken', () => {
    // Without this, one bad page poisons the session until a reload.
    const { rerender } = render(
      <ErrorBoundary fallback={fallback} resetKey="/asset/1"><Boom shouldThrow /></ErrorBoundary>,
    )
    expect(screen.getByText(/caught:/)).toBeInTheDocument()

    rerender(
      <ErrorBoundary fallback={fallback} resetKey="/gallery"><Boom shouldThrow={false} /></ErrorBoundary>,
    )
    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('stays in the error state while resetKey is unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary fallback={fallback} resetKey="/asset/1"><Boom shouldThrow /></ErrorBoundary>,
    )
    rerender(
      <ErrorBoundary fallback={fallback} resetKey="/asset/1"><Boom shouldThrow={false} /></ErrorBoundary>,
    )
    expect(screen.getByText(/caught:/)).toBeInTheDocument()
  })

  it('renders nothing rather than crashing when given no fallback', () => {
    const { container } = render(<ErrorBoundary><Boom shouldThrow /></ErrorBoundary>)
    expect(container).toBeEmptyDOMElement()
  })
})
