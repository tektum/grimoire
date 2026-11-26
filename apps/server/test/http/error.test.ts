import { describe, expect, it, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { z } from '@hono/zod-openapi';
import { createApp } from '../../src/app.js';
import { ERROR_STATUS, fail } from '../../src/http/error.js';
import { defineRoute } from '../../src/http/factory.js';
import type { ErrorCode } from '../../src/http/error.js';
import { makeContext } from '../server/support/context.js';

const codes = Object.keys(ERROR_STATUS) as ErrorCode[];
const table: [ErrorCode, number][] = [
  ['unauthenticated', 401],
  ['forbidden', 403], ['account_suspended', 403], ['not_allowed', 403],
  ['not_found', 404],
  ['conflict', 409], ['would_create_cycle', 409], ['too_deep', 409], ['collection_full', 409], ['collection_deleted', 409],
  ['last_admin', 409], ['name_taken', 409], ['save_failed', 409], ['markdown_stale', 409], ['upload_missing', 409], ['size_mismatch', 409], ['part_missing', 409], ['already_started', 409], ['not_running', 409], ['tenant_pages_full', 409],
  ['too_large', 413],
  ['invalid', 422], ['type_not_allowed', 422], ['type_mismatch', 422], ['not_a_zip', 422],
  ['client_too_old', 426],
  ['rate_limited', 429],
  ['staging_quota', 429],
  ['unavailable', 503],
];

function build(opts?: Parameters<typeof createApp>[1]) {
  const t = makeContext();
  const app = createApp(t.ctx, opts);
  for (const code of codes) app.get(`/code/${code}`, () => fail(code));
  app.get('/throw/string', () => { throw 'secret-string'; });
  app.get('/throw/error', () => { throw new Error('secret-error'); });
  app.get('/throw/http', () => { throw new HTTPException(404, { message: 'secret-http' }); });
  app.post('/echo', async (c) => c.text(await c.req.text()));
  return { app, logger: t.logger };
}

describe('error envelope', () => {
  it('lists exactly the codes of the contract table', () => {
    expect([...codes].sort()).toEqual(table.map(([code]) => code).sort());
  });

  it.each(table)('%s answers %i with the envelope', async (code, status) => {
    const res = await build().app.request(`/code/${code}`);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(json)).toEqual(['error']);
    expect(json.error.code).toBe(code);
    expect(json.error.message.length).toBeGreaterThan(0);
  });

  it('answers an unknown path with 404 not_found', async () => {
    const res = await build().app.request('/nothing/here');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it.each(['/throw/string', '/throw/error', '/throw/http'])('%s gives 503 unavailable with none of the thrown text', async (path) => {
    const { app, logger } = build();
    const res = await app.request(path);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('unavailable');
    expect(text).not.toMatch(/secret/);
    expect(logger.entries.some((e) => e.event === 'http.handler_error')).toBe(true);
  });

  it('answers a body over the limit with 413 too_large', async () => {
    const { app } = build({ bodyLimitBytes: 16 });
    expect((await app.request('/echo', { method: 'POST', body: 'x'.repeat(16) })).status).toBe(200);
    const res = await app.request('/echo', { method: 'POST', body: 'x'.repeat(17) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'too_large', message: expect.any(String) } });
  });

  it('answers a handler slower than the timeout with 503 unavailable, not 504', async () => {
    vi.useFakeTimers();
    try {
      const { app } = build({ requestTimeoutMs: 100 });
      app.get('/slow', async (c) => {
        await new Promise(() => undefined);
        return c.text('late');
      });
      const pending = app.request('/slow');
      await vi.advanceTimersByTimeAsync(150);
      const res = await pending;
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps /healthz and /readyz as plain text', async () => {
    const { app } = build();
    for (const path of ['/healthz', '/readyz']) {
      const res = await app.request(path);
      expect(res.headers.get('content-type'), path).toContain('text/plain');
    }
  });

  it.each([
    ['a malformed JSON body', 'application/json', '{bad'],
    ['a body of the wrong content type', 'text/plain', 'x'],
  ])('answers %s with 422 invalid and a warning, not an outage', async (_name, contentType, payload) => {
    const { app, logger } = build();
    app.openapi(
      defineRoute({
        method: 'post', path: '/typed', summary: 's', tags: ['t'], policy: { kind: 'public' },
        request: { body: { content: { 'application/json': { schema: z.object({ a: z.string() }) } }, required: true } },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => c.body(null, 200),
    );
    const res = await app.request('/typed', { method: 'POST', headers: { 'content-type': contentType }, body: payload });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid');
    expect(logger.entries.map((e) => [e.level, e.event])).toEqual([['warn', 'http.handler_rejected']]);
  });
});
