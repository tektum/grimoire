import { describe, expect, it } from 'vitest';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { HttpConfig } from '@tektum/grimoire-core/ports/config';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { z } from '@hono/zod-openapi';
import { createApp } from '../../src/app.js';
import { defineRoute } from '../../src/http/factory.js';
import { makeContext } from '../server/support/context.js';

/** Tokens `u1`, `u2` and so on are valid for users `d1`, `d2`; `suspended` is a suspended user; `down` is an outage; anything else is garbage. */
function build(opts: { http?: Partial<HttpConfig>; trustedProxies?: string[] } = {}) {
  const t = makeContext();
  const calls: string[] = [];
  const verifier: AuthVerifier = {
    verify: (token) => {
      calls.push(token);
      if (/^u\d+$/.test(token)) return Promise.resolve({ kind: 'ok', userId: `d${token.slice(1)}`, expiresAt: 9e12 });
      if (token === 'suspended') return Promise.resolve({ kind: 'ok', userId: 'dS', expiresAt: 9e12 });
      if (token === 'down') return Promise.resolve({ kind: 'service-unavailable' });
      return Promise.resolve({ kind: 'invalid-token' });
    },
  };
  const rows: UserRecord[] = [1, 2, 3].map((n) => ({ id: `id${n}`, descopeUserId: `d${n}`, email: `p${n}@example.com`, name: 'P', role: 'member' as const, suspended: false }));
  rows.push({ id: 'idS', descopeUserId: 'dS', email: 'pS@example.com', name: 'P', role: 'member', suspended: true });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const provisioner = createProvisioner({ users, verifier, policy: signInPolicy });
  const config = makeFakeConfig({ ...(opts.trustedProxies === undefined ? {} : { trustedProxies: opts.trustedProxies }), ...(opts.http === undefined ? {} : { http: opts.http }) });
  const app = createApp({ ...t.ctx, config, auth: { verifier }, signInPolicy, http: { ...t.ctx.http, config, users, provisioner } });
  app.get('/v1/things', (c) => c.json({ ok: true }));
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' });
  app.openapi(
    defineRoute({ method: 'get', path: '/v1/plain', summary: 's', tags: ['t'], policy: { kind: 'authenticated' }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } }),
    (c) => c.json({ ok: true }, 200),
  );
  app.openapi(
    defineRoute({ method: 'post', path: '/v1/limited', summary: 's', tags: ['t'], policy: { kind: 'authenticated' }, rateLimit: { max: 5, windowSeconds: 60 }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } }),
    (c) => c.json({ ok: true }, 200),
  );
  return { app, t, calls };
}

const from = (peer: string) => ({ incoming: { socket: { remoteAddress: peer } } });
type App = ReturnType<typeof build>['app'];
const hit = (app: App, peer: string, headers: Record<string, string> = {}, path = '/v1/things', method = 'GET') =>
  app.request(path, { method, headers }, from(peer));
