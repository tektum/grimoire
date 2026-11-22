import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { createApp } from '../../src/app.js';
import { routeConsoleToEvents } from '../../src/lifecycle/console.js';
import { makeContext } from './support/context.js';

const SECRET = 'password=hunter2';
let stderr: string[];
beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });

function build() {
  const t = makeContext();
  const app = createApp(t.ctx);
  app.get('/boom/throw', () => { throw new Error(`sync ${SECRET}`); });
  app.get('/boom/reject', async () => { await Promise.resolve(); throw new TypeError(`async ${SECRET}`); });
  app.get('/boom/value', () => { throw `string ${SECRET}`; });
  app.get('/boom/http', () => { throw new HTTPException(418, { message: `teapot ${SECRET}` }); });
  app.get('/boom/:id', () => { throw new Error(`param ${SECRET}`); });
  return { app, logger: t.logger };
}

describe('handler errors', () => {
  it.each([
    ['/boom/throw', 500, 'internal error', 'error', 'http.handler_error', 'Error'],
    ['/boom/reject', 500, 'internal error', 'error', 'http.handler_error', 'TypeError'],
    ['/boom/value', 500, 'internal error', 'error', 'http.handler_error', 'NonError'],
    ['/boom/http', 418, 'error', 'warn', 'http.handler_rejected', 'Error'],
  ])('%s gives %i with a clean body and exactly one named event', async (path, status, body, level, event, name) => {
    const { app, logger } = build();
    const res = await app.request(path);
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(body);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level, event, fields: { errorName: name, method: 'GET', route: path, status } });
    expect(JSON.stringify(logger.entries)).not.toContain('hunter2');
    expect(stderr.join('')).toBe('');
  });

  it('logs the route pattern, not the URL or query', async () => {
    const { app, logger } = build();
    await app.request(`/boom/user-42?token=abc&${SECRET}`);
    expect(logger.entries[0]?.fields).toMatchObject({ route: '/boom/:id' });
    expect(JSON.stringify(logger.entries)).not.toMatch(/user-42|token=abc|hunter2/);
  });

  it('timeouts keep the middleware status (504) and are logged as a named event', async () => {
    vi.useFakeTimers();
    try {
      const t = makeContext();
      const app = createApp(t.ctx, { requestTimeoutMs: 50 });
      app.get('/slow', async (c) => { await new Promise(() => undefined); return c.text('late'); }); // never settles: slower than any timeout
      const pending = app.request('/slow');
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).status).toBe(504);
      expect(t.logger.entries.map((e) => e.event)).toEqual(['http.handler_error']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('console routing', () => {
  it('turns every console call into a named event carrying only the method', () => {
    const t = makeContext();
    const fake = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error } as Console;
    routeConsoleToEvents(t.ctx.log, fake);
    fake.error(new Error(SECRET));
    fake.info('The user aborted a request.');
    fake.log(SECRET);
    expect(t.logger.entries.map((e) => [e.level, e.event, e.fields])).toEqual([
      ['warn', 'console.error_output', { method: 'error' }],
      ['debug', 'console.info_output', { method: 'info' }],
      ['debug', 'console.info_output', { method: 'log' }],
    ]);
    expect(JSON.stringify(t.logger.entries)).not.toContain('hunter2');
  });
});
