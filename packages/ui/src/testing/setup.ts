import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

/**
 * jsdom gaps that Radix's pointer and scroll handling depends on.
 *
 * These are missing DOM APIs in the test environment, not defects in the components: a real
 * browser implements all of them. Without the shims Select throws on open, which would read
 * as a component failure and send someone hunting a bug that does not exist.
 *
 * Genuine pointer and scroll behaviour is exercised in the Playwright suite against a real
 * browser (11-testing-architecture.md §6).
 */
beforeAll(() => {
  // Element.prototype is typed as having these already, so `in` narrows the false branch to
  // never. Go through an indexed view to patch only what is genuinely absent at runtime —
  // and without `any`, which is a build error (01-overview.md §3 principle 10).
  const proto = Element.prototype as unknown as Record<string, unknown>;
  const noop = (): void => undefined;

  for (const method of ['scrollIntoView', 'setPointerCapture', 'releasePointerCapture']) {
    if (typeof proto[method] !== 'function') proto[method] = noop;
  }
  if (typeof proto['hasPointerCapture'] !== 'function') {
    proto['hasPointerCapture'] = (): boolean => false;
  }

  const globals = globalThis as unknown as Record<string, unknown>;
  if (typeof globals['ResizeObserver'] !== 'function') {
    globals['ResizeObserver'] = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

afterEach(cleanup);
