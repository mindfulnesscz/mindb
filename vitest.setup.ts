/* Vitest setup — jest-dom matchers, and DOM cleanup between component tests.
 *
 * Harmless in the node environment used by the pure-logic tests: the jest-dom import only registers
 * matchers, it does not touch the DOM.
 *
 * The cleanup matters, and was missing. Without it every `render()` leaves its tree in the document,
 * so a file that renders the same component twice hits "found multiple elements" — and worse, a test
 * can pass by finding a node an EARLIER test rendered. React Testing Library registers this
 * automatically only when Vitest runs with globals enabled, which this config deliberately does not.
 *
 * Loaded behind a DOM check so the node-environment suites never pull React in at all.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
