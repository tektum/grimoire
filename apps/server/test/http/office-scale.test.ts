import { describe, expect, it } from 'vitest';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const USERS = 100;
const OFFICE = { incoming: { socket: { remoteAddress: '203.0.113.50' } } };

function office() {
  const t = makeContext();
  const verifier: AuthVerifier = {
    verify: (token) => (/^u\d+$/.test(token)
      ? Promise.resolve({ kind: 'ok', userId: `d${token.slice(1)}`, expiresAt: 9e12 })
      : Promise.resolve({ kind: 'invalid-token' })),
  };
  const rows: UserRecord[] = Array.from({ length: USERS }, (_, n) => ({ id: `id${String(n)}`, descopeUserId: `d${String(n)}`, email: `p${String(n)}@example.com`, name: 'P', role: 'member', suspended: false, tenantId: 'legacy' }));
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const provisioner = createProvisioner({ users, verifier, policy: signInPolicy });
  const config = makeFakeConfig();
  const app = createApp({ ...t.ctx, config, auth: { verifier }, signInPolicy, http: { ...t.ctx.http, config, users, provisioner } });
  app.get('/v1/things', (c) => c.json({ ok: true }));
  const call = (token: string) => app.request('/v1/things', { headers: { authorization: `Bearer ${token}` } }, OFFICE);
  return { call };
}

describe('one office address', () => {
  it('serves 100 signed-in users at 30 requests each, then limits garbage tokens at the 61st', async () => {
    const { call } = office();
    let refused = 0;
    for (let round = 0; round < 30; round += 1) {
      for (let n = 0; n < USERS; n += 1) if ((await call(`u${String(n)}`)).status !== 200) refused += 1;
    }
    expect(refused).toBe(0);
    for (let i = 0; i < 60; i += 1) expect((await call(`garbage${String(i)}`)).status).toBe(401);
    expect((await call('garbage-last')).status).toBe(429);
  }, 30_000); // 3,000 in-process requests plus 61 more; no sockets and no waiting

  it('refuses the 6,001st request of any kind from one address in 60 seconds', async () => {
    const { call } = office();
    for (let i = 0; i < 6000; i += 1) expect((await call(`u${String(i % USERS)}`)).status).toBe(200);
    expect((await call('u0')).status).toBe(429);
  }, 60_000); // 6,001 in-process requests; no sockets and no waiting
});
