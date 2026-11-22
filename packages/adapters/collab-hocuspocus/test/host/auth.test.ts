import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_DATABASE_TIMEOUT_MS, createAuthExtension } from '../../src/extensions/auth.js';
import { guardConnectHooks } from '../../src/guard.js';
import { REFUSAL_CLOSE_CODES } from '../../src/refusal.js';
import { DEV, makeDeps, PAGE, SUBJECT, U1, userRow } from './support.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const MISSING = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999';
const CLOSED = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8888';
const DELETED = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e7777';

function setup(role: 'admin' | 'member' | 'viewer' | undefined) {
  const t = makeDeps(role);
  t.world.collections.push({ id: 'c-closed', deleted: false, defaultPermission: null });
  t.world.pages.push({ id: CLOSED, collectionId: 'c-closed', deleted: false, epoch: 0 }, { id: DELETED, collectionId: DEV, deleted: true, epoch: 0 });
  const ext = () => guardConnectHooks(createAuthExtension({ deps: t.deps, log: t.log, peers: t.peers, guard: t.guard }), t);
  const connect = (documentName: string) => ext().onConnect?.({ documentName, context: { peerId: 'p1', address: 'a' } } as never);
  const authenticate = (token: string, documentName = PAGE, readOnly = { v: false }) => {
    const data = { token, documentName, context: { peerId: 'p1', address: 'a' }, connectionConfig: { get readOnly() { return readOnly.v; }, set readOnly(v: boolean) { readOnly.v = v; }, isAuthenticated: false } };
    return { readOnly, result: ext().onAuthenticate?.(data as never) };
  };
  const refused = () => t.logger.entries.filter((e) => e.event === 'collab.refused');
  return Object.assign(t, { ext, connect, authenticate, refused });
}

