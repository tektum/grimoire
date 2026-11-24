import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthExtension } from '../../src/extensions/auth.js';
import { guardConnectHooks } from '../../src/guard.js';
import { makeDeps, PAGE, SUBJECT } from '../host/support.js';

// The user lookup of the handshake gets what the verifier said about the tenant, so that a lookup that creates or checks the person (the provisioner of local mode) acts in the tenant
// of the token and not in `legacy`.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the identity the handshake hands to the user lookup', () => {
  it('carries the tenant of the verified token, and none when the token has none', async () => {
    for (const claim of [{ kind: 'one', id: 'tenant-a' }, undefined] as const) {
      const t = makeDeps('member');
      t.verifier.result = { kind: 'ok', userId: SUBJECT, expiresAt: 10_000_000, ...(claim === undefined ? {} : { tenant: claim }) };
      const seen: unknown[] = [];
      const resolve = t.deps.resolveUser;
      t.deps = { ...t.deps, resolveUser: (token, identity) => { seen.push(identity); return resolve(token, identity); } };
      const ext = guardConnectHooks(createAuthExtension({ deps: t.deps, log: t.log, peers: t.peers, guard: t.guard }), t);
      await ext.onAuthenticate?.({ token: 't', documentName: PAGE, context: { peerId: 'p1', address: 'a' }, connectionConfig: { readOnly: false } } as never);
      expect(seen).toEqual([{ userId: SUBJECT, ...(claim === undefined ? {} : { tenant: claim }) }]);
    }
  });
});
