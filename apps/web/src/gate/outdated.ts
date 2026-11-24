import { useSyncExternalStore } from 'react';

// Set when the server says this client is too old (a 426 `client_too_old` answer): the app then shows the reload text and nothing else,
// and no further request leaves the client.
let outdated = false;
const listeners = new Set<() => void>();

export function markClientOutdated(): void {
  if (outdated) return;
  outdated = true;
  for (const listener of listeners) listener();
}
export const isClientOutdated = (): boolean => outdated;
/** For tests: forget the mark. */
export function resetClientOutdated(): void {
  outdated = false;
  for (const listener of listeners) listener();
}
export function useClientOutdated(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => outdated,
  );
}

/** A `fetch` that refuses at once once the client is marked outdated, so a stale client sends no more calls. */
export function blockWhenOutdated(base: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return (request) => (outdated ? Promise.reject(new DOMException('This client is too old', 'AbortError')) : base(request));
}
