import { describe, expect, it } from 'vitest';
import { decide } from '@tektum/grimoire-core/authorize/decide';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import type { Permission } from '@tektum/grimoire-core/ports/access-store';
import type { Role } from '@tektum/grimoire-core/ports/user-store';
import { createAuthExtension } from '../../src/extensions/auth.js';
import { guardConnectHooks } from '../../src/guard.js';
import { linkedAccessStore, makeDeps, userRow } from './support.js';
import { createPageAccess } from '@tektum/grimoire-core/authorize';

// Property: for random worlds of users, groups, collections, entries and pages, the host admits exactly the connections the pure
// rule allows, at exactly that level, and refuses the rest with the answer the contract gives. The seed is printed in the test name;
// GRIMOIRE_ADMISSION_SEED=<n> replays one run.
const SEED = Number(process.env['GRIMOIRE_ADMISSION_SEED'] ?? Date.now() % 1_000_000);
const WORLDS = 60;

/** mulberry32: a few lines of seeded randomness; no property-testing library is installed and none is added for this. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}`;
const uuid = (kind: 'a' | 'b' | 'c' | 'd', n: number): string => hex(`${kind}0000000-0000-4000-8000-`, n);

function randomWorld(rand: () => number): World {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const w = emptyWorld();
  const roles: Role[] = ['admin', 'member', 'viewer'];
  const perms: (Permission | null)[] = [null, 'read', 'read_write'];
  for (let i = 0; i < 4; i++) w.users.push({ id: uuid('a', i), role: pick(roles), suspended: rand() < 0.2 });
  for (let i = 0; i < 2; i++) w.groups.push({ id: uuid('b', i) });
  for (const u of w.users) for (const g of w.groups) if (rand() < 0.3) w.members.push({ groupId: g.id, userId: u.id });
  for (let i = 0; i < 3; i++) w.collections.push({ id: uuid('c', i), deleted: rand() < 0.15, defaultPermission: pick(perms) });
  for (const c of w.collections) {
    for (const u of w.users) if (rand() < 0.3) w.access.push({ collectionId: c.id, userId: u.id, permission: rand() < 0.5 ? 'read' : 'read_write' });
    for (const g of w.groups) if (rand() < 0.3) w.access.push({ collectionId: c.id, groupId: g.id, permission: rand() < 0.5 ? 'read' : 'read_write' });
  }
  for (let i = 0; i < 4; i++) w.pages.push({ id: uuid('d', i), collectionId: pick(w.collections).id, deleted: rand() < 0.15, epoch: Math.floor(rand() * 5) });
  return w;
}

describe(`host admission equals the authorisation rule (seed ${String(SEED)})`, () => {
  it(`${String(WORLDS)} random worlds: every (user, page) pair is admitted exactly when decide allows, at that level`, async () => {
    const rand = prng(SEED);
    let admitted = 0;
    let refused = 0;
    for (let n = 0; n < WORLDS; n++) {
      const world = randomWorld(rand);
      const t = makeDeps();
      // One row per world user, keyed by subject `s-<id>`; one extra subject with no row at all.
      const users = new FakeUserStore(world.users.map((u) => userRow(u.id, `s-${u.id}`, u.role, u.suspended)));
      t.deps = { ...t.deps, resolveUser: (_token, identity) => users.findByDescopeId(identity.userId), access: createPageAccess(linkedAccessStore(users, world)) };
      const reference = createFakeAccessStore(world);
      const ext = guardConnectHooks(createAuthExtension({ deps: t.deps, log: t.log, peers: t.peers, guard: t.guard }), t);
      const subjects = [...world.users.map((u) => `s-${u.id}`), 's-nobody'];
      const pages = [...world.pages.map((p) => p.id), uuid('d', 99)];
      for (const subject of subjects) {
        for (const pageId of pages) {
          t.verifier.result = { kind: 'ok', userId: subject, expiresAt: 10_000_000 };
          const readOnly = { v: false };
          const data = { token: 't', documentName: pageId, context: { peerId: 'p1', address: 'a' }, connectionConfig: { get readOnly() { return readOnly.v; }, set readOnly(v: boolean) { readOnly.v = v; }, isAuthenticated: false } };
          const outcome = await Promise.resolve(ext.onAuthenticate?.(data as never)).then((ctx) => ({ ok: true as const, ctx }), (e: unknown) => ({ ok: false as const, e }));
          const user = world.users.find((u) => `s-${u.id}` === subject);
          const where = `seed ${String(SEED)} world ${String(n)} subject ${subject} page ${pageId}`;
          if (user === undefined || user.suspended) {
            expect(outcome, where).toMatchObject({ ok: false, e: { reason: 'forbidden' } });
            refused++;
            continue;
          }
          const [facts] = await reference.facts([{ tenantId: 'legacy', userId: user.id, pageId }]);
          const d = facts ? decide(facts) : { access: 'none' as const };
          if (d.access === 'none') {
            expect(outcome, where).toMatchObject({ ok: false, e: { reason: 'not-found' } });
            refused++;
          } else {
            expect(outcome, where).toMatchObject({ ok: true, ctx: { userId: user.id, accessLevel: d.access, epoch: d.epoch } });
            expect(readOnly.v, where).toBe(d.access === 'read-only');
            admitted++;
          }
        }
      }
    }
    // The generator must exercise both sides, or the property says nothing.
    expect(admitted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
  });
});
