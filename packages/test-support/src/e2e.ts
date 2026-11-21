import { setTimeout as poll } from 'node:timers/promises';

/** The origin-carrying WebSocket of the standalone scenarios (Node's global WebSocket sends no Origin; undici accepts headers). */
export const originSocket = (origin: string): typeof WebSocket => class extends WebSocket {
  constructor(url: string | URL) { super(url, { headers: { Origin: origin } }); }
};

/**
 * Polls an actual condition. Standalone scenarios run under plain Node, outside a Vitest runner, so `vi.waitFor` is unavailable.
 * Contract: `fn` returning `undefined`, `null` or `false` means "not yet" and polling goes on; ANY other value (including `0`
 * and `''`, which are real answers such as a count of zero) ends the wait and is returned. Callers return `true`/`undefined`.
 */
export async function eventually<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs: number, what: string): Promise<Exclude<T, undefined | null | false>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) return value as Exclude<T, undefined | null | false>;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await poll(25);
  }
}

/** Waits up to `timeoutMs` for an outcome that may legitimately never come: true as soon as the condition holds, false at the deadline. */
export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await poll(25);
  }
}
