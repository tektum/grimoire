import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../../src/extensions/lifecycle.js';
import { PeerRegistry } from '../../src/peers.js';
import { REFUSAL_CLOSE_CODES } from '../../src/refusal.js';
import { buildExtensions } from '../../src/registry.js';
import { makeDeps } from '../host/support.js';

/** R4.4: the server is built from extensions, one concern each, in a fixed order of priority. */
describe('the extensions of the collaboration server', () => {
  const t = makeDeps('member');
  const { extensions } = buildExtensions({ deps: t.deps, log: t.log, peers: new PeerRegistry(REFUSAL_CLOSE_CODES), guard: {} as never, sleep: () => Promise.resolve() });
  const lifecycle = createLifecycle(t.log).extension;
  const byPriority = [...extensions, lifecycle].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  it('are one per concern, named, each with a priority of its own', () => {
    expect(byPriority.map((e) => e.extensionName)).toEqual([
      'grimoire-auth', 'grimoire-handshake', 'grimoire-recheck', 'grimoire-limits', 'grimoire-presence', 'grimoire-persistence', 'grimoire-lifecycle',
    ]);
    const priorities = byPriority.map((e) => e.priority);
    expect(priorities.every((p) => typeof p === 'number')).toBe(true);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('run authentication first, then the re-check and the limits, and store only after the connection concerns have run', () => {
    const priority = (name: string) => byPriority.find((e) => e.extensionName === name)?.priority as number;
    expect(priority('grimoire-auth')).toBeGreaterThan(priority('grimoire-handshake'));
    expect(priority('grimoire-handshake')).toBeGreaterThan(priority('grimoire-recheck'));
    expect(priority('grimoire-recheck')).toBeGreaterThan(priority('grimoire-limits'));
    expect(priority('grimoire-limits')).toBeGreaterThan(priority('grimoire-presence'));
    expect(priority('grimoire-presence')).toBeGreaterThan(priority('grimoire-persistence'));
    expect(priority('grimoire-persistence')).toBeGreaterThan(priority('grimoire-lifecycle'));
  });

  it('give each concern its own hooks: only the persistence extension stores documents and only the auth extension authenticates', () => {
    const stores = byPriority.filter((e) => e.onStoreDocument !== undefined).map((e) => e.extensionName);
    expect(stores).toEqual(['grimoire-persistence']);
    const authenticates = byPriority.filter((e) => e.onAuthenticate !== undefined).map((e) => e.extensionName);
    expect(authenticates).toEqual(['grimoire-auth']);
  });
});
