/* The portal's error state — what a client sees instead of a white page.
 *
 * The audience matters. This is a client-facing portal, so the fallback says what happened in plain
 * words and offers a way forward; the message and stack go to `reportError`, not to the page. A client
 * reading a minified React stack learns nothing and loses confidence.
 *
 * Keyed on the route, so navigating away clears the error rather than trapping the session.
 */

import { useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@sotto/asset-library'
import { reportError } from '../lib/reportError'

export function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation()

  return (
    <ErrorBoundary
      resetKey={location.pathname}
      onError={(error, componentStack) =>
        reportError(`route:${location.pathname}`, Object.assign(error, { componentStack }))
      }
      fallback={({ retry }) => (
        <div className="flex min-h-screen items-center justify-center bg-bg px-6">
          <div className="max-w-md text-center">
            <p className="font-sans text-sm font-bold uppercase tracking-label text-text-muted">
              Something went wrong
            </p>
            <p className="mt-3 font-sans text-sm text-text">
              This page failed to load. Nothing you did caused it, and nothing has been lost.
            </p>
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={retry}
                className="rounded-sm border border-cosmos-black px-3 py-1.5 font-sans text-[11px] font-semibold transition-colors hover:bg-cosmos-black hover:text-clear-white"
              >
                Try again
              </button>
              <a
                href="/"
                className="font-sans text-[11px] text-text-muted underline hover:text-cosmos-black"
              >
                Back to start
              </a>
            </div>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
