/* The desktop error state — what an operator sees instead of a blank pane.
 *
 * Different audience from the portal's, so a different fallback: this user is staff, mid-run, and the
 * message is the most useful thing on screen. There are no devtools in a packaged binary, so it is
 * shown here as well as filed to the rolling error log — with the breadcrumb trail attached, which is
 * what makes a render crash locatable at all.
 *
 * The nav rail stays mounted around this, so a broken view never strands the operator: they can switch
 * views, and switching resets the boundary via `resetKey`.
 */

import { ErrorBoundary } from '@sotto/asset-library';
import { reportError, recentBreadcrumbs } from '../services/reportError';
import css from './ViewErrorBoundary.module.css';

export function ViewErrorBoundary({ view, children }: { view: string; children: React.ReactNode }) {
  return (
    <ErrorBoundary
      resetKey={view}
      onError={(error, componentStack) =>
        reportError(`view:${view}`, Object.assign(error, { componentStack }))
      }
      fallback={({ error, retry }) => (
        <div className={css.wrap}>
          <div className={css.title}>The {view} view stopped responding</div>
          <p className={css.body}>
            Nothing on disk or in the database was changed by this. Switching views or retrying is safe.
          </p>
          <pre className={css.detail}>{error.message}</pre>
          {recentBreadcrumbs().length > 0 && (
            <p className={css.trail}>Last steps: {recentBreadcrumbs().join(' → ')}</p>
          )}
          <p className={css.body}>
            The full error was written to <code>errors.log</code> in the app data folder.
          </p>
          <button className={css.retry} onClick={retry}>Retry this view</button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
