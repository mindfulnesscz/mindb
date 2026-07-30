/* Vitest setup — jest-dom matchers for the component suites.
 *
 * Harmless in the node environment used by the pure-logic tests: the import only registers
 * matchers, it does not touch the DOM.
 */
import '@testing-library/jest-dom/vitest';
