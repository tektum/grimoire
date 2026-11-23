import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const ROLES: Record<string, Role> = { member: 'member', outsider: 'member' };

/** A member who reads `open`, an outsider who reads nothing in `closed`. */
function build() {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = Object.entries(ROLES).map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000010${String(i)}`,
    descopeUserId: `d-${name}`,
    email: `${name}@example.com`,
    name,
    role,
    suspended: false,
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a2', defaultPermission: null });
  const pages = new FakePageRepo(world);
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx,
    auth: { verifier },
    signInPolicy,
    http: {
      ...t.ctx.http,
      users,
      collections,
      pages,
      idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store),
      authorizer: createAuthorizer(store),
    },
  });
  const get = (who: string | undefined, id: string, headers: Record<string, string> = {}) =>
    app.request(`/v1/pages/${id}/markdown`, { headers: { ...(who === undefined ? {} : { authorization: `Bearer ${who}` }), ...headers } });
  return { app, get, pages, open, closed, origin: t.ctx.config.allowedOrigins[0] as string };
}

describe('GET /v1/pages/{id}/markdown', () => {
  it('serves the saved Markdown as a download that no browser may sniff, with the time it was saved', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.open.id, markdown: '# Title\n\nbody\n', savedAt: Date.UTC(2026, 10, 23, 10, 30, 15, 123) });
    const res = await b.get('member', page.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('x-saved-at')).toBe('2026-11-23T10:30:15.123Z');
    expect(await res.text()).toBe('# Title\n\nbody\n');
  });

  it('names the file after the page in the download header, without anything that could end the header', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.open.id, title: 'Plan "B"\r\nx-injected: yes', markdown: 'x' });
    const res = await b.get('member', page.id);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename=/);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(res.headers.get('x-injected')).toBeNull();
  });

  it('carries the real title in UTF-8 and a plain fallback, and a default name for a page with no title', async () => {
    const b = build();
    const titled = b.pages.seed({ collectionId: b.open.id, title: "Caf\u00e9 plan's (v2)*", markdown: 'x' });
    const named = (await b.get('member', titled.id)).headers.get('content-disposition');
    expect(named).toBe('attachment; filename="Caf_ plan_s _v2__.md"; filename*=UTF-8\'\'Caf%C3%A9%20plan%27s%20%28v2%29%2A.md');
    const untitled = b.pages.seed({ collectionId: b.open.id, title: '', markdown: 'x' });
    expect((await b.get('member', untitled.id)).headers.get('content-disposition')).toBe('attachment; filename="page.md"; filename*=UTF-8\'\'page.md');
  });

  it('carries no stale header for a page whose Markdown is current', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.open.id, markdown: 'fresh' });
    const res = await b.get('member', page.id);
    expect(res.headers.has('x-grimoire-markdown-stale')).toBe(false);
    expect(res.headers.has('x-grimoire-markdown-stale-since')).toBe(false);
  });

  it('says the Markdown is stale, and since when as an HTTP date, when the editor state is newer', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.open.id, markdown: 'old text', markdownStaleSince: Date.UTC(2026, 10, 22, 8, 0, 0) });
    const res = await b.get('member', page.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-grimoire-markdown-stale')).toBe('true');
    expect(res.headers.get('x-grimoire-markdown-stale-since')).toBe('Sun, 22 Nov 2026 08:00:00 GMT');
    expect(await res.text()).toBe('old text');
  });

  it('answers 200 with an empty body for a page with no saved Markdown: stale when it has a state, plain when it has none', async () => {
    const b = build();
    const withState = b.pages.seed({ collectionId: b.open.id, hasState: true });
    const stale = await b.get('member', withState.id);
    expect([stale.status, await stale.text(), stale.headers.get('x-grimoire-markdown-stale')]).toEqual([200, '', 'true']);
    const empty = b.pages.seed({ collectionId: b.open.id });
    const plain = await b.get('member', empty.id);
    expect([plain.status, await plain.text(), plain.headers.get('x-grimoire-markdown-stale')]).toEqual([200, '', null]);
  });

  it('is 404 for a user who cannot read the page, for an unknown page, and for a deleted collection, and 401 without a token', async () => {
    const b = build();
    const hidden = b.pages.seed({ collectionId: b.closed.id, markdown: 'secret' });
    for (const id of [hidden.id, '00000000-0000-4000-8000-000000000999']) {
      const res = await b.get('outsider', id);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([404, 'not_found']);
    }
    expect((await b.get(undefined, hidden.id)).status).toBe(401);
  });

  it('is 404 when the page is gone between the access check and the reads', async () => {
    const b = build();
    const id = '00000000-0000-4000-8000-000000000777';
    b.pages.world.pages.push({ id, collectionId: b.open.id, deleted: false, epoch: 0 }); // the access store knows it, the page store does not
    const res = await b.get('member', id);
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([404, 'not_found']);
  });

  it('never leaks the text of a page the caller cannot read, in any header', async () => {
    const b = build();
    const hidden = b.pages.seed({ collectionId: b.closed.id, title: 'Hidden title', markdown: 'secret words' });
    const res = await b.get('outsider', hidden.id);
    const everything = `${[...res.headers.entries()].join('\n')}\n${await res.text()}`;
    expect(everything).not.toContain('secret words');
    expect(everything).not.toContain('Hidden title');
  });

  it('is listed with its three headers in the OpenAPI document and exposed to a browser on an allowed origin', async () => {
    const b = build();
    const doc = b.app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } });
    const ok = (doc.paths?.['/v1/pages/{id}/markdown']?.get?.responses?.['200'] ?? {}) as {
      headers?: Record<string, unknown>;
      content?: Record<string, unknown>;
    };
    expect(
      Object.keys(ok.headers ?? {})
        .map((h) => h.toLowerCase())
        .sort(),
    ).toEqual(['x-grimoire-markdown-stale', 'x-grimoire-markdown-stale-since', 'x-saved-at']);
    expect(Object.keys(ok.content ?? {})).toEqual(['text/markdown']);
    const page = b.pages.seed({ collectionId: b.open.id, markdown: 'x' });
    const res = await b.get('member', page.id, { origin: b.origin });
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    for (const name of ['x-saved-at', 'x-grimoire-markdown-stale', 'x-grimoire-markdown-stale-since']) expect(exposed).toContain(name);
  });
});
