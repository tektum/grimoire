import type { AuthVerifier, ProfileResult, VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import type { AccessRequest, AccessStore } from '@tektum/grimoire-core/ports/access-store';
import type { CollabDeps } from '@tektum/grimoire-core/ports/collaboration-host';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createCollabLog } from '../../src/events.js';
import { REFUSAL_CLOSE_CODES } from '../../src/refusal.js';
import { PeerRegistry } from '../../src/peers.js';
import { createUpgradeGuard } from '../../src/upgrade-guard.js';
import { FakePageStore } from '@tektum/grimoire-core/testing/fake-page-store';

export const PAGE = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10';
/** Pages of the default world, all in the collection `DEV` (default read-write): the pages the host tests open. */
export const KNOWN_PAGES = [PAGE, '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11', '1c7e0f3a-5b2d-4e8f-8a11-9b3c4d5e6f70'];
export const DEV = 'c0000000-0000-4000-8000-0000000000d1';
/** The token subject of the default user and its database id: deliberately different, so a test can tell which one the host used. */
export const SUBJECT = 'u1';
export const U1 = '0a000000-0000-4000-8000-000000000001';

/**
 * A scripted verifier: `result` answers every token (the collab-hocuspocus tests may not import the auth-fake adapter, R2.18).
 * `profile` answers like the development adapter, so the local-mode provisioner can create rows.
 */
export class FakeVerifier implements AuthVerifier {
  calls = 0;
  result: VerifyResult = { kind: 'ok', userId: SUBJECT, expiresAt: 10_000_000 };
  verify(): Promise<VerifyResult> { this.calls++; return Promise.resolve(this.result); }
  profile(userId: string): Promise<ProfileResult> {
    return Promise.resolve({ kind: 'ok', profile: { email: `${userId}@dev.invalid`, name: userId, emailVerified: true } });
  }
}

/** An access store over the fake user store's rows and a page world, counting round trips. */
export function linkedAccessStore(users: FakeUserStore, world: World): AccessStore & { calls: number; fail?: Error } {
  const s: { calls: number; fail?: Error } = { calls: 0 };
  const current = (): AccessStore => createFakeAccessStore({ ...world, users: users.all().map((u) => ({ id: u.id, role: u.role, suspended: u.suspended })) });
  return Object.assign(s, {
    facts: (rs: readonly AccessRequest[]) => { s.calls++; return s.fail ? Promise.reject(s.fail) : current().facts(rs); },
    collectionFacts: (rs: Parameters<AccessStore['collectionFacts']>[0]) => current().collectionFacts(rs),
    visibleCollections: (userId: string) => current().visibleCollections(userId),
  });
}

export function devWorld(pages: readonly string[] = KNOWN_PAGES): World {
  const w = emptyWorld();
  w.collections.push({ id: DEV, deleted: false, defaultPermission: 'read_write' });
  for (const id of pages) w.pages.push({ id, collectionId: DEV, deleted: false, epoch: 0 });
  return w;
}

export const userRow = (id: string, descopeUserId: string, role: Role, suspended = false): UserRecord =>
  ({ id, descopeUserId, email: `${descopeUserId}@example.test`, name: descopeUserId, role, suspended });

/**
 * Fake host deps. `role` set: the user `SUBJECT` exists with that role (database id `U1`); unset: no user row, so connections are
 * refused `forbidden`. `resolveUser` is the production shape outside local mode (`findByDescopeId`); `provisionAs(role)` switches it
 * to the local-mode shape (the provisioner with a development role), creating rows for every verified subject.
 */
export function makeDeps(role?: Role) {
  const logger = new FakeLogger();
  const clock = new FakeClock(1_000_000);
  const verifier = new FakeVerifier();
  const pages = new FakePageStore();
  const converter = new FakeMarkdownConverter({ convert: (state) => ({ ok: true, markdown: Buffer.from(state).toString('base64'), text: '' }) });
  const users = new FakeUserStore(role ? [userRow(U1, SUBJECT, role)] : []);
  const world = devWorld();
  const accessStore = linkedAccessStore(users, world);
  const resolve = { calls: 0, fail: undefined as Error | undefined };
  const byId: CollabDeps['resolveUser'] = (_token, identity) => {
    resolve.calls++;
    return resolve.fail ? Promise.reject(resolve.fail) : users.findByDescopeId(identity.userId);
  };
  const deps: CollabDeps = { config: makeFakeConfig(), logger, clock, verifier, resolveUser: byId, access: createPageAccess(accessStore), pages, converter };
  const peers = new PeerRegistry(REFUSAL_CLOSE_CODES);
  const closes: { code: number; reason: string }[] = [];
  peers.add('p1', { close: (code: number, reason: string) => { closes.push({ code, reason }); } } as never);
  const t = {
    deps, logger, clock, verifier, pages, converter, peers, closes, users, world, accessStore, resolve,
    log: createCollabLog(logger), guard: createUpgradeGuard(),
    /** Local-mode resolution: the provisioner creates a row for each verified subject with `devRole`. */
    provisionAs(devRole: Role): void {
      const provisioner = createProvisioner({ users, verifier, policy: { firstAdminEmails: [], allowedEmailDomains: [], allowDevRole: true } });
      t.deps = {
        ...t.deps,
        resolveUser: async (_token, identity) => {
          resolve.calls++;
          const r = await provisioner.signIn({ identity, devRole });
          return r.kind === 'ok' ? r.user : undefined;
        },
      };
    },
    /** The database id of the row for `subject`, for assertions. */
    async idOf(subject: string): Promise<string | undefined> { return (await users.findByDescopeId(subject))?.id; },
  };
  return t;
}