const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('address limiter: requests without credentials', () => {
  it('refuses the 61st request in 60 seconds with Retry-After, and the verifier is never called', async () => {
    const { app, calls } = build();
    for (let i = 0; i < 60; i += 1) expect((await hit(app, '203.0.113.5')).status).toBe(401);
    const res = await hit(app, '203.0.113.5');
    expect(res.status).toBe(429);
    expect(await code(res)).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(calls).toEqual([]);
  });

  it('counts a malformed bearer the same way and keeps other addresses separate', async () => {
    const { app } = build();
    for (let i = 0; i < 60; i += 1) await hit(app, '203.0.113.5', { authorization: 'Bearer' });
    expect((await hit(app, '203.0.113.5', { authorization: 'Bearer' })).status).toBe(429);
    expect((await hit(app, '203.0.113.6')).status).toBe(401);
  });

  it('ignores a forged X-Forwarded-For when no proxy is trusted: the peer address is what counts', async () => {
    const { app } = build();
    for (let i = 0; i < 60; i += 1) await hit(app, '203.0.113.5', { 'x-forwarded-for': `198.51.100.${String(i)}` });
    expect((await hit(app, '203.0.113.5', { 'x-forwarded-for': '198.51.100.200' })).status).toBe(429);
  });

  it('takes the address from the right of X-Forwarded-For when the peer is a trusted proxy', async () => {
    const { app } = build({ trustedProxies: ['10.0.0.1'] });
    const via = (xff: string) => hit(app, '10.0.0.1', { 'x-forwarded-for': xff });
    for (let i = 0; i < 60; i += 1) await via(`spoof${String(i)}.invalid, 192.0.2.1`.replace(/spoof\d+\.invalid/, `198.51.100.${String(i)}`));
    expect((await via('198.51.100.250, 192.0.2.1')).status).toBe(429);
    expect((await via('198.51.100.250, 192.0.2.2')).status).toBe(401);
    expect((await via('192.0.2.3, 10.0.0.1')).status).toBe(401);
  });

  it('keeps the peer when the header is malformed, and when the peer is not a trusted proxy', async () => {
    const { app } = build({ trustedProxies: ['10.0.0.0/8'] });
    for (let i = 0; i < 60; i += 1) await hit(app, '10.1.2.3', { 'x-forwarded-for': 'not-an-address' });
    expect((await hit(app, '10.1.2.3', { 'x-forwarded-for': '192.0.2.9' })).status).toBe(401);
    for (let i = 0; i < 60; i += 1) await hit(app, '10.1.2.3', { 'x-forwarded-for': 'garbage' });
    expect((await hit(app, '10.1.2.3', { 'x-forwarded-for': 'garbage' })).status).toBe(429);
    expect((await hit(app, '192.0.2.77', { 'x-forwarded-for': '10.9.9.9' })).status).toBe(401);
  });

  it('reads the client behind a proxy that writes ports, for IPv4 and bracketed IPv6', async () => {
    const { app } = build({ trustedProxies: ['10.0.0.1'] });
    const via = (xff: string) => hit(app, '10.0.0.1', { 'x-forwarded-for': xff });
    for (let i = 0; i < 60; i += 1) await via(`198.51.100.7:${String(5000 + i)}`);
    expect((await via('198.51.100.7')).status).toBe(429);
    expect((await via('198.51.100.8:1')).status).toBe(401);
    for (let i = 0; i < 60; i += 1) await via(`[2001:db8:1:2::5]:${String(443 + i)}`);
    expect((await via('2001:db8:1:2::5')).status).toBe(429);
    expect((await via('[2001:db8:9:9::5]:443')).status).toBe(401);
  });

  it('counts one client under one spelling: IPv4-mapped forms, zero-padded IPv6 and the peer itself', async () => {
    const { app } = build();
    for (let i = 0; i < 20; i += 1) await hit(app, '198.51.100.7');
    for (let i = 0; i < 20; i += 1) await hit(app, '::ffff:198.51.100.7');
    for (let i = 0; i < 20; i += 1) await hit(app, '::ffff:c633:6407');
    expect((await hit(app, '198.51.100.7')).status).toBe(429);
    for (let i = 0; i < 30; i += 1) await hit(app, '2001:db8::1');
    for (let i = 0; i < 30; i += 1) await hit(app, '2001:0db8:0:0:0:0:0:1');
    expect((await hit(app, '2001:DB8::1')).status).toBe(429);
  });

  it('counts an IPv6 client under its /64: rotating inside the block gains nothing', async () => {
    const { app } = build();
    for (let i = 0; i < 60; i += 1) await hit(app, `2001:db8:aaaa:bbbb::${i.toString(16)}`);
    expect((await hit(app, '2001:db8:aaaa:bbbb:1:2:3:4')).status).toBe(429);
    expect((await hit(app, '2001:db8:aaaa:cccc::1')).status).toBe(401);
  });

  it('starts with an IPv4-mapped trusted range and trusts it', async () => {
    const { app } = build({ trustedProxies: ['::ffff:10.0.0.0/104'] });
    for (let i = 0; i < 60; i += 1) await hit(app, '10.1.2.3', { 'x-forwarded-for': '192.0.2.50' });
    expect((await hit(app, '10.1.2.3', { 'x-forwarded-for': '192.0.2.50' })).status).toBe(429);
    expect((await hit(app, '10.1.2.3', { 'x-forwarded-for': '192.0.2.51' })).status).toBe(401);
  });

  it('handles loopback, an oversized peer text, single IPv6 proxies and a chain of trusted proxies only', async () => {
    const { app } = build({ trustedProxies: ['2001:db8::1', '10.0.0.1', '10.0.0.2', '10.0.0.0/abc', '10.0.0.0/-1'] });
    for (let i = 0; i < 30; i += 1) await hit(app, 'fe80::1%eth0');
    for (let i = 0; i < 30; i += 1) await hit(app, 'fe80::1');
    expect((await hit(app, '::1%lo')).status).toBe(401);
    expect((await hit(app, 'fe80::1%eth1')).status).toBe(429);
    for (let i = 0; i < 60; i += 1) await hit(app, '1'.repeat(101));
    expect((await hit(app, '2'.repeat(101))).status).toBe(429);
    expect((await hit(app, '2001:db8::1', { 'x-forwarded-for': '192.0.2.5' })).status).toBe(401);
    for (let i = 0; i < 60; i += 1) await hit(app, '10.0.0.1', { 'x-forwarded-for': '10.0.0.2' });
    expect((await hit(app, '10.0.0.1', { 'x-forwarded-for': '10.0.0.2, 10.0.0.1' })).status).toBe(429);
  });

  it('counts under the peer when the socket has no address, and ignores stray proxy entries', async () => {
    const { app } = build({ trustedProxies: ['', 'bogus', '10.0.0.1'] });
    for (let i = 0; i < 60; i += 1) await app.request('/v1/things', {}, { incoming: { socket: {} } });
    expect((await app.request('/v1/things', {}, { incoming: { socket: {} } })).status).toBe(429);
  });

  it('counts requests made in process (no socket) under one shared key', async () => {
    const { app } = build();
    for (let i = 0; i < 60; i += 1) await app.request('/v1/things');
    expect((await app.request('/v1/things')).status).toBe(429);
  });
});

