import { vi } from 'vitest';
import type { Extension } from '@hocuspocus/server';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { CollabDeps } from '@tektum/grimoire-core/ports/collaboration-host';
import type { VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createCollabLog } from '../../src/events.js';
import { throttleLog } from '../../src/log-throttle.js';
import { createRecheck } from '../../src/extensions/recheck.js';
import type { Recheck } from '../../src/extensions/recheck.js';
import { DEV, linkedAccessStore, makeDeps, PAGE, SUBJECT, U1, userRow } from '../host/support.js';

export { DEV, PAGE, SUBJECT, U1, userRow };
export const INTERVAL_SECONDS = 2;
export const INTERVAL_MS = INTERVAL_SECONDS * 1000;

export interface FakeConnection {
  readOnly: boolean;
  context: Record<string, unknown>;
  closes: { code: number; reason: string }[];
  requestToken: ReturnType<typeof vi.fn>;
  close(event?: { code: number; reason: string }): void;
  onClose(cb: () => void): void;
}

export interface Rig {
  readonly t: ReturnType<typeof makeDeps>;
  readonly recheck: Recheck;
  readonly store: ReturnType<typeof linkedAccessStore>;
  readonly connections: FakeConnection[];
  /** Admits a document connection as the real host does: `connected` with the context `onAuthenticate` returned. */
  open(o?: { page?: string; userId?: string; subject?: string; level?: 'read-write' | 'read-only'; expiresInMs?: number; epoch?: number; peerId?: string }): Promise<FakeConnection>;
  /** Moves the clock and the timers together: the injected clock decides expiry, the (fake) timer decides when a round runs. */
  elapse(ms: number): Promise<void>;
  tokenSync(c: FakeConnection, token: string): Promise<void>;
  events(name: string): Record<string, unknown>[];
}

/** The re-check over fake stores: user `SUBJECT` is a member with row `U1`; user `u2` (row `U2`) is a member too. */
export function rig(o: { role?: 'admin' | 'member' | 'viewer'; intervalSeconds?: number } = {}): Rig {
  const t = makeDeps(o.role ?? 'member');
  void t.users.createIfAbsent({ descopeUserId: 'u2', email: 'u2@example.test', name: 'u2', role: 'member' });
  const store = linkedAccessStore(t.users, t.world);
  t.deps = { ...t.deps, access: createPageAccess(store), config: makeFakeConfig({ collab: { recheckSeconds: o.intervalSeconds ?? INTERVAL_SECONDS } }) } satisfies CollabDeps;
  const log = throttleLog(createCollabLog(t.logger));
  const recheck = createRecheck({ deps: t.deps, log });
  const connections: FakeConnection[] = [];
  const ext: Extension = recheck.extension;
  const r: Rig = {
    t, recheck, store, connections,
    async open(p = {}) {
      const closeCallbacks: (() => void)[] = [];
      const c: FakeConnection = {
        readOnly: (p.level ?? 'read-write') === 'read-only',
        context: {},
        closes: [],
        requestToken: vi.fn(),
        close(event) {
          c.closes.push(event ?? { code: 0, reason: '' });
          for (const cb of closeCallbacks.splice(0)) cb();
        },
        onClose(cb) { closeCallbacks.push(cb); },
      };
      c.context = {
        address: '127.0.0.1', peerId: p.peerId ?? 'p1', userId: p.userId ?? U1, descopeUserId: p.subject ?? SUBJECT,
        accessLevel: p.level ?? 'read-write', expiresAt: t.clock.now() + (p.expiresInMs ?? 3_600_000), epoch: p.epoch ?? 0,
      };
      await ext.connected?.({ documentName: p.page ?? PAGE, context: c.context, connection: c } as never);
      connections.push(c);
      return c;
    },
    async elapse(ms) { t.clock.advance(ms); await vi.advanceTimersByTimeAsync(ms); },
    async tokenSync(c, token) {
      await ext.onTokenSync?.({ documentName: PAGE, context: c.context, connection: c, token } as never);
    },
    events: (name) => t.logger.entries.filter((e) => e.event === name).map((e) => e.fields),
  };
  return r;
}

/** A verifier that answers per token: `ok` for the subject written in the token (`sub:<subject>:<expiresAt>`), invalid for anything else. */
export function subjectVerifier(r: Rig): void {
  r.t.verifier.verify = (token: string): Promise<VerifyResult> => {
    r.t.verifier.calls++;
    const m = /^sub:([^:]+):(\d+)$/.exec(token);
    if (!m) return Promise.resolve({ kind: 'invalid-token' });
    return Promise.resolve({ kind: 'ok', userId: m[1] as string, expiresAt: Number(m[2]) });
  };
}
