import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Testing Library set-up for the `web` project: import it for its effects at the top of a component test.
 * Cleans up after each test (vitest has no globals, so Testing Library does not do it) and gives happy-dom the few browser
 * classes Radix and cmdk call.
 */
afterEach(cleanup);

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopObserver;
Element.prototype.scrollIntoView ??= () => {};