describe('address limiter: failed verification', () => {
  it('counts a garbage token after the fact: the 61st is 429', async () => {
    const { app, calls } = build();
    for (let i = 0; i < 60; i += 1) expect((await hit(app, '203.0.113.5', bearer('garbage'))).status).toBe(401);
    expect((await hit(app, '203.0.113.5', bearer('garbage'))).status).toBe(429);
    expect(calls).toHaveLength(61);
  });

  it('never counts a valid request, an outage or a suspended user', async () => {
    const { app } = build();
    for (let i = 0; i < 80; i += 1) {
      expect((await hit(app, '203.0.113.5', bearer('u1'))).status).toBe(200);
      expect((await hit(app, '203.0.113.5', bearer('down'))).status).toBe(503);
      expect((await hit(app, '203.0.113.5', bearer('suspended'))).status).toBe(403);
    }
    expect((await hit(app, '203.0.113.5', bearer('u1'))).status).toBe(200);
  });

  it('does not stop a valid user behind an address that sent garbage', async () => {
    const { app } = build();
    for (let i = 0; i < 61; i += 1) await hit(app, '203.0.113.5', bearer('garbage'));
    expect((await hit(app, '203.0.113.5', bearer('u1'))).status).toBe(200);
  });
});

describe('flood ceiling', () => {
  it('refuses any request over the ceiling, valid ones too, and logs the scope', async () => {
    const { app, t } = build({ http: { addressCeilingPerMinute: 10 } });
    for (let i = 0; i < 10; i += 1) expect((await hit(app, '203.0.113.5', bearer('u1'))).status).toBe(200);
    expect((await hit(app, '203.0.113.5', bearer('u1'))).status).toBe(429);
    expect((await hit(app, '203.0.113.6', bearer('u1'))).status).toBe(200);
    expect(t.logger.entries.find((e) => e.event === 'http.rate_limited')?.fields).toEqual({ scope: 'address', route: '/v1/things' });
  });
});

describe('user limiter', () => {
  it('refuses the 1,001st request of a user in 60 seconds and leaves another user alone', async () => {
    const { app, t } = build();
    for (let i = 0; i < 1000; i += 1) expect((await hit(app, `198.51.100.${String(i % 200)}`, bearer('u1'))).status).toBe(200);
    const res = await hit(app, '198.51.100.1', bearer('u1'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
    expect((await hit(app, '198.51.100.1', bearer('u2'))).status).toBe(200);
    expect(t.logger.entries.find((e) => e.event === 'http.rate_limited')?.fields).toEqual({ scope: 'user', route: '/v1/things' });
  });

  it('is keyed by the user, never by a header or an address', async () => {
    const { app } = build({ http: { userLimitPerMinute: 5 } });
    for (let i = 0; i < 5; i += 1) await hit(app, `198.51.100.${String(i)}`, bearer('u1', { 'x-forwarded-for': `192.0.2.${String(i)}`, 'x-user-id': `other${String(i)}` }));
    expect((await hit(app, '198.51.100.99', bearer('u1', { 'x-user-id': 'fresh' }))).status).toBe(429);
  });

  it('gives a route its own limit: the 6th call of a route declared with 5 per 60 seconds is 429', async () => {
    const { app, t } = build();
    for (let i = 0; i < 5; i += 1) expect((await hit(app, '198.51.100.1', bearer('u1'), '/v1/limited', 'POST')).status).toBe(200);
    expect((await hit(app, '198.51.100.1', bearer('u1'), '/v1/limited', 'POST')).status).toBe(429);
    expect((await hit(app, '198.51.100.1', bearer('u2'), '/v1/limited', 'POST')).status).toBe(200);
    expect((await hit(app, '198.51.100.1', bearer('u1'))).status).toBe(200);
    expect(t.logger.entries.filter((e) => e.event === 'http.rate_limited').map((e) => e.fields)).toEqual([{ scope: 'route', route: '/v1/limited' }]);
  });

  it('lets a route without a limit through up to the overall limit', async () => {
    const { app } = build();
    for (let i = 0; i < 20; i += 1) expect((await hit(app, '198.51.100.1', bearer('u1'), '/v1/plain')).status).toBe(200);
  });

  it('does not limit the public route per user', async () => {
    const { app } = build();
    app.get('/v1/config', (c) => c.json({ ok: true }));
    for (let i = 0; i < 100; i += 1) expect((await hit(app, '198.51.100.1', bearer('u1'), '/v1/config')).status).toBe(200);
  });
});
