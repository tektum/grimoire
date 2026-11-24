import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '../../src/http/error.js';
import { buildDocument } from '../../src/openapi/emit.js';
import type { Operation } from './document.js';
import { bodyFields, exampleBody, operations, operationsOf, policyText, withoutPolicy } from './document.js';
import { EXPECTED_OPERATIONS } from './expected-operations.js';
import { bodyHints, buildWorld, pathFor } from './world.js';
import type { Who, WorldBuilt } from './world.js';

/**
 * The walk of every route of the generated document (R2.18, R12.1, R12.3, R12.4): who is let in, who is refused and how. It builds the application with the
 * fake stores, in process, and sends requests with `app.request`. Every operation gets a world of its own, because the operations that succeed change it.
 */
const ops = operations();
const KINDS = new Set(['public', 'authenticated', 'admin', 'collection', 'collection-body', 'page', 'page-body', 'attachment', 'uploader', 'import', 'trash']);

describe('the document and its policies', () => {
  it('has exactly the operations of the list in expected-operations.ts, each with the policy the list gives it (a route moved to a weaker policy fails here)', () => {
    expect(ops.map((o) => [o.key, policyText(o.policy)])).toEqual([...EXPECTED_OPERATIONS].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  });

  it('gives every operation a policy of a known kind', () => {
    expect(withoutPolicy(ops)).toEqual([]);
    for (const op of ops) expect(KINDS.has(op.policy.kind), `${op.key}: ${op.policy.kind}`).toBe(true);
  });

  it('has exactly one public operation, GET /v1/config', () => {
    expect(ops.filter((o) => o.policy.kind === 'public').map((o) => o.key)).toEqual(['GET /v1/config']);
  });

  it('is not accepted when a route skips the factory: no policy is found for it, and the document is refused', () => {
    const bypass = new OpenAPIHono();
    bypass.openapi(createRoute({ method: 'get', path: '/v1/bypass', operationId: 'bypass', responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({}) } } } } }), (c) => c.json({}, 200));
    const raw = bypass.getOpenAPIDocument({ openapi: '3.0.3', info: { title: 't', version: '1' } });
    expect(withoutPolicy(operationsOf(raw))).toEqual(['GET /v1/bypass']);
    expect(() => buildDocument([bypass as never])).toThrow(/x-grimoire-policy/);
  });
});

/** Every response: the error envelope with a code of the table and the status that goes with it, and never a cookie. */
async function seen(res: Response, what: string): Promise<Response> {
  expect(res.headers.get('set-cookie'), `${what}: Set-Cookie`).toBeNull();
  if (res.status >= 400) {
    const body = (await res.clone().json()) as { error?: { code?: string; message?: string } };
    const code = body.error?.code as keyof typeof ERROR_STATUS;
    expect(code in ERROR_STATUS, `${what}: ${JSON.stringify(body)}`).toBe(true);
    expect(res.status, `${what}: the status of ${code}`).toBe(ERROR_STATUS[code]);
    expect(typeof body.error?.message, `${what}: message`).toBe('string');
  }
  return res;
}
const codeOf = async (res: Response): Promise<string> => ((await res.clone().json()) as { error: { code: string } }).error.code;

async function send(w: WorldBuilt, op: Operation, who: Who | undefined, hidden = false): Promise<Response> {
  const body = op.bodySchema === undefined ? undefined : exampleBody(op.bodySchema, bodyHints(w, hidden));
  return seen(await w.call(who, op.method, pathFor(op, w, hidden), body), `${op.key} as ${who ?? 'nobody'}${hidden ? ' on the hidden resource' : ''}`);
}

