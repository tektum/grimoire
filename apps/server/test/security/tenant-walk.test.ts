import { describe, expect, it } from 'vitest';
import type { Operation } from './document.js';
import { bodyFields, exampleBody, operations } from './document.js';
import { OTHER_COLLECTION_ID, OTHER_HIT_ID, bodyHints, buildWorld, pathFor } from './world.js';
import type { WorldBuilt } from './world.js';

// The walk of tenancy (docs/tenancy.md section 7, test 1) for the routes of milestone 7: the world has one tenant, `legacy`, and an administrator of another, `other`. Every id of the world belongs to
// `legacy`, so for that administrator none of them exists: an import, an item, the source of a failed page, a cancel and a start answer 404 with the code of a missing resource (not 403, which would say
// the id is there), a new import into a collection of `legacy` is refused the same way, and a search says nothing of the other tenant's pages. The routes are taken from the generated document, so a
// new route of these families is walked without being listed. A route of another family that names an id (in its path, its body or its query) is not part of this file: it is listed by key in
// COVERED_ELSEWHERE, so that adding one fails here until somebody lists it and says which tenancy suite covers it.
const ops = operations();
const OF_THE_WALK = (o: Operation): boolean => o.path === '/v1/search' || o.path === '/v1/imports' || o.path.startsWith('/v1/imports/');

const send = async (w: WorldBuilt, op: Operation, hidden: boolean, prepare = true): Promise<Response> => {
  if (prepare) await w.prepareImport(op, hidden); // the state an operation needs to be able to succeed: a start needs an import that waits
  const body = op.bodySchema === undefined ? undefined : exampleBody(op.bodySchema, bodyHints(w, hidden));
  return w.call('outsider', op.method, pathFor(op, w, hidden), body);
};
/** The code of the error envelope, or `no-code` for an answer that is not one (which then fails the comparison with a clear value). */
const codeOf = async (res: Response): Promise<string> => {
  const body: unknown = await res.clone().json();
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'code' in body.error ? String(body.error.code) : 'no-code';
};

describe('the routes of milestone 7 are walked', () => {
  it('names the search and import operations of the document, ten of them (search, create, get, items, source, cancel, start, abort, the parts of a file and the addresses of its parts)', () => {
    expect(ops.filter(OF_THE_WALK).map((o) => o.key)).toEqual([
      'GET /v1/imports/{id}',
      'GET /v1/imports/{id}/items',
      'GET /v1/imports/{id}/items/{itemId}/source',
      'GET /v1/imports/{id}/parts/{index}',
      'GET /v1/search',
      'POST /v1/imports',
      'POST /v1/imports/{id}/abort',
      'POST /v1/imports/{id}/cancel',
      'POST /v1/imports/{id}/parts/{index}/urls',
      'POST /v1/imports/{id}/start',
    ]);
  });
});

describe.each(ops.filter((o) => OF_THE_WALK(o) && o.path !== '/v1/search'))('$key, as the administrator of another tenant', (op) => {
  it.each([false, true])('answers 404 not_found for an id of the first tenant (the one only its administrator can read: %s)', async (hidden) => {
    const w = await buildWorld({ outsider: true });
    const res = await send(w, op, hidden);
    expect([res.status, await codeOf(res)], `${op.key} with ${op.path.includes('{id}') ? 'an import' : 'a collection'} of the first tenant: ${await res.clone().text()}`).toEqual([404, 'not_found']);
  });

  it('changes nothing: no import is added, and the one of the first tenant is as it was', async () => {
    const w = await buildWorld({ outsider: true });
    await w.prepareImport(op, false);
    const before = await w.imports.get('legacy', w.ids.import);
    const count = w.imports.count();
    await send(w, op, false, false);
    expect(w.imports.count(), 'a create that answers 404 must not insert a row').toBe(count);
    expect(await w.imports.get('legacy', w.ids.import)).toEqual(before);
  });
});

describe('GET /v1/search, as the administrator of another tenant', () => {
  // The fake search holds a hit in each tenant (the first tenant's in its open collection, the other's in a collection of its own), so a search of the wrong tenant, or of a collection that is not the caller's,
  // has something to return: these checks fail if the route passes the first tenant or the first tenant's collections to the repository.
  it('asks the repository for its own tenant and its own collections, and gets its own hit and nothing of the first tenant', async () => {
    const w = await buildWorld({ outsider: true });
    const res = await w.call('outsider', 'GET', '/v1/search?q=plan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { pageId: string }[] };
    expect(body.items.map((i) => i.pageId)).toEqual([OTHER_HIT_ID]);
    const asked = w.search.requests.at(-1);
    expect(asked?.tenantId).toBe('other');
    expect(asked?.collectionIds).toEqual([OTHER_COLLECTION_ID]);
  });

  it('names a collection of the first tenant: an empty answer, never its hit, whichever collection it is', async () => {
    const w = await buildWorld({ outsider: true });
    for (const collection of [w.ids.openCollection, w.ids.closedCollection]) {
      const res = await w.call('outsider', 'GET', `/v1/search?q=plan&collectionId=${collection}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ items: [] });
      for (const id of Object.values(w.ids)) expect(text).not.toContain(id);
    }
    for (const asked of w.search.requests) expect(asked.tenantId).toBe('other');
  });
});

/** Every operation outside this walk that names an id in its path, a collection in its body or an id in its query: each is covered by the tenancy suite of its own family (pages, collections, groups, users, attachments, trash and revisions), and is listed by key. */
const COVERED_ELSEWHERE = [
  'DELETE /v1/collections/{id}',
  'DELETE /v1/collections/{id}/access/{entryId}',
  'DELETE /v1/groups/{id}',
  'DELETE /v1/groups/{id}/members/{userId}',
  'DELETE /v1/pages/{id}',
  'DELETE /v1/trash/{id}',
  'GET /v1/attachments/{id}',
  'GET /v1/collections/{id}',
  'GET /v1/collections/{id}/access',
  'GET /v1/collections/{id}/tree',
  'GET /v1/groups/{id}/members',
  'GET /v1/pages/by-url-id/{urlId}',
  'GET /v1/pages/{id}',
  'GET /v1/pages/{id}/markdown',
  'GET /v1/pages/{id}/revisions',
  'GET /v1/pages/{id}/revisions/{rid}',
  'GET /v1/trash',
  'PATCH /v1/collections/{id}',
  'PATCH /v1/groups/{id}',
  'PATCH /v1/pages/{id}',
  'PATCH /v1/users/{id}',
  'POST /v1/attachments/{id}/complete',
  'POST /v1/pages',
  'POST /v1/pages/{id}/move',
  'POST /v1/pages/{id}/reset-state',
  'POST /v1/pages/{id}/revisions/{rid}/restore',
  'POST /v1/trash/{id}/restore',
  'PUT /v1/collections/{id}/access',
  'PUT /v1/groups/{id}/members/{userId}',
];

describe('the operations that name an id of another family', () => {
  const named = ops
    .filter((o) => !OF_THE_WALK(o) && (/\{[^}]+\}/.test(o.path) || bodyFields(o).includes('collectionId') || (o.raw.parameters ?? []).some((p) => p.in === 'query' && /Id$/.test(p.name))))
    .map((o) => o.key);

  it('are exactly the list of the suites that cover them: a new operation that names an id fails here until it is listed', () => {
    expect([...named].sort()).toEqual([...COVERED_ELSEWHERE].sort());
  });
});
