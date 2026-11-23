import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { caller } from '../../src/http/collection-guard.js';
import { ApiError } from '../../src/http/error.js';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const NIL = '00000000-0000-4000-8000-000000000000';
const ROLES: Record<string, Role> = { admin: 'admin', member: 'member', viewer: 'viewer', outsider: 'member' };

/** Four people over two collections: `open` (everyone reads) and `closed` (nobody but an administrator). */
function build() {
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
  const closed = collections.seed({ name: 'Closed', description: 'private', icon: null, color: null, position: 'a2', defaultPermission: null });
  const group = '00000000-0000-4000-8000-000000000200';
  world.groups.push({ id: group });
  collections.names.set(group, 'Writers');
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, collections, audit: collections.audit, idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, collections, open, closed, rows, group };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('GET /v1/collections', () => {
  it('lists only what the caller can read, in position order, with the caller\'s permission', async () => {
    const { call, collections } = build();
    collections.seed({ name: 'First', description: null, icon: null, color: null, position: 'a0', defaultPermission: 'read_write' });
    const asMember = (await (await call('member', 'GET', '/v1/collections')).json()) as { items: { name: string; myPermission: string }[] };
    expect(asMember.items.map((i) => [i.name, i.myPermission])).toEqual([['First', 'read-write'], ['Open', 'read-only']]);
    const asAdmin = (await (await call('admin', 'GET', '/v1/collections')).json()) as { items: { name: string; myPermission: string }[] };
    expect(asAdmin.items.map((i) => [i.name, i.myPermission])).toEqual([['First', 'read-write'], ['Open', 'read-write'], ['Closed', 'read-write']]);
  });

  it('pins every pair of stored and answered spelling, so a stored value never reaches myPermission', async () => {
    const table: { role: string; stored: 'read' | 'read_write'; answered: string }[] = [
      { role: 'member', stored: 'read', answered: 'read-only' },
      { role: 'member', stored: 'read_write', answered: 'read-write' },
      { role: 'viewer', stored: 'read', answered: 'read-only' },
      { role: 'viewer', stored: 'read_write', answered: 'read-only' },
      { role: 'admin', stored: 'read', answered: 'read-write' },
    ];
    for (const { role, stored, answered } of table) {
      const { call, collections, open } = build();
      collections.seed({ ...open, defaultPermission: stored });
      const body = (await (await call(role, 'GET', `/v1/collections/${open.id}`)).json()) as { myPermission: string; defaultPermission: string };
      expect([role, stored, body.myPermission, body.defaultPermission]).toEqual([role, stored, answered, stored]);
    }
  });

  it('answers 401 without a token', async () => {
    const { call } = build();
    expect((await call('', 'GET', '/v1/collections', undefined, { authorization: '' })).status).toBe(401);
  });
});

describe('GET /v1/collections/{id}', () => {
  it('answers 200 to a reader and 404 to a user without access, as for an unknown id', async () => {
    const { call, open, closed } = build();
    expect((await call('viewer', 'GET', `/v1/collections/${open.id}`)).status).toBe(200);
    for (const who of ['member', 'outsider', 'viewer']) {
      const res = await call(who, 'GET', `/v1/collections/${closed.id}`);
      expect([res.status, await code(res)]).toEqual([404, 'not_found']);
    }
    expect((await call('admin', 'GET', `/v1/collections/${closed.id}`)).status).toBe(200);
    expect((await call('admin', 'GET', `/v1/collections/${NIL}`)).status).toBe(404);
    expect((await call('admin', 'GET', '/v1/collections/not-an-id')).status).toBe(422);
  });
});

