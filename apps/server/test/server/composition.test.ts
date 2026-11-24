import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/composition.js';
import type { AppContext } from '../../src/composition.js';
import { createIssuer, PROJECT_ID } from './support/descope-double.js';
import { appUrl } from '@tektum/grimoire-test-support/database';

const base = {
  GRIMOIRE_DATABASE_URL: appUrl('grimoire', '127.0.0.1:1'),
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
};
const opened: AppContext[] = [];
afterEach(async () => { for (const c of opened.splice(0)) for (const h of c.shutdownHooks) await h.run(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function ctxOf(env: Record<string, string>): AppContext {
  const c = compose(env);
  if (!c.ok) throw new Error(`unexpected refusal: ${c.issues.join('; ')}`);
  opened.push(c.ctx);
  return c.ctx;
}

describe('composition root', () => {
  it('local mode selects the development verifier', async () => {
    const ctx = ctxOf({ ...base, GRIMOIRE_LOCAL: '1' });
    expect(ctx.auth.roles?.devOnly).toBe(true);
    expect(await ctx.auth.verifier.verify('dev:test-secret-0123456789abcdef:ann:admin')).toMatchObject({ kind: 'ok', userId: 'ann' });
  });

  it('non-local mode never uses the development verifier: a dev token is not a Descope session token', async () => {
    const ctx = ctxOf({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P123', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' });
    expect(ctx.auth.roles).toBeUndefined();
    expect(await ctx.auth.verifier.verify('dev:test-secret-0123456789abcdef:ann:admin')).toEqual({ kind: 'invalid-token' });
  });

  it('non-local mode builds the collaboration host with the Descope verifier, the user lookup and the database authoriser', () => {
    const ctx = ctxOf({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P123', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' });
    expect(ctx.collab?.deps.verifier).toBe(ctx.auth.verifier);
    expect(typeof ctx.collab?.deps.access.pageAccess).toBe('function');
    expect(ctx.shutdownHooks.map((h) => h.name)).toEqual(['descope-keys', 'markdown-pool', 'page-store-pool', 'auth-pool', 'database-pool']);
  });

  describe('the sign-in provider endpoint that GET /v1/config reports to browsers', () => {
    const regional = `Peu1${'a'.repeat(27)}`; // the region is what stands between the leading P and the last 27 characters
    const hosted = { ...base, GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' };
    it.each([
      ['a project id of a region with no setting: the endpoint the verifier derives', { GRIMOIRE_DESCOPE_PROJECT_ID: regional }, 'https://api.eu1.descope.com'],
      ['a project id of the default region with no setting', { GRIMOIRE_DESCOPE_PROJECT_ID: 'P123' }, 'https://api.descope.com'],
      ['a setting with a trailing slash: the slash is stripped, as the verifier strips it', { GRIMOIRE_DESCOPE_PROJECT_ID: regional, GRIMOIRE_DESCOPE_BASE_URL: 'https://api.use1.example.test/' }, 'https://api.use1.example.test'],
      ['a setting with a path: kept without its trailing slashes', { GRIMOIRE_DESCOPE_PROJECT_ID: regional, GRIMOIRE_DESCOPE_BASE_URL: 'https://proxy.example.test/descope//' }, 'https://proxy.example.test/descope'],
    ])('%s', (_name, extra, expected) => {
      expect(ctxOf({ ...hosted, ...extra }).http.providerBaseUrl).toBe(expected);
    });
    it('is null when no project is configured (local mode without one)', () => {
      expect(ctxOf({ ...base, GRIMOIRE_LOCAL: '1' }).http.providerBaseUrl).toBeNull();
    });
    it('is the same endpoint the verifier is built with, for the same inputs', async () => {
      const { descopeBaseUrl } = await import('@tektum/grimoire-adapter-auth-descope');
      for (const [id, url] of [[regional, undefined], ['P123', undefined], [regional, 'https://api.use1.example.test/']] as const) {
        const ctx = ctxOf({ ...hosted, GRIMOIRE_DESCOPE_PROJECT_ID: id, ...(url === undefined ? {} : { GRIMOIRE_DESCOPE_BASE_URL: url }) });
        expect(ctx.http.providerBaseUrl).toBe(descopeBaseUrl(id, url));
      }
    });
  });

  it.each([['1', true], ['0', false]] as const)('GRIMOIRE_LOCAL=%s: the provisioner policy has allowDevRole = config.local (%s)', (local, expected) => {
    const env = local === '1' ? { ...base, GRIMOIRE_LOCAL: '1' } : { ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P123', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', GRIMOIRE_FIRST_ADMIN_EMAILS: 'boss@example.test' };
    const ctx = ctxOf(env);
    expect(ctx.signInPolicy.allowDevRole).toBe(expected);
    expect(ctx.config.local).toBe(expected);
    if (!expected) expect(ctx.signInPolicy).toEqual({ allowDevRole: false, allowedEmailDomains: ['example.test'], refusedEmailDomains: [], firstAdminEmails: ['boss@example.test'] });
  });

  it('the token lifetime setting reaches the verifier: a token living longer than GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS is invalid-token', async () => {
    const issuer = await createIssuer(PROJECT_ID);
    // The verifier reads keys from https://api.descope.com/v2/keys/<id> for this id; fetch is replaced so no network is used.
    const keyUrls: string[] = [];
    vi.stubGlobal('fetch', (url: string | URL) => {
      keyUrls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(issuer.jwks), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const ctx = ctxOf({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: PROJECT_ID, GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS: '300' });
    const now = Math.floor(Date.now() / 1000);
    expect(await ctx.auth.verifier.verify(await issuer.token('U2within', { exp: now + 240 }))).toMatchObject({ kind: 'ok', userId: 'U2within' });
    expect(await ctx.auth.verifier.verify(await issuer.token('U2beyond', { exp: now + 400 }))).toEqual({ kind: 'invalid-token' });
    expect(keyUrls).toEqual([`https://api.descope.com/v2/keys/${PROJECT_ID}`]);
    // The default (24 h) would have accepted the second token: the setting, not the default, refused it.
    const def = ctxOf({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: PROJECT_ID, GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' });
    expect(await def.auth.verifier.verify(await issuer.token('U2beyond', { exp: now + 400 }))).toMatchObject({ kind: 'ok' });
  });

  it.each([['access', 'authorizer-stub'], ['verifier', 'verifier-stub']] as const)('a %s override is refused outside local mode (%s) and accepted in local mode', (kind, reason) => {
    const stub = kind === 'access'
      ? { access: { checkAccess: () => Promise.resolve('allowed' as const), checkAccessMany: () => Promise.resolve([]), pageAccess: () => Promise.resolve({ result: 'allowed' as const, access: 'read-write' as const, epoch: 0 }), pageAccessMany: () => Promise.resolve([]) } }
      : { verifier: { verify: () => Promise.resolve({ kind: 'ok' as const, userId: 'x', expiresAt: Number.MAX_SAFE_INTEGER }) } };
    const refused = compose({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P123', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' }, stub);
    expect(refused).toMatchObject({ ok: false, refused: { reason } });
    const local = compose({ ...base, GRIMOIRE_LOCAL: '1' }, stub);
    expect(local.ok).toBe(true);
    if (local.ok) { opened.push(local.ctx); if (kind === 'access') expect(local.ctx.collab?.deps.access).toBe(stub.access); }
  });

  it.each([
    ['local mode with a Descope project id', { ...base, GRIMOIRE_LOCAL: '1', GRIMOIRE_DESCOPE_PROJECT_ID: 'P123' }, ['GRIMOIRE_LOCAL', 'GRIMOIRE_DESCOPE_PROJECT_ID']],
    ['non-local mode without a project id', { ...base }, ['GRIMOIRE_DESCOPE_PROJECT_ID']],
    ['a missing database url', { GRIMOIRE_ALLOWED_ORIGINS: base.GRIMOIRE_ALLOWED_ORIGINS, GRIMOIRE_DEV_TOKEN_SECRET: base.GRIMOIRE_DEV_TOKEN_SECRET, GRIMOIRE_LOCAL: '1' }, ['GRIMOIRE_DATABASE_URL']],
  ])('refuses %s, naming the variables and no values', (_name, env, variables) => {
    const c = compose(env);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    const text = c.issues.join('\n');
    for (const v of variables) expect(text).toContain(v);
    expect(text).not.toContain('grimoire-dev');
    expect(text).not.toContain('P123');
  });
});
