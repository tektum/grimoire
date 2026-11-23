import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { createApp } from '../../src/app.js';
import { decodeCursor, encodeCursor, paginationQuery, toPage } from '../../src/http/pagination.js';
import { ApiError } from '../../src/http/error.js';
import { createRouter, defineRoute } from '../../src/http/factory.js';
import { makeContext } from '../server/support/context.js';

interface Row { name: string; id: string }
const ROWS: Row[] = Array.from({ length: 250 }, (_, n) => ({ name: `n${String(Math.floor(n / 7)).padStart(3, '0')}`, id: `id${String(n).padStart(4, '0')}` }));

/** Two lists over the same rows, keyed (name, id): a stand-in for the keyset query `where (name, id) > ($1, $2) order by name, id limit $3`. */
function lists() {
  const router = createRouter();
  const page = (list: string) => (c: import('hono').Context) => {
    const { limit, cursor } = paginationQuery.parse(c.req.query());
    const after = decodeCursor(list, cursor, 2);
    const rows = ROWS.filter((r) => after === undefined || r.name > String(after[0]) || (r.name === after[0] && r.id > String(after[1]))).slice(0, limit + 1);
    return c.json(toPage(list, rows, limit, (r) => [r.name, r.id]));
  };
  router.get('/a', page('a'));
  router.get('/b', page('b'));
  return router;
}

function build() {
  const t = makeContext();
  const app = createApp(t.ctx);
  app.route('/', lists());
  return app;
}

type Body = { items: Row[]; nextCursor: string | null };
const list = async (app: ReturnType<typeof build>, path: string): Promise<{ status: number; body: Body }> => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('pagination', () => {
  it('defaults the limit to 50 and refuses 0, 101 and a non-number with 422 invalid', () => {
    expect(paginationQuery.parse({}).limit).toBe(50);
    expect(paginationQuery.parse({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', '-1', 'x', '1.5']) expect(paginationQuery.safeParse({ limit }).success, limit).toBe(false);
  });

  it('answers a bad limit over HTTP in the error envelope', async () => {
    const router = createRouter();
    router.openapi(
      defineRoute({ method: 'get', path: '/limited', summary: 's', tags: ['t'], policy: { kind: 'public' }, request: { query: paginationQuery }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } } }),
      (c) => c.json({ ok: true }, 200),
    );
    const res = await router.request('/limited?limit=101');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid');
  });

  it('pages 250 rows by 100: each once, in order, nextCursor null at the end', async () => {
    const app = build();
    const seen: Row[] = [];
    let path = '/a?limit=100';
    let pages = 0;
    for (;;) {
      const { status, body } = await list(app, path);
      expect(status).toBe(200);
      seen.push(...body.items);
      pages += 1;
      if (body.nextCursor === null) break;
      path = `/a?limit=100&cursor=${body.nextCursor}`;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(ROWS);
  });

  it('returns nextCursor null when the rows fit exactly in one page', () => {
    expect(toPage('a', [1, 2, 3], 3, (n) => [n]).nextCursor).toBeNull();
    expect(toPage('a', [], 3, (n: number) => [n])).toEqual({ items: [], nextCursor: null });
    expect(toPage('a', [1, 2, 3, 4], 3, (n) => [n]).nextCursor).toBe(encodeCursor('a', [3]));
  });

  it('refuses a cursor from another list, and every malformed cursor, with 422 invalid', async () => {
    const app = build();
    const cursor = (await list(app, '/a?limit=1')).body.nextCursor ?? '';
    expect((await list(app, `/a?limit=1&cursor=${cursor}`)).status).toBe(200);
    for (const bad of [cursor, 'not-base64!', '', 'e30', Buffer.from('{"l":"a","k":["x"]}').toString('base64url'), Buffer.from('{"l":"a","k":["x","y","z"]}').toString('base64url'), Buffer.from('{"l":"a","k":[null,"y"]}').toString('base64url'), Buffer.from('[1]').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      const path = bad === cursor ? `/b?cursor=${bad}` : `/a?cursor=${bad}`;
      const res = await app.request(path);
      expect(res.status, path).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid');
    }
  });

  it('refuses a cursor that decodes but is not exactly what encodeCursor writes', () => {
    const padded = `${encodeCursor('a', ['x', 'y'])}=`;
    expect(() => decodeCursor('a', padded, 2)).toThrow(ApiError);
    expect(decodeCursor('a', undefined, 2)).toBeUndefined();
    expect(decodeCursor('a', encodeCursor('a', ['x', 3]), 2)).toEqual(['x', 3]);
  });
});
