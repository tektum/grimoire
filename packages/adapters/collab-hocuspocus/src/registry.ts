import type { Extension } from '@hocuspocus/server';
import type { CollabDeps } from '@tektum/grimoire-core/ports/collaboration-host';
import type { CollabLog } from './events.js';
import { createAuthExtension } from './extensions/auth.js';
import { createLimitsExtension } from './extensions/limits.js';
import { createPersistenceExtension } from './extensions/persistence.js';
import type { PersistenceExtension } from './extensions/persistence.js';
import { createPresenceExtension } from './extensions/presence.js';
import { createRecheck } from './extensions/recheck.js';
import type { Recheck } from './extensions/recheck.js';
import { guardConnectHooks } from './guard.js';
import type { BreakerOptions } from './save.js';
import type { PeerRegistry } from './peers.js';
import type { UpgradeGuard } from './upgrade-guard.js';

export interface RegistryOptions {
  readonly deps: CollabDeps;
  readonly log: CollabLog;
  readonly peers: PeerRegistry;
  readonly guard: UpgradeGuard;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onChange?: (e: { documentName: string }) => void;
  /** Extra extensions (tests, later milestones), run by priority with the others. */
  readonly extra?: readonly Extension[];
  /** Heap bytes in use for the memory guard of the limits extension. */
  readonly memoryUsed?: () => number;
  /** Breaker settings of the save path (the test-only `disabled` switch rides here). */
  readonly breaker?: BreakerOptions;
}

/** The ordered extension list; Hocuspocus orders by `priority` (auth 1000, re-check 900, limits 800, presence 600, persistence 100, lifecycle 50). */
export function buildExtensions(o: RegistryOptions): { extensions: Extension[]; persistence: PersistenceExtension; recheck: Recheck } {
  const persistence = createPersistenceExtension({
    deps: o.deps, log: o.log, sleep: o.sleep, convertConcurrency: o.deps.config.collab.convertPoolSize, ...(o.onChange ? { onChange: o.onChange } : {}), ...(o.breaker ? { breaker: o.breaker } : {}),
  });
  const recheck = createRecheck({ deps: o.deps, log: o.log });
  const limits = createLimitsExtension({ config: o.deps.config.collab, log: o.log, clock: o.deps.clock, ...(o.memoryUsed ? { memoryUsed: o.memoryUsed } : {}) });
  o.peers.onRemove((peerId) => { limits.abandonSocket(peerId); });
  o.peers.holdsAdmission((peerId) => limits.holdsReservation(peerId));
  const extensions: Extension[] = [
    createAuthExtension({ deps: o.deps, log: o.log, peers: o.peers, guard: o.guard, admit: (data, userId) => { limits.admit(data, userId); } }),
    limits,
    createPresenceExtension(),
    recheck.extension,
    persistence,
    ...(o.extra ?? []),
  ].map((e) => guardConnectHooks(e, { ...o, onFailed: (d) => { limits.connectFailed(d); } }));
  const names = new Set<string>();
  for (const e of extensions) {
    const name = e.extensionName;
    if (name === undefined) continue;
    // Two extensions with one name would be indistinguishable in logs and in any rule keyed by name: a configuration error, found at construction.
    if (names.has(name)) throw new Error(`duplicate extension name: ${name}`);
    names.add(name);
  }
  return { extensions, persistence, recheck };
}
