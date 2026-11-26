import { describe, expect, it } from 'vitest';
import type { Operation } from './document.js';
import { bodyFields, exampleBody, operations } from './document.js';
import { bodyHints, buildWorld, pathFor } from './world.js';
import type { WorldBuilt } from './world.js';

// The walk of tenancy (docs/tenancy.md section 7, test 1) for the routes of milestone 7: the world has one tenant, `legacy`, and an administrator of another, `other`. Every id of the world belongs to
// `legacy`, so for that administrator none of them exists: an import, an item, the source of a failed page, a cancel and a start answer 404 with the code of a missing resource (not 403, which would say
// the id is there), a new import into a collection of `legacy` is refused the same way, and a search says nothing of the other tenant's pages. The routes are taken from the generated document, so a
// new route of these families is walked without being listed; a route of another family that names an id is not part of this file and is listed in OTHER_FAMILIES, so that adding one fails here until
// somebody says which walk covers it.
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
  it('names the search and import operations of the document, seven of them (search, create, get, items, source, cancel, start)', () => {
    expect(ops.filter(OF_THE_WALK).map((o) => o.key)).toEqual([
      'GET /v1/imports/{id}',
      'GET /v1/imports/{id}/items',
      'GET /v1/imports/{id}/items/{itemId}/source',
      'GET /v1/search',
      'POST /v1/imports',
      'POST /v1/imports/{id}/cancel',
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

  it('changes nothing: the import of the first tenant is as it was', async () => {
    const w = await buildWorld({ outsider: true });
    await w.prepareImport(op, false);
    const before = await w.imports.get('legacy', w.ids.import);
    await send(w, op, false, false);
    expect(await w.imports.get('legacy', w.ids.import)).toEqual(before);
  });
});

describe('GET /v1/search, as the administrator of another tenant', () => {
  it('is an answer of its own tenant: nothing holds an id of the first tenant, whichever collection it names', async () => {
    const w = await buildWorld({ outsider: true });
    const ids = Object.values(w.ids);
    for (const extra of ['', `&collectionId=${w.ids.openCollection}`, `&collectionId=${w.ids.closedCollection}`]) {
      const res = await w.call('outsider', 'GET', `/v1/search?q=plan${extra}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const id of ids) expect(text).not.toContain(id);
    }
  });
});

describe('the operations that name an id of another family', () => {
  /** Every other operation that takes an id in its path or a collection in its body: covered by the tenancy suites of their own milestones, not by this file. */
  const OTHER_FAMILIES = ops.filter((o) => !OF_THE_WALK(o) && (/\{[^}]+\}/.test(o.path) || bodyFields(o).includes('collectionId'))).map((o) => o.key);

  it('is the list the tenancy suites cover; a new operation with an id that is in none of the walks fails here', () => {
    expect(OTHER_FAMILIES.length).toBeGreaterThan(0);
    expect(OTHER_FAMILIES.every((key) => /^(GET|POST|PUT|PATCH|DELETE) \/v1\/(pages|collections|attachments|trash|groups|users|revisions)/.test(key))).toBe(true);
  });
});
