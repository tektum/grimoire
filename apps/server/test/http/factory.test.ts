import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { createRouter, defineRoute } from '../../src/http/factory.js';

const body = z.object({ title: z.string().min(1) });
const ok = z.object({ ok: z.boolean() });

function route(path: string) {
  return defineRoute({
    method: 'post',
    path,
    summary: 'Probe',
    tags: ['probe'],
    policy: { kind: 'authenticated' },
    request: { body: { content: { 'application/json': { schema: body } }, required: true } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: ok } } } },
  });
}

function mounted() {
  const a = createRouter();
  a.openapi(route('/a'), (c) => c.json({ ok: true }, 200));
  const b = createRouter();
  b.openapi(route('/b'), (c) => c.json({ ok: true }, 200));
  const app = createRouter();
  app.route('/', a);
  app.route('/', b);
  return app;
}

const post = (app: ReturnType<typeof mounted>, path: string, payload: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

describe('createRouter', () => {
  it('answers 422 with exactly the error envelope when the body fails validation', async () => {
    const res = await post(mounted(), '/a', { title: 5 });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(json)).toEqual(['error']);
    expect(Object.keys(json.error).sort()).toEqual(['code', 'message']);
    expect(json.error.code).toBe('invalid');
    expect(json.error.message).not.toContain('title');
  });

  it('does so for every router mounted in one app, not only the first', async () => {
    const app = mounted();
    for (const path of ['/a', '/b']) {
      const res = await post(app, path, {});
      expect(res.status, path).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid');
    }
  });

  it('lets a valid body through', async () => {
    expect((await post(mounted(), '/b', { title: 'x' })).status).toBe(200);
  });
});

describe('defineRoute', () => {
  it('refuses a definition without a policy at compile time', () => {
    // @ts-expect-error policy is required
    const call = () => defineRoute({ method: 'get', path: '/x', summary: 's', tags: ['t'], responses: { 200: { description: 'ok' } } });
    expect(call).toThrow();
    expectTypeOf<Parameters<typeof defineRoute>[0]>().toHaveProperty('policy');
    expectTypeOf<Parameters<typeof defineRoute>[0]['policy']>().not.toBeUndefined();
  });

  it('puts the policy, the bearer security entry and the standard responses in the document', async () => {
    const app = createRouter();
    app.openapi(route('/a'), (c) => c.json({ ok: true }, 200));
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } });
    const op = doc.paths?.['/a']?.post as Record<string, unknown> & { responses: Record<string, unknown> };
    expect(op['x-grimoire-policy']).toEqual({ kind: 'authenticated' });
    expect(op['security']).toEqual([{ bearerAuth: [] }]);
    for (const status of ['200', '401', '403', '404', '422', '429', '503']) expect(op.responses, status).toHaveProperty(status);
  });

  it('leaves security off a public route', () => {
    const app = createRouter();
    app.openapi(
      defineRoute({ method: 'get', path: '/open', summary: 's', tags: ['t'], policy: { kind: 'public' }, responses: { 200: { description: 'ok' } } }),
      (c) => c.body(null, 200),
    );
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } });
    const op = doc.paths?.['/open']?.get as Record<string, unknown>;
    expect(op['x-grimoire-policy']).toEqual({ kind: 'public' });
    expect(op['security']).toBeUndefined();
  });

  it('carries the route rate limit and the idempotency flag into the document, and only when declared', () => {
    const app = createRouter();
    const base = { method: 'post' as const, path: '/limited', summary: 's', tags: ['t'], policy: { kind: 'admin' as const }, responses: { 200: { description: 'ok' } } };
    app.openapi(defineRoute({ ...base, rateLimit: { max: 5, windowSeconds: 60 }, idempotent: true }), (c) => c.body(null, 200));
    app.openapi(defineRoute({ ...base, path: '/plain' }), (c) => c.body(null, 200));
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } });
    const limited = doc.paths?.['/limited']?.post as Record<string, unknown>;
    expect(limited['x-grimoire-rate-limit']).toEqual({ max: 5, windowSeconds: 60 });
    expect(limited['x-grimoire-idempotent']).toBe(true);
    const plain = doc.paths?.['/plain']?.post as Record<string, unknown>;
    expect(plain).not.toHaveProperty('x-grimoire-rate-limit');
    expect(plain).not.toHaveProperty('x-grimoire-idempotent');
  });
});