describe('POST /v1/collections', () => {
  it('is for administrators: 403 for everyone else', async () => {
    const { call } = build();
    for (const who of ['member', 'viewer', 'outsider']) {
      const res = await call(who, 'POST', '/v1/collections', { name: 'X' });
      expect([res.status, await code(res)]).toEqual([403, 'forbidden']);
    }
  });

  it('creates the collection last in order and shows it to its readers', async () => {
    const { call } = build();
    const res = await call('admin', 'POST', '/v1/collections', { name: ' New ', description: 'd', defaultPermission: 'read' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; name: string; position: string; myPermission: string; defaultPermission: string };
    expect([made.name, made.myPermission, made.defaultPermission]).toEqual(['New', 'read-write', 'read']);
    expect(made.position > 'a2').toBe(true);
    const list = (await (await call('member', 'GET', '/v1/collections')).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toContain(made.id);
  });

  it('refuses a name of 0 or 101 characters, a blank name and unknown fields with 422 invalid', async () => {
    const { call } = build();
    for (const body of [{ name: '' }, { name: 'x'.repeat(101) }, { name: '   ' }, { name: 'ok', surprise: 1 }, { name: 'ok', defaultPermission: 'write' }, {}]) {
      const res = await call('admin', 'POST', '/v1/collections', body);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
    expect((await call('admin', 'POST', '/v1/collections', { name: 'x'.repeat(100) })).status).toBe(201);
  });

  it('creates one collection for the same Idempotency-Key and replays the answer', async () => {
    const { call, collections } = build();
    const first = await call('admin', 'POST', '/v1/collections', { name: 'Once' }, { 'idempotency-key': 'k1' });
    const second = await call('admin', 'POST', '/v1/collections', { name: 'Once' }, { 'idempotency-key': 'k1' });
    expect([first.status, second.status, second.headers.get('idempotent-replay')]).toEqual([201, 201, 'true']);
    expect(await second.json()).toEqual(await first.json());
    expect((await collections.listLive(collections.world.collections.map((c) => c.id))).filter((c) => c.name === 'Once')).toHaveLength(1);
  });
});

describe('the audit row of a collection created with a default permission', () => {
  it('is written, and none is written when there is no default permission', async () => {
    const { call, collections, rows } = build();
    const none = (await (await call('admin', 'POST', '/v1/collections', { name: 'Plain' })).json()) as { id: string };
    expect(collections.audit.events).toEqual([]);
    const made = (await (await call('admin', 'POST', '/v1/collections', { name: 'Shared', defaultPermission: 'read_write' })).json()) as { id: string };
    expect(made.id).not.toBe(none.id);
    expect(collections.audit.events).toEqual([
      { actorId: rows[0]?.id, action: 'collection.default_permission_changed', targetType: 'collection', targetId: made.id, detail: { from: null, to: 'read_write' } },
    ]);
  });
});

describe('PATCH /v1/collections/{id}', () => {
  it('answers 403 to a reader who is not an administrator and 404 to one who cannot read', async () => {
    const { call, open, closed } = build();
    const asReader = await call('member', 'PATCH', `/v1/collections/${open.id}`, { name: 'Z' });
    expect([asReader.status, await code(asReader)]).toEqual([403, 'forbidden']);
    expect((await call('viewer', 'PATCH', `/v1/collections/${open.id}`, { name: 'Z' })).status).toBe(403);
    const asOutsider = await call('outsider', 'PATCH', `/v1/collections/${closed.id}`, { name: 'Z' });
    expect([asOutsider.status, await code(asOutsider)]).toEqual([404, 'not_found']);
  });

  it('changes fields, takes the default permission away at once, and records the change', async () => {
    const { call, collections, open, rows } = build();
    const res = await call('admin', 'PATCH', `/v1/collections/${open.id}`, { name: 'Renamed', description: null, defaultPermission: null, position: 'a15' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Renamed', description: null, defaultPermission: null, position: 'a15', myPermission: 'read-write' });
    expect((await call('member', 'GET', `/v1/collections/${open.id}`)).status).toBe(404);
    expect(collections.audit.events).toEqual([
      { actorId: rows[0]?.id, action: 'collection.default_permission_changed', targetType: 'collection', targetId: open.id, detail: { from: 'read', to: null } },
    ]);
  });

  it('writes no audit row when the default permission stays as it is', async () => {
    const { call, collections, open } = build();
    await call('admin', 'PATCH', `/v1/collections/${open.id}`, { name: 'Same', defaultPermission: 'read' });
    expect(collections.audit.events).toEqual([]);
  });

  it('refuses an empty patch, a name of 101 characters and a malformed position with 422, and a taken position with 409', async () => {
    const { call, open } = build();
    for (const body of [{}, { name: 'x'.repeat(101) }, { position: 'not valid!' }, { color: 5 }]) {
      const res = await call('admin', 'PATCH', `/v1/collections/${open.id}`, body);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
    const taken = await call('admin', 'PATCH', `/v1/collections/${open.id}`, { position: 'a2' });
    expect([taken.status, await code(taken)]).toEqual([409, 'conflict']);
  });
});

describe('a collection that disappears between the check and the read', () => {
  it('answers 404 for get and patch, as for any collection that is not there', async () => {
    const { call, collections, open } = build();
    collections.get = () => Promise.resolve(undefined);
    collections.update = () => Promise.resolve({ kind: 'not-found' });
    expect((await call('admin', 'GET', `/v1/collections/${open.id}`)).status).toBe(404);
    expect((await call('admin', 'PATCH', `/v1/collections/${open.id}`, { name: 'Z' })).status).toBe(404);
  });
});

describe('caller', () => {
  it('refuses a request that carries no signed-in user', () => {
    const noUser = { get: () => undefined } as never;
    expect(() => caller(noUser)).toThrow(ApiError);
  });
});

describe('collection access routes', () => {
  const grant = (principalId: string, permission = 'read', principalType = 'user') => ({ principalType, principalId, permission });

  it('are for administrators: 403 to a reader, 404 to a user who cannot read the collection', async () => {
    const { call, open, closed, rows } = build();
    const entry = grant(rows[3]?.id as string);
    for (const [method, tail, body] of [['GET', '', undefined], ['PUT', '', entry], ['DELETE', `/${NIL}`, undefined]] as const) {
      const reader = await call('member', method, `/v1/collections/${open.id}/access${tail}`, body);
      expect([method, reader.status, await code(reader)]).toEqual([method, 403, 'forbidden']);
      const outsider = await call('outsider', method, `/v1/collections/${closed.id}/access${tail}`, body);
      expect([method, outsider.status, await code(outsider)]).toEqual([method, 404, 'not_found']);
    }
  });

  it('PUT gives access at once, twice on one principal leaves one entry with the same id, and DELETE takes it away', async () => {
    const { call, closed, rows } = build();
    const outsider = rows[3]?.id as string;
    const seen = async () => (await call('outsider', 'GET', `/v1/collections/${closed.id}`)).status;
    expect(await seen()).toBe(404);
    const first = await call('admin', 'PUT', `/v1/collections/${closed.id}/access`, grant(outsider));
    const second = await call('admin', 'PUT', `/v1/collections/${closed.id}/access`, grant(outsider, 'read_write'));
    expect([first.status, second.status]).toEqual([200, 200]);
    const a = (await first.json()) as { id: string; name: string };
    const b = (await second.json()) as { id: string; permission: string };
    expect(b).toMatchObject({ id: a.id, permission: 'read_write' });
    expect(a.name).toBe(outsider);
    expect(await seen()).toBe(200);
    const list = (await (await call('admin', 'GET', `/v1/collections/${closed.id}/access`)).json()) as { defaultPermission: null; entries: { id: string }[] };
    expect(list).toMatchObject({ defaultPermission: null, entries: [{ id: a.id, principalType: 'user', principalId: outsider, permission: 'read_write' }] });
    expect((await call('admin', 'DELETE', `/v1/collections/${closed.id}/access/${a.id}`)).status).toBe(204);
    expect(await seen()).toBe(404);
    expect((await call('admin', 'DELETE', `/v1/collections/${closed.id}/access/${a.id}`)).status).toBe(404);
  });

  it('give a group access by its id and name it in the list', async () => {
    const { call, closed, group } = build();
    const res = await call('admin', 'PUT', `/v1/collections/${closed.id}/access`, grant(group, 'read', 'group'));
    expect(await res.json()).toMatchObject({ principalType: 'group', principalId: group, name: 'Writers' });
  });

  it('write one audit row per upsert and per removal, naming the administrator', async () => {
    const { call, collections, closed, rows, group } = build();
    const put = (await (await call('admin', 'PUT', `/v1/collections/${closed.id}/access`, grant(group, 'read', 'group'))).json()) as { id: string };
    await call('admin', 'DELETE', `/v1/collections/${closed.id}/access/${put.id}`);
    expect(collections.audit.events.map((e) => [e.actorId, e.action, e.targetType, e.targetId])).toEqual([
      [rows[0]?.id, 'collection.access_upserted', 'collection', closed.id],
      [rows[0]?.id, 'collection.access_removed', 'collection', closed.id],
    ]);
    expect(collections.audit.events[1]?.detail).toEqual({ principalType: 'group', principalId: group, permission: 'read' });
  });

  it('refuse an unknown principal, a bad body and a malformed id with 422, and an entry of another collection with 404', async () => {
    const { call, open, closed, rows } = build();
    for (const body of [grant(NIL), grant(NIL, 'read', 'group'), grant(rows[3]?.id as string, 'write'), { principalId: NIL }, { ...grant(NIL), extra: 1 }, grant('nope')]) {
      const res = await call('admin', 'PUT', `/v1/collections/${closed.id}/access`, body);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
    expect((await call('admin', 'DELETE', `/v1/collections/${closed.id}/access/nope`)).status).toBe(422);
    const entry = (await (await call('admin', 'PUT', `/v1/collections/${open.id}/access`, grant(rows[3]?.id as string))).json()) as { id: string };
    expect((await call('admin', 'DELETE', `/v1/collections/${closed.id}/access/${entry.id}`)).status).toBe(404);
  });

  it('answer 404 when the collection disappears between the check and the work', async () => {
    const { call, collections, open, rows } = build();
    collections.listAccess = () => Promise.resolve(undefined);
    collections.upsertAccess = () => Promise.resolve({ kind: 'not-found' });
    expect((await call('admin', 'GET', `/v1/collections/${open.id}/access`)).status).toBe(404);
    expect((await call('admin', 'PUT', `/v1/collections/${open.id}/access`, grant(rows[3]?.id as string))).status).toBe(404);
  });
});
