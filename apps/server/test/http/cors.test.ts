import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { routers } from '../../src/routes/registry.js';
import { makeContext } from '../server/support/context.js';

const ALLOWED = 'http://127.0.0.1:8080';

function build() {
  const t = makeContext();
  const app = createApp(t.ctx);
  app.get('/v1/probe', (c) => c.json({ ok: true }));
  return app;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('CORS', () => {
  it('gives a disallowed origin no allow-origin header', async () => {
    const res = await build().request('/v1/probe', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight from an allowed origin and allows Authorization', async () => {
    const res = await build().request('/v1/probe', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('lets an allowed origin read a body-limit refusal', async () => {
    const t = makeContext();
    const app = createApp(t.ctx, { bodyLimitBytes: 4 });
    app.post('/v1/probe', (c) => c.json({ ok: true }));
    const res = await app.request('/v1/probe', { method: 'POST', body: 'too long a body', headers: { origin: ALLOWED, 'content-length': '15' } });
    expect(res.status).toBe(413);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });

  it('matches a configured origin written in mixed case against the lowercase form a browser sends', async () => {
    const t = makeContext();
    const app = createApp({ ...t.ctx, config: { ...t.ctx.config, allowedOrigins: ['HTTPS://App.Example.com'] } });
    app.get('/v1/probe', (c) => c.json({ ok: true }));
    const res = await app.request('/v1/probe', { headers: { origin: 'https://app.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });

  it('never allows credentials, for allowed and disallowed origins and preflights', async () => {
    const app = build();
    for (const origin of [ALLOWED, 'https://evil.example']) {
      for (const method of ['GET', 'OPTIONS']) {
        const res = await app.request('/v1/probe', { method, headers: { origin, 'access-control-request-method': 'GET' } });
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      }
    }
  });

  it('sets no cookie on any registered route or on the health routes', async () => {
    const app = build();
    const paths = new Set<string>(['/healthz', '/readyz', '/v1/probe', '/nowhere']);
    for (const router of routers) for (const r of router.routes) paths.add(r.path.replace(/:[^/]+/g, 'x'));
    for (const path of paths) {
      const res = await app.request(path, { headers: { origin: ALLOWED } });
      expect(res.headers.get('set-cookie'), path).toBeNull();
    }
  });

  it('has no cookie code in the server sources', () => {
    for (const file of sources(join(__dirname, '../../src'))) {
      expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toMatch(/set-cookie|setcookie/);
    }
  });
});