describe('authentication outcomes', () => {
  it.each(['0B6F4F0E-3C1D-4A53-9A62-5D1C2A7E8F10', '0b6f4f0e3c1d4a539a625d1c2a7e8f10', '../x', 'a'.repeat(300), '{0B6F4F0E-3C1D-4A53-9A62-5D1C2A7E8F10}'])(
    'bad document name %#: refused as bad-document-name before any verifier or database call', async (name) => {
      const s = setup('member');
      await expect(s.connect(name)).rejects.toMatchObject({ reason: 'bad-document-name' });
      expect(s.verifier.calls).toBe(0);
      expect(s.resolve.calls).toBe(0);
      expect(s.accessStore.calls).toBe(0);
      expect(s.pages.calls).toEqual({ load: 0, store: 0 });
      expect(s.logger.entries).toEqual([{ level: 'warn', event: 'collab.refused', fields: { code: 'bad-document-name' } }]);
    });

  it('a canonical lowercase UUID passes onConnect', async () => {
    await expect(setup('member').connect(PAGE)).resolves.toBeUndefined();
  });

  it('member: read-write context with the database user id (not the token subject), subject, level, expiry and epoch', async () => {
    const s = setup('member');
    const { result, readOnly } = s.authenticate('t');
    await expect(result).resolves.toStrictEqual({ userId: U1, descopeUserId: SUBJECT, accessLevel: 'read-write', expiresAt: 10_000_000, epoch: 0 });
    expect(readOnly.v).toBe(false);
    expect(U1).not.toBe(SUBJECT);
  });

  it('the epoch comes from the access decision', async () => {
    const s = setup('member');
    const page = s.world.pages.find((p) => p.id === PAGE);
    if (page) page.epoch = 7;
    await expect(s.authenticate('t').result).resolves.toMatchObject({ epoch: 7 });
  });

  it('viewer: read-only, the connection is marked read-only', async () => {
    const s = setup('viewer');
    const { result, readOnly } = s.authenticate('t');
    await expect(result).resolves.toMatchObject({ accessLevel: 'read-only' });
    expect(readOnly.v).toBe(true);
  });

  it('a member with a read entry only: read-only', async () => {
    const s = setup('member');
    s.world.access.push({ collectionId: 'c-closed', userId: U1, permission: 'read' });
    const { result, readOnly } = s.authenticate('t', CLOSED);
    await expect(result).resolves.toMatchObject({ accessLevel: 'read-only' });
    expect(readOnly.v).toBe(true);
  });

  it('a verified user with no row: forbidden, no access check', async () => {
    const s = setup(undefined);
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'forbidden' });
    expect(s.accessStore.calls).toBe(0);
    expect(s.refused()).toEqual([{ level: 'warn', event: 'collab.refused', fields: { code: 'forbidden', detail: 'no-user' } }]);
  });

  it('the system user is never a session, even if its row were not suspended', async () => {
    const s = setup(undefined);
    await s.users.createIfAbsent({ descopeUserId: 'system:migration', email: 'system@grimoire.invalid', name: 'System', role: 'admin' });
    s.verifier.result = { kind: 'ok', userId: 'system:migration', expiresAt: 10_000_000 };
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'forbidden' });
    expect(s.accessStore.calls).toBe(0);
  });

  it('a row for another subject than the verified one is refused (identity must match)', async () => {
    const s = setup('member');
    s.deps = { ...s.deps, resolveUser: () => Promise.resolve(userRow('0a000000-0000-4000-8000-0000000000ff', 'someone-else', 'admin')) };
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'forbidden' });
    expect(s.accessStore.calls).toBe(0);
  });

  it.each([['missing page', MISSING], ['deleted page', DELETED], ['page the user cannot see', CLOSED]])(
    '%s: not-found, with one access check (the same work and the same answer for all three)', async (_l, page) => {
      const s = setup('member');
      await expect(s.authenticate('t', page).result).rejects.toMatchObject({ reason: 'not-found' });
      expect(s.accessStore.calls).toBe(1);
      expect(s.refused()).toEqual([{ level: 'warn', event: 'collab.refused', fields: { code: 'not-found' } }]);
    });

  it('invalid token: invalid-token, no database call', async () => {
    const s = setup('member');
    s.verifier.result = { kind: 'invalid-token' };
    await expect(s.authenticate('bad').result).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(s.resolve.calls + s.accessStore.calls).toBe(0);
  });

  it('expiry in the past (or now): invalid-token, no database call', async () => {
    const s = setup('member');
    s.verifier.result = { kind: 'ok', userId: SUBJECT, expiresAt: s.clock.now() };
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(s.resolve.calls).toBe(0);
  });

  it.each([
    ['an unknown result kind', { kind: 'maybe' }],
    ['ok without a subject', { kind: 'ok', userId: '', expiresAt: 10_000_000 }],
    ['ok with a non-number expiry', { kind: 'ok', userId: SUBJECT, expiresAt: Number.NaN }],
  ])('%s from the verifier: invalid-token (fail closed), no database call', async (_l, result) => {
    const s = setup('member');
    s.verifier.result = result as never;
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(s.resolve.calls).toBe(0);
  });

  it('verifier outage: try-again, one collab.auth_unavailable, no database call', async () => {
    const s = setup('member');
    s.verifier.result = { kind: 'service-unavailable' };
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'try-again' });
    expect(s.logger.entries.filter((e) => e.event === 'collab.auth_unavailable')).toEqual([{ level: 'error', event: 'collab.auth_unavailable', fields: { source: 'verifier' } }]);
    expect(s.resolve.calls).toBe(0);
  });

  it('a verifier that throws: try-again', async () => {
    const s = setup('member');
    s.verifier.verify = () => Promise.reject(new Error('boom'));
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'try-again' });
  });

  it('the user lookup fails (database down): try-again, one collab.auth_unavailable naming the database', async () => {
    const s = setup('member');
    s.resolve.fail = new Error('connect ECONNREFUSED');
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'try-again' });
    expect(s.logger.entries.filter((e) => e.event === 'collab.auth_unavailable')).toEqual([{ level: 'error', event: 'collab.auth_unavailable', fields: { source: 'database' } }]);
    expect(JSON.stringify(s.logger.entries)).not.toContain('ECONNREFUSED');
  });

  it('the access check fails (database down): try-again', async () => {
    const s = setup('member');
    s.accessStore.fail = new Error('db');
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'try-again' });
  });

  it('a hung database: try-again after the bound, never admitted', async () => {
    const s = setup('member');
    s.deps = { ...s.deps, resolveUser: () => new Promise(() => undefined) };
    const { result } = s.authenticate('t');
    const settled = expect(result).rejects.toMatchObject({ reason: 'try-again' });
    await vi.advanceTimersByTimeAsync(AUTH_DATABASE_TIMEOUT_MS);
    await settled;
  });

  it('a try-again refusal does not count as a failed sign-in for the address', async () => {
    const s = setup('member');
    const spy = vi.spyOn(s.guard, 'onAuthenticated');
    s.verifier.result = { kind: 'service-unavailable' };
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'try-again' });
    s.verifier.result = { kind: 'ok', userId: SUBJECT, expiresAt: 10_000_000 };
    s.resolve.fail = new Error('db');
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'try-again' });
    expect(spy.mock.calls).toEqual([['p1'], ['p1']]);
    s.resolve.fail = undefined;
    s.verifier.result = { kind: 'invalid-token' };
    await expect(s.authenticate('t').result).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('closes the socket with the refusal code after the delay, unless a document authenticated meanwhile', async () => {
    const s = setup('member');
    s.verifier.result = { kind: 'invalid-token' };
    await expect(s.authenticate('bad').result).rejects.toBeDefined();
    vi.advanceTimersByTime(1000);
    expect(s.closes).toEqual([{ code: REFUSAL_CLOSE_CODES['invalid-token'], reason: 'invalid-token' }]);

    const s2 = setup('member');
    s2.verifier.result = { kind: 'invalid-token' };
    await expect(s2.authenticate('bad').result).rejects.toBeDefined();
    s2.peers.markAuthenticated('p1', 'u1', PAGE);
    vi.advanceTimersByTime(1000);
    expect(s2.closes).toEqual([]);
  });

  it('no event carries the token, on refusal or admission', async () => {
    const s = setup('member');
    await s.authenticate('SECRET-TOKEN-VALUE').result;
    s.verifier.result = { kind: 'invalid-token' };
    await expect(s.authenticate('SECRET-TOKEN-VALUE').result).rejects.toBeDefined();
    expect(JSON.stringify(s.logger.entries)).not.toContain('SECRET-TOKEN-VALUE');
  });
});

describe('read-only on the wire: the context is the source of truth', () => {
  it('a read-only context forces connection.readOnly before any message is applied', async () => {
    const s = setup('viewer');
    const connection = { readOnly: false };
    await s.ext().beforeHandleMessage?.({ context: { accessLevel: 'read-only', userId: U1 }, connection, documentName: PAGE } as never);
    expect(connection.readOnly).toBe(true);
    expect(s.logger.entries.filter((e) => e.event === 'collab.read_only_mismatch')).toEqual([{ level: 'error', event: 'collab.read_only_mismatch', fields: { pageId: PAGE } }]);
  });

  it('a context without a level is treated as read-only (fail closed); a read-write context is left alone', async () => {
    const s = setup('member');
    const none = { readOnly: false };
    await s.ext().beforeHandleMessage?.({ context: {}, connection: none, documentName: PAGE } as never);
    expect(none.readOnly).toBe(true);
    const rw = { readOnly: false };
    await s.ext().beforeHandleMessage?.({ context: { accessLevel: 'read-write', userId: U1 }, connection: rw, documentName: PAGE } as never);
    expect(rw.readOnly).toBe(false);
  });
});
