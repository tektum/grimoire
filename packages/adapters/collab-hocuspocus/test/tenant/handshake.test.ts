import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantClaim } from '@tektum/grimoire-core/ports/auth-verifier';
import { createAuthExtension } from '../../src/extensions/auth.js';
import { guardConnectHooks } from '../../src/guard.js';
import { makeDeps, PAGE, SUBJECT, U1 } from '../host/support.js';

// docs/tenancy.md sections 3.4 and 6, tests of section 7 (items 2 and 10): the handshake of a person of tenant A on a page of tenant B is refused exactly as a page that is
// not there; a token with no usable tenant (none, or several) is refused before the database is asked; a user row of another tenant than the token's is refused.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const MISSING = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999';
const A: TenantClaim = { kind: 'one', id: 'tenant-a' };

/** A member whose token, user row and (when `page` is given) page are of the tenants named. */
function setup(o: { claim?: TenantClaim | undefined; user?: string | undefined; page?: string | undefined; role?: 'admin' | 'member'; requireTenant?: boolean } = { claim: A, user: 'tenant-a', page: 'tenant-a' }) {
  const t = makeDeps(o.role ?? 'member');
  t.deps = { ...t.deps, requireTenant: o.requireTenant ?? true };
  t.verifier.result = { kind: 'ok', userId: SUBJECT, expiresAt: 10_000_000, ...(o.claim === undefined ? {} : { tenant: o.claim }) };
  if (o.user !== undefined) t.users.setTenant(SUBJECT, o.user);
  for (const page of t.world.pages) if (o.page !== undefined) page.tenantId = o.page;
  const ext = () => guardConnectHooks(createAuthExtension({ deps: t.deps, log: t.log, peers: t.peers, guard: t.guard }), t);
  const authenticate = (documentName = PAGE) => {
    const data = { token: 't', documentName, context: { peerId: 'p1', address: 'a' }, connectionConfig: { readOnly: false } };
    return ext().onAuthenticate?.(data as never);
  };
  const refused = () => t.logger.entries.filter((e) => e.event === 'collab.refused');
  return Object.assign(t, { authenticate, refused });
}

describe('the handshake and the tenant of the page', () => {
  it('admits a person of tenant A to a page of tenant A, at the level their role gives', async () => {
    await expect(setup().authenticate()).resolves.toMatchObject({ userId: U1, accessLevel: 'read-write' });
  });

  it('refuses a person of tenant A on a page of tenant B as not-found, the same refusal a page that is not there gets, with the same log line', async () => {
    const other = setup({ claim: A, user: 'tenant-a', page: 'tenant-b' });
    await expect(other.authenticate()).rejects.toMatchObject({ reason: 'not-found' });
    const missing = setup();
    await expect(missing.authenticate(MISSING)).rejects.toMatchObject({ reason: 'not-found' });
    expect(other.refused()).toEqual(missing.refused());
  });

  it('asks the database the same number of times for a page of another tenant as for a page that is not there (no timing tell)', async () => {
    const other = setup({ claim: A, user: 'tenant-a', page: 'tenant-b' });
    await expect(other.authenticate()).rejects.toBeDefined();
    const missing = setup();
    await expect(missing.authenticate(MISSING)).rejects.toBeDefined();
    expect([other.resolve.calls, other.accessStore.calls]).toEqual([missing.resolve.calls, missing.accessStore.calls]);
  });

  it('refuses even an administrator, and a page the collection would give to everybody', async () => {
    const s = setup({ claim: A, user: 'tenant-a', page: 'tenant-b', role: 'admin' });
    s.world.collections.forEach((c) => { c.defaultPermission = 'read_write'; });
    await expect(s.authenticate()).rejects.toMatchObject({ reason: 'not-found' });
  });
});

describe('the token and the tenant', () => {
  it.each([
    ['names no tenant', { kind: 'none' } as TenantClaim, 'no-tenant'],
    ['carries no tenant claim at all (the verifier left the field out)', undefined, 'no-tenant'],
    ['names several tenants', { kind: 'many' } as TenantClaim, 'tenant-ambiguous'],
  ])('a token that %s is refused forbidden before the user row or the page are asked about, with a fixed detail in the log', async (_name, claim: TenantClaim | undefined, detail) => {
    const s = setup({ claim, user: 'tenant-a', page: 'tenant-a' });
    await expect(s.authenticate()).rejects.toMatchObject({ reason: 'forbidden', detail });
    expect(s.resolve.calls).toBe(0);
    expect(s.accessStore.calls).toBe(0);
    expect(s.refused()).toEqual([{ level: 'warn', event: 'collab.refused', fields: { code: 'forbidden', detail } }]);
  });

  it('refuses a user row of another tenant than the token names, and says why in the log (the provider and our row disagree: a possible fault)', async () => {
    const s = setup({ claim: A, user: 'tenant-b', page: 'tenant-a' });
    await expect(s.authenticate()).rejects.toMatchObject({ reason: 'forbidden', detail: 'tenant-mismatch' });
    expect(s.refused()).toEqual([{ level: 'warn', event: 'collab.refused', fields: { code: 'forbidden', detail: 'tenant-mismatch' } }]);
  });

  it('admits a token with no usable tenant while the deployment does not require tenants (so tokens that predate the sign-in flow are not locked out)', async () => {
    for (const claim of [{ kind: 'none' }, { kind: 'many' }] as TenantClaim[]) {
      const s = setup({ claim, user: undefined, page: undefined });
      s.deps = { ...s.deps };
      delete (s.deps as { requireTenant?: boolean }).requireTenant;
      await expect(s.authenticate()).resolves.toMatchObject({ userId: U1 });
    }
  });

  it('keeps the tenant of the user row, which admission checked the page in, for a token with no usable tenant (the page work runs in it, as on HTTP)', async () => {
    for (const claim of [{ kind: 'none' }, { kind: 'many' }] as TenantClaim[]) {
      await expect(setup({ claim, user: 'tenant-a', page: 'tenant-a', requireTenant: false }).authenticate()).resolves.toMatchObject({ userId: U1, tenantId: 'tenant-a' });
    }
  });

  it('is unchanged, while tenants are not required, for a verifier that knows nothing of them (no claim, rows with no tenant)', async () => {
    await expect(setup({ claim: undefined, user: undefined, page: undefined, requireTenant: false }).authenticate()).resolves.toMatchObject({ userId: U1 });
  });

  it('does not admit a token of tenant A whose user row says nothing of tenants to a page of tenant A (one side without the other denies)', async () => {
    await expect(setup({ claim: A, user: undefined, page: 'tenant-a' }).authenticate()).rejects.toMatchObject({ reason: 'not-found' });
  });
});
