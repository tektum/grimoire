import { afterEach, describe, expect, it } from 'vitest';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { PAGE, SUBJECT, U1, linkedAccessStore, userRow } from './support.js';
import { connect, eventually, startLive } from './live-support.js';
import type { Client, Live } from './live-support.js';

// A suspended user is refused on every path: the provisioner answers `ok` with `user.suspended` true for an
// existing suspended user, so the host must refuse the session itself and not rely on the provisioner.
const lives: Live[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const l of lives.splice(0)) await l.stop();
});

async function live(suspended: boolean, mode: 'lookup' | 'provisioner'): Promise<{ l: Live; accessCalls: () => number }> {
  let counter: { calls: number } = { calls: 0 };
  const l = await startLive(mode === 'lookup' ? 'admin' : undefined, {}, (t) => {
    if (mode === 'lookup') {
      // Outside local mode: `resolveUser` is the row lookup; the row exists and is (or is not) suspended.
      t.deps = { ...t.deps, resolveUser: () => Promise.resolve(userRow(U1, SUBJECT, 'admin', suspended)) };
    } else {
      // Local mode: the provisioner, whose `ok` result carries `suspended: true` for the existing suspended row.
      void t.users.createIfAbsent({ descopeUserId: SUBJECT, email: 'u1@dev.invalid', name: 'u1', role: 'admin' });
      if (suspended) t.users.suspend(SUBJECT);
      t.provisionAs('admin');
    }
    const store = linkedAccessStore(t.users, t.world);
    counter = store;
    t.deps = { ...t.deps, access: createPageAccess(store) };
  });
  l.t.pages.seed(PAGE);
  lives.push(l);
  return { l, accessCalls: () => counter.calls };
}

describe.each(['lookup', 'provisioner'] as const)('suspended user, resolveUser = %s', (mode) => {
  it('is refused forbidden with one collab.refused naming suspended; no document opened, no access check', async () => {
    const { l, accessCalls } = await live(true, mode);
    const c = connect(l, PAGE); clients.push(c);
    await eventually(() => c.failures.length > 0, 5000, 'refused');
    expect(c.failures).toEqual(['forbidden']);
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.refused')).toEqual([{ level: 'warn', event: 'collab.refused', fields: { code: 'forbidden', detail: 'suspended' } }]);
    expect(accessCalls()).toBe(0);
    expect(l.t.pages.calls.load).toBe(0);
    expect(l.host.hocuspocus?.documents.size).toBe(0);
  });

  it('the same row with suspended false connects', async () => {
    const { l, accessCalls } = await live(false, mode);
    const c = connect(l, PAGE); clients.push(c);
    await eventually(() => c.provider.synced, 5000, 'synced');
    expect(c.failures).toEqual([]);
    expect(accessCalls()).toBe(1);
  });
});