type Outcome = 401 | 403 | 404 | 'pass';
/** What each person gets, by the policy of the operation. `hidden` is the resource only an administrator can read. */
function table(op: Operation): { who: Who; hidden?: boolean; outcome: Outcome; code?: string }[] {
  const p = op.policy as { kind: string; need?: string };
  const readers = [{ who: 'member' as const }, { who: 'viewer' as const }];
  switch (p.kind) {
    case 'authenticated': return [...readers, { who: 'admin', outcome: 'pass' }].map((r) => ({ outcome: 'pass' as const, ...r }));
    case 'admin': return [{ who: 'member', outcome: 403, code: 'forbidden' }, { who: 'viewer', outcome: 403, code: 'forbidden' }, { who: 'admin', outcome: 'pass' }];
    case 'collection':
    case 'collection-body':
    case 'page':
    case 'page-body':
    case 'attachment':
    case 'trash': {
      const hidden = readers.map((r) => ({ ...r, hidden: true, outcome: 404 as const, code: 'not_found' }));
      if (p.need === 'read') return [...hidden, { who: 'member', outcome: 'pass' }, { who: 'viewer', outcome: 'pass' }, { who: 'admin', outcome: 'pass' }];
      // write: the member writes, the viewer reads. admin: nobody but an administrator.
      const member = p.need === 'admin' ? { who: 'member' as const, outcome: 403 as const, code: 'forbidden' } : { who: 'member' as const, outcome: 'pass' as const };
      // The trash shows a deleted page only to those who can restore it, so for the viewer it does not exist: 404 where the other policies say 403.
      const viewer = p.kind === 'trash' ? { who: 'viewer' as const, outcome: 404 as const, code: 'not_found' } : { who: 'viewer' as const, outcome: 403 as const, code: 'forbidden' };
      return [...hidden, member, viewer, { who: 'admin', outcome: 'pass' }];
    }
    // The uploader's own pending upload, by the member who made it: nobody else (an administrator included) finds it, and the member does not on a page they cannot write.
    case 'uploader': return [{ who: 'member', hidden: true, outcome: 404, code: 'not_found' }, { who: 'viewer', outcome: 404, code: 'not_found' }, { who: 'admin', outcome: 404, code: 'not_found' }, { who: 'member', outcome: 'pass' }];
    default: throw new Error(`${op.key}: the walk does not know the policy ${p.kind}`);
  }
}

describe.each(ops.filter((o) => o.policy.kind !== 'public'))('$key', (op) => {
  // Each case builds a world (about 30 ms) and sends a handful of requests in process.
  it('without credentials, with a token that does not verify or has expired, 401; a suspended user 403 account_suspended; a returning user whose domain is no longer allowed 403 not_allowed', async () => {
    const w = await buildWorld();
    for (const who of [undefined, 'garbage', 'expired'] as const) {
      const res = await send(w, op, who);
      expect([res.status, await codeOf(res)], who ?? 'nobody').toEqual([401, 'unauthenticated']);
    }
    const suspended = await send(w, op, 'suspended');
    expect([suspended.status, await codeOf(suspended)]).toEqual([403, 'account_suspended']);
    const former = await send(w, op, 'former');
    expect([former.status, await codeOf(former)]).toEqual([403, 'not_allowed']);
  }, 30_000);

  it(`follows its policy: ${JSON.stringify(op.policy)}`, async () => {
    for (const row of table(op)) {
      // A world per person: whoever gets through changes it (a page is deleted, a name is taken), and the next must find it as it was.
      const w = await buildWorld();
      const res = await send(w, op, row.who, row.hidden === true);
      const label = `${op.key} as ${row.who}${row.hidden === true ? ' on the resource it cannot read' : ''}`;
      if (row.outcome === 'pass') {
        // The handler ran and the request was good: a 2xx. (A 4xx from the validator or a handler would hide a policy that lets the person in.)
        expect(res.status, `${label}: ${await res.clone().text()}`).toBeGreaterThanOrEqual(200);
        expect(res.status, label).toBeLessThan(300);
      } else {
        expect([res.status, await codeOf(res)], label).toEqual([row.outcome, row.code]);
      }
    }
  }, 30_000);
});

/** A body that names a collection to put a page in (the destination of a move) is checked against that collection too, whatever the policy of the route says about the page. */
describe.each(ops.filter((o) => bodyFields(o).includes('collectionId') && o.policy.kind !== 'collection-body'))('$key, with a destination collection', (op) => {
  it('is 404 for a member when the destination is a collection the member cannot read, and changes nothing', async () => {
    const w = await buildWorld();
    const body = { ...(exampleBody(op.bodySchema as never, bodyHints(w)) as object), collectionId: w.ids.closedCollection };
    // The content, and where the page is: the collection, the parent and the position (`stored` does not hold them), and the fact the access decisions read.
    const where = async (): Promise<string> => JSON.stringify({
      stored: w.pages.stored(w.ids.page),
      meta: await w.pages.get(w.ids.page),
      fact: w.world.pages.find((p) => p.id === w.ids.page),
    });
    const before = await where();
    const res = await seen(await w.call('member', op.method, pathFor(op, w), body), `${op.key} into the closed collection`);
    expect([res.status, await codeOf(res)]).toEqual([404, 'not_found']);
    expect(await where()).toBe(before);
    expect(w.world.pages.find((p) => p.id === w.ids.page)?.collectionId).toBe(w.ids.openCollection);
  });
});

describe('GET /v1/config, the one public operation', () => {
  it('answers 200 without credentials', async () => {
    const w = await buildWorld();
    const res = await seen(await w.call(undefined, 'GET', '/v1/config'), 'GET /v1/config');
    expect(res.status).toBe(200);
  });
});
