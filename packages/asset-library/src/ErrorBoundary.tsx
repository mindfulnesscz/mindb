/* One error boundary for both apps.
 *
 * WHY IT IS SHARED
 * A React render error unmounts the whole tree by default: the user gets a blank white page, and the
 * error exists only in a console they cannot open. That is the same failure in the portal and on
 * desktop, so the LOGIC lives here once — catch, report through the app's own error sink, offer a way
 * out.
 *
 * The CHROME is not shared, because the two apps do not look alike (Tailwind versus CSS modules). Each
 * passes its own `fallback`, and its own `onError` — the portal and desktop have separate
 * `reportError` implementations with different sinks.
 *
 * `resetKey` is what makes this more than a dead end: change it (the current route, the active view)
 * and the boundary re-renders its children. Without it a single bad asset detail page poisons the
 * whole session and the user must reload the app to escape.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryFallbackProps {
  error: Error
  /** Try the same children again — useful when the cause was transient (a failed fetch mid-render). */
  retry: () => void
}

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Renders the error state. Given no fallback, the boundary renders nothing rather than crash. */
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode
  /** The app's error sink. Called once per caught error, with the component stack. */
  onError?: (error: Error, componentStack: string) => void
  /** Changing this clears the error — pass the route or the active view. */
  resetKey?: unknown
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the part that makes a minified render error locatable at all.
    this.props.onError?.(error, info.componentStack ?? '')
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private retry = () => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return this.props.fallback?.({ error, retry: this.retry }) ?? null
  }
}
