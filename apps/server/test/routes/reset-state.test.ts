import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakePageStateRepo } from '@tektum/grimoire-core/testing/fake-page-state-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const ROLES: Record<string, Role> = { admin: 'admin', member: 'member', outsider: 'member' };
const NIL = '00000000-0000-4000-8000-000000000000';

/** Three people; the page lives in `open` (everyone reads). `hidden` is a page in a collection only an administrator can see. */
function build(wrap: (c: FakeMarkdownConverter) => MarkdownConverter = (c) => c) {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = Object.entries(ROLES).map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000010${String(i)}`, descopeUserId: `d-${name}`, email: `${name}@example.com`, name, role, suspended: false,
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a2', defaultPermission: null });
  const pages = new FakePageRepo(world);
  const page = pages.seed({ collectionId: open.id, title: 'Doc', markdown: 'old text' });
  const hidden = pages.seed({ collectionId: closed.id, title: 'Secret', markdown: 'secret' });
  // Two pages the access check knows and one repository does not: a page that was removed after the access check.
  const ghost = '00000000-0000-4000-8000-000000000999';
  world.pages.push({ id: ghost, collectionId: open.id, deleted: false, epoch: 0 });
  const untracked = pages.seed({ collectionId: open.id, title: 'Untracked', markdown: 'm' }).id;
  const pageState = new FakePageStateRepo();
  pageState.track(page.id, { markdown: 'old text', epoch: 4 });
  pageState.track(hidden.id, { markdown: 'secret', epoch: 0 });
  const fake = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown: 'canonical', text: 'canonical text' } });
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, collections, pages, pageState, converter: wrap(fake), idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string | undefined, id: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1/pages/${id}/reset-state`, {
      method: 'POST',
      headers: { ...(who === undefined ? {} : { authorization: `Bearer ${who}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, page, hidden, pageState, fake, ghost, untracked, users, world, adminId: rows[0]?.id as string };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('POST /v1/pages/{id}/reset-state: who may call', () => {
  it('401 without a token, 403 to a reader who is not an administrator, 404 to a user who cannot read the page, 404 for an unknown page', async () => {
    const { call, page, hidden, pageState } = build();
    expect((await call(undefined, page.id)).status).toBe(401);
    expect((await call('member', page.id)).status).toBe(403);
    expect((await call('outsider', hidden.id)).status).toBe(404);
    expect((await call('admin', NIL)).status).toBe(404);
    expect(pageState.stored(page.id)).toMatchObject({ epoch: 4 });
    expect(pageState.audit).toEqual([]);
  });

  it('answers 429 with Retry-After on the sixth call in 60 seconds', async () => {
    const { call, page } = build();
    for (let i = 0; i < 5; i += 1) expect((await call('admin', page.id)).status).toBe(200);
    const sixth = await call('admin', page.id);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('a page that goes away between the checks', () => {
  it('is 404 when the page repository no longer has it, and when the state repository no longer has it', async () => {
    const { call, ghost, untracked, pageState, fake } = build();
    expect(await code(await call('admin', ghost))).toBe('not_found');
    expect(await code(await call('admin', untracked))).toBe('not_found');
    expect(pageState.audit).toEqual([]);
    expect(fake.seedCalls).toEqual([]);
  });
});

describe('a reset that keeps the saved Markdown', () => {
  it('gives 200 with the epoch one higher, drops the state, leaves the Markdown alone and writes one audit row', async () => {
    const { call, page, pageState, adminId } = build();
    const res = await call('admin', page.id);
    expect([res.status, await res.json()]).toEqual([200, { stateEpoch: 5, markdownStale: false }]);
    expect(pageState.stored(page.id)).toMatchObject({ state: null, markdown: 'old text', epoch: 5 });
    expect(pageState.audit).toEqual([{ actorId: adminId, action: 'page.state_reset', targetType: 'page', targetId: page.id, detail: { stateEpoch: 5, markdownReplaced: false, markdownStale: false } }]);
  });

  it('409 markdown_stale for a stale page without confirmStale, nothing changed; with confirmStale it succeeds and says so', async () => {
    const { call, page, pageState } = build();
    pageState.track(page.id, { markdown: 'old text', epoch: 4, stale: true });
    const refused = await call('admin', page.id, {});
    expect([refused.status, await code(refused)]).toEqual([409, 'markdown_stale']);
    expect(pageState.stored(page.id)).toMatchObject({ epoch: 4, stale: true });
    expect(pageState.stored(page.id)?.state).not.toBeNull();
    expect(pageState.audit).toEqual([]);
    const confirmed = await call('admin', page.id, { confirmStale: true });
    expect([confirmed.status, await confirmed.json()]).toEqual([200, { stateEpoch: 5, markdownStale: true }]);
    expect(pageState.stored(page.id)).toMatchObject({ state: null, stale: false });
  });
});

describe('a reset with supplied Markdown', () => {
  it('seeds it with the strict limits under the admin id, stores the canonical Markdown with its state, and needs no confirmation on a stale page', async () => {
    const { call, page, pageState, fake, adminId } = build();
    pageState.track(page.id, { markdown: 'old text', epoch: 4, stale: true });
    const res = await call('admin', page.id, { markdown: '# new' });
    expect([res.status, await res.json()]).toEqual([200, { stateEpoch: 5, markdownStale: false }]);
    expect(fake.seedKeys).toEqual([adminId]);
    expect(fake.seedCalls).toEqual(['# new']);
    expect(pageState.stored(page.id)).toMatchObject({ state: new Uint8Array([1, 2, 3]), markdown: 'canonical', text: 'canonical text', epoch: 5, stale: false });
    expect(pageState.audit.map((e) => e.detail)).toEqual([{ stateEpoch: 5, markdownReplaced: true, markdownStale: false }]);
  });

  it('422 with the pool\'s sentence over the seed limits, 503 when the converter is busy, and nothing changes', async () => {
    const { call, page, pageState, fake } = build();
    fake.enqueueSeed({ ok: false, reason: 'too-large', detail: 'The page has 3 headings, the limit is 2.' });
    const big = await call('admin', page.id, { markdown: 'x' });
    expect(big.status).toBe(422);
    expect(await big.json()).toEqual({ error: { code: 'invalid', message: 'The page has 3 headings, the limit is 2.' } });
    fake.enqueueSeed({ ok: false, reason: 'queue-timeout', detail: 'busy' });
    const busy = await call('admin', page.id, { markdown: 'x' });
    expect([busy.status, busy.headers.get('retry-after')]).toEqual([503, '5']);
    expect(pageState.stored(page.id)).toMatchObject({ epoch: 4, markdown: 'old text' });
    expect(pageState.stored(page.id)?.state).not.toBeNull();
    expect(pageState.audit).toEqual([]);
  });

  it('422 for a replacement that has no state, and a field the route does not know', async () => {
    const { call, page, pageState, fake } = build();
    fake.enqueueSeed({ ok: true, state: new Uint8Array(0) });
    expect((await call('admin', page.id, { markdown: 'x' })).status).toBe(422);
    expect(pageState.stored(page.id)).toMatchObject({ epoch: 4 });
    expect((await call('admin', page.id, { extra: 1 })).status).toBe(422);
  });

  it('answers 429 to a second reset by the same admin while a conversion runs, and converts outside any lock', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = (): void => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const { call, page, pageState } = build((fake) => ({
      seed: async (m, k) => { started(); await gate; return fake.seed(m, k); },
      reseed: (m, k) => fake.reseed(m, k),
      toMarkdown: (s) => fake.toMarkdown(s),
      close: () => fake.close(),
    }));
    const first = call('admin', page.id, { markdown: 'one' });
    await running;
    const second = await call('admin', page.id, { markdown: 'two' });
    expect(second.status).toBe(429);
    expect(pageState.stored(page.id)).toMatchObject({ epoch: 4 });
    release();
    expect((await first).status).toBe(200);
  });
});

describe('a retry of a reset with the same Idempotency-Key', () => {
  const key = { 'idempotency-key': 'reset-1' };

  it('replays the answer without a second reset: the epoch, the state and the audit rows stay as the first call left them', async () => {
    const { call, page, pageState } = build();
    const first = await call('admin', page.id, { markdown: '# once' }, key);
    expect(await first.json()).toEqual({ stateEpoch: 5, markdownStale: false });
    // Edits made after the first answer are not wiped by the retry.
    pageState.track(page.id, { markdown: 'edited since', epoch: 5 });
    const retry = await call('admin', page.id, { markdown: '# once' }, key);
    expect([retry.status, retry.headers.get('idempotent-replay'), await retry.json()]).toEqual([200, 'true', { stateEpoch: 5, markdownStale: false }]);
    expect(pageState.stored(page.id)).toMatchObject({ epoch: 5, markdown: 'edited since' });
    expect(pageState.stored(page.id)?.state).not.toBeNull();
    expect(pageState.audit).toHaveLength(1);
  });

  it('is refused when the caller is no longer an administrator or can no longer read the page, and the epoch does not move', async () => {
    const demoted = build();
    await demoted.call('admin', demoted.page.id, undefined, key);
    await demoted.users.updateRole(demoted.adminId, 'member');
    expect((await demoted.call('admin', demoted.page.id, undefined, key)).status).toBe(403);
    expect(demoted.pageState.stored(demoted.page.id)).toMatchObject({ epoch: 5 });
    const removed = build();
    await removed.call('admin', removed.page.id, undefined, key);
    (removed.world.pages.find((p) => p.id === removed.page.id) as { deleted: boolean }).deleted = true;
    expect((await removed.call('admin', removed.page.id, undefined, key)).status).toBe(404);
    expect(removed.pageState.audit).toHaveLength(1);
  });
});
