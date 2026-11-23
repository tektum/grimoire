import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { makeContext } from './support/context.js';

describe('Hono built-in middleware', () => {
  it('refuses a body above the body-limit with 413', async () => {
    const app = createApp(makeContext().ctx, { bodyLimitBytes: 16 });
    app.post('/echo', async (c) => c.text(await c.req.text()));
    const small = await app.request('/echo', { method: 'POST', body: 'x'.repeat(16) });
    expect(small.status).toBe(200);
    const big = await app.request('/echo', { method: 'POST', body: 'x'.repeat(17) });
    expect(big.status).toBe(413);
  });

  it('adds x-content-type-options: nosniff to every response', async () => {
    const app = createApp(makeContext().ctx);
    for (const path of ['/healthz', '/readyz', '/missing']) {
      expect((await app.request(path)).headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('answers a handler slower than the timeout with 503, not the middleware default 504', async () => {
    vi.useFakeTimers();
    try {
      const app = createApp(makeContext().ctx, { requestTimeoutMs: 100 });
      app.get('/slow', async (c) => {
        await new Promise(() => undefined); // never settles: slower than any timeout
        return c.text('late');
      });
      const pending = app.request('/slow');
      await vi.advanceTimersByTimeAsync(150);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });
});
